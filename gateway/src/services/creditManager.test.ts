import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreditManager } from "./creditManager.js";
import type { CreditManagerConfig } from "./creditManager.js";
import { createMockPool, type MockPoolClient } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: CreditManagerConfig = {
  pricing: {
    openai: {
      "gpt-4": { promptPerMToken: 30, completionPerMToken: 60 },
    },
    anthropic: {
      "claude-3-5-sonnet-20241022": { promptPerMToken: 3, completionPerMToken: 15 },
    },
  },
  defaultInitialCredits: 3800,
  maxDailySpend: 0,
  minBalance: 0,
};

function setupMockClient(pool: ReturnType<typeof createMockPool>) {
  const mockClient: MockPoolClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  pool.connect.mockResolvedValue(mockClient);
  return mockClient;
}

// ---------------------------------------------------------------------------
//  Static helpers
// ---------------------------------------------------------------------------

describe("CreditManager — static helpers", () => {
  it("toDisplay converts stored credits to display", () => {
    expect(CreditManager.toDisplay(100)).toBe(1);
    expect(CreditManager.toDisplay(1000)).toBe(10);
    expect(CreditManager.toDisplay(0)).toBe(0);
    expect(CreditManager.toDisplay(50)).toBe(0.5);
  });

  it("toStored converts display to stored credits", () => {
    expect(CreditManager.toStored(1)).toBe(100);
    expect(CreditManager.toStored(10)).toBe(1000);
    expect(CreditManager.toStored(0)).toBe(0);
  });

});

// ---------------------------------------------------------------------------
//  calculateCost
// ---------------------------------------------------------------------------

describe("CreditManager — calculateCost", () => {
  let cm: CreditManager;

  beforeEach(() => {
    const pool = createMockPool();
    cm = new CreditManager(pool as any, TEST_CONFIG);
  });

  it("calculates cost for known provider+model", () => {
    // 1M prompt tokens at 30 credits/M + 1M completion tokens at 60 credits/M = 90
    const cost = cm.calculateCost("openai", "gpt-4", 1_000_000, 1_000_000);
    expect(cost).toBe(90);
  });

  it("returns 0 for unknown provider", () => {
    const cost = cm.calculateCost("unknown", "model", 1000, 1000);
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown model", () => {
    const cost = cm.calculateCost("openai", "unknown-model", 1000, 1000);
    expect(cost).toBe(0);
  });

  it("uses Math.ceil for fractional costs", () => {
    // Small token count should still charge at least 1 credit per component
    const cost = cm.calculateCost("openai", "gpt-4", 1, 1);
    expect(cost).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
//  createAccount
// ---------------------------------------------------------------------------

describe("CreditManager — createAccount", () => {
  it("inserts account with default initial credits", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);
    // BEGIN, INSERT account, INSERT transaction, COMMIT
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await cm.createAccount("agt_1");

    // Should have called connect() for transaction
    expect(pool.connect).toHaveBeenCalled();
    // Should have inserted with default credits (3800)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("credit_accounts"),
      expect.arrayContaining(["agt_1", 3800]),
    );
  });

  it("inserts account with custom initial credits", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await cm.createAccount("agt_1", 5000);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("credit_accounts"),
      expect.arrayContaining(["agt_1", 5000]),
    );
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("CreditManager — getBalance", () => {
  it("returns account info when account exists", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "1000",
        lifetime_earned: "5000",
        lifetime_spent: "4000",
        auto_convert_pct: 25,
        status: "active",
      }],
      rowCount: 1,
    });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    const result = await cm.getBalance("agt_1");

    expect(result).not.toBeNull();
    expect(result!.balance).toBe(1000);
    expect(result!.lifetimeEarned).toBe(5000);
    expect(result!.lifetimeSpent).toBe(4000);
    expect(result!.autoConvertPct).toBe(25);
    expect(result!.status).toBe("active");
  });

  it("returns null when account does not exist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    const result = await cm.getBalance("nonexistent");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  deductCredits
// ---------------------------------------------------------------------------

describe("CreditManager — deductCredits", () => {
  it("throws on non-positive amount", async () => {
    const pool = createMockPool();
    const cm = new CreditManager(pool as any, TEST_CONFIG);

    await expect(cm.deductCredits("agt_1", 0, "req_1")).rejects.toThrow("positive");
    await expect(cm.deductCredits("agt_1", -10, "req_1")).rejects.toThrow("positive");
  });

  it("throws ACCOUNT_NOT_FOUND when account does not exist", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — no rows (account not found)
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // No daily spend query — maxDailySpend is 0 (unlimited)
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await expect(cm.deductCredits("agt_1", 50, "req_1")).rejects.toThrow("ACCOUNT_NOT_FOUND");
  });

  it("throws INSUFFICIENT_CREDITS when balance is too low", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance too low
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "10",
        lifetime_spent: "0",
        lifetime_earned: "1000",
        has_purchased: false,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // No daily spend query — maxDailySpend is 0 (unlimited)
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await expect(cm.deductCredits("agt_1", 50, "req_1")).rejects.toThrow("INSUFFICIENT_CREDITS");
  });

  it("deducts credits successfully (no daily spend check when maxDailySpend=0)", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "1000",
        lifetime_spent: "0",
        lifetime_earned: "1000",
        has_purchased: false,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // No daily spend query — maxDailySpend is 0 (unlimited)
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    const result = await cm.deductCredits("agt_1", 50, "req_1");

    expect(result.balanceAfter).toBe(950);
    expect(client.release).toHaveBeenCalled();
  });

  it("enforces daily spend limit when maxDailySpend > 0", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    const configWithCap = { ...TEST_CONFIG, maxDailySpend: 100 };

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "1000",
        lifetime_spent: "0",
        lifetime_earned: "1000",
        has_purchased: false,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // Daily spend query — already spent 80
    client.query.mockResolvedValueOnce({ rows: [{ total: "80" }], rowCount: 1 });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, configWithCap);
    await expect(cm.deductCredits("agt_1", 50, "req_1")).rejects.toThrow("DAILY_SPEND_LIMIT");
  });
});

