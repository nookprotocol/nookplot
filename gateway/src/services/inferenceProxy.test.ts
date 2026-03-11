import { describe, it, expect, vi } from "vitest";
import { InferenceProxy } from "./inferenceProxy.js";
import { createMockPool } from "../test/helpers.js";
import type { InferenceProvider } from "./inference/provider.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockCreditManager(balance = 5000) {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance, status: "active" }),
    calculateCost: vi.fn().mockReturnValue(100),
    deductCredits: vi.fn().mockResolvedValue(undefined),
    addCredits: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockByokManager(key: string | null = null) {
  return {
    getKey: vi.fn().mockResolvedValue(key),
  };
}

function createMockProvider(name = "openai"): InferenceProvider {
  return {
    name,
    isValidModel: vi.fn().mockReturnValue(true),
    listModels: vi.fn().mockReturnValue([
      { id: "gpt-4", name: "GPT-4", provider: name },
    ]),
    chat: vi.fn().mockResolvedValue({
      content: "Hello!",
      model: "gpt-4",
      promptTokens: 50,
      completionTokens: 20,
      finishReason: "stop",
    }),
    chatStream: vi.fn(),
  };
}

const DEFAULT_CONFIG = {
  defaultKeys: { openai: "sk-FAKE-gateway-default" },
  requestTimeoutMs: 30_000,
  rateLimitRpm: 60,
  rateLimitTpm: 100_000,
};

function createProxy(opts?: {
  pool?: ReturnType<typeof createMockPool>;
  creditManager?: ReturnType<typeof createMockCreditManager>;
  byokManager?: ReturnType<typeof createMockByokManager>;
  config?: Partial<typeof DEFAULT_CONFIG>;
}) {
  const pool = opts?.pool ?? createMockPool();
  const cm = opts?.creditManager ?? createMockCreditManager();
  const byok = opts?.byokManager ?? createMockByokManager();
  const config = { ...DEFAULT_CONFIG, ...opts?.config };
  const proxy = new InferenceProxy(pool as any, cm as any, byok as any, config);
  return { proxy, pool, creditManager: cm, byokManager: byok };
}

function makeRequest(model = "gpt-4") {
  return {
    model,
    messages: [{ role: "user" as const, content: "Hello" }],
    maxTokens: 100,
    temperature: 0.7,
    stream: false,
    requestId: "req-001",
  };
}

// ---------------------------------------------------------------------------
//  registerProvider / getProvider / listAllModels
// ---------------------------------------------------------------------------

