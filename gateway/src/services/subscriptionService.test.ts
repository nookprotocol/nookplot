import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubscriptionService, PLAN_DEFINITIONS, PACK_ID_TO_PLAN } from "./subscriptionService.js";
import { CreditManager } from "./creditManager.js";
import { createMockPool, type MockPoolClient } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function setupMockClient(pool: ReturnType<typeof createMockPool>) {
  const mockClient: MockPoolClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  pool.connect.mockResolvedValue(mockClient);
  return mockClient;
}

const mockCreditManager = {
  addCredits: vi.fn().mockResolvedValue({ balanceAfter: 15000 }),
} as unknown as CreditManager;

// ---------------------------------------------------------------------------
//  Plan definitions
// ---------------------------------------------------------------------------

describe("SubscriptionService — plan definitions", () => {
  it("defines four plans", () => {
    expect(Object.keys(PLAN_DEFINITIONS)).toEqual(["free", "starter", "builder", "pro"]);
  });

  it("maps pack IDs to plans", () => {
    expect(PACK_ID_TO_PLAN[3]).toBe("starter");
    expect(PACK_ID_TO_PLAN[4]).toBe("builder");
    expect(PACK_ID_TO_PLAN[5]).toBe("pro");
  });

  it("starter plan has correct pricing", () => {
    expect(PLAN_DEFINITIONS.starter.usdcPrice).toBe(5);
    expect(PLAN_DEFINITIONS.starter.monthlyCredits).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
//  activate
// ---------------------------------------------------------------------------

describe("SubscriptionService — activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid plan", async () => {
    const pool = createMockPool();
    const svc = new SubscriptionService(pool as any, mockCreditManager);
    await expect(svc.activate("agt_1", "free")).rejects.toThrow("INVALID_PLAN");
    await expect(svc.activate("agt_1", "nonexistent")).rejects.toThrow("INVALID_PLAN");
  });

  it("activates a starter subscription", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Cancel existing active
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT subscription
    client.query.mockResolvedValueOnce({
      rows: [{ id: "sub_1", current_period_start: now, current_period_end: end }],
      rowCount: 1,
    });
    // UPDATE credit_accounts
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    const result = await svc.activate("agt_1", "starter", "0xabc");

    expect(result.plan).toBe("starter");
    expect(result.planName).toBe("Starter");
    expect(result.status).toBe("active");
    expect(result.monthlyCreditsRemaining).toBe(15_000);

    // Should have allocated monthly credits
    expect(mockCreditManager.addCredits).toHaveBeenCalledWith(
      "agt_1",
      15_000,
      "subscription_credits",
      expect.stringContaining("sub-starter-"),
    );
  });
});

// ---------------------------------------------------------------------------
//  getStatus
// ---------------------------------------------------------------------------

describe("SubscriptionService — getStatus", () => {
  it("returns free plan when no active subscription", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    const status = await svc.getStatus("agt_1");

    expect(status.plan).toBe("free");
    expect(status.planName).toBe("Free");
    expect(status.currentPeriodStart).toBeNull();
  });

  it("returns active subscription", async () => {
    const pool = createMockPool();
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    pool.query.mockResolvedValueOnce({
      rows: [{
        plan: "builder",
        status: "active",
        current_period_start: now,
        current_period_end: end,
        monthly_credits_remaining: "80000",
        inference_tokens_remaining: "1500000",
      }],
      rowCount: 1,
    });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    const status = await svc.getStatus("agt_1");

    expect(status.plan).toBe("builder");
    expect(status.planName).toBe("Builder");
    expect(status.monthlyCreditsRemaining).toBe(80000);
    expect(status.inferenceTokensRemaining).toBe(1500000);
  });
});

// ---------------------------------------------------------------------------
//  cancel
// ---------------------------------------------------------------------------

describe("SubscriptionService — cancel", () => {
  it("throws when no active subscription", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    await expect(svc.cancel("agt_1")).rejects.toThrow("NO_ACTIVE_SUBSCRIPTION");
  });

  it("cancels active subscription and resets plan to free", async () => {
    const pool = createMockPool();
    // UPDATE subscriptions
    pool.query.mockResolvedValueOnce({ rows: [{ id: "sub_1" }], rowCount: 1 });
    // UPDATE credit_accounts
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    await svc.cancel("agt_1");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("subscription_plan = 'free'"),
      expect.arrayContaining(["agt_1"]),
    );
  });
});

// ---------------------------------------------------------------------------
//  checkExpired
// ---------------------------------------------------------------------------

describe("SubscriptionService — checkExpired", () => {
  it("expires and resets overdue subscriptions", async () => {
    const pool = createMockPool();
    // UPDATE returning expired rows
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "sub_1", agent_id: "agt_1", plan: "starter" },
        { id: "sub_2", agent_id: "agt_2", plan: "pro" },
      ],
      rowCount: 2,
    });
    // UPDATE credit_accounts for agt_1
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // UPDATE credit_accounts for agt_2
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    const expired = await svc.checkExpired();

    expect(expired).toBe(2);
  });

  it("returns 0 when nothing to expire", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SubscriptionService(pool as any, mockCreditManager);
    const expired = await svc.checkExpired();

    expect(expired).toBe(0);
  });
});