// ---------------------------------------------------------------------------
//  addCredits
// ---------------------------------------------------------------------------

describe("CreditManager — addCredits", () => {
  it("throws on non-positive amount", async () => {
    const pool = createMockPool();
    const cm = new CreditManager(pool as any, TEST_CONFIG);

    await expect(cm.addCredits("agt_1", 0, "top_up")).rejects.toThrow("positive");
  });

  it("throws ACCOUNT_NOT_FOUND when account does not exist", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — no rows
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await expect(cm.addCredits("agt_1", 100, "top_up")).rejects.toThrow("ACCOUNT_NOT_FOUND");
  });

  it("adds credits successfully", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE
    client.query.mockResolvedValueOnce({
      rows: [{ balance_credits: "500", lifetime_earned: "1000", has_purchased: false }],
      rowCount: 1,
    });
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    const result = await cm.addCredits("agt_1", 200, "top_up");

    expect(result.balanceAfter).toBe(700);
  });
});

// ---------------------------------------------------------------------------
//  getTransactions
// ---------------------------------------------------------------------------

describe("CreditManager — getTransactions", () => {
  it("returns paginated transactions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "tx_1",
          agent_id: "agt_1",
          amount_credits: -50,
          balance_after: 950,
          type: "relay_spend",
          reference_id: "ref_1",
          created_at: new Date("2025-01-01T00:00:00Z"),
        },
      ],
      rowCount: 1,
    });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    const txs = await cm.getTransactions("agt_1", 20, 0);

    expect(txs).toHaveLength(1);
    expect(txs[0].amountCredits).toBe(-50);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("credit_transactions"),
      ["agt_1", 20, 0],
    );
  });
});

// ---------------------------------------------------------------------------
//  setAutoConvertPct
// ---------------------------------------------------------------------------

describe("CreditManager — setAutoConvertPct", () => {
  it("rejects percentage out of range", async () => {
    const pool = createMockPool();
    const cm = new CreditManager(pool as any, TEST_CONFIG);

    await expect(cm.setAutoConvertPct("agt_1", -1)).rejects.toThrow();
    await expect(cm.setAutoConvertPct("agt_1", 101)).rejects.toThrow();
  });

  it("updates auto-convert percentage", async () => {
    const pool = createMockPool();
    // Check account exists
    pool.query.mockResolvedValueOnce({ rows: [{ auto_convert_pct: 0 }], rowCount: 1 });
    // UPDATE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await cm.setAutoConvertPct("agt_1", 50);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("auto_convert_pct"),
      expect.arrayContaining([50, "agt_1"]),
    );
  });
});

// ---------------------------------------------------------------------------
//  Balance floor (grace credit reserve)
// ---------------------------------------------------------------------------

const GRACE_CONFIG: CreditManagerConfig = {
  ...TEST_CONFIG,
  minBalance: 500,
};

