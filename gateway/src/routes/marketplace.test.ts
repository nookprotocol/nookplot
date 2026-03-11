import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createMarketplaceRouter } from "./marketplace.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_mkt", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function createMockMarketplaceService() {
  return {
    searchListings: vi.fn().mockResolvedValue([]),
    getListingDetail: vi.fn().mockResolvedValue(null),
    getFeaturedListings: vi.fn().mockResolvedValue([]),
    getProviderStats: vi.fn().mockResolvedValue({ totalListings: 5, avgRating: 4.2 }),
    getAgreements: vi.fn().mockResolvedValue([]),
    getAgreementDetail: vi.fn().mockResolvedValue(null),
    submitReview: vi.fn().mockResolvedValue({ id: "rev_1", rating: 5 }),
    getReviews: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([{ name: "ai", count: 5 }]),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  svc?: ReturnType<typeof createMockMarketplaceService>,
) {
  const marketplaceService = svc ?? createMockMarketplaceService();
  const router = createMarketplaceRouter(pool as any, SDK_CONFIG, TEST_HMAC_SECRET, marketplaceService as any);
  return { app: createTestApp(router), marketplaceService };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/search
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/search", () => {
  it("returns search results", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.searchListings.mockResolvedValue([{ id: 1, category: "ai" }]);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/search")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(1);
    expect(svc.searchListings).toHaveBeenCalledWith(expect.objectContaining({
      activeOnly: true,
      limit: 50,
      offset: 0,
    }));
  });

  it("passes category filter", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    await request(app)
      .get("/v1/marketplace/search?category=ai&activeOnly=false")
      .set(authHeader());

    expect(svc.searchListings).toHaveBeenCalledWith(expect.objectContaining({
      category: "ai",
      activeOnly: false,
    }));
  });

  it("returns 500 on error", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.searchListings.mockRejectedValue(new Error("DB fail"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/search")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/listings/:id
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/listings/:id", () => {
  it("returns listing detail", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getListingDetail.mockResolvedValue({ id: 1, category: "ai", price: "100" });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/listings/1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("ai");
  });

  it("rejects non-numeric ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/listings/abc")
      .set(authHeader());

    expect(res.status).toBe(400);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getListingDetail.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/listings/999")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/featured
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/featured", () => {
  it("returns featured listings", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getFeaturedListings.mockResolvedValue([{ id: 1 }]);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/featured")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/provider/:address
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/provider/:address", () => {
  it("returns provider profile", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);
    // Agent lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_provider" }], rowCount: 1 });

    const res = await request(app)
      .get("/v1/marketplace/provider/0xProvider")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("0xProvider");
    expect(res.body.stats).toBeDefined();
  });

  it("returns 404 for unknown agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Route is public — no auth mocks needed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/marketplace/provider/0xUnknown");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/agreements
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/agreements", () => {
  it("returns agreements for authenticated agent", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getAgreements.mockResolvedValue([{ id: 1, status: "active" }]);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/agreements")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(1);
    expect(svc.getAgreements).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "both",
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });

  it("passes role filter", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    await request(app)
      .get("/v1/marketplace/agreements?role=buyer")
      .set(authHeader());

    expect(svc.getAgreements).toHaveBeenCalledWith(
      TEST_AGENT.id,
      "buyer",
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/agreements/:id
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/agreements/:id", () => {
  it("returns agreement detail", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getAgreementDetail.mockResolvedValue({ id: 1, status: "active" });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/agreements/1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("rejects non-numeric ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/agreements/abc")
      .set(authHeader());

    expect(res.status).toBe(400);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getAgreementDetail.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/agreements/999")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/marketplace/reviews
// ---------------------------------------------------------------------------

describe("POST /v1/marketplace/reviews", () => {
  it("submits a review", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/marketplace/reviews")
      .set(authHeader())
      .send({ agreementId: 1, revieweeAgentId: "agt_other", rating: 5, comment: "Great!" });

    expect(res.status).toBe(201);
    expect(svc.submitReview).toHaveBeenCalled();
  });

  it("rejects missing required fields", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/marketplace/reviews")
      .set(authHeader())
      .send({ rating: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("rejects invalid rating", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/marketplace/reviews")
      .set(authHeader())
      .send({ agreementId: 1, revieweeAgentId: "agt_other", rating: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 and 5");
  });

  it("returns 409 on duplicate review", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.submitReview.mockRejectedValue(new Error("duplicate key"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/marketplace/reviews")
      .set(authHeader())
      .send({ agreementId: 1, revieweeAgentId: "agt_other", rating: 4 });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/reviews/:address
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/reviews/:address", () => {
  it("returns reviews for an agent", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    svc.getReviews.mockResolvedValue([{ id: "rev_1", rating: 5 }]);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);
    // Agent lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_target" }], rowCount: 1 });

    const res = await request(app)
      .get("/v1/marketplace/reviews/0xTarget")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
  });

  it("returns 404 for unknown agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Public endpoint — no auth needed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/marketplace/reviews/0xUnknown");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/marketplace/categories
// ---------------------------------------------------------------------------

describe("GET /v1/marketplace/categories", () => {
  it("returns categories with counts", async () => {
    const pool = createMockPool();
    const svc = createMockMarketplaceService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/marketplace/categories")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].name).toBe("ai");
  });
});
