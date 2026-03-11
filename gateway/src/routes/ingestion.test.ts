import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createIngestionRouter } from "./ingestion.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_ing", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });
const ADMIN_ADDRESS = TEST_AGENT.address;

function createMockIngestionService() {
  return {
    pollCategory: vi.fn().mockResolvedValue({ papersFound: 3, papersIngested: 2 }),
    ingestHistoricalPaper: vi.fn().mockResolvedValue({ id: 1, arxiv_id: "2401.00001", title: "Test Paper" }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  svc?: ReturnType<typeof createMockIngestionService>,
  adminAddr?: string,
) {
  const ingestionService = svc ?? createMockIngestionService();
  const router = createIngestionRouter(pool as any, TEST_HMAC_SECRET, adminAddr ?? ADMIN_ADDRESS);
  const app = createTestApp(router);
  app.locals.ingestionService = ingestionService;
  return { app, ingestionService };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/ingestion/trigger — Admin
// ---------------------------------------------------------------------------

describe("POST /v1/ingestion/trigger", () => {
  it("triggers ingestion for a category", async () => {
    const pool = createMockPool();
    const svc = createMockIngestionService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ingestion/trigger")
      .set(authHeader())
      .send({ category: "cs.AI" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(svc.pollCategory).toHaveBeenCalledWith("cs.AI");
  });

  it("rejects missing category", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ingestion/trigger")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("category");
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    // Build with no admin address so all users are rejected
    const { app } = buildApp(pool, undefined, "0x0000000000000000000000000000000000000000");
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ingestion/trigger")
      .set(authHeader())
      .send({ category: "cs.AI" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/ingestion/paper — Admin
// ---------------------------------------------------------------------------

describe("POST /v1/ingestion/paper", () => {
  it("ingests a specific paper", async () => {
    const pool = createMockPool();
    const svc = createMockIngestionService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ingestion/paper")
      .set(authHeader())
      .send({ id: "2401.00001" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(svc.ingestHistoricalPaper).toHaveBeenCalledWith("2401.00001");
  });

  it("rejects missing id", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ingestion/paper")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("id");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/ingestion/status — Public
// ---------------------------------------------------------------------------

describe("GET /v1/ingestion/status", () => {
  it("returns ingestion stats", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // 3 concurrent pool queries
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, category: "cs.AI", papers_found: 5, papers_passed: 3 }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ total: 42 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ total: 5 }], rowCount: 1 });

    const res = await request(app).get("/v1/ingestion/status");

    expect(res.status).toBe(200);
    expect(res.body.recentRuns).toHaveLength(1);
    expect(res.body.totalPapersIngested).toBe(42);
    expect(res.body.pendingCitations).toBe(5);
  });

  it("returns 500 on query failure", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/v1/ingestion/status");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/ingestion/papers — Public
// ---------------------------------------------------------------------------

describe("GET /v1/ingestion/papers", () => {
  it("returns paginated papers", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Count query
    pool.query.mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 });
    // Data query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, arxiv_id: "2401.00001", title: "Test Paper", quality_score: 85 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/ingestion/papers");

    expect(res.status).toBe(200);
    expect(res.body.papers).toHaveLength(1);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by category", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/v1/ingestion/papers?category=cs.AI");

    const countSql = pool.query.mock.calls[0][0] as string;
    expect(countSql).toContain("categories");
  });

  it("respects pagination and sort params", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ total: 100 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/ingestion/papers?page=3&limit=10&sort=most-cited");

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(3);
    expect(res.body.pagination.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/ingestion/papers/:arxivId — Public
// ---------------------------------------------------------------------------

describe("GET /v1/ingestion/papers/:arxivId", () => {
  it("returns paper detail by arxiv ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Paper lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, arxiv_id: "2401.00001", content_cid: "bafypaper", title: "Test", quality_score: 90 }],
      rowCount: 1,
    });
    // Pending citations
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/ingestion/papers/2401.00001");

    expect(res.status).toBe(200);
    expect(res.body.arxiv_id).toBe("2401.00001");
    expect(res.body.pendingCitations).toHaveLength(0);
  });

  it("returns paper detail by numeric ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, arxiv_id: "2401.00001", content_cid: "bafypaper", title: "Test" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/ingestion/papers/42");

    expect(res.status).toBe(200);
    // Should use "id = $1" query with numeric param
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(42);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/ingestion/papers/9999.99999");

    expect(res.status).toBe(404);
  });
});
