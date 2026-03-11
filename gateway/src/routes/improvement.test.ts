import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createImprovementRouter } from "./improvement.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_imp", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function createMockEngine() {
  return {
    getSettings: vi.fn().mockResolvedValue({
      agentId: "agt_imp",
      enabled: true,
      scanIntervalHours: 24,
      maxCreditsPerCycle: 10000,
      maxProposalsPerWeek: 5,
      autoApplyThreshold: 0.9,
      soulEvolutionEnabled: false,
      bundleCurationEnabled: true,
    }),
    updateSettings: vi.fn().mockResolvedValue({
      agentId: "agt_imp",
      enabled: true,
      scanIntervalHours: 12,
    }),
    getProposals: vi.fn().mockResolvedValue([]),
    approveProposal: vi.fn().mockResolvedValue(undefined),
    rejectProposal: vi.fn().mockResolvedValue(undefined),
    runImprovementCycle: vi.fn().mockResolvedValue({ proposalsGenerated: 2 }),
    getCycleHistory: vi.fn().mockResolvedValue([]),
    getSoulHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockTracker() {
  return {
    getAgentMetrics: vi.fn().mockResolvedValue({ totalActions: 100 }),
    getPerformanceTrend: vi.fn().mockResolvedValue([]),
    getBundlePerformance: vi.fn().mockResolvedValue([]),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  engine?: ReturnType<typeof createMockEngine>,
  tracker?: ReturnType<typeof createMockTracker>,
) {
  const improvementEngine = engine ?? createMockEngine();
  const performanceTracker = tracker ?? createMockTracker();
  const router = createImprovementRouter(
    pool as any, TEST_HMAC_SECRET,
    improvementEngine as any, performanceTracker as any,
    SDK_CONFIG,
  );
  return { app: createTestApp(router), improvementEngine, performanceTracker };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/improvement/settings
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/settings", () => {
  it("returns existing settings", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app).get("/v1/improvement/settings").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.scanIntervalHours).toBe(24);
    expect(engine.getSettings).toHaveBeenCalledWith(TEST_AGENT.id);
  });

  it("returns defaults when no settings exist", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.getSettings.mockResolvedValue(null);
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app).get("/v1/improvement/settings").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.scanIntervalHours).toBe(24);
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/improvement/settings
// ---------------------------------------------------------------------------

