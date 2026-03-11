import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubscriptionService, PLAN_DEFINITIONS } from "../subscriptionService.js";

// Suppress audit log calls
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ============================================================
//  Mock factories
// ============================================================

function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({}), // Default: resolve with {} (needed for ROLLBACK .catch() chaining)
    release: vi.fn(),
  };
}

function createMockPool() {
  const client = createMockClient();
  return {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  } as any;
}

function createMockCreditManager() {
  return {
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 10000 }),
  } as any;
}

// ============================================================
//  Constants
// ============================================================

const AGENT_ID = "agt_test_001";
const TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SUB_ID = "sub-uuid-001";

const NOW = new Date("2026-03-04T12:00:00.000Z");
const PERIOD_START = new Date("2026-03-04T12:00:00.000Z");
const PERIOD_END = new Date("2026-04-04T12:00:00.000Z");

// ============================================================
//  Helpers
// ============================================================

function makeInsertRow(overrides: Partial<{ id: string; current_period_start: Date; current_period_end: Date }> = {}) {
  return {
    id: SUB_ID,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    ...overrides,
  };
}

function makeSelectRow(plan: string, overrides: Record<string, unknown> = {}) {
  const def = PLAN_DEFINITIONS[plan];
  return {
    plan,
    status: "active",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    monthly_credits_remaining: String(def.monthlyCredits),
    inference_tokens_remaining: String(def.inferenceTokens),
    ...overrides,
  };
}

// ============================================================
//  activate()
// ============================================================

