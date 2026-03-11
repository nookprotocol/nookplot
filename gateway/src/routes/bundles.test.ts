import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createBundlesRouter } from "./bundles.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../sdkFactory.js", () => ({
  getProvider: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_bn", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createBundlesRouter(pool as any, SDK_CONFIG, TEST_HMAC_SECRET);
  return { app: createTestApp(router) };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/bundles — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/bundles", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).post("/v1/bundles").set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bundles — List bundles
// ---------------------------------------------------------------------------

describe("GET /v1/bundles", () => {
  it("returns bundles list", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundleId: "1", creator: "0x1111", name: "Test Bundle",
        descriptionCid: "bafy123", contentCids: ["cid1"], contributorCount: 2,
        cidCount: 1, createdAt: "2025-06-01", isActive: true,
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bundles");

    expect(res.status).toBe(200);
    expect(res.body.bundles).toHaveLength(1);
    expect(res.body.bundles[0].creator).toEqual({ id: "0x1111" });
  });

  it("respects first and skip params", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?first=10&skip=5");

    expect(res.status).toBe(200);
    expect(res.body.first).toBe(10);
    expect(res.body.skip).toBe(5);
  });

  it("sort=score injects bundleScore ORDER BY", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?sort=score&first=1");

    expect(res.status).toBe(200);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('"bundleScore" DESC');
  });

  it("clamps first to max 100", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?first=500");

    expect(res.status).toBe(200);
    expect(res.body.first).toBe(100);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bundles/:id — Bundle detail
// ---------------------------------------------------------------------------

describe("GET /v1/bundles/:id", () => {
  it("returns bundle detail with contributors", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Bundle query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "0x01", bundleId: "1", creator: "0x1111", name: "Test Bundle",
        descriptionCid: "bafy123", contentCids: ["cid1"], cidCount: 1,
        contributorCount: 1, createdAt: "2025-06-01", isActive: true,
      }],
      rowCount: 1,
    });
    // Contributors query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "c_1", contributor: "0x2222", weightBps: 5000 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bundles/1");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Test Bundle");
    expect(res.body.creator).toEqual({ id: "0x1111" });
    expect(res.body.contributors).toHaveLength(1);
  });

  it("rejects non-numeric bundle ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/bundles/abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("number");
  });

  it("returns 404 for unknown bundle", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles/999");

    expect(res.status).toBe(404);
  });

  it("includes metadata fields in detail response", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "0x01", bundleId: "1", creator: "0x1111", name: "ML Bundle",
        descriptionCid: "bafy123", contentCids: ["cid1"], cidCount: 1,
        contributorCount: 1, createdAt: "2025-06-01", isActive: true,
        bundleType: "curation", tags: ["ml", "ai"], summary: "An ML bundle",
        domain: "artificial-intelligence", bundleMetadata: { custom: "data" },
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // contributors

    const res = await request(app).get("/v1/bundles/1");

    expect(res.status).toBe(200);
    expect(res.body.bundleType).toBe("curation");
    expect(res.body.tags).toEqual(["ml", "ai"]);
    expect(res.body.summary).toBe("An ML bundle");
    expect(res.body.domain).toBe("artificial-intelligence");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bundles — Filtering
// ---------------------------------------------------------------------------

describe("GET /v1/bundles — filtering", () => {
  it("filters by bundleType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?bundleType=curation");

    expect(res.status).toBe(200);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("bundle_type");
  });

  it("filters by tags (comma-separated)", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?tags=ml,ai");

    expect(res.status).toBe(200);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("tags &&");
  });

  it("filters by domain", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bundles?domain=artificial-intelligence");

    expect(res.status).toBe(200);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("domain");
  });

  it("includes metadata columns in list response", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundleId: "1", creator: "0x1111", name: "Test",
        descriptionCid: "bafy", contributorCount: 1, cidCount: 1,
        createdAt: "2025-06-01", isActive: true,
        bundleType: "dataset", tags: ["data"], summary: "A dataset",
        domain: "data-science", bundleMetadata: null,
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bundles");

    expect(res.status).toBe(200);
    expect(res.body.bundles[0].bundleType).toBe("dataset");
    expect(res.body.bundles[0].tags).toEqual(["data"]);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bundles/:id/content — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/bundles/:id/content", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).post("/v1/bundles/1/content").set(authHeader());

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bundles/:id/content/remove — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/bundles/:id/content/remove", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).post("/v1/bundles/1/content/remove").set(authHeader());

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bundles/:id/contributors — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/bundles/:id/contributors", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).post("/v1/bundles/1/contributors").set(authHeader());

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/bundles/:id — 410 Gone
// ---------------------------------------------------------------------------

describe("DELETE /v1/bundles/:id", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).delete("/v1/bundles/1").set(authHeader());

    expect(res.status).toBe(410);
  });
});
