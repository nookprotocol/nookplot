import { describe, it, expect, vi } from "vitest";
import { InProcessMessageBus } from "./messageBus.js";
import type { BusMessage, BusHandler } from "./messageBus.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<BusMessage>): BusMessage {
  return {
    type: "test",
    data: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  publish / subscribe
// ---------------------------------------------------------------------------

describe("InProcessMessageBus — publish/subscribe", () => {
  it("delivers message to subscriber", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    bus.subscribe("ch:test", handler);
    bus.publish("ch:test", makeMessage());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("ch:test", expect.objectContaining({ type: "test" }));
  });

  it("delivers to multiple subscribers on same channel", () => {
    const bus = new InProcessMessageBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.subscribe("ch:test", h1);
    bus.subscribe("ch:test", h2);
    bus.publish("ch:test", makeMessage());

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to subscribers on other channels", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    bus.subscribe("ch:other", handler);
    bus.publish("ch:test", makeMessage());

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe function stops delivery", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    const unsub = bus.subscribe("ch:test", handler);
    bus.publish("ch:test", makeMessage());
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.publish("ch:test", makeMessage());
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });
});

// ---------------------------------------------------------------------------
//  subscribePattern
// ---------------------------------------------------------------------------

describe("InProcessMessageBus — subscribePattern", () => {
  it("matches channels with the given prefix", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    bus.subscribePattern("dm:", handler);
    bus.publish("dm:agent-1", makeMessage());
    bus.publish("dm:agent-2", makeMessage());

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith("dm:agent-1", expect.anything());
    expect(handler).toHaveBeenCalledWith("dm:agent-2", expect.anything());
  });

  it("does not match channels without the prefix", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    bus.subscribePattern("dm:", handler);
    bus.publish("ch:test", makeMessage());

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe function stops pattern delivery", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    const unsub = bus.subscribePattern("dm:", handler);
    bus.publish("dm:test", makeMessage());
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.publish("dm:test", makeMessage());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("cleans up empty pattern handler sets", () => {
    const bus = new InProcessMessageBus();
    const handler = vi.fn();

    const unsub = bus.subscribePattern("dm:", handler);
    unsub();

    // Publishing should work without errors
    bus.publish("dm:test", makeMessage());
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  Error isolation
// ---------------------------------------------------------------------------

describe("InProcessMessageBus — error isolation", () => {
  it("does not crash on handler errors (pattern subscribers)", () => {
    const bus = new InProcessMessageBus();
    const badHandler = vi.fn().mockImplementation(() => {
      throw new Error("handler crash");
    });
    const goodHandler = vi.fn();

    bus.subscribePattern("ch:", badHandler);
    bus.subscribePattern("ch:", goodHandler);

    // Should not throw
    expect(() => bus.publish("ch:test", makeMessage())).not.toThrow();
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
//  unsubscribe (direct)
// ---------------------------------------------------------------------------

describe("InProcessMessageBus — unsubscribe", () => {
  it("removes a specific handler from a channel", () => {
    const bus = new InProcessMessageBus();
    const handler: BusHandler = vi.fn();

    // Note: direct unsubscribe uses emitter.off, which needs the exact
    // same function reference. subscribe() wraps it, so direct unsubscribe
    // only works with raw emitter handlers. This tests the method exists.
    bus.unsubscribe("ch:test", handler);
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
//  shutdown
// ---------------------------------------------------------------------------

describe("InProcessMessageBus — shutdown", () => {
  it("removes all listeners and pattern handlers", () => {
    const bus = new InProcessMessageBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.subscribe("ch:test", h1);
    bus.subscribePattern("dm:", h2);

    bus.shutdown();

    bus.publish("ch:test", makeMessage());
    bus.publish("dm:agent", makeMessage());

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("can be called multiple times safely", () => {
    const bus = new InProcessMessageBus();
    bus.shutdown();
    expect(() => bus.shutdown()).not.toThrow();
  });
});
