/**
 * Tests for executeAgentAction() — verifies the CLI dispatcher routes
 * all actions through unified gateway dispatch (POST /v1/actions/execute).
 *
 * After the thin dispatch refactor, all actions go through a single gateway
 * call. These tests verify:
 *  - Correct toolName + payload are sent to the gateway
 *  - `completed` results are handled
 *  - `sign_required` results trigger local signing + relay
 *  - `error` results are caught and logged
 *  - `ignore` action skips dispatch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @nookplot/runtime before importing the module under test ──

const mockSignForwardRequest = vi.fn().mockResolvedValue("0xSIGNATURE");

vi.mock("@nookplot/runtime", () => ({
  NookplotRuntime: vi.fn(),
  AutonomousAgent: vi.fn(),
  prepareSignRelay: vi.fn(),
  signForwardRequest: mockSignForwardRequest,
  formatActionsForPrompt: vi.fn(() => ""),
}));

// Must import after vi.mock
const { executeAgentAction } = await import("../agentLoop.js");

// ── Mock runtime factory ──

function createMockRuntime() {
  const connection = {
    request: vi.fn().mockResolvedValue({ status: "completed", result: { success: true } }),
    address: "0xAGENT_ADDRESS",
    privateKey: "0xPRIVATE_KEY",
  };
  return { connection } as any;
}

// ── Helpers ──

const signal: Record<string, unknown> = {
  signalType: "dm_received",
  senderAddress: "0xSENDER",
  channelId: "test-channel",
  projectId: "test-project",
};

const noop = () => {};

async function dispatch(runtime: any, action: Record<string, unknown>, sig = signal) {
  await executeAgentAction(runtime, action, sig, noop);
}

// ── Tests ──

describe("executeAgentAction", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    runtime = createMockRuntime();
    vi.clearAllMocks();
  });

  // ── Unified dispatch via gateway ──

  describe("unified dispatch via POST /v1/actions/execute", () => {
    it("dispatches action with correct toolName and payload", async () => {
      await dispatch(runtime, { action: "send_message", to: "0xTARGET", content: "Hello!" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({
          toolName: "nookplot_send_message",
          payload: expect.objectContaining({ to: "0xTARGET", content: "Hello!" }),
        }),
      );
    });

    it("follow dispatches as nookplot_follow", async () => {
      await dispatch(runtime, { action: "follow", to: "0xTARGET" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({ toolName: "nookplot_follow" }),
      );
    });

    it("reply dispatches as nookplot_reply", async () => {
      await dispatch(runtime, { action: "reply", content: "Hello" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({
          toolName: "nookplot_reply",
          payload: expect.objectContaining({ content: "Hello" }),
        }),
      );
    });

    it("vote dispatches as nookplot_vote", async () => {
      await dispatch(runtime, { action: "vote", cid: "QmABC", voteType: "up" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({
          toolName: "nookplot_vote",
          payload: expect.objectContaining({ cid: "QmABC", voteType: "up" }),
        }),
      );
    });

    it("create_post dispatches correctly", async () => {
      await dispatch(runtime, { action: "create_post", content: "My post", title: "Title", community: "general" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({
          toolName: "nookplot_create_post",
          payload: expect.objectContaining({ title: "Title", community: "general" }),
        }),
      );
    });
  });

  // ── Action type → toolName mapping ──

  describe("action type → toolName mapping", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["send_dm", { to: "0xT", content: "hi" }],
      ["send_message", { to: "0xT", content: "hi" }],
      ["follow_back", { to: "0xT" }],
      ["attest", { to: "0xT" }],
      ["attest_back", { to: "0xT" }],
      ["post_reply", { parentCid: "QmP" }],
      ["create_community", { slug: "test", name: "Test", description: "desc" }],
      ["create_project", { name: "Proj", description: "desc" }],
      ["propose_guild", { name: "G1", description: "Guild", members: ["0xA"] }],
      ["join_guild", { guildId: 7 }],
      ["reject_guild", { guildId: 7 }],
      ["leave_guild", { guildId: 7 }],
      ["create_bounty", { title: "Fix bug", description: "desc" }],
      ["claim_bounty", { bountyId: "5" }],
      ["apply_bounty", { bountyId: "5", content: "applying" }],
      ["create_bundle", { title: "Bundle", description: "desc" }],
      ["commit_files", { files: [{ path: "test.txt", content: "hi" }], content: "Commit" }],
      ["create_task", { content: "Build feature" }],
      ["publish_insight", { title: "Insight", body: "text" }],
      ["create_swarm", { title: "S1", subtasks: [{ title: "Sub1" }] }],
      ["create_intent", { title: "I1", description: "intent" }],
      ["egress_request", { url: "https://example.com" }],
      ["http_request", { url: "https://example.com", method: "GET" }],
      ["execute_tool", { toolName: "calc", args: {} }],
      ["register_webhook", { source: "github" }],
      ["deposit_treasury", { guildId: "42", amount: 100 }],
      ["withdraw_treasury", { guildId: "42", amount: 50 }],
      ["fund_bounty_from_treasury", { guildId: "42", bountyId: "5", amount: 25 }],
      ["distribute_revenue", { guildId: "42" }],
      ["claim_subtask", { subtaskId: "st1" }],
      ["submit_swarm_result", { subtaskId: "st1", content: "Result" }],
      ["aggregate_swarm", { swarmId: "sw1", summary: "Done" }],
      ["record_gap", { queryText: "ml" }],
      ["update_proficiency", { skillDomain: "python", proficiency: 85 }],
      ["generate_recommendations", {}],
      ["submit_proposal", { intentId: "int1", description: "approach" }],
      ["accept_proposal", { intentId: "int1", proposalId: "prop1" }],
      ["cancel_intent", { intentId: "int1" }],
      ["complete_intent", { intentId: "int1" }],
      ["query_oracle", { entityType: "project", entityId: "proj1" }],
      ["find_agents", { skills: ["python"] }],
      ["assemble_team", { content: "Build bot" }],
      ["deliver_work", { agreementId: 3, deliveryCid: "QmD" }],
      ["settle_agreement", { agreementId: 3 }],
      ["dispute_agreement", { agreementId: 3 }],
      ["cancel_agreement", { agreementId: 3 }],
      ["review", { content: "Looks good", commitId: "c1", verdict: "approve" }],
      ["workspace_create", { name: "WS" }],
      ["workspace_set", { workspaceId: "ws1", key: "score", value: 42 }],
      ["propose_collab", { targetAddress: "0xT", to: "0xT", content: "Collab!" }],
    ];

    for (const [actionType, payload] of cases) {
      it(`${actionType} → nookplot_${actionType}`, async () => {
        await dispatch(runtime, { action: actionType, ...payload });
        expect(runtime.connection.request).toHaveBeenCalledWith(
          "POST",
          "/v1/actions/execute",
          expect.objectContaining({
            toolName: `nookplot_${actionType}`,
          }),
        );
      });
    }
  });

  // ── sign_required handling ──

  describe("sign_required response handling", () => {
    it("signs and relays when gateway returns sign_required", async () => {
      runtime.connection.request.mockImplementation(async (method: string, path: string) => {
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

      await dispatch(runtime, { action: "create_community", slug: "test", name: "Test", description: "desc" });

      // Should have called relay with the signed request
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/relay",
        expect.objectContaining({ signature: "0xSIGNATURE" }),
      );
    });

    it("throws when sign_required but no private key", async () => {
      runtime.connection.privateKey = null;

      runtime.connection.request.mockImplementation(async (method: string, path: string) => {
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

      // Should not throw (error is caught and logged)
      await expect(dispatch(runtime, { action: "vote", cid: "QmABC" })).resolves.toBeUndefined();
    });
  });

  // ── error response handling ──

  describe("error response handling", () => {
    it("catches error status from gateway", async () => {
      runtime.connection.request.mockResolvedValue({ status: "error", error: "Rate limited" });

      // Should not throw (error is caught and logged)
      await expect(dispatch(runtime, { action: "send_message", to: "0xT", content: "Hi" })).resolves.toBeUndefined();
    });

    it("catches network errors", async () => {
      runtime.connection.request.mockRejectedValue(new Error("Network failure"));

      await expect(dispatch(runtime, { action: "follow", to: "0xT" })).resolves.toBeUndefined();
    });
  });

  // ── Special cases ──

  describe("special cases", () => {
    it("ignore action does nothing — no gateway call", async () => {
      await dispatch(runtime, { action: "ignore" });
      expect(runtime.connection.request).not.toHaveBeenCalled();
    });

    it("unknown action dispatches to gateway (gateway validates)", async () => {
      await dispatch(runtime, { action: "totally_unknown_action" });
      expect(runtime.connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/actions/execute",
        expect.objectContaining({ toolName: "nookplot_totally_unknown_action" }),
      );
    });

    it("payload strips the action field before sending", async () => {
      await dispatch(runtime, { action: "send_message", to: "0xT", content: "Hi" });
      const call = runtime.connection.request.mock.calls[0];
      const payload = call[2].payload;
      expect(payload).not.toHaveProperty("action");
      expect(payload).toHaveProperty("to");
      expect(payload).toHaveProperty("content");
    });

    it("populates default to/content/channelId from signal when not in action", async () => {
      await dispatch(runtime, { action: "reply" }, { senderAddress: "0xSENDER", channelId: "ch_1" });
      const call = runtime.connection.request.mock.calls[0];
      const payload = call[2].payload;
      expect(payload.to).toBe("0xSENDER");
      expect(payload.channelId).toBe("ch_1");
    });
  });

  // ── client_side_required ──

  describe("client_side_required handling", () => {
    it("logs client-side action without throwing", async () => {
      runtime.connection.request.mockResolvedValue({
        status: "client_side_required",
        action: "approve_token",
        params: { tokenAddress: "0xTOKEN" },
      });

      await expect(dispatch(runtime, { action: "approve_token" })).resolves.toBeUndefined();
    });
  });
});
