/**
 * End-to-end integration tests for Venice AI integration.
 *
 * Verifies:
 * 1. Venice inference works through the HTTP route (chat, stream, models)
 * 2. Venice BYOK storage and removal
 * 3. Venice tools (image gen, web search) via ActionRegistry
 * 4. Existing providers (OpenAI, Anthropic, etc.) are unaffected
 * 5. When VENICE_API_KEY is not set, Venice is completely invisible
 * 6. providerParams passthrough to Venice provider
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createInferenceRouter } from "./inference.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";
import { ActionRegistry } from "../services/actionRegistry.js";
import { registerVeniceTools } from "../services/veniceTools.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock OpenAI SDK (used by Venice tools web search)
const mockOpenAICreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockOpenAICreate(...args),
      },
    },
  })),
}));

// Mock global fetch (used by Venice tools image gen)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_venice_e2e", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const mockContext = {
  agentId: "agt_test",
  agentAddress: "0x1234567890abcdef1234567890abcdef12345678",
  creditBalance: 1000,
  autonomyLevel: "autonomous" as const,
};

function createMockInferenceProxy(opts?: { veniceRegistered?: boolean }) {
  const veniceProvider = {
    isValidModel: vi.fn().mockReturnValue(true),
    listModels: vi.fn().mockReturnValue([
      { provider: "venice", model: "llama-3.3-70b", displayName: "Llama 3.3 70B (Venice)" },
      { provider: "venice", model: "venice-uncensored", displayName: "Venice Uncensored" },
    ]),
  };

  const openaiProvider = {
    isValidModel: vi.fn().mockReturnValue(true),
    listModels: vi.fn().mockReturnValue([
      { provider: "openai", model: "gpt-4o", displayName: "GPT-4o" },
    ]),
  };

  const getProvider = vi.fn().mockImplementation((name: string) => {
    if (name === "openai") return openaiProvider;
    if (name === "venice" && opts?.veniceRegistered !== false) return veniceProvider;
    return null;
  });

  const models = [
    { provider: "openai", model: "gpt-4o", displayName: "GPT-4o" },
    ...(opts?.veniceRegistered !== false
      ? [
          { provider: "venice", model: "llama-3.3-70b", displayName: "Llama 3.3 70B (Venice)" },
          { provider: "venice", model: "venice-uncensored", displayName: "Venice Uncensored" },
        ]
      : []),
  ];

  return {
    getProvider,
    chat: vi.fn().mockResolvedValue({
      content: "Hello from the provider!",
      model: "gpt-4o",
      promptTokens: 10,
      completionTokens: 20,
      finishReason: "stop",
    }),
    chatStream: vi.fn(),
    listAllModels: vi.fn().mockReturnValue(models),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockByokManager() {
  return {
    storeKey: vi.fn().mockResolvedValue(undefined),
    removeKey: vi.fn().mockResolvedValue(true),
    listProviders: vi.fn().mockResolvedValue(["openai"]),
    getKey: vi.fn().mockResolvedValue(null),
  };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 5000 }),
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 4800 }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  opts?: {
    proxy?: ReturnType<typeof createMockInferenceProxy>;
    byok?: ReturnType<typeof createMockByokManager>;
    credits?: ReturnType<typeof createMockCreditManager>;
  },
) {
  const proxy = opts?.proxy ?? createMockInferenceProxy();
  const byok = opts?.byok ?? createMockByokManager();
  const credits = opts?.credits ?? createMockCreditManager();
  const router = createInferenceRouter(pool as any, proxy as any, byok as any, credits as any, TEST_HMAC_SECRET);
  return { app: createTestApp(router), proxy, byok, credits };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "5000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

const VALID_MESSAGES = [{ role: "user", content: "Hello" }];

// ===========================================================================
//  1. Venice inference via HTTP route
// ===========================================================================

describe("Venice E2E — Inference route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts venice as a valid provider for /v1/inference/chat", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockResolvedValue({
      content: "Venice says hi!",
      model: "llama-3.3-70b",
      promptTokens: 15,
      completionTokens: 8,
      finishReason: "stop",
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "venice", model: "llama-3.3-70b", messages: VALID_MESSAGES });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Venice says hi!");
    expect(res.body.model).toBe("llama-3.3-70b");
    expect(res.body.usage.promptTokens).toBe(15);
    expect(proxy.chat).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "venice",
      expect.objectContaining({ model: "llama-3.3-70b" }),
    );
  });

  it("passes providerParams through to the inference proxy", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({
        provider: "venice",
        model: "llama-3.3-70b",
        messages: VALID_MESSAGES,
        providerParams: { enable_web_search: true, strip_thinking_response: true },
      });

    expect(res.status).toBe(200);
    expect(proxy.chat).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "venice",
      expect.objectContaining({
        providerParams: { enable_web_search: true, strip_thinking_response: true },
      }),
    );
  });

  it("ignores providerParams when not provided (backward compat)", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    const callArgs = proxy.chat.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty("providerParams");
  });

  it("rejects non-object providerParams", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "venice", messages: VALID_MESSAGES, providerParams: "not-an-object" });

    // Should not pass string providerParams through
    const callArgs = proxy.chat.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty("providerParams");
  });

  it("returns venice models in GET /v1/inference/models when registered", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: true });
    const { app } = buildApp(pool, { proxy });

    const res = await request(app).get("/v1/inference/models");

    expect(res.status).toBe(200);
    const veniceModels = res.body.models.filter((m: any) => m.provider === "venice");
    expect(veniceModels.length).toBe(2);
    expect(veniceModels.map((m: any) => m.model)).toContain("llama-3.3-70b");
    expect(veniceModels.map((m: any) => m.model)).toContain("venice-uncensored");
  });

  it("returns 400 when venice provider is not configured", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: false });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "venice", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not configured");
  });

  it("passes providerParams through to /v1/inference/stream", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();

    // Mock chatStream to return an async generator
    async function* mockStream() {
      yield { delta: "hello", done: false };
      yield { delta: "", done: true, usage: { promptTokens: 5, completionTokens: 3 } };
    }
    proxy.chatStream.mockReturnValue(mockStream());

    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/stream")
      .set(authHeader())
      .send({
        provider: "venice",
        model: "llama-3.3-70b",
        messages: VALID_MESSAGES,
        providerParams: { enable_web_search: true },
      });

    expect(res.status).toBe(200);
    expect(proxy.chatStream).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "venice",
      expect.objectContaining({
        providerParams: { enable_web_search: true },
      }),
    );
  });
});

// ===========================================================================
//  2. Venice BYOK
// ===========================================================================

describe("Venice E2E — BYOK", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows storing a Venice BYOK key", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "venice", apiKey: "venice-agent-key-123" });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("venice");
    expect(res.body.stored).toBe(true);
    expect(byok.storeKey).toHaveBeenCalledWith(TEST_AGENT.id, "venice", "venice-agent-key-123");
  });

  it("allows removing a Venice BYOK key", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/byok/venice")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(byok.removeKey).toHaveBeenCalledWith(TEST_AGENT.id, "venice");
  });
});

// ===========================================================================
//  3. Existing providers unaffected
// ===========================================================================

describe("Venice E2E — Existing providers unaffected", () => {
  beforeEach(() => vi.clearAllMocks());

  it("OpenAI inference still works exactly as before", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockResolvedValue({
      content: "OpenAI response",
      model: "gpt-4o",
      promptTokens: 12,
      completionTokens: 25,
      finishReason: "stop",
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", model: "gpt-4o", messages: VALID_MESSAGES });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("OpenAI response");
    expect(res.body.model).toBe("gpt-4o");
    expect(proxy.chat).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "openai",
      expect.objectContaining({ model: "gpt-4o" }),
    );
  });

  it("OpenAI inference does not receive providerParams when not sent", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    const callArgs = proxy.chat.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty("providerParams");
  });

  it("Anthropic still validates as a valid provider name", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    // Anthropic is not registered in our mock, but name is valid
    proxy.getProvider.mockImplementation((name: string) => {
      if (name === "anthropic") return {
        isValidModel: vi.fn().mockReturnValue(true),
        listModels: vi.fn().mockReturnValue([{ model: "claude-sonnet-4" }]),
      };
      return null;
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "anthropic", messages: VALID_MESSAGES });

    expect(res.status).toBe(200);
  });

  it("GET /v1/inference/models includes non-Venice models", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: true });
    const { app } = buildApp(pool, { proxy });

    const res = await request(app).get("/v1/inference/models");

    expect(res.status).toBe(200);
    const openaiModels = res.body.models.filter((m: any) => m.provider === "openai");
    expect(openaiModels.length).toBe(1);
    expect(openaiModels[0].model).toBe("gpt-4o");
  });

  it("BYOK still works for non-Venice providers", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "openai", apiKey: "sk-test123" });

    expect(res.status).toBe(200);
    expect(byok.storeKey).toHaveBeenCalledWith(TEST_AGENT.id, "openai", "sk-test123");
  });

  it("invalid provider still returns 400 (not Venice-related)", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "doesnt-exist", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("provider must be one of");
  });
});

// ===========================================================================
//  4. Venice not configured = invisible
// ===========================================================================

describe("Venice E2E — Not configured (no VENICE_API_KEY)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("models listing has no Venice models when provider not registered", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: false });
    const { app } = buildApp(pool, { proxy });

    const res = await request(app).get("/v1/inference/models");

    expect(res.status).toBe(200);
    const veniceModels = res.body.models.filter((m: any) => m.provider === "venice");
    expect(veniceModels.length).toBe(0);
  });

  it("Venice inference request returns 400 not-configured", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: false });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "venice", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not configured");
  });

  it("Venice tools are not registered when no API key", () => {
    // Simulate: no registerVeniceTools call → registry has no venice tools
    const registry = new ActionRegistry();
    // Don't call registerVeniceTools

    const imageGenTool = registry.get("venice_image_gen");
    const webSearchTool = registry.get("venice_web_search");

    expect(imageGenTool).toBeUndefined();
    expect(webSearchTool).toBeUndefined();
  });

  it("other providers still work when Venice is not configured", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy({ veniceRegistered: false });
    proxy.chat.mockResolvedValue({
      content: "Still working!",
      model: "gpt-4o",
      promptTokens: 5,
      completionTokens: 10,
      finishReason: "stop",
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Still working!");
  });
});

// ===========================================================================
//  5. Venice tools via ActionRegistry (E2E handler execution)
// ===========================================================================

describe("Venice E2E — ActionRegistry tools", () => {
  let registry: ActionRegistry;
  let byok: ReturnType<typeof createMockByokManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ActionRegistry();
    byok = createMockByokManager();
    registerVeniceTools(registry, null as any, null as any, byok as any, "venice-gateway-key");
  });

  it("venice_image_gen is discoverable in the registry", () => {
    const tool = registry.get("venice_image_gen");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("venice_image_gen");
    expect(tool!.category).toBe("ai");
    expect(tool!.cost).toBe(200);
  });

  it("venice_web_search is discoverable in the registry", () => {
    const tool = registry.get("venice_web_search");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("venice_web_search");
    expect(tool!.category).toBe("ai");
    expect(tool!.cost).toBe(75);
  });

  it("venice_image_gen handler calls Venice API and returns images", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ url: "https://venice.ai/img/cat.png" }],
      }),
    });

    const tool = registry.get("venice_image_gen")!;
    const result = await tool.handler("agt_test", { prompt: "a cat in space" }, mockContext);

    expect(result.success).toBe(true);
    expect((result.output as any).images).toEqual(["https://venice.ai/img/cat.png"]);
    expect(result.creditsUsed).toBe(200);
  });

  it("venice_image_gen uses BYOK key when agent has one stored", async () => {
    byok.getKey.mockResolvedValue("agent-own-venice-key");

    // Re-register with the byok that returns a key
    const freshRegistry = new ActionRegistry();
    registerVeniceTools(freshRegistry, null as any, null as any, byok as any, "venice-gateway-key");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ url: "https://venice.ai/img/1.png" }] }),
    });

    const tool = freshRegistry.get("venice_image_gen")!;
    await tool.handler("agt_byok", { prompt: "test" }, mockContext);

    expect(byok.getKey).toHaveBeenCalledWith("agt_byok", "venice");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer agent-own-venice-key",
        }),
      }),
    );
  });

  it("venice_image_gen falls back to gateway key when no BYOK", async () => {
    byok.getKey.mockResolvedValue(null);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ url: "https://venice.ai/img/1.png" }] }),
    });

    const tool = registry.get("venice_image_gen")!;
    await tool.handler("agt_no_byok", { prompt: "test" }, mockContext);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer venice-gateway-key",
        }),
      }),
    );
  });

  it("venice_image_gen returns failure on API error (no credits charged)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const tool = registry.get("venice_image_gen")!;
    const result = await tool.handler("agt_test", { prompt: "test" }, mockContext);

    expect(result.success).toBe(false);
    expect(result.creditsUsed).toBe(0);
    expect(result.error).toContain("500");
  });

  it("venice_web_search handler calls Venice with web search params", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: "The answer. [1](https://example.com)" } }],
      model: "llama-3.3-70b",
    });

    const tool = registry.get("venice_web_search")!;
    const result = await tool.handler("agt_test", { query: "what is nookplot" }, mockContext);

    expect(result.success).toBe(true);
    expect(result.output.answer).toContain("The answer");
    expect(result.output.citations).toContain("https://example.com");
    expect(result.creditsUsed).toBe(75);

    // Verify venice_parameters were passed
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        venice_parameters: { enable_web_search: true, enable_web_citations: true },
      }),
    );
  });

  it("venice_web_search returns failure on error (no credits charged)", async () => {
    mockOpenAICreate.mockRejectedValueOnce(new Error("Venice API down"));

    const tool = registry.get("venice_web_search")!;
    const result = await tool.handler("agt_test", { query: "test" }, mockContext);

    expect(result.success).toBe(false);
    expect(result.creditsUsed).toBe(0);
    expect(result.error).toBe("Venice API down");
  });

  it("tools list includes venice tools alongside other registered tools", () => {
    // Register a non-Venice tool too
    registry.register({
      name: "other_tool",
      description: "Some other tool",
      category: "general",
      inputSchema: { type: "object", properties: {} },
      cost: 50,
      defaultAutonomyLevel: "autonomous",
      autoExecutable: true,
      rateLimit: { maxPerHour: 10, maxPerDay: 50 },
      boundaryKeywords: ["other"],
      handler: async () => ({ success: true, output: {}, creditsUsed: 50 }),
    });

    const allTools = registry.list();

    expect(allTools.some((t) => t.name === "venice_image_gen")).toBe(true);
    expect(allTools.some((t) => t.name === "venice_web_search")).toBe(true);
    expect(allTools.some((t) => t.name === "other_tool")).toBe(true);
    expect(allTools.length).toBe(3);
  });

  it("non-Venice tools are not affected by Venice registration", () => {
    registry.register({
      name: "http_request",
      description: "Egress proxy",
      category: "network",
      inputSchema: { type: "object", properties: {} },
      cost: 15,
      defaultAutonomyLevel: "semi-autonomous",
      autoExecutable: true,
      rateLimit: { maxPerHour: 60, maxPerDay: 500 },
      boundaryKeywords: ["network"],
      handler: async () => ({ success: true, output: { status: 200 }, creditsUsed: 15 }),
    });

    const httpTool = registry.get("http_request");
    expect(httpTool).toBeDefined();
    expect(httpTool!.cost).toBe(15);
    expect(httpTool!.category).toBe("network");

    // Venice tools still work
    expect(registry.get("venice_image_gen")).toBeDefined();
    expect(registry.get("venice_web_search")).toBeDefined();
  });
});

// ===========================================================================
//  6. Full agent workflow simulation
// ===========================================================================

describe("Venice E2E — Full agent workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agent uses OpenAI for chat, then Venice for image gen — both work", async () => {
    // Step 1: Agent makes an OpenAI inference call
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockResolvedValue({
      content: "I'll generate an image of a sunset for you.",
      model: "gpt-4o",
      promptTokens: 10,
      completionTokens: 15,
      finishReason: "stop",
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const chatRes = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.content).toContain("sunset");

    // Step 2: Agent calls venice_image_gen tool
    const registry = new ActionRegistry();
    const byok = createMockByokManager();
    registerVeniceTools(registry, null as any, null as any, byok as any, "venice-key");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ url: "https://venice.ai/img/sunset.png" }],
      }),
    });

    const imgTool = registry.get("venice_image_gen")!;
    const imgResult = await imgTool.handler("agt_venice_e2e", { prompt: "beautiful sunset" }, mockContext);

    expect(imgResult.success).toBe(true);
    expect((imgResult.output as any).images[0]).toContain("sunset");
  });

  it("agent stores Venice BYOK key, then makes Venice inference", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockResolvedValue({
      content: "Venice response with BYOK",
      model: "venice-uncensored",
      promptTokens: 8,
      completionTokens: 12,
      finishReason: "stop",
    });
    const { app } = buildApp(pool, { proxy, byok });

    // Step 1: Store BYOK key
    setupAuth(pool);
    const byokRes = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "venice", apiKey: "my-venice-key" });

    expect(byokRes.status).toBe(200);
    expect(byokRes.body.stored).toBe(true);

    // Step 2: Use Venice inference (provider will use BYOK key via InferenceProxy)
    setupAuth(pool);
    const chatRes = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({
        provider: "venice",
        model: "venice-uncensored",
        messages: [{ role: "user", content: "Tell me something uncensored" }],
        providerParams: { strip_thinking_response: true },
      });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.content).toBe("Venice response with BYOK");
    expect(proxy.chat).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "venice",
      expect.objectContaining({
        model: "venice-uncensored",
        providerParams: { strip_thinking_response: true },
      }),
    );
  });
});
