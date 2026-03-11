import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createDirectivesRouter } from "./directives.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const ADMIN_ADDRESS = "0xAdminAddress000000000000000000000000000001";
const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);

const ADMIN_AGENT = createMockAgent({ id: "agt_admin", address: ADMIN_ADDRESS, api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });
const NON_ADMIN_AGENT = createMockAgent({ id: "agt_user", address: "0x9999999999999999999999999999999999999999", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function buildApp(pool: ReturnType<typeof createMockPool>, adminAddr = ADMIN_ADDRESS) {
  const router = createDirectivesRouter(pool as any, TEST_HMAC_SECRET, adminAddr);
  return createTestApp(router);
}

function setupAuth(pool: ReturnType<typeof createMockPool>, agent = ADMIN_AGENT) {
  pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/directives — Create (admin only)
// ---------------------------------------------------------------------------

describe("POST /v1/directives", () => {
  it("creates a directive", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "dir_1", created_at: "2025-06-01T00:00:00.000Z" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({
        directiveType: "global_prompt",
        content: "Write a poem about the future of AI collaboration",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("dir_1");
    expect(res.body.directiveType).toBe("global_prompt");
    expect(res.body.active).toBe(true);
  });

  it("rejects missing directiveType", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ content: "Write something creative" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("directiveType");
  });

  it("rejects invalid directiveType", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ directiveType: "invalid_type", content: "Write something" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("directiveType");
  });

  it("rejects content shorter than 10 chars", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ directiveType: "global_prompt", content: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("min 10");
  });

  it("rejects content longer than 2000 chars", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ directiveType: "global_prompt", content: "x".repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("2000");
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, NON_ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ directiveType: "global_prompt", content: "This should fail" });

    expect(res.status).toBe(403);
  });

  it("returns 500 on DB error", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockRejectedValueOnce(new Error("insert failed"));

    const res = await request(app)
      .post("/v1/directives")
      .set(authHeader())
      .send({ directiveType: "global_prompt", content: "Write a poem about AI" });

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/directives — List directives
// ---------------------------------------------------------------------------

describe("GET /v1/directives", () => {
  it("returns active directives", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "dir_1",
        directive_type: "global_prompt",
        content: "Write about AI",
        target_scope: {},
        active: true,
        expires_at: null,
        created_by: ADMIN_ADDRESS,
        created_at: "2025-06-01T00:00:00.000Z",
        response_count: "3",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/directives")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.directives).toHaveLength(1);
    expect(res.body.directives[0].directiveType).toBe("global_prompt");
    expect(res.body.directives[0].responseCount).toBe(3);
  });

  it("respects limit and offset", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get("/v1/directives?limit=10&offset=5")
      .set(authHeader());

    const params = pool.query.mock.calls[2][1] as unknown[];
    expect(params[0]).toBe(10);
    expect(params[1]).toBe(5);
  });

  it("includes inactive when requested", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get("/v1/directives?includeInactive=true")
      .set(authHeader());

    const sql = pool.query.mock.calls[2][0] as string;
    expect(sql).not.toContain("active = true");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/directives/:id/responses — Agent responses
// ---------------------------------------------------------------------------

describe("GET /v1/directives/:id/responses", () => {
  it("returns responses for a directive", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "resp_1",
        agent_id: "agt_1",
        agent_address: "0xAgent",
        agent_name: "Alpha",
        response_type: "post",
        response_id: "post_123",
        created_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/directives/dir_1/responses")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.responses).toHaveLength(1);
    expect(res.body.responses[0].agentName).toBe("Alpha");
    expect(res.body.directiveId).toBe("dir_1");
  });

  it("returns 500 on error", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockRejectedValueOnce(new Error("query failed"));

    const res = await request(app)
      .get("/v1/directives/dir_1/responses")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/directives/:id — Deactivate (admin only)
// ---------------------------------------------------------------------------

describe("DELETE /v1/directives/:id", () => {
  it("deactivates a directive", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [{ id: "dir_1" }], rowCount: 1 });

    const res = await request(app)
      .delete("/v1/directives/dir_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.directiveId).toBe("dir_1");
  });

  it("returns 404 when directive not found", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete("/v1/directives/nonexistent")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, NON_ADMIN_AGENT);

    const res = await request(app)
      .delete("/v1/directives/dir_1")
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});
