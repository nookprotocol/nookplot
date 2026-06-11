/**
 * Lifecycle and options tests for AutonomousAgent.
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

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;
});

describe("start and stop", () => {
  it("start registers signal + action callbacks", () => {
    const agent = new AutonomousAgent(runtime, { verbose: false, generateResponse: async () => null });
    agent.start();
    expect(runtime.proactive.onSignal).toHaveBeenCalledTimes(1);
    expect(runtime.proactive.onActionRequest).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent — second call does not re-register", () => {
    const agent = new AutonomousAgent(runtime, { verbose: false, generateResponse: async () => null });
    agent.start();
    agent.start();
    expect(runtime.proactive.onSignal).toHaveBeenCalledTimes(1);
  });

  it("stop prevents further signal processing", async () => {
    const handler = vi.fn();
    const agent = new AutonomousAgent(runtime, { verbose: false, onSignal: handler });
    agent.start();
    agent.stop();
    callbacks.signalCb!({ signalType: "dm_received", senderAddress: "0xA" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it("stop prevents further action processing", async () => {
    const agent = new AutonomousAgent(runtime, { verbose: false });
    agent.start();
    agent.stop();
    callbacks.actionCb!({ agentId: "a1", actionType: "follow", payload: { targetAddress: "0xA" } });
    await new Promise((r) => setTimeout(r, 10));
    // After stop, no dispatch should happen
    expect(runtime.connection.request).not.toHaveBeenCalledWith("POST", "/v1/actions/execute", expect.anything());
  });
});

describe("no handler warning", () => {
  it("warns when neither generateResponse nor onSignal provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new AutonomousAgent(runtime, { verbose: true });
    agent.start();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Neither generateResponse nor onSignal"));
    warnSpy.mockRestore();
  });

  it("does not warn when generateResponse provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new AutonomousAgent(runtime, { generateResponse: async () => null });
    agent.start();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when onSignal provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new AutonomousAgent(runtime, { onSignal: async () => {} });
    agent.start();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("approval handler", () => {
  it("approval handler blocks on-chain action when returning false", async () => {
    const agent = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: async () => false,
    });
    agent.start();
    callbacks.actionCb!({ agentId: "a1", actionType: "create_community", actionId: "act_1", payload: { slug: "x", name: "X" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.proactive.rejectDelegatedAction).toHaveBeenCalledWith("act_1", "Rejected by approval handler");
  });

  it("approval handler allows on-chain action when returning true", async () => {
    const agent = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: async () => true,
    });
    agent.start();
    callbacks.actionCb!({ agentId: "a1", actionType: "follow", payload: { targetAddress: "0xT" } });
    await new Promise((r) => setTimeout(r, 20));
    // Should dispatch to gateway after approval
    expect(runtime.connection.request).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({ toolName: "nookplot_follow" }),
    );
  });

  it("approval handler not called for off-chain actions", async () => {
    const approvalFn = vi.fn().mockResolvedValue(false);
    const agent = new AutonomousAgent(runtime, {
      verbose: false,
      onApproval: approvalFn,
    });
    agent.start();
    callbacks.actionCb!({ agentId: "a1", actionType: "reply", payload: { channelId: "ch1" }, suggestedContent: "hi" });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvalFn).not.toHaveBeenCalled();
    // Should still dispatch to gateway (off-chain actions skip approval)
    expect(runtime.connection.request).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({ toolName: "nookplot_reply" }),
    );
  });
});

describe("verbose logging", () => {
  it("verbose=true logs on start", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const agent = new AutonomousAgent(runtime, { verbose: true, onSignal: async () => {} });
    agent.start();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("AutonomousAgent started"));
    logSpy.mockRestore();
  });

  it("verbose=false does not log on start", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const agent = new AutonomousAgent(runtime, { verbose: false, onSignal: async () => {} });
    agent.start();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("AutonomousAgent started"));
    logSpy.mockRestore();
  });
});

describe("onSignal vs generateResponse", () => {
  it("onSignal handler receives signal data and runtime", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const agent = new AutonomousAgent(runtime, { verbose: false, onSignal: handler });
    agent.start();
    const signal = { signalType: "dm_received", senderAddress: "0xSENDER", messagePreview: "hello" };
    callbacks.signalCb!(signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ signalType: "dm_received" }), runtime);
  });

  it("onSignal bypasses generateResponse", async () => {
    const genRes = vi.fn();
    const handler = vi.fn().mockResolvedValue(undefined);
    const agent = new AutonomousAgent(runtime, { verbose: false, onSignal: handler, generateResponse: genRes });
    agent.start();
    callbacks.signalCb!({ signalType: "dm_received", senderAddress: "0xA" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalled();
    expect(genRes).not.toHaveBeenCalled();
  });
});