describe("SubscriptionService.activate()", () => {
  it("activates starter plan: cancels old, inserts new, updates credit_accounts, grants credits", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);
    const client = pool._client;

    // Sequence: BEGIN, cancel old, INSERT (returns row), UPDATE credit_accounts, COMMIT
    client.query
      .mockResolvedValueOnce({})                                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 })                       // cancel old (none found)
      .mockResolvedValueOnce({ rows: [makeInsertRow()] })           // INSERT
      .mockResolvedValueOnce({})                                    // UPDATE credit_accounts
      .mockResolvedValueOnce({});                                   // COMMIT

    const result = await service.activate(AGENT_ID, "starter");

    // Transaction was started and committed
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(5, "COMMIT");

    // Old subscription was cancelled
    const cancelCall = client.query.mock.calls[1];
    expect(cancelCall[0]).toMatch(/UPDATE subscriptions/);
    expect(cancelCall[0]).toMatch(/status = 'cancelled'/);
    expect(cancelCall[1]).toContain(AGENT_ID);

    // New subscription was inserted
    const insertCall = client.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO subscriptions/);
    expect(insertCall[1]).toEqual([
      AGENT_ID,
      "starter",
      PLAN_DEFINITIONS.starter.monthlyCredits,
      PLAN_DEFINITIONS.starter.inferenceTokens,
      null, // no txHash
    ]);

    // credit_accounts updated
    const updateCall = client.query.mock.calls[3];
    expect(updateCall[0]).toMatch(/UPDATE credit_accounts/);
    expect(updateCall[1]).toEqual(["starter", AGENT_ID]);

    // Client was released
    expect(client.release).toHaveBeenCalledOnce();

    // Credits were granted after commit
    expect(creditManager.addCredits).toHaveBeenCalledWith(
      AGENT_ID,
      PLAN_DEFINITIONS.starter.monthlyCredits,
      "subscription_credits",
      `sub-starter-${SUB_ID}`,
    );

    // Return value is correct SubscriptionStatus
    expect(result.plan).toBe("starter");
    expect(result.planName).toBe("Starter");
    expect(result.status).toBe("active");
    expect(result.monthlyCreditsRemaining).toBe(PLAN_DEFINITIONS.starter.monthlyCredits);
    expect(result.inferenceTokensRemaining).toBe(PLAN_DEFINITIONS.starter.inferenceTokens);
    expect(result.currentPeriodStart).toBe(PERIOD_START.toISOString());
    expect(result.currentPeriodEnd).toBe(PERIOD_END.toISOString());
  });

  it("activates pro plan with correct credit amount", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);
    const client = pool._client;

    client.query
      .mockResolvedValueOnce({})                                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 })                       // cancel old
      .mockResolvedValueOnce({ rows: [makeInsertRow()] })           // INSERT
      .mockResolvedValueOnce({})                                    // UPDATE credit_accounts
      .mockResolvedValueOnce({});                                   // COMMIT

    const result = await service.activate(AGENT_ID, "pro");

    expect(result.plan).toBe("pro");
    expect(result.planName).toBe("Pro");
    expect(result.monthlyCreditsRemaining).toBe(PLAN_DEFINITIONS.pro.monthlyCredits);
    expect(result.inferenceTokensRemaining).toBe(PLAN_DEFINITIONS.pro.inferenceTokens);

    expect(creditManager.addCredits).toHaveBeenCalledWith(
      AGENT_ID,
      PLAN_DEFINITIONS.pro.monthlyCredits,
      "subscription_credits",
      `sub-pro-${SUB_ID}`,
    );
  });

  it("passes txHash to the INSERT statement", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);
    const client = pool._client;

    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [makeInsertRow()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await service.activate(AGENT_ID, "builder", TX_HASH);

    const insertCall = client.query.mock.calls[2];
    expect(insertCall[1][4]).toBe(TX_HASH);
  });

  it("throws INVALID_PLAN for an unknown plan name", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    await expect(service.activate(AGENT_ID, "enterprise")).rejects.toThrow("INVALID_PLAN");

    // Should not have tried to connect to the pool
    expect(pool.connect).not.toHaveBeenCalled();
    expect(creditManager.addCredits).not.toHaveBeenCalled();
  });

  it("throws INVALID_PLAN for the free plan", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    await expect(service.activate(AGENT_ID, "free")).rejects.toThrow("INVALID_PLAN");

    expect(pool.connect).not.toHaveBeenCalled();
    expect(creditManager.addCredits).not.toHaveBeenCalled();
  });

  it("rolls back and releases client on error, then re-throws", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);
    const client = pool._client;

    const dbError = new Error("DB connection lost");

    client.query
      .mockResolvedValueOnce({})       // BEGIN
      .mockResolvedValueOnce({})       // cancel old
      .mockRejectedValueOnce(dbError)  // INSERT fails
      // ROLLBACK uses .catch(() => {}) so the default mockResolvedValue({}) handles it
    ;

    await expect(service.activate(AGENT_ID, "starter")).rejects.toThrow("DB connection lost");

    // ROLLBACK was attempted
    const rollbackCall = client.query.mock.calls.find((c: any[]) => c[0] === "ROLLBACK");
    expect(rollbackCall).toBeDefined();

    // Client was still released in finally
    expect(client.release).toHaveBeenCalledOnce();

    // Credits were NOT granted
    expect(creditManager.addCredits).not.toHaveBeenCalled();
  });
});

// ============================================================
//  getStatus()
// ============================================================

describe("SubscriptionService.getStatus()", () => {
  it("returns active subscription details for a subscribed agent", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query.mockResolvedValueOnce({ rows: [makeSelectRow("builder")] });

    const result = await service.getStatus(AGENT_ID);

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]*FROM subscriptions/);
    expect(params).toEqual([AGENT_ID]);

    expect(result.plan).toBe("builder");
    expect(result.planName).toBe("Builder");
    expect(result.status).toBe("active");
    expect(result.monthlyCreditsRemaining).toBe(PLAN_DEFINITIONS.builder.monthlyCredits);
    expect(result.inferenceTokensRemaining).toBe(PLAN_DEFINITIONS.builder.inferenceTokens);
    expect(result.currentPeriodStart).toBe(PERIOD_START.toISOString());
    expect(result.currentPeriodEnd).toBe(PERIOD_END.toISOString());
  });

  it("returns free defaults when no active subscription exists", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await service.getStatus(AGENT_ID);

    expect(result.plan).toBe("free");
    expect(result.planName).toBe("Free");
    expect(result.status).toBe("active");
    expect(result.currentPeriodStart).toBeNull();
    expect(result.currentPeriodEnd).toBeNull();
    expect(result.monthlyCreditsRemaining).toBe(0);
    expect(result.inferenceTokensRemaining).toBe(0);
  });

  it("returns correct plan name from PLAN_DEFINITIONS for all paid plans", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    for (const plan of ["starter", "builder", "pro"] as const) {
      pool.query.mockResolvedValueOnce({ rows: [makeSelectRow(plan)] });
      const result = await service.getStatus(AGENT_ID);
      expect(result.planName).toBe(PLAN_DEFINITIONS[plan].name);
    }
  });
});

