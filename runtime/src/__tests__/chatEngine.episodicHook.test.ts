/**
 * ChatEngine × episodic-memory hook regression test.
 *
 * This refactor moved the inline `runtime.memory.storeMemory("episodic", …)` call
 * out of `chatEngine.ts` and into `installEpisodicMemoryHook()`, fired via
 * the `chat_turn_complete` event. These tests prove:
 *   - the hook fires once per turn, with the documented payload shape
 *   - `installEpisodicMemoryHook(runtime)` reproduces the prior write
 *   - chat() returns BEFORE the memory write resolves (fire-and-forget)
 *   - opt-out (no auto-install + no manual install) means no memory write
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

vi.mock("../actionCatalog.js", () => ({
  ACTION_CATALOG: {},
  formatActionsForPrompt: vi.fn().mockReturnValue(""),
  getCategoryListing: vi.fn().mockReturnValue([]),
  getToolsInCategory: vi.fn().mockReturnValue([]),
}));

vi.mock("../signalActionMap.js", () => ({ CORE_ACTIONS: [] }));
vi.mock("../contentSafety.js", () => ({
  sanitizeForPrompt: vi.fn((s: string) => s),
  UNTRUSTED_CONTENT_INSTRUCTION: "",
}));

import { ChatEngine } from "../chat/chatEngine.js";
import { HookRegistry } from "../hooks.js";
import { installEpisodicMemoryHook } from "../episodicMemoryHook.js";
import type { ChatTurnCompletePayload } from "../hooks.js";

function makeRuntimeMock(opts?: { storeMemoryImpl?: () => Promise<unknown> }) {
  const hooks = new HookRegistry();
  const storeMemory = vi.fn(opts?.storeMemoryImpl ?? (() => Promise.resolve({ id: "mem_1" })));
  return {
    runtime: {
      hooks,
      connection: {
        request: vi.fn().mockResolvedValue({}),
      },
      memory: {
        storeMemory,
        recall: vi.fn().mockResolvedValue([]),
      },
      economy: {
        getBalance: vi.fn().mockResolvedValue({
          credits: { available: 1000, total: 1000, pending: 0 },
        }),
        inference: vi.fn().mockResolvedValue({ content: "hello back" }),
      },
      events: { subscribe: vi.fn() },
      identity: { getAddress: vi.fn().mockReturnValue("0xtest") },
    },
    hooks,
    storeMemory,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chatEngine fires chat_turn_complete", () => {
  it("emits exactly once per chat() call with the documented payload shape", async () => {
    const { runtime, hooks } = makeRuntimeMock();
    const captured: ChatTurnCompletePayload[] = [];
    hooks.register("chat_turn_complete", (p) => { captured.push(p); });

    const engine = new ChatEngine(runtime as never, {
      generateResponse: async () => "hi there",
      enableMemory: true,
      enableTools: false,
    });
    await engine.chat("hello", { platform: "telegram", senderName: "alice", senderId: "u1" });
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(1);
    const p = captured[0];
    expect(p.sender).toBe("alice");
    expect(p.platform).toBe("telegram");
    expect(p.message).toBe("hello");
    expect(p.response).toBe("hi there");
    expect(p.toolsUsed).toBe(false);
    expect(p.toolCallCount).toBe(0);
    expect(p.senderId).toBe("u1");
    expect(p.enableMemory).toBe(true);
    expect(p.agentName).toBe("Agent");
  });

  it("installEpisodicMemoryHook calls storeMemory with the prior payload shape", async () => {
    const { runtime, hooks, storeMemory } = makeRuntimeMock();
    installEpisodicMemoryHook(runtime as never, { hooks });

    const engine = new ChatEngine(runtime as never, {
      generateResponse: async () => "response body",
      enableMemory: true,
      enableTools: false,
    });
    await engine.chat("message body", {
      platform: "telegram", senderName: "alice", senderId: "u1", channelId: "ch1",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(storeMemory).toHaveBeenCalledTimes(1);
    const args = storeMemory.mock.calls[0] as unknown as [string, string, { tags: string[]; metadata: Record<string, unknown> }];
    const tier = args[0];
    const content = args[1];
    const options = args[2];
    expect(tier).toBe("episodic");
    expect(content).toBe("[telegram] alice: message body\nAgent: response body");
    expect(options.tags).toContain("conversation");
    expect(options.tags).toContain("telegram");
    expect(options.metadata.platform).toBe("telegram");
    expect(options.metadata.senderId).toBe("u1");
    expect(options.metadata.senderName).toBe("alice");
    expect(options.metadata.channelId).toBe("ch1");
    expect(options.metadata.toolsUsed).toBe(false);
    expect(options.metadata.toolCallCount).toBe(0);
    expect(options.metadata.messageLength).toBe("message body".length);
    expect(options.metadata.responseLength).toBe("response body".length);
    expect(typeof options.metadata.timestamp).toBe("string");
  });

  it("WITHOUT the hook installed, no memory write happens", async () => {
    const { runtime, storeMemory } = makeRuntimeMock();
    // No installEpisodicMemoryHook call → opt-out semantics.

    const engine = new ChatEngine(runtime as never, {
      generateResponse: async () => "response",
      enableMemory: true,
      enableTools: false,
    });
    await engine.chat("hello", { platform: "terminal" });
    await new Promise((r) => setTimeout(r, 5));

    expect(storeMemory).not.toHaveBeenCalled();
  });

  it("chat() returns BEFORE the memory write resolves (fire-and-forget)", async () => {
    let memoryResolved = false;
    const { runtime, hooks } = makeRuntimeMock({
      // never resolves until we say so
      storeMemoryImpl: () => new Promise<unknown>((res) => {
        setTimeout(() => { memoryResolved = true; res({ id: "mem_late" }); }, 200);
      }),
    });
    installEpisodicMemoryHook(runtime as never, { hooks });

    const engine = new ChatEngine(runtime as never, {
      generateResponse: async () => "hi",
      enableMemory: true,
      enableTools: false,
    });

    const t0 = Date.now();
    const reply = await engine.chat("hey", { platform: "terminal" });
    const elapsed = Date.now() - t0;

    expect(reply).toBe("hi");
    expect(memoryResolved).toBe(false);
    expect(elapsed).toBeLessThan(150);
  });

  it("enableMemory: false suppresses the storeMemory call", async () => {
    const { runtime, hooks, storeMemory } = makeRuntimeMock();
    installEpisodicMemoryHook(runtime as never, { hooks });

    const engine = new ChatEngine(runtime as never, {
      generateResponse: async () => "hi",
      enableMemory: false,
      enableTools: false,
    });
    await engine.chat("hello", { platform: "terminal" });
    await new Promise((r) => setTimeout(r, 5));

    expect(storeMemory).not.toHaveBeenCalled();
  });
});
