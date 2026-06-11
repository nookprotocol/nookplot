/**
 * HookRegistry — unit tests.
 *
 * Covers: registration order, prepend, throwing-callback isolation,
 * deregister + disposer, async emit semantics, fire-and-forget, clear,
 * and the parity-fixture key-shape contract.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  HookRegistry,
  hooks as moduleSingleton,
  type HookEvent,
  type HookEventMap,
} from "../hooks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "hook-events.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  events: Record<string, { required_keys: string[]; key_types: Record<string, string> }>;
};

describe("HookRegistry", () => {
  it("preserves insertion order on emit", async () => {
    const reg = new HookRegistry();
    const calls: number[] = [];
    reg.register("action_start", () => { calls.push(1); });
    reg.register("action_start", () => { calls.push(2); });
    reg.register("action_start", () => { calls.push(3); });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual([1, 2, 3]);
  });

  it("prepend: true puts callback at the front", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    reg.register("action_start", () => { calls.push("b"); });
    reg.register("action_start", () => { calls.push("a"); }, { prepend: true });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual(["a", "b"]);
  });

  it("one throwing callback does not prevent others", async () => {
    const reg = new HookRegistry();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let counted = 0;
    reg.register("action_start", () => { throw new Error("boom"); });
    reg.register("action_start", () => { counted += 1; });
    reg.register("action_start", async () => { counted += 1; });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(counted).toBe(2);
    errSpy.mockRestore();
  });

  it("logs callback errors via console.error (observability)", async () => {
    const reg = new HookRegistry();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reg.register("action_start", () => { throw new Error("boom"); });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = errSpy.mock.calls[0] ?? [];
    expect(String(msg)).toContain("action_start");
    expect((err as Error).message).toBe("boom");
    errSpy.mockRestore();
  });

  it("deregister removes only the matching callback", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    const cbA = () => { calls.push("a"); };
    const cbB = () => { calls.push("b"); };
    reg.register("action_start", cbA);
    reg.register("action_start", cbB);
    reg.deregister("action_start", cbA);
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual(["b"]);
    expect(reg.count("action_start")).toBe(1);
  });

  it("disposer returned by register() removes only that callback", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    const dispose = reg.register("action_start", () => { calls.push("a"); });
    reg.register("action_start", () => { calls.push("b"); });
    dispose();
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual(["b"]);
  });

  it("emit awaits async callbacks before resolving", async () => {
    const reg = new HookRegistry();
    let resolved = false;
    reg.register("action_start", async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolved = true;
    });
    const t0 = Date.now();
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(resolved).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it("emitFireAndForget returns synchronously even with async callbacks", async () => {
    const reg = new HookRegistry();
    let resolved = false;
    reg.register("action_start", async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolved = true;
    });
    reg.emitFireAndForget("action_start", { actionType: "x", args: {} });
    expect(resolved).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  it("sync and async callbacks coexist on the same event", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    reg.register("action_start", () => { calls.push("sync1"); });
    reg.register("action_start", async () => { calls.push("async1"); });
    reg.register("action_start", () => { calls.push("sync2"); });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls.sort()).toEqual(["async1", "sync1", "sync2"]);
  });

  it("clear(event) removes only that event's subscribers", async () => {
    const reg = new HookRegistry();
    let a = 0; let b = 0;
    reg.register("action_start", () => { a++; });
    reg.register("action_end", () => { b++; });
    reg.clear("action_start");
    await reg.emit("action_start", { actionType: "x", args: {} });
    await reg.emit("action_end", { actionType: "x", args: {}, result: null, durationMs: 0 });
    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it("clear() removes all events", () => {
    const reg = new HookRegistry();
    reg.register("action_start", () => {});
    reg.register("action_end", () => {});
    reg.clear();
    expect(reg.count("action_start")).toBe(0);
    expect(reg.count("action_end")).toBe(0);
  });

  it("snapshot semantics: a callback that registers another mid-emit doesn't fire it this turn", async () => {
    const reg = new HookRegistry();
    const calls: string[] = [];
    reg.register("action_start", () => {
      calls.push("first");
      reg.register("action_start", () => { calls.push("late"); });
    });
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual(["first"]);
    await reg.emit("action_start", { actionType: "x", args: {} });
    expect(calls).toEqual(["first", "first", "late"]);
  });

  it("module singleton is a usable HookRegistry", () => {
    expect(moduleSingleton).toBeInstanceOf(HookRegistry);
  });

  describe("parity fixture", () => {
    it("declares the same set of events as HookEventMap", () => {
      // Sanity check: every event mentioned in the TS HookEvent union must
      // have an entry in the fixture, otherwise the Py side would test a
      // shape the TS side doesn't agree with.
      const tsEvents: HookEvent[] = [
        "action_start", "action_end", "action_error", "action_rejected",
        "signal_received", "tool_input", "tool_output",
        "chat_turn_complete", "memory_compacted", "compaction_failed",
        "doom_loop_detected",
      ];
      for (const evt of tsEvents) {
        expect(fixture.events[evt], `fixture missing event: ${evt}`).toBeDefined();
      }
    });

    it("a representative payload for each event satisfies its required keys", async () => {
      const samples: { [E in HookEvent]: HookEventMap[E] } = {
        action_start: { actionType: "vote", args: { postCid: "QmX" } },
        action_end: { actionType: "vote", args: {}, result: { txHash: "0x1" }, durationMs: 12 },
        action_error: { actionType: "vote", args: {}, error: new Error("nope"), durationMs: 5 },
        action_rejected: { actionType: "vote", args: {}, reason: "denied" },
        signal_received: { signalType: "dm_received" },
        tool_input: { toolName: "send_dm", args: { to: "0x1", content: "hi" } },
        tool_output: { toolName: "send_dm", args: {}, result: { ok: true } },
        chat_turn_complete: {
          sender: "alice", platform: "telegram", message: "hi", response: "hello",
          toolsUsed: false, toolCallCount: 0,
        },
        memory_compacted: {
          sessionId: "sess1", compactionNumber: 1, messagesCompacted: 8, summaryTokens: 256,
        },
        compaction_failed: {
          sessionId: "sess1", error: new Error("LLM down"), attemptedMessages: 12,
        },
        doom_loop_detected: {
          offender: "send_dm", triggers: 1, actionType: "send_dm",
        },
      };
      for (const [evt, payload] of Object.entries(samples)) {
        const spec = fixture.events[evt];
        for (const key of spec.required_keys) {
          expect((payload as Record<string, unknown>)[key], `${evt}.${key}`).toBeDefined();
        }
      }
    });
  });
});
