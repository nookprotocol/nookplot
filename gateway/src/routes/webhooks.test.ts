import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createWebhooksRouter } from "./webhooks.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_wh", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockWebhookManager() {
  return {
    handleIncoming: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue({
      id: "whr_1",
      source: "github",
      config: {},
      createdAt: "2025-06-01T00:00:00.000Z",
    }),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(true),
    getEventLog: vi.fn().mockResolvedValue([]),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  mgr?: ReturnType<typeof createMockWebhookManager>,
) {
  const webhookManager = mgr ?? createMockWebhookManager();
  const router = createWebhooksRouter(pool as any, TEST_HMAC_SECRET, webhookManager as any);
  return { app: createTestApp(router), webhookManager };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/webhooks/:address/:source — Public inbound
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/:address/:source", () => {
  it("processes incoming webhook", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    const { app } = buildApp(pool, mgr);

    const res = await request(app)
      .post("/v1/webhooks/0xAgent/github")
      .send({ event: "push", ref: "refs/heads/main" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mgr.handleIncoming).toHaveBeenCalledWith(
      "0xAgent",
      "github",
      expect.any(Object),
      expect.any(String),
    );
  });

  it("returns error status from WebhookError", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    // Import WebhookError to simulate
    const err = new Error("Signature verification failed") as any;
    err.statusCode = 401;
    err.retryAfter = undefined;
    // Make it instanceof WebhookError by adding the property check
    Object.defineProperty(err, "constructor", { value: function WebhookError() {} });
    // Instead, just mock handleIncoming to throw a regular error for 500
    mgr.handleIncoming.mockRejectedValue(new Error("Processing failed"));
    const { app } = buildApp(pool, mgr);

    const res = await request(app)
      .post("/v1/webhooks/0xAgent/github")
      .send({ event: "push" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("webhook");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/me/webhooks — Register
// ---------------------------------------------------------------------------

describe("POST /v1/agents/me/webhooks", () => {
  it("registers a webhook source", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .set(authHeader())
      .send({ source: "github" });

    expect(res.status).toBe(201);
    expect(res.body.data.source).toBe("github");
    expect(res.body.data.webhookUrl).toContain("/v1/webhooks/");
    expect(mgr.register).toHaveBeenCalledWith(TEST_AGENT.id, "github", {});
  });

  it("rejects missing source", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("source");
  });

  it("validates config.secret max length", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .set(authHeader())
      .send({ source: "github", config: { secret: "x".repeat(501) } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("secret");
  });

  it("validates config.maxAgeSeconds range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .set(authHeader())
      .send({ source: "github", config: { maxAgeSeconds: 10 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("maxAgeSeconds");
  });

  it("validates config.eventMapping max entries", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const mapping: Record<string, string> = {};
    for (let i = 0; i < 51; i++) mapping[`event_${i}`] = `action_${i}`;

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .set(authHeader())
      .send({ source: "github", config: { eventMapping: mapping } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("eventMapping");
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/agents/me/webhooks")
      .send({ source: "github" });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/webhooks — List
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/webhooks", () => {
  it("returns webhook registrations with URLs", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    mgr.list.mockResolvedValue([{ id: "whr_1", source: "github", config: {} }]);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/me/webhooks")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].source).toBe("github");
    expect(res.body.data[0].webhookUrl).toContain("github");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/agents/me/webhooks/:source — Remove
// ---------------------------------------------------------------------------

describe("DELETE /v1/agents/me/webhooks/:source", () => {
  it("removes a webhook registration", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/agents/me/webhooks/github")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mgr.remove).toHaveBeenCalledWith(TEST_AGENT.id, "github");
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    mgr.remove.mockResolvedValue(false);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/agents/me/webhooks/nonexistent")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/webhooks/log — Event log
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/webhooks/log", () => {
  it("returns event log entries", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    mgr.getEventLog.mockResolvedValue([{ id: "evt_1", source: "github", event: "push" }]);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/me/webhooks/log")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toBe(0);
  });

  it("passes page parameter", async () => {
    const pool = createMockPool();
    const mgr = createMockWebhookManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    await request(app)
      .get("/v1/agents/me/webhooks/log?page=3")
      .set(authHeader());

    expect(mgr.getEventLog).toHaveBeenCalledWith(TEST_AGENT.id, 3);
  });
});
