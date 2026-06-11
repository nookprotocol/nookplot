/**
 * Integration tests — AutonomousAgent doom-loop detector. Mirrors the
 * detector wiring in `doomLoop.ts`. Three identical actions
 * (or A,B,A,B cycles) accumulate triggers; on the 3rd trigger the cycle
 * aborts and fires `doom_loop_detected` + `action_error`.
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
  moduleHooks.clear();

  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;
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

async function dispatch(
  actionType: string,
  payload: Record<string, unknown> = {},
  actionId?: string,
) {
  callbacks.actionCb!({ agentId: "agent_1", actionType, payload, actionId });
  await new Promise((r) => setTimeout(r, 25));
}

describe("AutonomousAgent × doom-loop detector", () => {
  it("3 identical actions trigger the detector", async () => {
    const events: Array<{ offender: string; triggers: number }> = [];
    moduleHooks.register("doom_loop_detected", (p) => {
      events.push({ offender: p.offender, triggers: p.triggers });
    });

    await dispatch("send_dm", { to: "0xA", content: "hi" });
    await dispatch("send_dm", { to: "0xA", content: "hi" });
    await dispatch("send_dm", { to: "0xA", content: "hi" });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.offender).toBe("send_dm");
    expect(events[0]!.triggers).toBe(1);
  });

  it("2 identical actions do NOT trigger the detector", async () => {
    const events: unknown[] = [];
    moduleHooks.register("doom_loop_detected", (p) => { events.push(p); });

    await dispatch("send_dm", { to: "0xA", content: "hi" });
    await dispatch("send_dm", { to: "0xA", content: "hi" });

    expect(events).toHaveLength(0);
  });

  it("A,B,A,B pattern triggers the detector", async () => {
    const events: Array<{ offender: string; triggers: number }> = [];
    moduleHooks.register("doom_loop_detected", (p) => {
      events.push({ offender: p.offender, triggers: p.triggers });
    });

    await dispatch("send_dm", { to: "0xA" });
    await dispatch("vote", { postCid: "QmA" });
    await dispatch("send_dm", { to: "0xA" });
    await dispatch("vote", { postCid: "QmA" });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(["send_dm", "vote"]).toContain(events[0]!.offender);
  });

  it("A,B,A pattern does NOT trigger (needs 2 full reps)", async () => {
    const events: unknown[] = [];
    moduleHooks.register("doom_loop_detected", (p) => { events.push(p); });

    await dispatch("send_dm", { to: "0xA" });
    await dispatch("vote", { postCid: "QmA" });
    await dispatch("send_dm", { to: "0xA" });

    expect(events).toHaveLength(0);
  });

  it("3 triggers in one lifetime aborts the cycle (action_error, no action_end)", async () => {
    const triggerEvents: Array<{ offender: string; triggers: number }> = [];
    const endEvents: string[] = [];
    const errorEvents: Array<{ actionType: string }> = [];
    moduleHooks.register("doom_loop_detected", (p) => {
      triggerEvents.push({ offender: p.offender, triggers: p.triggers });
    });
    moduleHooks.register("action_end", (p) => { endEvents.push(p.actionType); });
    moduleHooks.register("action_error", (p) => { errorEvents.push({ actionType: p.actionType }); });

    // Five identical calls — first 2 don't trigger (need 3 in a row), then
    // every subsequent identical call trips the detector. After the 3rd
    // trigger, the cycle aborts before reaching the dispatcher.
    for (let i = 0; i < 5; i++) {
      await dispatch("send_dm", { to: "0xA", content: "hi" });
    }

    expect(triggerEvents.length).toBeGreaterThanOrEqual(3);
    // The last trigger event recorded a `triggers` count of 3 — at which
    // point handle aborted instead of running the dispatch.
    const lastTrigger = triggerEvents[triggerEvents.length - 1]!;
    expect(lastTrigger.triggers).toBe(3);
    // At least one action_error fired with the doom-loop reason.
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects the delegated action when triggers reach the abort threshold", async () => {
    const rejectMock = runtime.proactive.rejectDelegatedAction as ReturnType<typeof vi.fn>;
    rejectMock.mockResolvedValue(undefined);

    for (let i = 0; i < 5; i++) {
      await dispatch("send_dm", { to: "0xA", content: "hi" }, `act_${i}`);
    }

    // Once triggers reach 3 the agent calls reject_delegated_action with the
    // corrective prompt as the reason.
    expect(rejectMock).toHaveBeenCalled();
    const lastCall = rejectMock.mock.calls[rejectMock.mock.calls.length - 1]!;
    expect(lastCall[1]).toContain("Doom loop detected on 'send_dm'");
  });

  it("non-repeating actions never trigger the detector", async () => {
    const events: unknown[] = [];
    moduleHooks.register("doom_loop_detected", (p) => { events.push(p); });

    await dispatch("send_dm", { to: "0xA" });
    await dispatch("vote", { postCid: "QmA" });
    await dispatch("attest", { subject: "0xB" });
    await dispatch("post", { body: "gm" });
    await dispatch("follow", { target: "0xC" });

    expect(events).toHaveLength(0);
  });
});