describe("InferenceProxy — provider registry", () => {
  it("registers and retrieves a provider", () => {
    const { proxy } = createProxy();
    const provider = createMockProvider();

    proxy.registerProvider(provider);

    expect(proxy.getProvider("openai")).toBe(provider);
    expect(proxy.getProvider("unknown")).toBeUndefined();
  });

  it("lists models from all registered providers", () => {
    const { proxy } = createProxy();
    proxy.registerProvider(createMockProvider("openai"));
    proxy.registerProvider(createMockProvider("anthropic"));

    const models = proxy.listAllModels();
    expect(models).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("InferenceProxy.chat", () => {
  it("completes full inference flow", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const byokManager = createMockByokManager();
    const { proxy } = createProxy({ pool, creditManager, byokManager });
    const provider = createMockProvider();
    proxy.registerProvider(provider);

    // logInference INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await proxy.chat("agt_test", "openai", makeRequest());

    expect(response.content).toBe("Hello!");
    expect(response.promptTokens).toBe(50);
    expect(response.completionTokens).toBe(20);

    // Verified credit flow
    expect(creditManager.getBalance).toHaveBeenCalledWith("agt_test");
    expect(creditManager.calculateCost).toHaveBeenCalled();
    expect(creditManager.deductCredits).toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalled();
  });

  it("throws for unknown provider", async () => {
    const { proxy } = createProxy();

    await expect(proxy.chat("agt_test", "unknown", makeRequest())).rejects.toThrow(
      "Unknown provider",
    );
  });

  it("throws for invalid model", async () => {
    const { proxy } = createProxy();
    const provider = createMockProvider();
    (provider.isValidModel as ReturnType<typeof vi.fn>).mockReturnValue(false);
    proxy.registerProvider(provider);

    await expect(proxy.chat("agt_test", "openai", makeRequest("bad-model"))).rejects.toThrow(
      "Invalid model",
    );
  });

  it("throws ACCOUNT_NOT_FOUND when no credit account", async () => {
    const creditManager = createMockCreditManager();
    creditManager.getBalance.mockResolvedValue(null);
    const { proxy } = createProxy({ creditManager });
    proxy.registerProvider(createMockProvider());

    await expect(proxy.chat("agt_test", "openai", makeRequest())).rejects.toThrow(
      "ACCOUNT_NOT_FOUND",
    );
  });

  it("throws ACCOUNT_PAUSED when account is paused", async () => {
    const creditManager = createMockCreditManager();
    creditManager.getBalance.mockResolvedValue({ balance: 5000, status: "paused" });
    const { proxy } = createProxy({ creditManager });
    proxy.registerProvider(createMockProvider());

    await expect(proxy.chat("agt_test", "openai", makeRequest())).rejects.toThrow(
      "ACCOUNT_PAUSED",
    );
  });

  it("uses BYOK key when available", async () => {
    const pool = createMockPool();
    const byokManager = createMockByokManager("sk-FAKE-byok-key");
    const { proxy } = createProxy({ pool, byokManager });
    const provider = createMockProvider();
    proxy.registerProvider(provider);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await proxy.chat("agt_test", "openai", makeRequest());

    // Provider should be called with the BYOK key
    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatCall[1]).toBe("sk-FAKE-byok-key");
  });

  it("falls back to gateway default key", async () => {
    const pool = createMockPool();
    const byokManager = createMockByokManager(null); // no BYOK
    const { proxy } = createProxy({ pool, byokManager });
    const provider = createMockProvider();
    proxy.registerProvider(provider);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await proxy.chat("agt_test", "openai", makeRequest());

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatCall[1]).toBe("sk-FAKE-gateway-default");
  });

  it("refunds and throws when no API key available", async () => {
    const creditManager = createMockCreditManager();
    const byokManager = createMockByokManager(null);
    const { proxy } = createProxy({
      creditManager,
      byokManager,
      config: { defaultKeys: { openai: "" } }, // no gateway defaults
    });
    proxy.registerProvider(createMockProvider());

    await expect(proxy.chat("agt_test", "openai", makeRequest())).rejects.toThrow(
      "No API key available",
    );

    // Should have refunded the pre-deducted estimate
    expect(creditManager.addCredits).toHaveBeenCalledWith("agt_test", 100, "refund", "req-001");
  });

  it("refunds on provider error", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { proxy } = createProxy({ pool, creditManager });
    const provider = createMockProvider();
    (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));
    proxy.registerProvider(provider);

    // logInference INSERT for error
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(proxy.chat("agt_test", "openai", makeRequest())).rejects.toThrow("API error");

    expect(creditManager.addCredits).toHaveBeenCalledWith("agt_test", 100, "refund", "req-001");
  });

  it("adjusts credits when actual cost differs from estimate", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    // First call: estimate cost = 100, second call: actual cost = 80
    creditManager.calculateCost
      .mockReturnValueOnce(100) // estimate
      .mockReturnValueOnce(80); // actual
    const { proxy } = createProxy({ pool, creditManager });
    proxy.registerProvider(createMockProvider());

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logInference

    await proxy.chat("agt_test", "openai", makeRequest());

    // Should refund estimate and charge actual
    expect(creditManager.addCredits).toHaveBeenCalledWith("agt_test", 100, "refund_estimate", "req-001");
    expect(creditManager.deductCredits).toHaveBeenCalledTimes(2); // initial + actual
  });

  it("skips credit operations when cost is 0", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    creditManager.calculateCost.mockReturnValue(0);
    const { proxy } = createProxy({ pool, creditManager });
    proxy.registerProvider(createMockProvider());

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logInference

    await proxy.chat("agt_test", "openai", makeRequest());

    expect(creditManager.deductCredits).not.toHaveBeenCalled();
  });

  it("enforces RPM rate limit", async () => {
    const { proxy } = createProxy({ config: { rateLimitRpm: 2, rateLimitTpm: 100_000 } });
    const provider = createMockProvider();
    proxy.registerProvider(provider);
    const pool = createMockPool();

    // Manually exhaust rate limit by recording requests
    // Access private rateLimitWindow via reflection
    const window = (proxy as any).rateLimitWindow;
    window.record("agt_test", 10);
    window.record("agt_test", 10);

    await expect(proxy.chat("agt_test", "openai", makeRequest())).rejects.toThrow(
      "RATE_LIMIT_RPM",
    );
  });
});

// ---------------------------------------------------------------------------
//  getHistory
// ---------------------------------------------------------------------------

describe("InferenceProxy.getHistory", () => {
  it("returns formatted inference log entries", async () => {
    const pool = createMockPool();
    const { proxy } = createProxy({ pool });

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "log-1",
          request_id: "req-001",
          provider: "openai",
          model: "gpt-4",
          prompt_tokens: 50,
          completion_tokens: 20,
          cost_credits: "100",
          duration_ms: 1500,
          status: "success",
          created_at: new Date("2025-06-01"),
        },
      ],
      rowCount: 1,
    });

    const history = await proxy.getHistory("agt_test", 10, 0);

    expect(history).toHaveLength(1);
    expect(history[0].requestId).toBe("req-001");
    expect(history[0].provider).toBe("openai");
    expect(history[0].costCredits).toBe(100);
    expect(history[0].durationMs).toBe(1500);
    expect(history[0].status).toBe("success");
  });

  it("returns empty array when no history", async () => {
    const pool = createMockPool();
    const { proxy } = createProxy({ pool });

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const history = await proxy.getHistory("agt_test", 10, 0);
    expect(history).toHaveLength(0);
  });
});
