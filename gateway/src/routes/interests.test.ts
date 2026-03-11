import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createInterestsRouter } from "./interests.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";
import { ValidationError, LimitError } from "../services/interestEngine.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_int", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockInterestEngine() {
  return {
    createSubscription: vi.fn(),
    listSubscriptions: vi.fn(),
    getSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    testSubscription: vi.fn(),
    getNotificationHistory: vi.fn(),
    getNotificationStats: vi.fn(),
    addRepoWatch: vi.fn(),
    listRepoWatches: vi.fn(),
    removeRepoWatch: vi.fn(),
    manualPollRepoWatch: vi.fn(),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  engine?: ReturnType<typeof createMockInterestEngine>,
) {
  const ie = engine ?? createMockInterestEngine();
  const router = createInterestsRouter(pool as any, TEST_HMAC_SECRET, ie as any);
  return { app: createTestApp(router), ie };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/interests — Create subscription
// ---------------------------------------------------------------------------

describe("POST /v1/interests", () => {
  it("creates subscription successfully", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.createSubscription.mockResolvedValueOnce({ id: "sub_1", label: "AI stuff" });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests")
      .set(authHeader())
      .send({ label: "AI stuff", tags: ["ml"] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("sub_1");
  });

  it("returns 400 on ValidationError", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.createSubscription.mockRejectedValueOnce(new ValidationError("Label must be 1-200 characters"));
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Label");
  });

  it("returns 409 on LimitError", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.createSubscription.mockRejectedValueOnce(new LimitError("Maximum 20 subscriptions reached"));
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests")
      .set(authHeader())
      .send({ label: "Test", tags: ["python"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Maximum");
  });

  it("returns 500 on unexpected error", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.createSubscription.mockRejectedValueOnce(new Error("DB error"));
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests")
      .set(authHeader())
      .send({ label: "Test", tags: ["python"] });

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/interests — List subscriptions
// ---------------------------------------------------------------------------

describe("GET /v1/interests", () => {
  it("returns subscriptions", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.listSubscriptions.mockResolvedValueOnce([{ id: "sub_1", label: "AI" }]);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/interests/:id — Get subscription
// ---------------------------------------------------------------------------

describe("GET /v1/interests/:id", () => {
  it("returns subscription when found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.getSubscription.mockResolvedValueOnce({ id: "sub_1", label: "AI" });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests/sub_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("sub_1");
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.getSubscription.mockResolvedValueOnce(null);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests/sub_999")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/interests/:id — Update subscription
// ---------------------------------------------------------------------------

describe("PUT /v1/interests/:id", () => {
  it("updates subscription", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.updateSubscription.mockResolvedValueOnce({ id: "sub_1", label: "Updated" });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/interests/sub_1")
      .set(authHeader())
      .send({ label: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Updated");
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.updateSubscription.mockResolvedValueOnce(null);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/interests/sub_999")
      .set(authHeader())
      .send({ label: "Updated" });

    expect(res.status).toBe(404);
  });

  it("returns 400 on ValidationError", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.updateSubscription.mockRejectedValueOnce(new ValidationError("matchMode must be 'any' or 'all'"));
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/interests/sub_1")
      .set(authHeader())
      .send({ matchMode: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("matchMode");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/interests/:id — Delete subscription
// ---------------------------------------------------------------------------

describe("DELETE /v1/interests/:id", () => {
  it("deletes subscription", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.deleteSubscription.mockResolvedValueOnce(true);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/interests/sub_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.deleteSubscription.mockResolvedValueOnce(false);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/interests/sub_999")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/interests/:id/test — Dry-run
// ---------------------------------------------------------------------------

describe("POST /v1/interests/:id/test", () => {
  it("returns test results", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.testSubscription.mockResolvedValueOnce({ matches: [], estimatedDailyCost: 0 });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/sub_1/test")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.estimatedDailyCost).toBe(0);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.testSubscription.mockResolvedValueOnce(null);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/sub_999/test")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/interests/notifications — History
// ---------------------------------------------------------------------------

describe("GET /v1/interests/notifications", () => {
  it("returns notification history", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.getNotificationHistory.mockResolvedValueOnce({ notifications: [], total: 0 });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests/notifications")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/interests/notifications/stats — Stats
// ---------------------------------------------------------------------------

describe("GET /v1/interests/notifications/stats", () => {
  it("returns notification stats", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.getNotificationStats.mockResolvedValueOnce({ todayCount: 3, creditsSpent: 10, freeRemaining: 7 });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests/notifications/stats")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.todayCount).toBe(3);
    expect(res.body.freeRemaining).toBe(7);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/interests/repo-watches — Add watch
// ---------------------------------------------------------------------------

describe("POST /v1/interests/repo-watches", () => {
  it("creates repo watch", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.addRepoWatch.mockResolvedValueOnce({ id: "rw_1", owner: "octocat", repo: "hello" });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches")
      .set(authHeader())
      .send({ owner: "octocat", repo: "hello" });

    expect(res.status).toBe(201);
    expect(res.body.owner).toBe("octocat");
  });

  it("rejects missing owner", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches")
      .set(authHeader())
      .send({ repo: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner");
  });

  it("rejects missing repo", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches")
      .set(authHeader())
      .send({ owner: "octocat" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repo");
  });

  it("returns 409 on duplicate (unique constraint)", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    const pgError = new Error("duplicate") as Error & { code: string };
    pgError.code = "23505";
    ie.addRepoWatch.mockRejectedValueOnce(pgError);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches")
      .set(authHeader())
      .send({ owner: "octocat", repo: "hello" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Already watching");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/interests/repo-watches — List watches
// ---------------------------------------------------------------------------

describe("GET /v1/interests/repo-watches", () => {
  it("returns watches", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.listRepoWatches.mockResolvedValueOnce([{ id: "rw_1" }]);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/interests/repo-watches")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.watches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/interests/repo-watches/:id — Remove watch
// ---------------------------------------------------------------------------

describe("DELETE /v1/interests/repo-watches/:id", () => {
  it("removes watch", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.removeRepoWatch.mockResolvedValueOnce(true);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/interests/repo-watches/rw_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.removeRepoWatch.mockResolvedValueOnce(false);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/interests/repo-watches/rw_999")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/interests/repo-watches/:id/check — Manual poll
// ---------------------------------------------------------------------------

describe("POST /v1/interests/repo-watches/:id/check", () => {
  it("returns poll result", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.manualPollRepoWatch.mockResolvedValueOnce({ id: "rw_1", lastCheckedAt: "2025-01-01" });
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches/rw_1/check")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("rw_1");
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const ie = createMockInterestEngine();
    ie.manualPollRepoWatch.mockResolvedValueOnce(null);
    const { app } = buildApp(pool, ie);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/interests/repo-watches/rw_999/check")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});
