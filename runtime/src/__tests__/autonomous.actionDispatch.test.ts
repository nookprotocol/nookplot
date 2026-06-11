/**
 * Action dispatch tests for AutonomousAgent — unified dispatch via gateway.
 *
 * After the thin dispatch refactor, all actions go through
 * `POST /v1/actions/execute { toolName, payload }`. These tests verify:
 *  - Correct toolName + payload are sent to the gateway
 *  - `completed` results are handled
 *  - `sign_required` results trigger local signing + relay
 *  - `client_side_required` results are handled locally
 *  - `error` results reject delegated actions
 *  - Approval gate still works for on-chain actions
 *  - actionId lifecycle (completeAction / rejectDelegatedAction)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, type CapturedCallbacks } from "./helpers/mockRuntime.js";
import { AutonomousAgent } from "../autonomous.js";
import type { NookplotRuntime } from "../index.js";

// Mock the signing module
vi.mock("../signing.js", () => ({
  prepareSignRelay: vi.fn().mockResolvedValue({ txHash: "0xRELAY_TX" }),
  signForwardRequest: vi.fn().mockResolvedValue("0xSIGNATURE"),
}));

let runtime: NookplotRuntime;
let callbacks: CapturedCallbacks;
let agent: AutonomousAgent;
let requestMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;

  // Default mock: return `completed` for POST /v1/actions/execute
  requestMock = runtime.connection.request as ReturnType<typeof vi.fn>;
  requestMock.mockImplementation(async (method: string, path: string) => {
    if (method === "POST" && path === "/v1/actions/execute") {
      return { status: "completed", result: { success: true } };
    }
    return { success: true };
  });

  agent = new AutonomousAgent(runtime, { verbose: false });
  agent.start();
});

/** Helper: dispatch an action request and wait for processing */
async function dispatchAction(
  actionType: string,
  payload?: Record<string, unknown>,
  suggestedContent?: string,
  actionId?: string,
) {
  callbacks.actionCb!({ agentId: "agent_1", actionType, payload, suggestedContent, actionId });
  await new Promise((r) => setTimeout(r, 20));
}

// ── Unified dispatch to gateway ──────────────────────────────

describe("unified dispatch via POST /v1/actions/execute", () => {
  it("dispatches action with correct toolName and payload", async () => {
    await dispatchAction("send_message", { to: "0xTARGET", content: "Hello!" });
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_send_message",
        payload: expect.objectContaining({ to: "0xTARGET", content: "Hello!" }),
      }),
    );
  });

  it("includes suggestedContent in payload when present", async () => {
    await dispatchAction("create_post", { community: "general", title: "Test" }, "Post body here");
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_create_post",
        payload: expect.objectContaining({
          community: "general",
          title: "Test",
          suggestedContent: "Post body here",
        }),
      }),
    );
  });

  it("follows dispatches as nookplot_follow", async () => {
    await dispatchAction("follow", { targetAddress: "0xTARGET" });
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({ toolName: "nookplot_follow" }),
    );
  });

  it("vote dispatches as nookplot_vote", async () => {
    await dispatchAction("vote", { contentCid: "Qm_cid", isUpvote: true });
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_vote",
        payload: expect.objectContaining({ contentCid: "Qm_cid", isUpvote: true }),
      }),
    );
  });

  it("reply action dispatches correctly", async () => {
    await dispatchAction("reply", { channelId: "ch_1" }, "My reply");
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_reply",
        payload: expect.objectContaining({ channelId: "ch_1", suggestedContent: "My reply" }),
      }),
    );
  });
});

// ── sign_required handling ──────────────────────────────

describe("sign_required response handling", () => {
  it("signs and relays when gateway returns sign_required", async () => {
    // Provide a private key for signing
    Object.defineProperty(runtime.connection, "privateKey", { value: "0xPRIVATE_KEY", writable: true });

    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        return {
          status: "sign_required",
          forwardRequest: { from: "0xAGENT", to: "0xCONTRACT", data: "0x..." },
          domain: { name: "Nookplot" },
          types: { ForwardRequest: [] },
        };
      }
      if (method === "POST" && path === "/v1/relay") {
        return { txHash: "0xRELAY_TX_HASH" };
      }
      return { success: true };
    });

    await dispatchAction("create_community", { slug: "test", name: "Test" }, undefined, "act_1");

    // Should have called relay with the signed request
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/relay",
      expect.objectContaining({ signature: "0xSIGNATURE" }),
    );

    // Should complete the action with txHash
    expect(runtime.proactive.completeAction).toHaveBeenCalledWith("act_1", "0xRELAY_TX_HASH", { txHash: "0xRELAY_TX_HASH" });
  });

  it("throws when sign_required but no private key", async () => {
    Object.defineProperty(runtime.connection, "privateKey", { value: null, writable: true });

    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        return {
          status: "sign_required",
          forwardRequest: { from: "0xAGENT" },
          domain: { name: "Nookplot" },
          types: {},
        };
      }
      return { success: true };
    });

    await dispatchAction("vote", { contentCid: "Qm_cid" }, undefined, "act_2");

    // Should reject the delegated action
    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith(
      "act_2",
      expect.stringContaining("Private key not configured"),
    );
  });
});

// ── completed response handling ──────────────────────────────

describe("completed response handling", () => {
  it("completes delegated action with result", async () => {
    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        return { status: "completed", result: { messageId: "msg_1", sent: true } };
      }
      return { success: true };
    });

    await dispatchAction("send_message", { to: "0xTARGET", content: "Hi" }, undefined, "act_3");

    expect(runtime.proactive.completeAction).toHaveBeenCalledWith(
      "act_3",
      undefined,  // no txHash for off-chain
      { messageId: "msg_1", sent: true },
    );
  });
});

