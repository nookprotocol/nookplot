import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs (ChatEngine reads soul documents)
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn(),
}));

// Mock action catalog
vi.mock("../actionCatalog.js", () => ({
  ACTION_CATALOG: {},
  formatActionsForPrompt: vi.fn().mockReturnValue(""),
  getCategoryListing: vi.fn().mockReturnValue([]),
  getToolsInCategory: vi.fn().mockReturnValue([]),
}));

vi.mock("../signalActionMap.js", () => ({
  CORE_ACTIONS: [],
}));

vi.mock("../contentSafety.js", () => ({
  sanitizeForPrompt: vi.fn((s: string) => s),
  UNTRUSTED_CONTENT_INSTRUCTION: "",
}));

import { ChatEngine } from "../chat/chatEngine.js";
import type { IntelligenceStatus } from "../chat/chatEngine.js";

// ── Mock runtime ──────────────────────────────────────────

function createMockRuntime(overrides?: {
  credits?: number;
  byokProviders?: string[];
  plan?: string;
  inferenceTokensRemaining?: number;
  requestFails?: boolean;
}) {
  const opts = {
    credits: 0,
    byokProviders: [] as string[],
    plan: "free",
    inferenceTokensRemaining: 0,
    requestFails: false,
    ...overrides,
  };

  return {
    connection: {
      request: vi.fn().mockImplementation((method: string, path: string) => {
        if (opts.requestFails) throw new Error("Connection failed");

        if (path === "/v1/byok") {
          return { providers: opts.byokProviders.map((p: string) => ({ provider: p })) };
        }
        if (path === "/v1/subscriptions/status") {
          return { plan: opts.plan, inferenceTokensRemaining: opts.inferenceTokensRemaining };
        }
        return {};
      }),
    },
    memory: {
      storeMemory: vi.fn().mockResolvedValue({ id: "mem_1" }),
      recall: vi.fn().mockResolvedValue([]),
    },
    economy: {
      getBalance: vi.fn().mockResolvedValue({
        credits: { available: opts.credits, total: opts.credits, pending: 0 },
      }),
      inference: vi.fn(),
    },
    events: { subscribe: vi.fn() },
    identity: { getAddress: vi.fn().mockReturnValue("0xtest") },
  } as any;
}

// ── checkIntelligence tests ───────────────────────────────

