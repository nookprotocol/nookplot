/**
 * Signal dedup tests for AutonomousAgent.
 *
 * Tests that duplicate signals are suppressed within the 1-hour dedup window.
 * Dedup keys are tested indirectly via the public start() → signal callback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, type CapturedCallbacks } from "./helpers/mockRuntime.js";
import { AutonomousAgent } from "../autonomous.js";
import type { NookplotRuntime } from "../index.js";

vi.mock("../signing.js", () => ({
  prepareSignRelay: vi.fn().mockResolvedValue({ txHash: "0xRELAY" }),
  signForwardRequest: vi.fn(),
}));

let runtime: NookplotRuntime;
let callbacks: CapturedCallbacks;
let handler: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;
  handler = vi.fn().mockResolvedValue(undefined);
  const agent = new AutonomousAgent(runtime, { verbose: false, onSignal: handler });
  agent.start();
});

async function sendSignal(signal: Record<string, unknown>) {
  callbacks.signalCb!(signal);
  await new Promise((r) => setTimeout(r, 10));
}

describe("signal dedup", () => {
  it("dm_received deduplicates on senderAddress", async () => {
    const signal = { signalType: "dm_received", senderAddress: "0xSENDER" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("dm_received from different senders are both processed", async () => {
    await sendSignal({ signalType: "dm_received", senderAddress: "0xA" });
    await sendSignal({ signalType: "dm_received", senderAddress: "0xB" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("new_follower deduplicates on senderAddress", async () => {
    const signal = { signalType: "new_follower", senderAddress: "0xFOLLOWER" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("channel_message deduplicates on channelId + sender + preview", async () => {
    const signal = { signalType: "channel_message", channelId: "ch1", senderAddress: "0xA", messagePreview: "hello" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("channel_message with different preview is not deduplicated", async () => {
    await sendSignal({ signalType: "channel_message", channelId: "ch1", senderAddress: "0xA", messagePreview: "hello" });
    await sendSignal({ signalType: "channel_message", channelId: "ch1", senderAddress: "0xA", messagePreview: "world" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("files_committed deduplicates on commitId", async () => {
    const signal = { signalType: "files_committed", commitId: "abc123" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("agreement_created deduplicates on agreementId", async () => {
    const signal = { signalType: "agreement_created", agreementId: "42" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("work_delivered deduplicates on agreementId", async () => {
    const signal = { signalType: "work_delivered", agreementId: "42" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("team_invitation deduplicates on invitationId", async () => {
    const signal = { signalType: "team_invitation", invitationId: "inv_1" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("webhook_received is never deduplicated (timestamp-based key)", async () => {
    const signal = { signalType: "webhook_received", source: "github" };
    await sendSignal(signal);
    // Date.now() changes between calls so each is unique
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("bounty_application_submitted deduplicates on applicationId", async () => {
    const signal = { signalType: "bounty_application_submitted", applicationId: "app_1" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("guild_opportunity deduplicates on guildId + address", async () => {
    const signal = { signalType: "guild_opportunity", guildId: "5", senderAddress: "0xA" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("task_completed deduplicates on taskId", async () => {
    const signal = { signalType: "task_completed", taskId: "task_1" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unknown signal deduplicates on type + address + channel + postCid", async () => {
    const signal = { signalType: "some_new_signal", senderAddress: "0xA", channelId: "ch1", postCid: "Qm1" };
    await sendSignal(signal);
    await sendSignal(signal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("different signal types are not deduplicated against each other", async () => {
    await sendSignal({ signalType: "dm_received", senderAddress: "0xA" });
    await sendSignal({ signalType: "new_follower", senderAddress: "0xA" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("address dedup is case-insensitive", async () => {
    await sendSignal({ signalType: "dm_received", senderAddress: "0xAbCdEf" });
    await sendSignal({ signalType: "dm_received", senderAddress: "0xabcdef" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
