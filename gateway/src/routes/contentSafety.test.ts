import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createContentSafetyRouter } from "./contentSafety.js";
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

const ADMIN_AGENT = createMockAgent({ id: "agt_admin", address: ADMIN_ADDRESS, api_key_hash: TEST_KEY_HASH });
const NON_ADMIN_AGENT = createMockAgent({ id: "agt_user", address: "0x9999999999999999999999999999999999999999", api_key_hash: TEST_KEY_HASH });

function buildApp(pool: ReturnType<typeof createMockPool>, adminAddr = ADMIN_ADDRESS) {
  const router = createContentSafetyRouter(pool as any, TEST_HMAC_SECRET, adminAddr);
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
//  GET /v1/admin/content-threats
// ---------------------------------------------------------------------------

describe("GET /v1/admin/content-threats", () => {
  it("returns flagged content for admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "flag_1",
        agent_id: "agt_1",
        agent_address: "0xabc",
        content_type: "dm",
        content_id: "msg_1",
        threat_level: "high",
        max_severity: 0.9,
        signals: [{ type: "injection" }],
        resolution: "pending",
        created_at: "2025-06-01T00:00:00.000Z",
        updated_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/admin/content-threats")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.threats).toHaveLength(1);
    expect(res.body.threats[0].id).toBe("flag_1");
    expect(res.body.threats[0].threatLevel).toBe("high");
    expect(res.body.limit).toBe(50);
  });

  it("filters by level and resolution", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get("/v1/admin/content-threats?level=high&resolution=confirmed")
      .set(authHeader());

    const sql = pool.query.mock.calls[2][0] as string;
    expect(sql).toContain("threat_level");
    expect(sql).toContain("resolution");
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, NON_ADMIN_AGENT);

    const res = await request(app)
      .get("/v1/admin/content-threats")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/admin/content-threats");
    expect(res.status).toBe(401);
  });

  it("returns 500 on query failure", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app)
      .get("/v1/admin/content-threats")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/admin/content-threat-stats
// ---------------------------------------------------------------------------

describe("GET /v1/admin/content-threat-stats", () => {
  it("returns aggregated stats", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({
      rows: [
        { threat_level: "high", resolution: "pending", count: 5 },
        { threat_level: "medium", resolution: "pending", count: 10 },
        { threat_level: "high", resolution: "confirmed", count: 2 },
      ],
      rowCount: 3,
    });

    const res = await request(app)
      .get("/v1/admin/content-threat-stats")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(17);
    expect(res.body.pending).toBe(15);
    expect(res.body.byLevel.high).toBe(7);
    expect(res.body.byLevel.medium).toBe(10);
    expect(res.body.breakdown).toHaveLength(3);
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, NON_ADMIN_AGENT);

    const res = await request(app)
      .get("/v1/admin/content-threat-stats")
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/admin/content-threats/:id/resolve
// ---------------------------------------------------------------------------

describe("POST /v1/admin/content-threats/:id/resolve", () => {
  it("resolves a threat flag as safe", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    // UPDATE threat flag
    pool.query.mockResolvedValueOnce({ rows: [{ id: "flag_1" }], rowCount: 1 });
    // SELECT content_type for quarantine clearing
    pool.query.mockResolvedValueOnce({
      rows: [{ content_type: "dm", content_id: "msg_1" }],
      rowCount: 1,
    });
    // UPDATE agent_messages quarantined
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post("/v1/admin/content-threats/flag_1/resolve")
      .set(authHeader())
      .send({ resolution: "safe" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolution).toBe("safe");
  });

  it("resolves as confirmed without quarantine clearing", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [{ id: "flag_1" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/admin/content-threats/flag_1/resolve")
      .set(authHeader())
      .send({ resolution: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe("confirmed");
  });

  it("rejects invalid resolution value", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/admin/content-threats/flag_1/resolve")
      .set(authHeader())
      .send({ resolution: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("resolution");
  });

  it("returns 404 when flag not found", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, ADMIN_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/admin/content-threats/nonexistent/resolve")
      .set(authHeader())
      .send({ resolution: "safe" });

    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, NON_ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/admin/content-threats/flag_1/resolve")
      .set(authHeader())
      .send({ resolution: "safe" });

    expect(res.status).toBe(403);
  });
});