// ── error response handling ──────────────────────────────

describe("error response handling", () => {
  it("rejects delegated action when gateway returns error", async () => {
    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        return { status: "error", error: "Rate limited" };
      }
      return { success: true };
    });

    await dispatchAction("send_message", { to: "0xTARGET" }, "Hi", "act_4");

    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith(
      "act_4",
      "Rate limited",
    );
  });

  it("rejects delegated action when request throws", async () => {
    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        throw new Error("Network failure");
      }
      return { success: true };
    });

    await dispatchAction("vote", { contentCid: "Qm_cid" }, undefined, "act_5");

    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith(
      "act_5",
      "Network failure",
    );
  });
});

// ── approval gate ──────────────────────────────

describe("approval gate for on-chain actions", () => {
  it("blocks on-chain action when approval handler rejects", async () => {
    const agentWithApproval = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: async () => false,
    });
    agentWithApproval.start();

    callbacks.actionCb!({
      agentId: "a1",
      actionType: "create_community",
      actionId: "act_6",
      payload: { slug: "x", name: "X" },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith(
      "act_6",
      "Rejected by approval handler",
    );
    // Should NOT call the gateway execute endpoint
    expect(requestMock).not.toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.anything(),
    );
  });

  it("allows on-chain action when approval handler approves", async () => {
    const agentWithApproval = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: async () => true,
    });
    agentWithApproval.start();

    callbacks.actionCb!({
      agentId: "a1",
      actionType: "follow",
      payload: { targetAddress: "0xTARGET" },
    });
    await new Promise((r) => setTimeout(r, 20));

    // Should have dispatched to gateway
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({ toolName: "nookplot_follow" }),
    );
  });

  it("skips approval for off-chain actions", async () => {
    const approvalFn = vi.fn().mockResolvedValue(false);
    const agentWithApproval = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: approvalFn,
    });
    agentWithApproval.start();

    callbacks.actionCb!({
      agentId: "a1",
      actionType: "reply",
      payload: { channelId: "ch1" },
      suggestedContent: "hi",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(approvalFn).not.toHaveBeenCalled();
    // Should still dispatch to gateway
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({ toolName: "nookplot_reply" }),
    );
  });
});

// ── action lifecycle ──────────────────────────────

describe("action lifecycle (completeAction / rejectDelegatedAction)", () => {
  it("completes action on success (no actionId = no completeAction call)", async () => {
    await dispatchAction("send_message", { to: "0xA", content: "hi" });
    // No actionId → no completeAction call
    expect(runtime.proactive.completeAction).not.toHaveBeenCalled();
  });

  it("completes action with actionId on success", async () => {
    await dispatchAction("send_message", { to: "0xA", content: "hi" }, undefined, "act_7");
    expect(runtime.proactive.completeAction).toHaveBeenCalledWith("act_7", undefined, { success: true });
  });

  it("rejects action with actionId on failure", async () => {
    requestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        return { status: "error", error: "Tool not found" };
      }
      return { success: true };
    });

    await dispatchAction("nonexistent_tool", {}, undefined, "act_8");
    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith("act_8", "Tool not found");
  });
});

// ── various action types dispatch correctly ──────────────────────────────

describe("action type → toolName mapping", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["create_post", { community: "general", title: "T" }],
    ["post_reply", { parentCid: "Qm_p" }],
    ["vote", { contentCid: "Qm_c", isUpvote: true }],
    ["follow", { targetAddress: "0xT" }],
    ["follow_agent", { targetAddress: "0xT" }],
    ["attest", { targetAddress: "0xT" }],
    ["attest_agent", { targetAddress: "0xT" }],
    ["send_message", { to: "0xT", content: "hi" }],
    ["send_dm", { to: "0xT", content: "hi" }],
    ["send_channel_message", { channelId: "ch_1", content: "hi" }],
    ["create_community", { slug: "test", name: "Test", description: "A test" }],
    ["propose_guild", { name: "G1", description: "Guild" }],
    ["create_bounty", { title: "B1", description: "bounty", community: "gen", rewardCredits: 100 }],
    ["claim_bounty", { bountyId: "b_1" }],
    ["create_bundle", { name: "Bundle", cids: ["Qm_1"] }],
    ["create_project", { projectId: "my-proj", name: "My Project", description: "desc" }],
    ["commit_files", { projectId: "p1", message: "init", files: [] }],
    ["create_task", { projectId: "p1", title: "T1" }],
    ["publish_insight", { title: "Insight", body: "text" }],
    ["create_swarm", { title: "S1", subtasks: [] }],
    ["create_intent", { title: "I1", description: "intent" }],
    ["apply_bounty", { bountyId: "b_1", message: "applying" }],
    ["egress_request", { url: "https://example.com" }],
  ];

  for (const [actionType, payload] of cases) {
    it(`${actionType} → nookplot_${actionType}`, async () => {
      await dispatchAction(actionType, payload);
      expect(requestMock).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({
          toolName: `nookplot_${actionType}`,
          payload: expect.objectContaining(payload),
        }),
      );
    });
  }
});

// ── stop prevents dispatch ──────────────────────────────

describe("stop prevents action dispatch", () => {
  it("stopped agent does not dispatch actions", async () => {
    agent.stop();
    callbacks.actionCb!({ agentId: "a1", actionType: "follow", payload: { targetAddress: "0xA" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(requestMock).not.toHaveBeenCalledWith("POST", "/v1/actions/execute", expect.anything());
  });
});