describe("ChatEngine.checkIntelligence", () => {
  describe("source: local (custom callback)", () => {
    it("detects generateResponse callback as 'local' source", async () => {
      const runtime = createMockRuntime();
      const engine = new ChatEngine(runtime, {
        generateResponse: async () => "Hello from local",
      });

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(true);
      expect(status.source).toBe("local");
      expect(status.messages.some((m: string) => m.includes("custom callback"))).toBe(true);
    });

    it("does not call getBalance when local callback is set", async () => {
      const runtime = createMockRuntime();
      const engine = new ChatEngine(runtime, {
        generateResponse: async () => "local",
      });

      await engine.checkIntelligence();

      // getBalance should NOT be called — the local path returns early
      expect(runtime.economy.getBalance).not.toHaveBeenCalled();
    });

    it("reports zero credit cost for local callback", async () => {
      const runtime = createMockRuntime();
      const engine = new ChatEngine(runtime, {
        generateResponse: async () => "local",
      });

      const status = await engine.checkIntelligence();

      expect(status.messages.some((m: string) => m.toLowerCase().includes("zero"))).toBe(true);
    });

    it("includes model name in local source status", async () => {
      const runtime = createMockRuntime();
      const engine = new ChatEngine(runtime, {
        generateResponse: async () => "ok",
        model: "llama3:70b",
      });

      const status = await engine.checkIntelligence();

      expect(status.model).toBe("llama3:70b");
    });
  });

  describe("source: subscription", () => {
    it("detects active subscription with tokens", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "builder",
        inferenceTokensRemaining: 100000,
      });
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(true);
      expect(status.source).toBe("subscription");
      expect(status.plan).toBe("builder");
      expect(status.creditsRemaining).toBe(50000);
      expect(status.conversationsRemaining).toBeGreaterThan(0);
    });

    it("includes provider and model in subscription status", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "pro",
        inferenceTokensRemaining: 500000,
      });
      const engine = new ChatEngine(runtime, { provider: "nookplot", model: "claude-sonnet-4-20250514" });

      const status = await engine.checkIntelligence();

      expect(status.provider).toBe("nookplot");
      expect(status.model).toBe("claude-sonnet-4-20250514");
    });

    it("includes earning potential projections", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "starter",
        inferenceTokensRemaining: 75000,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.earningPotential).toBeDefined();
      expect(status.earningPotential!.miningPerDay).toBeGreaterThan(0);
      expect(status.earningPotential!.breakEvenDays).toBeGreaterThanOrEqual(0);
      expect(status.earningPotential!.selfSustainingAfterDays).toBeGreaterThanOrEqual(0);
    });

    it("warns when credits are running low", async () => {
      // Very few credits + subscription active
      const runtime = createMockRuntime({
        credits: 100, // extremely low
        plan: "starter",
        inferenceTokensRemaining: 50000,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.source).toBe("subscription");
      expect(status.estimatedDaysRemaining).toBeDefined();
    });

    it("does not choose subscription when plan is free", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      // Should NOT be subscription — free plan with 0 tokens
      expect(status.source).not.toBe("subscription");
    });
  });

  describe("source: byok", () => {
    it("detects BYOK keys when no subscription", async () => {
      const runtime = createMockRuntime({
        credits: 1000,
        byokProviders: ["openai"],
      });
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(true);
      expect(status.source).toBe("byok");
      expect(status.messages.some((m: string) => m.includes("BYOK"))).toBe(true);
    });

    it("reports minimal credit cost for BYOK mode", async () => {
      const runtime = createMockRuntime({
        credits: 5000,
        byokProviders: ["anthropic"],
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.source).toBe("byok");
      // BYOK should report very high conversations remaining (minimal gateway cost)
      expect(status.conversationsRemaining).toBe(99999);
    });

    it("prioritizes subscription over BYOK when both available", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "builder",
        inferenceTokensRemaining: 100000,
        byokProviders: ["openai"],
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      // Subscription should take priority over BYOK
      expect(status.source).toBe("subscription");
    });

    it("reports break-even at 1 day for BYOK", async () => {
      const runtime = createMockRuntime({
        credits: 5000,
        byokProviders: ["openrouter"],
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.earningPotential).toBeDefined();
      expect(status.earningPotential!.breakEvenDays).toBe(1);
      expect(status.earningPotential!.selfSustainingAfterDays).toBe(1);
    });
  });

  describe("source: credits (pay-per-use)", () => {
    it("detects pay-per-use when credits > 0 and no subscription", async () => {
      const runtime = createMockRuntime({
        credits: 5000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(true);
      expect(status.source).toBe("credits");
      expect(status.plan).toBe("pay-per-use");
      expect(status.creditsRemaining).toBe(5000);
    });

    it("calculates conversations remaining based on model cost", async () => {
      const runtime = createMockRuntime({
        credits: 10000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.conversationsRemaining).toBeGreaterThan(0);
      // With 10000 credits, conversationsRemaining should be credits / cost_per_conversation
      expect(status.conversationsRemaining).toBeDefined();
    });

    it("includes onboarding guidance messages", async () => {
      const runtime = createMockRuntime({
        credits: 2000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.messages.some((m: string) => m.includes("pay-per-use"))).toBe(true);
      expect(status.messages.some((m: string) => m.includes("Subscribe") || m.includes("subscribe"))).toBe(true);
    });

    it("includes estimatedDaysRemaining", async () => {
      const runtime = createMockRuntime({
        credits: 50000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.estimatedDaysRemaining).toBeDefined();
      expect(status.estimatedDaysRemaining).toBeGreaterThan(0);
    });
  });

  describe("source: none (no intelligence)", () => {
    it("returns not ready when no intelligence configured", async () => {
      const runtime = createMockRuntime({
        credits: 0,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(false);
      expect(status.source).toBe("none");
      expect(status.creditsRemaining).toBe(0);
      expect(status.conversationsRemaining).toBe(0);
    });

    it("includes all onboarding options (subscribe, BYOK, Ollama, callback)", async () => {
      const runtime = createMockRuntime({ credits: 0 });
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.messages.some((m: string) => m.includes("No inference configured"))).toBe(true);
      expect(status.messages.some((m: string) => m.includes("Subscribe"))).toBe(true);
      expect(status.messages.some((m: string) => m.includes("BYOK"))).toBe(true);
      expect(status.messages.some((m: string) => m.includes("Ollama"))).toBe(true);
      expect(status.messages.some((m: string) => m.includes("Custom callback"))).toBe(true);
    });

    it("includes earning potential even with zero credits", async () => {
      const runtime = createMockRuntime({ credits: 0 });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.earningPotential).toBeDefined();
      expect(status.earningPotential!.miningPerDay).toBeGreaterThan(0);
      expect(status.earningPotential!.breakEvenDays).toBeGreaterThan(0);
    });

    it("includes mining info in messages", async () => {
      const runtime = createMockRuntime({ credits: 0 });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.messages.some((m: string) => m.includes("Mining") || m.includes("mining"))).toBe(true);
    });
  });

  describe("gateway connection failure", () => {
    it("handles gateway connection failure gracefully", async () => {
      // economy.getBalance must throw to trigger the outer catch block
      const runtime = createMockRuntime();
      runtime.economy.getBalance = vi.fn().mockRejectedValue(new Error("Connection refused"));
      const engine = new ChatEngine(runtime, {});

      const status: IntelligenceStatus = await engine.checkIntelligence();

      expect(status.ready).toBe(false);
      expect(status.source).toBe("none");
      expect(status.messages.some((m: string) => m.includes("Cannot reach gateway"))).toBe(true);
    });

    it("suggests local model as fallback when gateway unreachable", async () => {
      const runtime = createMockRuntime();
      runtime.economy.getBalance = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      expect(status.messages.some((m: string) => m.includes("generateResponse"))).toBe(true);
    });
  });

  describe("BYOK check failure", () => {
    it("proceeds without BYOK when BYOK endpoint fails", async () => {
      const runtime = createMockRuntime({
        credits: 5000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      // Override request to throw on BYOK check
      runtime.connection.request = vi.fn().mockImplementation((method: string, path: string) => {
        if (path === "/v1/byok") throw new Error("BYOK not available");
        if (path === "/v1/subscriptions/status") return { plan: "free", inferenceTokensRemaining: 0 };
        return {};
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      // Should fall through to credits (not crash)
      expect(status.ready).toBe(true);
      expect(status.source).toBe("credits");
    });
  });

  describe("subscription check failure", () => {
    it("treats as free plan when subscription endpoint fails", async () => {
      const runtime = createMockRuntime({
        credits: 5000,
        plan: "free",
        inferenceTokensRemaining: 0,
      });
      runtime.connection.request = vi.fn().mockImplementation((method: string, path: string) => {
        if (path === "/v1/byok") return { providers: [] };
        if (path === "/v1/subscriptions/status") throw new Error("Subscription service down");
        return {};
      });
      const engine = new ChatEngine(runtime, {});

      const status = await engine.checkIntelligence();

      // Should fall through to credits (not crash or claim subscription)
      expect(status.ready).toBe(true);
      expect(status.source).toBe("credits");
    });
  });
});

// ── Chat method tests ─────────────────────────────────────

describe("ChatEngine.chat", () => {
  it("loads soul on first call if not loaded", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Hello!");
    const engine = new ChatEngine(runtime, { generateResponse });

    const response = await engine.chat("Hi there");

    expect(response).toBe("Hello!");
    // soul should have been loaded (default fallback since readFile mock throws ENOENT)
    expect(engine.agentName).toBe("Agent");
  });

  it("passes system prompt + conversation history to LLM", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Sure thing!");
    const engine = new ChatEngine(runtime, { generateResponse });

    await engine.chat("Tell me about biology");

    expect(generateResponse).toHaveBeenCalledTimes(1);
    const messages = generateResponse.mock.calls[0][0];
    // Should have system prompt + user message
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Tell me about biology");
  });

  it("stores conversation in episodic memory (fire-and-forget)", async () => {
    // refactor: episodic write moved out of chatEngine.ts and into
    // installEpisodicMemoryHook(). NookplotRuntime.connect() auto-installs it;
    // this test uses a mock runtime that never calls connect(), so we install
    // the hook manually to reproduce the prior inline behavior.
    const { HookRegistry } = await import("../hooks.js");
    const { installEpisodicMemoryHook } = await import("../episodicMemoryHook.js");
    const runtime = createMockRuntime({ credits: 5000 });
    const hooks = new HookRegistry();
    (runtime as any).hooks = hooks;
    installEpisodicMemoryHook(runtime as any, { hooks });

    const generateResponse = vi.fn().mockResolvedValue("Hi!");
    const engine = new ChatEngine(runtime, { generateResponse, enableMemory: true });

    await engine.chat("Hello", { platform: "terminal" });
    // Hook fires fire-and-forget; flush microtasks.
    await new Promise((r) => setTimeout(r, 5));

    expect(runtime.memory.storeMemory).toHaveBeenCalledWith(
      "episodic",
      expect.stringContaining("Hello"),
      expect.objectContaining({
        tags: expect.arrayContaining(["conversation", "terminal"]),
      }),
    );
  });

  it("skips memory when enableMemory is false", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Hi!");
    const engine = new ChatEngine(runtime, { generateResponse, enableMemory: false });

    await engine.chat("Hello");

    expect(runtime.memory.recall).not.toHaveBeenCalled();
    expect(runtime.memory.storeMemory).not.toHaveBeenCalled();
  });

  it("maintains separate conversation histories per sender", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Reply");
    const engine = new ChatEngine(runtime, { generateResponse });

    await engine.chat("User A message", { platform: "telegram", senderId: "userA" });
    await engine.chat("User B message", { platform: "telegram", senderId: "userB" });

    // Second call should not include User A's history
    const secondCallMessages = generateResponse.mock.calls[1][0];
    const userMessages = secondCallMessages.filter((m: any) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("User B message");
  });

  it("clears history for a specific sender", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Reply");
    const engine = new ChatEngine(runtime, { generateResponse });

    await engine.chat("First message", { platform: "terminal", senderId: "userA" });
    engine.clearHistory("userA");
    await engine.chat("Second message", { platform: "terminal", senderId: "userA" });

    // After clearing, the second call should not have the first message in history
    const secondCallMessages = generateResponse.mock.calls[1][0];
    const userMessages = secondCallMessages.filter((m: any) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("Second message");
  });

  it("clears all histories when no senderId provided", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    const generateResponse = vi.fn().mockResolvedValue("Reply");
    const engine = new ChatEngine(runtime, { generateResponse });

    await engine.chat("Msg A", { platform: "terminal", senderId: "userA" });
    await engine.chat("Msg B", { platform: "terminal", senderId: "userB" });
    engine.clearHistory();

    // Both users should have fresh histories
    await engine.chat("Fresh A", { platform: "terminal", senderId: "userA" });
    const callMessages = generateResponse.mock.calls[2][0];
    const userMessages = callMessages.filter((m: any) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("Fresh A");
  });

  it("uses runtime.economy.inference when no custom callback", async () => {
    const runtime = createMockRuntime({ credits: 5000 });
    runtime.economy.inference.mockResolvedValue({ content: "From gateway" });
    const engine = new ChatEngine(runtime, {});

    const response = await engine.chat("Hello");

    expect(response).toBe("From gateway");
    expect(runtime.economy.inference).toHaveBeenCalledTimes(1);
  });
});

// ── loadSoul tests ────────────────────────────────────────

describe("ChatEngine.loadSoul", () => {
  it("uses default agent name when soul file missing", async () => {
    const runtime = createMockRuntime();
    const engine = new ChatEngine(runtime, { generateResponse: async () => "" });

    await engine.loadSoul();

    expect(engine.agentName).toBe("Agent");
  });

  it("loads identity from soul.json", async () => {
    const { readFile: mockRead } = await import("node:fs/promises");
    const mockedRead = vi.mocked(mockRead);
    mockedRead.mockResolvedValueOnce(JSON.stringify({
      identity: { name: "Glitch", tagline: "Research agent" },
      personality: { traits: ["curious", "precise"] },
      purpose: { mission: "Advance biology research" },
    }));

    const runtime = createMockRuntime();
    const engine = new ChatEngine(runtime, { generateResponse: async () => "" });

    await engine.loadSoul("./soul.json");

    expect(engine.agentName).toBe("Glitch");
  });
});
