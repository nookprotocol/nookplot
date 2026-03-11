import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createProactiveRouter } from "./proactive.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_pro", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });
const ADMIN_ADDRESS = TEST_AGENT.address;

function createMockScheduler() {
  return {
    getSettings: vi.fn().mockResolvedValue({
      agentId: "agt_pro",
      enabled: true,
      scanIntervalMinutes: 10,
      maxCreditsPerCycle: 5000,
      maxActionsPerDay: 10,
    }),
    updateSettings: vi.fn().mockResolvedValue({
      agentId: "agt_pro",
      enabled: true,
      scanIntervalMinutes: 5,
    }),
    getActivity: vi.fn().mockResolvedValue([]),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    approveAction: vi.fn().mockResolvedValue(undefined),
    rejectAction: vi.fn().mockResolvedValue(undefined),
    getScanHistory: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ totalActions: 10, completedActions: 8 }),
    isActive: vi.fn().mockReturnValue(true),
    stop: vi.fn(),
    start: vi.fn(),
  };
}

function createMockBroadcaster() {
  return {
    broadcast: vi.fn(),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  scheduler?: ReturnType<typeof createMockScheduler>,
  broadcaster?: ReturnType<typeof createMockBroadcaster>,
  adminAddr?: string,
) {
  const s = scheduler ?? createMockScheduler();
  const b = broadcaster ?? createMockBroadcaster();
  const router = createProactiveRouter(pool as any, TEST_HMAC_SECRET, s as any, b as any, adminAddr ?? ADMIN_ADDRESS);
  return { app: createTestApp(router), scheduler: s, broadcaster: b };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/proactive/settings
// ---------------------------------------------------------------------------

describe("GET /v1/proactive/settings", () => {
  it("returns existing settings", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app).get("/v1/proactive/settings").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.schedulerActive).toBe(true);
  });

  it("returns defaults when no settings exist", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.getSettings.mockResolvedValue(null);
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app).get("/v1/proactive/settings").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.scanIntervalMinutes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/proactive/settings
// ---------------------------------------------------------------------------

describe("PUT /v1/proactive/settings", () => {
  it("updates settings", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ enabled: true, scanIntervalMinutes: 5 });

    expect(res.status).toBe(200);
    expect(scheduler.updateSettings).toHaveBeenCalledWith(TEST_AGENT.id, expect.objectContaining({
      enabled: true,
      scanIntervalMinutes: 5,
    }));
  });

  it("rejects scanIntervalMinutes out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scanIntervalMinutes: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("3 and 1440");
  });

  it("rejects maxActionsPerDay out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ maxActionsPerDay: 200 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 and 100");
  });

  it("rejects invalid creativityLevel", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ creativityLevel: "chaotic" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("creativityLevel");
  });

  it("rejects invalid socialLevel", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ socialLevel: "antisocial" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("socialLevel");
  });

  it("rejects non-HTTPS callbackUrl", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ callbackUrl: "http://example.com/webhook" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("HTTPS");
  });

  it("allows localhost callbackUrl", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ callbackUrl: "http://localhost:3000/webhook" });

    expect(res.status).toBe(200);
  });

  it("updates enhanced settings via pool query", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    // Enhanced settings UPDATE query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ channelCooldownSeconds: 60, creativityLevel: "active" });

    expect(res.status).toBe(200);
    // Should have called pool.query for enhanced settings
    const calls = pool.query.mock.calls;
    const updateCall = calls.find(c => typeof c[0] === "string" && c[0].includes("channel_cooldown_seconds"));
    expect(updateCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/proactive/settings — discovery affordances
// ---------------------------------------------------------------------------

describe("PUT /v1/proactive/settings — discovery affordances", () => {
  it("accepts valid scannerPriorities", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scannerPriorities: { scanBounties: 10, scanPotentialFriends: 0 } });

    expect(res.status).toBe(200);
    const calls = pool.query.mock.calls;
    const updateCall = calls.find(c => typeof c[0] === "string" && c[0].includes("scanner_priorities"));
    expect(updateCall).toBeDefined();
  });

  it("rejects scannerPriorities with out-of-range values", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scannerPriorities: { scanBounties: 15 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("0-10");
  });

  it("rejects scannerPriorities with non-integer values", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scannerPriorities: { scanBounties: 3.5 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("0-10");
  });

  it("rejects scannerPriorities when not an object", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scannerPriorities: [1, 2, 3] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scannerPriorities");
  });

  it("rejects scannerPriorities with too many entries", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const priorities: Record<string, number> = {};
    for (let i = 0; i < 25; i++) priorities[`scan${i}`] = 5;

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ scannerPriorities: priorities });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("20");
  });

  it("accepts valid budget fields", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ budgetSocial: 500, budgetContent: 1000, budgetBounties: null });

    expect(res.status).toBe(200);
  });

  it("rejects budget field out of range", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ budgetSocial: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("budgetSocial");
  });

  it("accepts valid discoveryCadence", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ discoveryCadence: "aggressive" });

    expect(res.status).toBe(200);
  });

  it("rejects invalid discoveryCadence", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ discoveryCadence: "frantic" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("discoveryCadence");
  });

  it("allows null discoveryCadence to clear it", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .put("/v1/proactive/settings")
      .set(authHeader())
      .send({ discoveryCadence: null });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/proactive/activity
// ---------------------------------------------------------------------------

describe("GET /v1/proactive/activity", () => {
  it("returns activity feed", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.getActivity.mockResolvedValue([{ id: "act_1", type: "post" }]);
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/proactive/activity?limit=10&offset=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    expect(scheduler.getActivity).toHaveBeenCalledWith(TEST_AGENT.id, 10, 5);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/proactive/approvals
// ---------------------------------------------------------------------------

describe("GET /v1/proactive/approvals", () => {
  it("returns pending approvals", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.getPendingApprovals.mockResolvedValue([{ id: "pa_1", type: "post" }]);
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app).get("/v1/proactive/approvals").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/proactive/approvals/:id/approve
// ---------------------------------------------------------------------------

describe("POST /v1/proactive/approvals/:id/approve", () => {
  it("approves an action", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const broadcaster = createMockBroadcaster();
    const { app } = buildApp(pool, scheduler, broadcaster);
    setupAuth(pool);
    // Self-approval check
    pool.query.mockResolvedValueOnce({ rows: [{ agent_id: "agt_other" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/proactive/approvals/pa_1/approve")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.decision).toBe("approved");
    expect(scheduler.approveAction).toHaveBeenCalledWith("pa_1", TEST_AGENT.id);
    expect(broadcaster.broadcast).toHaveBeenCalled();
  });

  it("returns 404 for unknown action", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.approveAction.mockRejectedValue(new Error("ACTION_NOT_FOUND_OR_NOT_PENDING"));
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/proactive/approvals/pa_missing/approve")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/proactive/approvals/:id/reject
// ---------------------------------------------------------------------------

describe("POST /v1/proactive/approvals/:id/reject", () => {
  it("rejects an action", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/proactive/approvals/pa_1/reject")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("rejected");
  });

  it("returns 404 for unknown action", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.rejectAction.mockRejectedValue(new Error("ACTION_NOT_FOUND_OR_NOT_PENDING"));
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/proactive/approvals/pa_missing/reject")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/proactive/scans
// ---------------------------------------------------------------------------

describe("GET /v1/proactive/scans", () => {
  it("returns scan history", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    scheduler.getScanHistory.mockResolvedValue([{ id: "scan_1" }]);
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);

    const res = await request(app).get("/v1/proactive/scans").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.scans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/proactive/stats
// ---------------------------------------------------------------------------

describe("GET /v1/proactive/stats", () => {
  it("returns stats", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).get("/v1/proactive/stats").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.totalActions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/proactive/actions/:id/complete
// ---------------------------------------------------------------------------

describe("POST /v1/proactive/actions/:id/complete", () => {
  it("completes an action", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Action lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_1", status: "approved" }], rowCount: 1 });
    // Update action
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/proactive/actions/act_1/complete")
      .set(authHeader())
      .send({ txHash: "0xabc", result: { success: true } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("completed");
  });

  it("returns 404 for non-completable action", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/proactive/actions/act_missing/complete")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/proactive/halt — Admin
// ---------------------------------------------------------------------------

describe("POST /v1/proactive/halt", () => {
  it("halts scheduler for admin", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    // system_settings upsert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/v1/proactive/halt").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("halted");
    expect(scheduler.stop).toHaveBeenCalled();
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool, undefined, undefined, "0x0000000000000000000000000000000000000000");
    setupAuth(pool);

    const res = await request(app).post("/v1/proactive/halt").set(authHeader());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/proactive/resume — Admin
// ---------------------------------------------------------------------------

describe("POST /v1/proactive/resume", () => {
  it("resumes scheduler for admin", async () => {
    const pool = createMockPool();
    const scheduler = createMockScheduler();
    const { app } = buildApp(pool, scheduler);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/v1/proactive/resume").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resumed");
    expect(scheduler.start).toHaveBeenCalled();
  });
});
