/**
 * loadedSkillRefs capture + flush.
 *
 * The runtime SDK records every nookplot_load_skill call's canonical_ref +
 * kind, then flushes the buffer into the payload of the next
 * submit_reasoning_trace / submit_subtask_trace call. This is the producer
 * side that lets the gateway's intersection logic write trace_id onto the
 * agent's recent skill-usage signals. Without this, the utility
 * prior reads zero rows and every candidate gets the cold-start prior 0.4.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, type CapturedCallbacks } from "./helpers/mockRuntime.js";
import { AutonomousAgent } from "../autonomous.js";
import type { NookplotRuntime } from "../index.js";

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

  requestMock = runtime.connection.request as ReturnType<typeof vi.fn>;
  requestMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && path === "/v1/actions/execute") {
      const { toolName } = (body ?? {}) as { toolName?: string };
      if (toolName === "nookplot_load_skill") {
        // Echo a load result with canonical_ref — payload's `kind` arg drives kind.
        return {
          status: "completed",
          result: {
            kind: "community",
            canonical_ref: "abc-123-uuid",
            content: "skill content",
          },
        };
      }
      return { status: "completed", result: { id: "submission_xyz" } };
    }
    return { success: true };
  });

  agent = new AutonomousAgent(runtime, { verbose: false });
  agent.start();
});

async function dispatchAction(
  actionType: string,
  payload?: Record<string, unknown>,
) {
  callbacks.actionCb!({ agentId: "agent_1", actionType, payload });
  await new Promise((r) => setTimeout(r, 20));
}

function getDispatchedPayload(callIndex: number): Record<string, unknown> {
  const call = requestMock.mock.calls[callIndex];
  return ((call[2] as { payload?: Record<string, unknown> }).payload) ?? {};
}

describe("loadedSkillRefs capture + flush", () => {
  it("captures canonical_ref from load_skill result and flushes on submit_reasoning_trace", async () => {
    await dispatchAction("load_skill", { name: "mining", kind: "community" });
    await dispatchAction("submit_reasoning_trace", {
      challengeId: "ch_1",
      traceCid: "Qm...",
      traceHash: "abc",
    });

    const submitPayload = getDispatchedPayload(1);
    expect(submitPayload.loadedSkillRefs).toEqual(["community:abc-123-uuid"]);
  });

  it("flushes multiple loaded skills as `${kind}:${ref}` array", async () => {
    // First load — community kind, ref X.
    requestMock.mockImplementationOnce(async () => ({
      status: "completed",
      result: { kind: "community", canonical_ref: "uuid-A" },
    }));
    await dispatchAction("load_skill", { name: "mining", kind: "community" });

    // Second load — mcp_tool kind, ref Y.
    requestMock.mockImplementationOnce(async () => ({
      status: "completed",
      result: { kind: "mcp_tool", canonical_ref: "nookplot_create_post" },
    }));
    await dispatchAction("load_skill", { name: "nookplot_create_post", kind: "mcp_tool" });

    await dispatchAction("submit_reasoning_trace", { challengeId: "ch_1" });

    const submitPayload = getDispatchedPayload(2);
    expect(submitPayload.loadedSkillRefs).toEqual([
      "community:uuid-A",
      "mcp_tool:nookplot_create_post",
    ]);
  });

  it("flushes on submit_subtask_trace too", async () => {
    await dispatchAction("load_skill", { name: "mining", kind: "community" });
    await dispatchAction("submit_subtask_trace", {
      challengeId: "ch_1",
      subtaskOrdinal: 1,
      guildId: 5,
    });

    const submitPayload = getDispatchedPayload(1);
    expect(submitPayload.loadedSkillRefs).toEqual(["community:abc-123-uuid"]);
  });

  it("does not inject loadedSkillRefs when buffer is empty", async () => {
    await dispatchAction("submit_reasoning_trace", { challengeId: "ch_1" });
    const submitPayload = getDispatchedPayload(0);
    expect(submitPayload.loadedSkillRefs).toBeUndefined();
  });

  it("respects caller-provided loadedSkillRefs (does not overwrite)", async () => {
    await dispatchAction("load_skill", { name: "mining", kind: "community" });
    await dispatchAction("submit_reasoning_trace", {
      challengeId: "ch_1",
      loadedSkillRefs: ["protocol_skill:custom-ref"],
    });

    const submitPayload = getDispatchedPayload(1);
    expect(submitPayload.loadedSkillRefs).toEqual(["protocol_skill:custom-ref"]);
  });

  it("does not capture from non-load_skill results", async () => {
    // search_skills returns candidates but is not a load — should not buffer.
    requestMock.mockImplementationOnce(async () => ({
      status: "completed",
      result: { candidates: [{ name: "x", canonical_ref: "uuid-search" }] },
    }));
    await dispatchAction("search_skills", { query: "test" });
    await dispatchAction("submit_reasoning_trace", { challengeId: "ch_1" });

    const submitPayload = getDispatchedPayload(1);
    expect(submitPayload.loadedSkillRefs).toBeUndefined();
  });

  it("caps buffer at 64 entries (drops oldest)", async () => {
    for (let i = 0; i < 70; i++) {
      requestMock.mockImplementationOnce(async () => ({
        status: "completed",
        result: { kind: "community", canonical_ref: `uuid-${i}` },
      }));
      await dispatchAction("load_skill", { name: `skill-${i}`, kind: "community" });
    }
    await dispatchAction("submit_reasoning_trace", { challengeId: "ch_1" });

    const submitPayload = getDispatchedPayload(70);
    const refs = submitPayload.loadedSkillRefs as string[];
    expect(refs).toHaveLength(64);
    // Oldest dropped: first kept ref is the 7th (index 6) = uuid-6.
    expect(refs[0]).toBe("community:uuid-6");
    expect(refs[63]).toBe("community:uuid-69");
  });

  it("ignores load_skill responses without canonical_ref", async () => {
    requestMock.mockImplementationOnce(async () => ({
      status: "completed",
      result: { kind: "community" }, // missing canonical_ref
    }));
    await dispatchAction("load_skill", { name: "broken", kind: "community" });
    await dispatchAction("submit_reasoning_trace", { challengeId: "ch_1" });

    const submitPayload = getDispatchedPayload(1);
    expect(submitPayload.loadedSkillRefs).toBeUndefined();
  });
});
