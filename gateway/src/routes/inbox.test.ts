import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createInboxRouter } from "./inbox.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: {
    contentScanBlockEnabled: false,
    contentScanBlockThreshold: 0.8,
  },
}));

vi.mock("../services/contentScanner.js", () => ({
  shouldQuarantine: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_inbox", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockInboxService() {
  return {
    send: vi.fn().mockResolvedValue({
      id: "msg_1",
      from_agent_id: "agt_inbox",
      to_agent_id: "agt_other",
      message_type: "text",
      content: "Hello",
      metadata: null,
      created_at: "2025-06-01T00:00:00.000Z",
    }),
    getMessages: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(true),
    getUnreadCount: vi.fn().mockResolvedValue(3),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  svc?: ReturnType<typeof createMockInboxService>,
) {
  const inboxService = svc ?? createMockInboxService();
  const router = createInboxRouter(pool as any, TEST_HMAC_SECRET, inboxService as any);
  return { app: createTestApp(router), inboxService };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/inbox/send
// ---------------------------------------------------------------------------

describe("POST /v1/inbox/send", () => {
  it("sends a message to another agent", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    const { app } = buildApp(pool, svc);

    setupAuth(pool);
    // Recipient lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_other" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0x2222222222222222222222222222222222222222", content: "Hello there" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("msg_1");
    expect(svc.send).toHaveBeenCalledWith(expect.objectContaining({
      fromAgentId: TEST_AGENT.id,
      toAgentId: "agt_other",
      content: "Hello there",
    }));
  });

  it("rejects missing 'to' field", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ content: "Hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("to");
  });

  it("rejects missing content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0x2222222222222222222222222222222222222222" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content");
  });

  it("rejects content longer than 10,000 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0xabc", content: "x".repeat(10_001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("10,000");
  });

  it("returns 404 for unknown recipient", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // recipient not found

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0xUnknown", content: "Hello" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("prevents self-messaging", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Recipient resolves to self
    pool.query.mockResolvedValueOnce({ rows: [{ id: TEST_AGENT.id }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: TEST_AGENT.address, content: "Talking to myself" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("yourself");
  });

  it("rejects invalid messageType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_other" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0xabc", content: "Hello", messageType: "evil_type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("messageType");
  });

  it("rejects oversized metadata", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_other" }], rowCount: 1 });

    const bigMetadata: Record<string, string> = {};
    for (let i = 0; i < 100; i++) bigMetadata[`key${i}`] = "x".repeat(50);

    const res = await request(app)
      .post("/v1/inbox/send")
      .set(authHeader())
      .send({ to: "0xabc", content: "Hello", metadata: bigMetadata });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("metadata");
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/inbox/send")
      .send({ to: "0xabc", content: "Hello" });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/inbox
// ---------------------------------------------------------------------------

describe("GET /v1/inbox", () => {
  it("returns inbox messages", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    svc.getMessages.mockResolvedValue([{
      id: "msg_1",
      from_agent_id: "agt_sender",
      message_type: "text",
      content: "Hello",
      metadata: null,
      read_at: null,
      created_at: "2025-06-01T00:00:00.000Z",
    }]);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);
    // Agent address lookup for enrichment
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_sender", address: "0xSender", display_name: "Sender" }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/inbox")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].from).toBe("0xSender");
    expect(res.body.messages[0].fromName).toBe("Sender");
  });

  it("returns empty when filtering by unknown sender", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Sender address lookup returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/inbox?from=0xUnknown")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/inbox/:id/read
// ---------------------------------------------------------------------------

describe("POST /v1/inbox/:id/read", () => {
  it("marks a message as read", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inbox/msg_1/read")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.markRead).toHaveBeenCalledWith("msg_1", TEST_AGENT.id);
  });

  it("returns 404 when message not found", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    svc.markRead.mockResolvedValue(false);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/inbox/msg_missing/read")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/inbox/unread
// ---------------------------------------------------------------------------

describe("GET /v1/inbox/unread", () => {
  it("returns unread count", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    svc.getUnreadCount.mockResolvedValue(5);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/inbox/unread")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(5);
  });

  it("returns 500 on error", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    svc.getUnreadCount.mockRejectedValue(new Error("DB fail"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/inbox/unread")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/inbox/:id
// ---------------------------------------------------------------------------

describe("DELETE /v1/inbox/:id", () => {
  it("deletes a message", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/inbox/msg_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.deleteMessage).toHaveBeenCalledWith("msg_1", TEST_AGENT.id);
  });

  it("returns 404 when message not found", async () => {
    const pool = createMockPool();
    const svc = createMockInboxService();
    svc.deleteMessage.mockResolvedValue(false);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/inbox/msg_missing")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});
