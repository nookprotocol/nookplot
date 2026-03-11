import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createResourcesRouter } from "../resources.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../../test/helpers.js";
import { hashApiKey } from "../../auth.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_res_test", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockResourceService() {
  return {
    submitResource: vi.fn().mockResolvedValue({ resourceId: "r-123", status: "created" }),
    listResources: vi.fn().mockResolvedValue({
      resources: [{ id: "r-1", title: "Test Paper", source_type: "paper" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    }),
    getResourceStats: vi.fn().mockResolvedValue({
      total: 100,
      byType: { paper: 80, github_repo: 20 },
      pendingEnrichment: 5,
    }),
    getMostCited: vi.fn().mockResolvedValue([
      { id: "r-1", title: "Most Cited Paper", citation_count: 500 },
    ]),
    getResource: vi.fn().mockResolvedValue({
      id: "r-1",
      title: "Test Paper",
      source_type: "paper",
      external_id: "arxiv:2301.12345",
    }),
    getResourceCitations: vi.fn().mockResolvedValue({
      citations: [{ id: "c-1", citing_agent_id: "agt-1" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    }),
  };
}

function buildApp(pool: any, svc?: any) {
  const resourceService = svc ?? createMockResourceService();
  const router = createResourcesRouter(pool, TEST_HMAC_SECRET, resourceService);
  const app = createTestApp(router);
  return { app, resourceService };
}

function setupAuth(pool: any) {
  // Auth middleware: agent lookup + credit balance check
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

describe("POST /v1/resources/submit", () => {
  it("submits a paper resource", async () => {
    const pool = createMockPool();
    const { app, resourceService } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "paper", identifier: "2301.12345" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("created");
    expect(res.body.resourceId).toBe("r-123");
    expect(resourceService.submitResource).toHaveBeenCalledWith("agt_res_test", "paper", "2301.12345");
  });

  it("returns 200 for duplicate", async () => {
    const pool = createMockPool();
    const svc = createMockResourceService();
    svc.submitResource.mockResolvedValue({ resourceId: "r-existing", status: "duplicate" });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "paper", identifier: "2301.12345" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("duplicate");
  });

  it("rejects missing sourceType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ identifier: "2301.12345" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("sourceType");
  });

  it("rejects missing identifier", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "paper" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("identifier");
  });

  it("rejects invalid sourceType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "invalid", identifier: "test" });

    expect(res.status).toBe(400);
  });

  it("returns 402 on insufficient credits", async () => {
    const pool = createMockPool();
    const svc = createMockResourceService();
    svc.submitResource.mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "paper", identifier: "2301.12345" });

    expect(res.status).toBe(402);
  });

  it("returns 429 on daily limit", async () => {
    const pool = createMockPool();
    const svc = createMockResourceService();
    svc.submitResource.mockRejectedValue(new Error("DAILY_SUBMISSION_LIMIT"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/resources/submit")
      .set({ Authorization: `Bearer ${TEST_API_KEY}` })
      .send({ sourceType: "paper", identifier: "2301.12345" });

    expect(res.status).toBe(429);
  });
});

describe("GET /v1/resources", () => {
  it("returns paginated resources", async () => {
    const pool = createMockPool();
    const { app, resourceService } = buildApp(pool);

    const res = await request(app).get("/v1/resources");

    expect(res.status).toBe(200);
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(resourceService.listResources).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      limit: 20,
      sort: "newest",
    }));
  });

  it("passes query parameters to service", async () => {
    const pool = createMockPool();
    const { app, resourceService } = buildApp(pool);

    await request(app).get("/v1/resources?sourceType=paper&sort=quality&search=transformer&page=2");

    expect(resourceService.listResources).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "paper",
      sort: "quality",
      search: "transformer",
      page: 2,
    }));
  });
});

describe("GET /v1/resources/stats", () => {
  it("returns resource statistics", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/resources/stats");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(100);
    expect(res.body.byType.paper).toBe(80);
    expect(res.body.pendingEnrichment).toBe(5);
  });
});

describe("GET /v1/resources/most-cited", () => {
  it("returns most-cited resources", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/resources/most-cited?limit=10");

    expect(res.status).toBe(200);
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.count).toBe(1);
  });
});

describe("GET /v1/resources/:id", () => {
  it("returns resource detail", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/resources/r-1");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Test Paper");
  });

  it("returns 404 for missing resource", async () => {
    const pool = createMockPool();
    const svc = createMockResourceService();
    svc.getResource.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);

    const res = await request(app).get("/v1/resources/nonexistent");

    expect(res.status).toBe(404);
  });
});

describe("GET /v1/resources/:id/citations", () => {
  it("returns citations for a resource", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/resources/r-1/citations");

    expect(res.status).toBe(200);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });
});