// ============================================================
//  cancel()
// ============================================================

describe("SubscriptionService.cancel()", () => {
  it("cancels active subscription and resets plan to free", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    // First call: UPDATE subscriptions (rowCount=1 means a row was updated)
    // Second call: UPDATE credit_accounts
    pool.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await service.cancel(AGENT_ID);

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [cancelSql, cancelParams] = pool.query.mock.calls[0];
    expect(cancelSql).toMatch(/UPDATE subscriptions/);
    expect(cancelSql).toMatch(/status = 'cancelled'/);
    expect(cancelParams).toContain(AGENT_ID);

    const [resetSql, resetParams] = pool.query.mock.calls[1];
    expect(resetSql).toMatch(/UPDATE credit_accounts/);
    expect(resetSql).toMatch(/subscription_plan = 'free'/);
    expect(resetParams).toContain(AGENT_ID);
  });

  it("throws NO_ACTIVE_SUBSCRIPTION when no active sub exists", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    await expect(service.cancel(AGENT_ID)).rejects.toThrow("NO_ACTIVE_SUBSCRIPTION");

    // Should not have proceeded to reset credit_accounts
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it("calls exactly two pool.query calls: UPDATE subscriptions then UPDATE credit_accounts", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await service.cancel(AGENT_ID);

    expect(pool.query).toHaveBeenCalledTimes(2);

    // Verify ordering: subscriptions cancel comes before credit_accounts reset
    const firstSql = pool.query.mock.calls[0][0] as string;
    const secondSql = pool.query.mock.calls[1][0] as string;
    expect(firstSql).toMatch(/subscriptions/);
    expect(secondSql).toMatch(/credit_accounts/);
  });
});

// ============================================================
//  checkExpired()
// ============================================================

describe("SubscriptionService.checkExpired()", () => {
  it("expires multiple subscriptions and resets each agent's plan to free", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    const expiredRows = [
      { id: "sub-001", agent_id: "agt-001", plan: "starter" },
      { id: "sub-002", agent_id: "agt-002", plan: "pro" },
      { id: "sub-003", agent_id: "agt-003", plan: "builder" },
    ];

    // First call: the bulk UPDATE RETURNING expired rows
    pool.query
      .mockResolvedValueOnce({ rows: expiredRows })
      // Subsequent calls: one UPDATE credit_accounts per expired row
      .mockResolvedValue({});

    const count = await service.checkExpired();

    expect(count).toBe(3);

    // Total queries: 1 bulk expire + 3 individual resets
    expect(pool.query).toHaveBeenCalledTimes(4);

    const bulkSql = pool.query.mock.calls[0][0] as string;
    expect(bulkSql).toMatch(/UPDATE subscriptions/);
    expect(bulkSql).toMatch(/status = 'expired'/);
    expect(bulkSql).toMatch(/RETURNING/);

    // Each agent had their credit_accounts reset to free
    for (let i = 0; i < expiredRows.length; i++) {
      const [resetSql, resetParams] = pool.query.mock.calls[i + 1];
      expect(resetSql).toMatch(/UPDATE credit_accounts/);
      expect(resetSql).toMatch(/subscription_plan = 'free'/);
      expect(resetParams).toContain(expiredRows[i].agent_id);
    }
  });

  it("returns the count of expired subscriptions", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: "sub-001", agent_id: "agt-001", plan: "starter" },
          { id: "sub-002", agent_id: "agt-002", plan: "builder" },
        ],
      })
      .mockResolvedValue({});

    const count = await service.checkExpired();

    expect(count).toBe(2);
  });

  it("returns 0 and makes only one query when nothing is expired", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const service = new SubscriptionService(pool, creditManager);

    pool.query.mockResolvedValueOnce({ rows: [] });

    const count = await service.checkExpired();

    expect(count).toBe(0);
    // Only the bulk UPDATE query was executed — no per-agent resets
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
