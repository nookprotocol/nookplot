/**
 * CLI parity for loadedSkillRefs capture + flush.
 *
 * Mirrors the runtime SDK test (autonomous.loadedSkillRefs.test.ts). The
 * CLI's executeAgentAction() owns the buffer at module scope (parallel to
 * `loadedCategories`), captures canonical_ref from load_skill responses,
 * and flushes into the payload of the next submit_reasoning_trace /
 * submit_subtask_trace call.
 *
 * NOTE: the buffer is module-level singleton — these tests run sequentially
 * with cumulative effect within a `describe` block. Each top-level test
 * starts with whatever the previous test left behind unless we explicitly
 * drain via a flush. To isolate, every test issues a `submit_reasoning_trace`
 * at the end, which leaves the buffer non-empty (we don't clear post-flush —
 * server-side intersection handles dedup). Tests must therefore assert on
 * what was sent for the call under test, not on global buffer state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@nookplot/runtime", () => ({
  NookplotRuntime: vi.fn(),
  AutonomousAgent: vi.fn(),
  prepareSignRelay: vi.fn(),
  signForwardRequest: vi.fn().mockResolvedValue("0xSIGNATURE"),
  formatActionsForPrompt: vi.fn(() => ""),
}));

const { executeAgentAction } = await import("../agentLoop.js");

function createMockRuntime(loadResult: Record<string, unknown> = { kind: "community", canonical_ref: "abc-123-uuid" }) {
  const connection = {
    request: vi.fn().mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/actions/execute") {
        const toolName = (body as { toolName?: string } | undefined)?.toolName;
        if (toolName === "nookplot_load_skill") {
          return { status: "completed", result: loadResult };
        }
        return { status: "completed", result: { id: "submission_xyz" } };
      }
      return { success: true };
    }),
    address: "0xAGENT_ADDRESS",
    privateKey: "0xPRIVATE_KEY",
  };
  return { connection } as any;
}

const signal: Record<string, unknown> = { signalType: "manual", senderAddress: "0xSENDER" };
const noop = () => {};

function getDispatchedPayload(runtime: any, callIndex: number): Record<string, unknown> {
  const call = runtime.connection.request.mock.calls[callIndex];
  return ((call[2] as { payload?: Record<string, unknown> }).payload) ?? {};
}

describe("executeAgentAction loadedSkillRefs", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    runtime = createMockRuntime();
    vi.clearAllMocks();
  });

  it("captures canonical_ref from load_skill and flushes on submit_reasoning_trace", async () => {
    await executeAgentAction(runtime, { action: "load_skill", name: "mining", kind: "community" }, signal, noop);
    await executeAgentAction(runtime, { action: "submit_reasoning_trace", challengeId: "ch_1" }, signal, noop);

    const submitPayload = getDispatchedPayload(runtime, 1);
    const refs = submitPayload.loadedSkillRefs as string[];
    // The buffer is module-level; assert at least our entry is present.
    expect(refs).toContain("community:abc-123-uuid");
  });

  it("flushes on submit_subtask_trace too", async () => {
    runtime = createMockRuntime({ kind: "protocol_skill", canonical_ref: "subtask-uuid" });
    await executeAgentAction(runtime, { action: "load_skill", name: "reputation", kind: "protocol_skill" }, signal, noop);
    await executeAgentAction(
      runtime,
      { action: "submit_subtask_trace", challengeId: "ch_1", subtaskOrdinal: 1, guildId: 5 },
      signal,
      noop,
    );

    const submitPayload = getDispatchedPayload(runtime, 1);
    const refs = submitPayload.loadedSkillRefs as string[];
    expect(refs).toContain("protocol_skill:subtask-uuid");
  });

  it("respects caller-provided loadedSkillRefs (does not overwrite)", async () => {
    await executeAgentAction(runtime, { action: "load_skill", name: "mining", kind: "community" }, signal, noop);
    await executeAgentAction(
      runtime,
      {
        action: "submit_reasoning_trace",
        challengeId: "ch_1",
        loadedSkillRefs: ["protocol_skill:custom-ref"],
      },
      signal,
      noop,
    );

    const submitPayload = getDispatchedPayload(runtime, 1);
    expect(submitPayload.loadedSkillRefs).toEqual(["protocol_skill:custom-ref"]);
  });

  it("does not capture from search_skills responses", async () => {
    runtime.connection.request = vi.fn().mockImplementationOnce(async () => ({
      status: "completed",
      result: { candidates: [{ name: "x", canonical_ref: "uuid-search" }] },
    })).mockImplementation(async () => ({ status: "completed", result: { id: "sub" } }));

    await executeAgentAction(runtime, { action: "search_skills", query: "mining" }, signal, noop);
    await executeAgentAction(runtime, { action: "submit_reasoning_trace", challengeId: "ch_1" }, signal, noop);

    const submitPayload = getDispatchedPayload(runtime, 1);
    // Submitted without any new entry from search_skills (whatever earlier
    // tests buffered into module state may still be there, but no new ref
    // from this call's search response).
    const refs = (submitPayload.loadedSkillRefs as string[] | undefined) ?? [];
    expect(refs).not.toContain("community:uuid-search");
    expect(refs).not.toContain("mcp_tool:uuid-search");
  });

  it("ignores load_skill responses without canonical_ref", async () => {
    runtime = createMockRuntime({ kind: "community" }); // no canonical_ref
    await executeAgentAction(runtime, { action: "load_skill", name: "broken-skill-X", kind: "community" }, signal, noop);
    await executeAgentAction(runtime, { action: "submit_reasoning_trace", challengeId: "ch_1" }, signal, noop);

    const submitPayload = getDispatchedPayload(runtime, 1);
    const refs = (submitPayload.loadedSkillRefs as string[] | undefined) ?? [];
    // Whatever's in module state from prior tests, but specifically nothing
    // referencing broken-skill-X (which had no canonical_ref).
    expect(refs.some(r => r.includes("broken"))).toBe(false);
  });
});
