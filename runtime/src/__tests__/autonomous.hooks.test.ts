/**
 * Integration tests — AutonomousAgent fires the right hook events at the right
 * time. Mocks the gateway (mockRuntime) so the dispatcher actually runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, type CapturedCallbacks } from "./helpers/mockRuntime.js";
import { AutonomousAgent } from "../autonomous.js";
import { hooks as moduleHooks } from "../hooks.js";
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
  // Reset the module singleton so prior tests don't leak listeners into us.
  moduleHooks.clear();

  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;
  // Attach the module singleton so AutonomousAgent's `runtime.hooks` lookup hits
  // the same instance our test inspects.
  (runtime as { hooks?: typeof moduleHooks }).hooks = moduleHooks;

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

async function dispatchAction(
  actionType: string,
  payload?: Record<string, unknown>,
  actionId?: string,
) {
  callbacks.actionCb!({ agentId: "agent_1", actionType, payload, actionId });
  // The dispatcher uses `emitFireAndForget`; flush microtasks + the gateway round-trip.
  await new Promise((r) => setTimeout(r, 25));
}

describe("HookRegistry × handleActionRequest", () => {
  it("fires action_start then action_end on a successful action", async () => {
    const events: string[] = [];
    moduleHooks.register("action_start", (p) => { events.push(`start:${p.actionType}`); });
    moduleHooks.register("action_end", (p) => { events.push(`end:${p.actionType}`); });

    await dispatchAction("vote", { postCid: "QmX", upvote: true });

    expect(events).toEqual(["start:vote", "end:vote"]);
  });

  it("action_end payload includes durationMs and result", async () => {
    const captured: import("../hooks.js").ActionEndPayload[] = [];
    moduleHooks.register("action_end", (p) => { captured.push(p); });

    await dispatchAction("vote", { postCid: "QmX" });

    expect(captured).toHaveLength(1);
    const p = captured[0];
    expect(p.actionType).toBe("vote");
    expect(typeof p.durationMs).toBe("number");
    expect(p.durationMs).toBeGreaterThanOrEqual(0);
    expect(p.result).toEqual({ success: true });
  });

  it("action_error fires on dispatcher exception, action_end does NOT", async () => {
    requestMock.mockImplementationOnce(async () => { throw new Error("gateway down"); });

    let endFired = false;
    let errorMsg: string | null = null;
    moduleHooks.register("action_end", () => { endFired = true; });
    moduleHooks.register("action_error", (p) => { errorMsg = p.error.message; });

    await dispatchAction("vote", { postCid: "QmX" }, "act_1");

    expect(endFired).toBe(false);
    expect(errorMsg).toBe("gateway down");
    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith("act_1", "gateway down");
  });

  it("action_rejected fires (and start/end do NOT) when approval handler denies", async () => {
    moduleHooks.clear();
    const events: string[] = [];
    moduleHooks.register("action_start", () => { events.push("start"); });
    moduleHooks.register("action_end", () => { events.push("end"); });
    moduleHooks.register("action_rejected", (p) => { events.push(`reject:${p.actionType}`); });

    agent.stop();
    agent = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: async () => false,
    });
    agent.start();

    // `vote` is in ON_CHAIN_ACTIONS, so the approval gate runs.
    await dispatchAction("vote", { postCid: "QmX" }, "act_2");

    expect(events).toEqual(["reject:vote"]);
    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith(
      "act_2",
      "Rejected by approval handler",
    );
  });

  it("browse_tools (early-return) still emits action_start and action_end", async () => {
    const events: string[] = [];
    moduleHooks.register("action_start", (p) => { events.push(`start:${p.actionType}`); });
    moduleHooks.register("action_end", (p) => { events.push(`end:${p.actionType}`); });

    await dispatchAction("browse_tools", { category: "discovery" });

    expect(events).toEqual(["start:browse_tools", "end:browse_tools"]);
  });

  it("signal_received fires once per gateway signal with the full payload", async () => {
    const received: unknown[] = [];
    moduleHooks.register("signal_received", (p) => { received.push(p); });

    callbacks.signalCb!({ data: { signalType: "dm_received", senderAddress: "0xS1", messagePreview: "hi" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    const first = received[0] as Record<string, unknown>;
    expect(first.signalType).toBe("dm_received");
    expect(first.senderAddress).toBe("0xS1");
  });
});
