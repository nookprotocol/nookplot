import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createInferenceRouter } from "./inference.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_infer", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockInferenceProxy() {
  return {
    getProvider: vi.fn().mockReturnValue({
      isValidModel: vi.fn().mockReturnValue(true),
      listModels: vi.fn().mockReturnValue([{ model: "gpt-4", displayName: "GPT-4" }]),
    }),
    chat: vi.fn().mockResolvedValue({
      content: "Hello!",
      model: "gpt-4",
      promptTokens: 10,
      completionTokens: 20,
      finishReason: "stop",
    }),
    chatStream: vi.fn(),
    listAllModels: vi.fn().mockReturnValue([
      { provider: "openai", model: "gpt-4", displayName: "GPT-4" },
    ]),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockByokManager() {
  return {
    storeKey: vi.fn().mockResolvedValue(undefined),
    removeKey: vi.fn().mockResolvedValue(true),
    listProviders: vi.fn().mockResolvedValue(["openai"]),
  };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 5000 }),
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

// ---------------------------------------------------------------------------
//  POST /v1/inference/chat
// ---------------------------------------------------------------------------

describe("POST /v1/inference/chat", () => {
  it("returns inference result", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Hello!");
    expect(res.body.model).toBe("gpt-4");
    expect(res.body.usage.promptTokens).toBe(10);
    expect(res.body.balance).toBe(5000);
  });

  it("rejects invalid provider", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "invalid", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("provider");
  });

  it("rejects missing provider", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
  });

  it("rejects unconfigured provider", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValue(null);
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "anthropic", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not configured");
  });

  it("rejects invalid model for provider", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValue({
      isValidModel: vi.fn().mockReturnValue(false),
      listModels: vi.fn().mockReturnValue([]),
    });
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", model: "nonexistent", messages: VALID_MESSAGES });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid model");
  });

  it("rejects empty messages array", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("non-empty");
  });

  it("rejects too many messages", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const messages = Array.from({ length: 101 }, () => ({ role: "user", content: "x" }));
    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Too many messages");
  });

  it("rejects message with invalid role", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: [{ role: "admin", content: "hi" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("role");
  });

  it("rejects message with non-string content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: [{ role: "user", content: 123 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("string");
  });

  it("returns 402 on insufficient credits", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("credits");
  });

  it("returns 402 on paused account", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("ACCOUNT_PAUSED"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(402);
  });

  it("returns 404 on account not found", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("ACCOUNT_NOT_FOUND"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(404);
  });

  it("returns 429 on daily spend limit", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("DAILY_SPEND_LIMIT"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(429);
  });

  it("returns 429 on rate limit", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("RATE_LIMIT_RPM"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(429);
  });

  it("returns 504 on inference timeout", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("INFERENCE_TIMEOUT"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(504);
  });

  it("returns 500 on generic provider error", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValue(new Error("unknown error"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .set(authHeader())
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Provider error");
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/inference/chat")
      .send({ provider: "openai", messages: VALID_MESSAGES });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/inference/models — Public
// ---------------------------------------------------------------------------

describe("GET /v1/inference/models", () => {
  it("returns all available models", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });

    const res = await request(app).get("/v1/inference/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/inference/history
// ---------------------------------------------------------------------------

describe("GET /v1/inference/history", () => {
  it("returns paginated history", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.getHistory.mockResolvedValue([{ id: "h1", model: "gpt-4" }]);
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/inference/history?limit=10&offset=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(5);
    expect(proxy.getHistory).toHaveBeenCalledWith(TEST_AGENT.id, 10, 5);
  });

  it("clamps limit to 100", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    await request(app)
      .get("/v1/inference/history?limit=500")
      .set(authHeader());

    expect(proxy.getHistory).toHaveBeenCalledWith(TEST_AGENT.id, 100, 0);
  });

  it("returns 500 on error", async () => {
    const pool = createMockPool();
    const proxy = createMockInferenceProxy();
    proxy.getHistory.mockRejectedValue(new Error("DB fail"));
    const { app } = buildApp(pool, { proxy });
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/inference/history")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/byok — Store a BYOK key
// ---------------------------------------------------------------------------

describe("POST /v1/byok", () => {
  it("stores a BYOK API key", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "openai", apiKey: "sk-test123" });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openai");
    expect(res.body.stored).toBe(true);
    expect(byok.storeKey).toHaveBeenCalledWith(TEST_AGENT.id, "openai", "sk-test123");
  });

  it("rejects missing provider", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ apiKey: "sk-test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("provider");
  });

  it("rejects mock provider", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "mock", apiKey: "test" });

    expect(res.status).toBe(400);
  });

  it("rejects missing apiKey", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "openai" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("apiKey");
  });

  it("returns 400 on invalid key format", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    byok.storeKey.mockRejectedValue(new Error("Invalid API key format for openai"));
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/byok")
      .set(authHeader())
      .send({ provider: "openai", apiKey: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid API key format");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/byok/:provider — Remove a BYOK key
// ---------------------------------------------------------------------------

describe("DELETE /v1/byok/:provider", () => {
  it("removes a BYOK key", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/byok/openai")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(byok.removeKey).toHaveBeenCalledWith(TEST_AGENT.id, "openai");
  });

  it("returns 404 when no key exists", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    byok.removeKey.mockResolvedValue(false);
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/byok/anthropic")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects invalid provider", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/byok/invalid")
      .set(authHeader());

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/byok — List stored providers
// ---------------------------------------------------------------------------

describe("GET /v1/byok", () => {
  it("returns list of stored providers", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    byok.listProviders.mockResolvedValue(["openai", "anthropic"]);
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/byok")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(["openai", "anthropic"]);
  });

  it("returns 500 on error", async () => {
    const pool = createMockPool();
    const byok = createMockByokManager();
    byok.listProviders.mockRejectedValue(new Error("DB fail"));
    const { app } = buildApp(pool, { byok });
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/byok")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});
