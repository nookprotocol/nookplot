/**
 * Coverage for the Open-bounty signal-map entries — wired to close the
 * autonomous-agent flow gap where these signals had no reachable action.
 *
 * The contract these tests enforce: the 4 Open-mode actions that previously
 * weren't reachable from any signal (approve_open_submission,
 * top_up_open_bounty, close_open_bounty, sweep_worker_payout) MUST be in
 * the signal context for the appropriate Open-mode signal. Without this, an
 * autonomous CLI agent acting as a Open-mode creator or post-defer worker is
 * blind to the on-chain events that should drive it.
 */

import { describe, it, expect } from "vitest";
import { getAvailableActions } from "../autonomous.js";
import { SIGNAL_CONTEXT_ACTIONS } from "../signalActionMap.js";

describe("Open-bounty signal map", () => {
  it("bounty_open_submission_received surfaces approve_open_submission as the primary creator action", () => {
    const ctx = SIGNAL_CONTEXT_ACTIONS["bounty_open_submission_received"];
    expect(ctx).toBeDefined();
    // Approve is the primary; without it the creator's autonomous loop has no on-chain path forward.
    expect(ctx).toContain("approve_open_submission");
    // Hedges: top-up if interest is heavy, close if it's poor.
    expect(ctx).toContain("top_up_open_bounty");
    expect(ctx).toContain("close_open_bounty");
    // Soft action: ack the submitter.
    expect(ctx).toContain("send_dm");
  });

  it("bounty_open_payout_deferred surfaces sweep_worker_payout — urgent + only useful action", () => {
    const ctx = SIGNAL_CONTEXT_ACTIONS["bounty_open_payout_deferred"];
    expect(ctx).toBeDefined();
    // The whole reason this signal exists. Without sweep_worker_payout here,
    // a worker whose payout soft-failed has no autonomous-loop path to recover
    // funds from pendingWorkerPayouts.
    expect(ctx).toContain("sweep_worker_payout");
  });

  it("bounty_open_approved (happy path) is distinct from bounty_open_payout_deferred", () => {
    const happy = SIGNAL_CONTEXT_ACTIONS["bounty_open_approved"];
    const deferred = SIGNAL_CONTEXT_ACTIONS["bounty_open_payout_deferred"];
    expect(happy).toBeDefined();
    expect(deferred).toBeDefined();
    // Happy path: nothing on-chain to do (already paid). Soft "thanks" via DM only.
    expect(happy).not.toContain("sweep_worker_payout");
    // Deferred path: sweep is the whole point. If the happy-path signal ever
    // includes sweep, an autonomous worker would call it when funds already
    // arrived (revert) — design must keep these signals distinct.
    expect(happy).toContain("send_dm");
  });

  it("getAvailableActions returns the Open-mode actions for each Open-mode signal (LLM-reachable contract)", () => {
    // NON-NEGOTIABLE: "If an action isn't in getAvailableActions(),
    // the LLM will never suggest it — the agent literally cannot use it." This
    // is the closing-the-loop contract for the agent-flow gap fix.
    for (const action of [
      "approve_open_submission",
      "top_up_open_bounty",
      "close_open_bounty",
    ]) {
      expect(getAvailableActions("bounty_open_submission_received")).toContain(action);
    }
    expect(getAvailableActions("bounty_open_payout_deferred")).toContain("sweep_worker_payout");
  });

  it("bounty_open_slots_low maps to top-up/close", () => {
    // The action map is pre-wired so the LLM has the action set ready for this
    // signal even where server-side dispatch is handled separately.
    const ctx = SIGNAL_CONTEXT_ACTIONS["bounty_open_slots_low"];
    expect(ctx).toBeDefined();
    expect(ctx).toContain("top_up_open_bounty");
    expect(ctx).toContain("close_open_bounty");
  });
});