describe("PUT /v1/improvement/settings", () => {
  it("updates settings", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ enabled: true, scanIntervalHours: 12 });

    expect(res.status).toBe(200);
    expect(engine.updateSettings).toHaveBeenCalledWith(TEST_AGENT.id, expect.objectContaining({
      enabled: true,
      scanIntervalHours: 12,
    }));
  });

  it("rejects non-boolean enabled", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("boolean");
  });

  it("rejects scanIntervalHours out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ scanIntervalHours: 200 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 and 168");
  });

  it("rejects maxCreditsPerCycle out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ maxCreditsPerCycle: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1,000");
  });

  it("rejects maxProposalsPerWeek out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ maxProposalsPerWeek: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 and 50");
  });

  it("rejects autoApplyThreshold out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ autoApplyThreshold: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("0.0 and 1.0");
  });

  it("rejects non-boolean soulEvolutionEnabled", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/improvement/settings")
      .set(authHeader())
      .send({ soulEvolutionEnabled: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("boolean");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/improvement/proposals
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/proposals", () => {
  it("returns proposals with pagination", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.getProposals.mockResolvedValue([{ id: "prop_1", status: "pending" }]);
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/improvement/proposals?status=pending&limit=10&offset=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(engine.getProposals).toHaveBeenCalledWith(TEST_AGENT.id, "pending", 10, 5);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/improvement/proposals/:id/approve
// ---------------------------------------------------------------------------

describe("POST /v1/improvement/proposals/:id/approve", () => {
  it("approves a proposal", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/improvement/proposals/prop_1/approve")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.decision).toBe("approved");
    expect(engine.approveProposal).toHaveBeenCalledWith("prop_1", TEST_AGENT.id);
  });

  it("returns 404 for unknown proposal", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.approveProposal.mockRejectedValue(new Error("PROPOSAL_NOT_FOUND_OR_NOT_PENDING"));
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/improvement/proposals/prop_missing/approve")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/improvement/proposals/:id/reject
// ---------------------------------------------------------------------------

describe("POST /v1/improvement/proposals/:id/reject", () => {
  it("rejects a proposal", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/improvement/proposals/prop_1/reject")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("rejected");
  });

  it("returns 404 for unknown proposal", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.rejectProposal.mockRejectedValue(new Error("PROPOSAL_NOT_FOUND_OR_NOT_PENDING"));
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/improvement/proposals/prop_missing/reject")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/improvement/trigger
// ---------------------------------------------------------------------------

describe("POST /v1/improvement/trigger", () => {
  it("triggers improvement cycle", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    const { app } = buildApp(pool, engine);
    setupAuth(pool);
    // Rate limit check — no recent cycle
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/improvement/trigger")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.proposalsGenerated).toBe(2);
    expect(engine.runImprovementCycle).toHaveBeenCalledWith(TEST_AGENT.id, TEST_AGENT.address, "manual");
  });

  it("returns 429 when rate limited", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Rate limit check — cycle ran 10 minutes ago
    pool.query.mockResolvedValueOnce({
      rows: [{ created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/improvement/trigger")
      .set(authHeader());

    expect(res.status).toBe(429);
    expect(res.body.error).toContain("once per hour");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/improvement/cycles
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/cycles", () => {
  it("returns cycle history", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.getCycleHistory.mockResolvedValue([{ id: "cyc_1", trigger: "manual" }]);
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app).get("/v1/improvement/cycles").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.cycles).toHaveLength(1);
    expect(engine.getCycleHistory).toHaveBeenCalledWith(TEST_AGENT.id, 20);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/improvement/performance
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/performance", () => {
  it("returns metrics and trend", async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const { app } = buildApp(pool, undefined, tracker);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/improvement/performance?periodDays=7")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.metrics).toBeDefined();
    expect(res.body.trend).toBeDefined();
    expect(tracker.getAgentMetrics).toHaveBeenCalledWith(TEST_AGENT.id, 7);
    expect(tracker.getPerformanceTrend).toHaveBeenCalledWith(TEST_AGENT.id, 7);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/improvement/performance/knowledge
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/performance/knowledge", () => {
  it("returns bundle performance when bundleId provided", async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    tracker.getBundlePerformance.mockResolvedValue([{ contentCid: "cid_1" }]);
    const { app } = buildApp(pool, undefined, tracker);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/improvement/performance/knowledge?bundleId=42")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.bundleId).toBe(42);
    expect(tracker.getBundlePerformance).toHaveBeenCalledWith(TEST_AGENT.id, 42);
  });

  it("returns all knowledge items without bundleId", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Pool query for knowledge_performance table
    pool.query.mockResolvedValueOnce({
      rows: [{
        content_cid: "cid_1",
        bundle_id: 1,
        usage_count: 10,
        success_count: 8,
        failure_count: 2,
        avg_quality: "0.85",
        last_used_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/improvement/performance/knowledge")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].avgQuality).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/improvement/soul-history
// ---------------------------------------------------------------------------

describe("GET /v1/improvement/soul-history", () => {
  it("returns soul version history", async () => {
    const pool = createMockPool();
    const engine = createMockEngine();
    engine.getSoulHistory.mockResolvedValue([{ version: 1, cid: "bafysoul" }]);
    const { app } = buildApp(pool, engine);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/improvement/soul-history?limit=10&offset=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(engine.getSoulHistory).toHaveBeenCalledWith(TEST_AGENT.id, 10, 5);
  });
});
