import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelBroadcaster } from "./channelBroadcaster.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Mock dependencies
// ---------------------------------------------------------------------------

function createMockMessageBus() {
  const patternHandlers = new Map<string, Function>();
  return {
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribePattern: vi.fn().mockImplementation((prefix: string, handler: Function) => {
      patternHandlers.set(prefix, handler);
      return () => { patternHandlers.delete(prefix); };
    }),
    unsubscribe: vi.fn(),
    shutdown: vi.fn(),
    // Test helper: trigger the pattern handler
    _triggerPattern: (channel: string, message: any) => {
      for (const [prefix, handler] of patternHandlers) {
        if (channel.startsWith(prefix)) {
          handler(channel, message);
        }
      }
    },
  };
}

function createMockEventBroadcaster() {
  return {
    broadcast: vi.fn(),
  };
}

function createMockChannelService() {
  return {
    isMember: vi.fn().mockResolvedValue(true),
  };
}

function makeChannelMessage(fromAgentId?: string) {
  return {
    type: "channel_message",
    timestamp: new Date().toISOString(),
    data: {
      channelId: "ch_001",
      content: "Hello",
      ...(fromAgentId ? { fromAgentId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
//  subscribe
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — subscribe", () => {
  it("subscribes member to channel", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    const result = await cb.subscribe("agt_1", "ch_001");

    expect(result).toBe(true);
    expect(channelSvc.isMember).toHaveBeenCalledWith("ch_001", "agt_1");
  });

  it("rejects non-member", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();
    channelSvc.isMember.mockResolvedValue(false);

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    const result = await cb.subscribe("agt_1", "ch_001");

    expect(result).toBe(false);
  });

  it("enforces max 50 subscriptions per agent", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);

    // Subscribe to 50 channels
    for (let i = 0; i < 50; i++) {
      await cb.subscribe("agt_1", `ch_${i}`);
    }

    // 51st should be rejected
    const result = await cb.subscribe("agt_1", "ch_50");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Fan-out via message bus
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — fan-out", () => {
  it("broadcasts to subscribed agents", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_1", "ch_001");
    await cb.subscribe("agt_2", "ch_001");

    // Simulate bus message
    bus._triggerPattern("ch:ch_001", makeChannelMessage());

    expect(broadcaster.broadcast).toHaveBeenCalledTimes(2);
    expect(broadcaster.broadcast).toHaveBeenCalledWith("agt_1", expect.objectContaining({ type: "channel_message" }));
    expect(broadcaster.broadcast).toHaveBeenCalledWith("agt_2", expect.objectContaining({ type: "channel_message" }));
  });

  it("does not echo back to sender", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_sender", "ch_001");
    await cb.subscribe("agt_receiver", "ch_001");

    bus._triggerPattern("ch:ch_001", makeChannelMessage("agt_sender"));

    // Only agt_receiver should receive (not agt_sender)
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcast).toHaveBeenCalledWith("agt_receiver", expect.anything());
  });

  it("does not broadcast to unsubscribed agents", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    // No subscriptions

    bus._triggerPattern("ch:ch_001", makeChannelMessage());

    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  unsubscribe
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — unsubscribe", () => {
  it("stops delivery after unsubscribe", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_1", "ch_001");

    cb.unsubscribe("agt_1", "ch_001");

    bus._triggerPattern("ch:ch_001", makeChannelMessage());

    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  removeAgent
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — removeAgent", () => {
  it("removes all subscriptions for agent", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_1", "ch_001");
    await cb.subscribe("agt_1", "ch_002");

    cb.removeAgent("agt_1");

    expect(cb.getAgentSubscriptions("agt_1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  getAgentSubscriptions
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — getAgentSubscriptions", () => {
  it("returns list of subscribed channels", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_1", "ch_001");
    await cb.subscribe("agt_1", "ch_002");

    const subs = cb.getAgentSubscriptions("agt_1");
    expect(subs).toHaveLength(2);
    expect(subs).toContain("ch_001");
    expect(subs).toContain("ch_002");
  });

  it("returns empty for unknown agent", () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    expect(cb.getAgentSubscriptions("agt_unknown")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  shutdown
// ---------------------------------------------------------------------------

describe("ChannelBroadcaster — shutdown", () => {
  it("clears all subscriptions", async () => {
    const bus = createMockMessageBus();
    const broadcaster = createMockEventBroadcaster();
    const channelSvc = createMockChannelService();

    const cb = new ChannelBroadcaster(bus as any, broadcaster as any, channelSvc as any);
    await cb.subscribe("agt_1", "ch_001");

    cb.shutdown();

    bus._triggerPattern("ch:ch_001", makeChannelMessage());
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(cb.getAgentSubscriptions("agt_1")).toHaveLength(0);
  });
});