describe("CreditManager — deductCredits balance floor", () => {
  it("deducts into negative for purchased agent when minBalance > 0", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 100, purchased agent
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "100",
        lifetime_spent: "900",
        lifetime_earned: "1000",
        has_purchased: true,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    const result = await cm.deductCredits("agt_1", 300, "req_1");

    // 100 - 300 = -200, which is above the floor of -500
    expect(result.balanceAfter).toBe(-200);
  });

  it("throws INSUFFICIENT_CREDITS when purchased agent exceeds floor", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 100, purchased agent
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "100",
        lifetime_spent: "900",
        lifetime_earned: "1000",
        has_purchased: true,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    // 100 - 700 = -600, below floor of -500
    await expect(cm.deductCredits("agt_1", 700, "req_1")).rejects.toThrow("INSUFFICIENT_CREDITS");
  });

  it("free-tier agent still gets hard wall at zero", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 10, free-tier agent
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "10",
        lifetime_spent: "990",
        lifetime_earned: "1000",
        has_purchased: false,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    await expect(cm.deductCredits("agt_1", 50, "req_1")).rejects.toThrow("INSUFFICIENT_CREDITS");
  });

  it("purchased agent with minBalance=0 (feature off) still gets hard wall", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 10, purchased agent
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "10",
        lifetime_spent: "990",
        lifetime_earned: "1000",
        has_purchased: true,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // minBalance=0 means floor is 0 even for purchased agents
    const cm = new CreditManager(pool as any, TEST_CONFIG);
    await expect(cm.deductCredits("agt_1", 50, "req_1")).rejects.toThrow("INSUFFICIENT_CREDITS");
  });
});

describe("CreditManager — computeStatus with negative balance", () => {
  it("status is low_power when purchased agent goes negative within floor", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 50, purchased
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "50",
        lifetime_spent: "950",
        lifetime_earned: "1000",
        has_purchased: true,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // No daily spend query — maxDailySpend is 0 (unlimited)
    // UPDATE balance — capture the status arg
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    await cm.deductCredits("agt_1", 150, "req_1");

    // The UPDATE call is the 3rd query (index 2): [newBalance, newLifetimeSpent, status, agentId]
    const updateCall = client.query.mock.calls[2];
    const statusArg = updateCall[1][2];
    expect(statusArg).toBe("low_power");
  });

  it("status is paused when balance hits floor exactly", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance 100, purchased
    client.query.mockResolvedValueOnce({
      rows: [{
        balance_credits: "100",
        lifetime_spent: "900",
        lifetime_earned: "1000",
        has_purchased: true,
        budget_low_threshold: null,
        budget_critical_threshold: null,
      }],
      rowCount: 1,
    });
    // No daily spend query — maxDailySpend is 0 (unlimited)
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    // 100 - 600 = -500, exactly at the floor
    await cm.deductCredits("agt_1", 600, "req_1");

    const updateCall = client.query.mock.calls[2];
    const statusArg = updateCall[1][2];
    expect(statusArg).toBe("paused");
  });
});

describe("CreditManager — addCredits status transitions from negative", () => {
  it("status is low_power after partial top-up (still negative)", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance -300, purchased
    client.query.mockResolvedValueOnce({
      rows: [{ balance_credits: "-300", lifetime_earned: "1000", has_purchased: true }],
      rowCount: 1,
    });
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    // -300 + 100 = -200, still negative but above floor
    const result = await cm.addCredits("agt_1", 100, "purchase");

    expect(result.balanceAfter).toBe(-200);
    // The UPDATE call is the 3rd query (index 2): [newBalance, newLifetimeEarned, status, agentId]
    const updateCall = client.query.mock.calls[2];
    const statusArg = updateCall[1][2];
    expect(statusArg).toBe("low_power");
  });

  it("status is active after full top-up clears debt", async () => {
    const pool = createMockPool();
    const client = setupMockClient(pool);

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT FOR UPDATE — balance -300, purchased
    client.query.mockResolvedValueOnce({
      rows: [{ balance_credits: "-300", lifetime_earned: "1000", has_purchased: true }],
      rowCount: 1,
    });
    // UPDATE balance
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT transaction
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const cm = new CreditManager(pool as any, GRACE_CONFIG);
    // -300 + 1000 = 700, well above zero
    const result = await cm.addCredits("agt_1", 1000, "purchase");

    expect(result.balanceAfter).toBe(700);
    const updateCall = client.query.mock.calls[2];
    const statusArg = updateCall[1][2];
    expect(statusArg).toBe("active");
  });
});
