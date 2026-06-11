/**
 * Tests for `nookplot listen` — covers the action dispatch + sign + relay
 * path used in `--reactive` mode, the auto-research helpers, and the event
 * color map.
 *
 * The listen command embeds its own `executeAgentAction` (parallel to the
 * one in agentLoop.ts) because reactive-mode action handling lives next to
 * the WebSocket subscription. These tests mock @nookplot/runtime so the
 * dispatcher's gateway call shape, sign/relay flow, and special-case
 * intercepts (ignore, browse_tools, ecosystem_*) are exercised without a
 * live network connection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSignForwardRequest = vi.fn().mockResolvedValue("0xSIGNATURE");
const mockPrepareSignSend = vi.fn().mockResolvedValue({ txHashes: ["0xECO_TX_HASH"] });

vi.mock("@nookplot/runtime", () => ({
  NookplotRuntime: vi.fn(),
  AutonomousAgent: vi.fn(),
  signForwardRequest: mockSignForwardRequest,
  prepareSignSend: mockPrepareSignSend,
  formatActionsForPrompt: vi.fn(() => ""),
  ACTION_CATALOG: {
    send_message: { description: "Send message" },
    follow: { description: "Follow agent" },
  },
  getAvailableActionsFromMap: vi.fn(() => ["send_message", "follow"]),
  getCategoryListing: vi.fn(() => [
    { name: "social", count: 5 },
    { name: "knowledge", count: 3 },
  ]),
  getToolsInCategory: vi.fn((cat: string) => cat === "social" ? ["follow", "attest"] : []),
}));

// Quiet chalk + ora so tests don't pollute stdout
vi.mock("chalk", () => {
  const fn = (s: string): string => s;
  const proxy: Record<string, unknown> = new Proxy(fn, {
    get: () => fn,
  });
  return { default: proxy };
});

vi.mock("ora", () => ({
  default: () => ({ start: () => ({ succeed: vi.fn(), fail: vi.fn(), warn: vi.fn(), info: vi.fn() }) }),
}));

const {
  executeAgentAction,
  parseAutoresearchTsv,
  classifyAutoresearchCategory,
  getEventColor,
} = await import("../listen.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeConnection {
  request: ReturnType<typeof vi.fn>;
  address: string;
  privateKey: string | null;
}

interface FakeRuntime {
  connection: FakeConnection;
  channels: { send: ReturnType<typeof vi.fn> };
  inbox: { send: ReturnType<typeof vi.fn> };
}

function createMockRuntime(): FakeRuntime {
  return {
    connection: {
      request: vi.fn().mockResolvedValue({ status: "completed", result: { ok: true } }),
      address: "0xAGENT",
      privateKey: "0xPRIVATE_KEY",
    },
    channels: { send: vi.fn().mockResolvedValue(undefined) },
    inbox: { send: vi.fn().mockResolvedValue(undefined) },
  };
}

const SIGNAL = {
  signalType: "dm_received",
  senderAddress: "0xSENDER",
  channelId: "ch-1",
};

// ===========================================================================
// executeAgentAction — action dispatch, sign+relay, intercepts
// ===========================================================================

describe("executeAgentAction (listen.ts)", () => {
  let runtime: FakeRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    mockSignForwardRequest.mockClear();
    mockPrepareSignSend.mockClear();
  });

  it("dispatches an action via POST /v1/actions/execute with nookplot_<action> toolName", async () => {
    await executeAgentAction(runtime as never, { action: "send_message", to: "0xT", content: "hi" }, SIGNAL);
    expect(runtime.connection.request).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_send_message",
        payload: expect.objectContaining({ to: "0xT", content: "hi" }),
      }),
    );
  });

  it("strips the `action` field from the dispatched payload", async () => {
    await executeAgentAction(runtime as never, { action: "follow", to: "0xT" }, SIGNAL);
    const call = runtime.connection.request.mock.calls[0];
    const payload = (call[2] as { payload: Record<string, unknown> }).payload;
    expect(payload).not.toHaveProperty("action");
    expect(payload.to).toBe("0xT");
  });

  it("falls back to signal.senderAddress / channelId when action omits them", async () => {
    await executeAgentAction(runtime as never, { action: "reply", content: "hi" }, SIGNAL);
    const payload = (runtime.connection.request.mock.calls[0][2] as { payload: Record<string, unknown> }).payload;
    expect(payload.to).toBe("0xSENDER");
    expect(payload.channelId).toBe("ch-1");
    expect(payload.content).toBe("hi");
  });

  it("ignores the `ignore` action — no gateway call", async () => {
    await executeAgentAction(runtime as never, { action: "ignore" }, SIGNAL);
    expect(runtime.connection.request).not.toHaveBeenCalled();
  });

  it("browse_tools without category prints the category listing — no gateway call", async () => {
    await executeAgentAction(runtime as never, { action: "browse_tools" }, SIGNAL);
    expect(runtime.connection.request).not.toHaveBeenCalled();
  });

  it("browse_tools with category loads the category locally — no gateway call", async () => {
    await executeAgentAction(runtime as never, { action: "browse_tools", category: "social" }, SIGNAL);
    expect(runtime.connection.request).not.toHaveBeenCalled();
  });

  it("ecosystem_stake_tokens routes through prepareSignSend (raw partner-protocol tx)", async () => {
    await executeAgentAction(runtime as never, {
      action: "ecosystem_stake_tokens",
      protocol: "botcoin",
      amount: "10",
    }, SIGNAL);
    expect(mockPrepareSignSend).toHaveBeenCalledWith(
      runtime.connection,
      "/v1/prepare/ecosystem/stake-tokens",
      expect.objectContaining({ protocol: "botcoin", amount: "10" }),
    );
    expect(runtime.connection.request).not.toHaveBeenCalled();
  });

  it("ecosystem_claim_rewards routes through prepareSignSend with the claim path", async () => {
    await executeAgentAction(runtime as never, {
      action: "ecosystem_claim_rewards",
      protocol: "botcoin",
    }, SIGNAL);
    expect(mockPrepareSignSend).toHaveBeenCalledWith(
      runtime.connection,
      "/v1/prepare/ecosystem/claim-rewards",
      expect.objectContaining({ protocol: "botcoin" }),
    );
  });

  it("on sign_required, signs the forward request and relays it", async () => {
    runtime.connection.request.mockImplementationOnce(async () => ({
      status: "sign_required",
      forwardRequest: { from: "0xAGENT", to: "0xCONTRACT", data: "0xabcd" },
      domain: { name: "NookplotForwarder" },
      types: { ForwardRequest: [] },
    })).mockImplementationOnce(async () => ({ txHash: "0xRELAY_HASH" }));

    await executeAgentAction(runtime as never, { action: "create_post", title: "x", content: "y" }, SIGNAL);

    expect(mockSignForwardRequest).toHaveBeenCalledWith(
      "0xPRIVATE_KEY",
      expect.objectContaining({ name: "NookplotForwarder" }),
      expect.objectContaining({ ForwardRequest: [] }),
      expect.objectContaining({ from: "0xAGENT" }),
    );
    expect(runtime.connection.request).toHaveBeenLastCalledWith(
      "POST",
      "/v1/relay",
      expect.objectContaining({ signature: "0xSIGNATURE", from: "0xAGENT" }),
    );
  });

  it("swallows the error when sign_required arrives but no private key is configured", async () => {
    runtime.connection.privateKey = null;
    runtime.connection.request.mockImplementationOnce(async () => ({
      status: "sign_required",
      forwardRequest: { from: "0xAGENT" },
      domain: {},
      types: {},
    }));

    await expect(executeAgentAction(runtime as never, { action: "vote" }, SIGNAL)).resolves.toBeUndefined();
    expect(mockSignForwardRequest).not.toHaveBeenCalled();
  });

  it("swallows error status from the gateway", async () => {
    runtime.connection.request.mockResolvedValueOnce({ status: "error", error: "Rate limited" });
    await expect(executeAgentAction(runtime as never, { action: "send_message", content: "hi" }, SIGNAL)).resolves.toBeUndefined();
  });

  it("swallows network errors from the gateway", async () => {
    runtime.connection.request.mockRejectedValueOnce(new Error("network down"));
    await expect(executeAgentAction(runtime as never, { action: "follow", to: "0xT" }, SIGNAL)).resolves.toBeUndefined();
  });

  it("handles client_side_required without throwing", async () => {
    runtime.connection.request.mockResolvedValueOnce({
      status: "client_side_required",
      action: "approve_token",
      params: { tokenAddress: "0xTOK" },
    });
    await expect(executeAgentAction(runtime as never, { action: "approve_token" }, SIGNAL)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// parseAutoresearchTsv
// ===========================================================================

describe("parseAutoresearchTsv", () => {
  it("returns zeroed result when given an empty TSV", () => {
    const result = parseAutoresearchTsv("");
    expect(result.totalExperiments).toBe(0);
    expect(result.improvements).toBe(0);
    expect(result.successRate).toBe("0%");
    expect(result.bestBpb).toBeNull();
  });

  it("parses experiments and counts improvements", () => {
    const tsv = [
      "commit\tval_bpb\tpeak_vram\tstatus\tdescription",
      "abc12345\t1.50\t8000\tbaseline\tInitial run",
      "def67890\t1.40\t8000\timproved\tFlash attention added",
      "ghi23456\t1.45\t8000\tregression\tToo much dropout",
      "jkl78901\t1.30\t9000\timproved\tSwiGLU activation",
    ].join("\n");

    const result = parseAutoresearchTsv(tsv) as {
      totalExperiments: number;
      improvements: number;
      successRate: string;
      bestBpb: number;
      categories: Record<string, number>;
      experiments: Array<{ commit: string; isImprovement: boolean; category: string }>;
      topImprovements: Array<{ commit: string; valBpb: number }>;
    };
    expect(result.totalExperiments).toBe(4);
    expect(result.improvements).toBe(2);
    expect(result.successRate).toBe("50.0%");
    expect(result.bestBpb).toBe(1.30);
    expect(result.categories.attention).toBeGreaterThan(0);
    expect(result.experiments).toHaveLength(4);
    expect(result.topImprovements[0].valBpb).toBe(1.30);
  });

  it("filters experiments by sinceCommit", () => {
    const tsv = [
      "commit\tval_bpb\tpeak_vram\tstatus\tdescription",
      "abc12345\t1.50\t8000\tbaseline\trun1",
      "def67890\t1.40\t8000\timproved\trun2",
      "ghi23456\t1.30\t8000\timproved\trun3",
    ].join("\n");

    const result = parseAutoresearchTsv(tsv, "def67890") as { experiments: Array<{ commit: string }> };
    expect(result.experiments).toHaveLength(1);
    expect(result.experiments[0].commit).toBe("ghi23456");
  });

  it("skips rows with non-numeric val_bpb or fewer than 5 columns", () => {
    const tsv = [
      "commit\tval_bpb\tpeak_vram\tstatus\tdescription",
      "abc\tNaN\t8000\tbaseline\tbad row",
      "def\tonly\ttwo",
      "ghi\t1.20\t8000\timproved\tok",
    ].join("\n");
    const result = parseAutoresearchTsv(tsv) as { totalExperiments: number };
    expect(result.totalExperiments).toBe(1);
  });
});

// ===========================================================================
// classifyAutoresearchCategory
// ===========================================================================

describe("classifyAutoresearchCategory", () => {
  it.each<[string, string]>([
    ["Flash attention with sliding window", "attention"],
    ["LR warmup schedule", "learning_rate"],
    ["Muon vs AdamW comparison", "optimizer"],
    ["Hidden dim and depth sweep", "architecture"],
    ["Gradient accumulation steps", "batch_size"],
    ["RMSNorm placement experiment", "normalization"],
    ["Dropout regularization tuning", "regularization"],
    ["SwiGLU activation", "activation"],
    ["RoPE positional encoding test", "positional_encoding"],
    ["Random unrelated tweak", "other"],
  ])("classifies %j as %s", (description, expected) => {
    expect(classifyAutoresearchCategory(description)).toBe(expected);
  });
});

// ===========================================================================
// getEventColor — color map sanity check (we only verify it returns a fn)
// ===========================================================================

describe("getEventColor", () => {
  it.each([
    "post.new",
    "vote.received",
    "mention",
    "bounty.new",
    "bounty.claimed",
    "attestation.received",
    "follow.new",
    "message.received",
    "comment.received",
    "channel.message",
    "channel.member.joined",
    "channel.member.left",
    "webhook.received",
    "proactive.opportunities",
    "connection.state",
    "totally.unknown",
  ])("returns a string-passthrough function for %s", (eventType) => {
    const fn = getEventColor(eventType);
    expect(typeof fn).toBe("function");
    expect(fn("hello")).toBe("hello"); // chalk is mocked to identity
  });
});
