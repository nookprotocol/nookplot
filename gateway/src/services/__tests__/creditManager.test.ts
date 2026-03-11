import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreditManager } from "../creditManager.js";
import type { CreditManagerConfig, CreditEventBroadcaster, CreditInboxSender } from "../creditManager.js";

// Suppress audit log calls
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ============================================================
//  Mock factories
// ============================================================

function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({}), // Default: resolve with empty object (needed for ROLLBACK .catch() chaining)
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

function createMockBroadcaster(): CreditEventBroadcaster & { broadcast: ReturnType<typeof vi.fn> } {
  return { broadcast: vi.fn() };
}

function createMockInboxSender(): CreditInboxSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

// ============================================================
//  Config
// ============================================================

const TEST_CONFIG: CreditManagerConfig = {
  pricing: {
    openai: {
      "gpt-4": { promptPerMToken: 1000, completionPerMToken: 2000 },
      "gpt-3.5-turbo": { promptPerMToken: 100, completionPerMToken: 200 },
    },
    anthropic: {
      "claude-3-opus": { promptPerMToken: 1500, completionPerMToken: 3000 },
    },
  },
  defaultInitialCredits: 5000,
  maxDailySpend: 50000,
  minBalance: 500,
};

// ============================================================
//  Constants
// ============================================================

const AGENT_ID = "agt_test_001";
const AGENT_B = "agt_test_002";
const REQUEST_ID = "req_abc123";

// ============================================================
//  Helpers
// ============================================================

function createManager(configOverrides?: Partial<CreditManagerConfig>) {
  const pool = createMockPool();
  const config = { ...TEST_CONFIG, ...configOverrides };
  const manager = new CreditManager(pool, config);
  const broadcaster = createMockBroadcaster();
  const inboxSender = createMockInboxSender();
  manager.setBroadcaster(broadcaster);
  manager.setInboxService(inboxSender);
  return { pool, manager, broadcaster, inboxSender };
}

// ============================================================
//  Tests
// ============================================================

describe("CreditManager", () => {
  // ── Static helpers ──────────────────────────────────────────

  describe("static helpers", () => {
    it("toDisplay converts stored credits to display (100 → 1.00)", () => {
      expect(CreditManager.toDisplay(100)).toBe(1.0);
      expect(CreditManager.toDisplay(3800)).toBe(38.0);
      expect(CreditManager.toDisplay(0)).toBe(0);
      expect(CreditManager.toDisplay(-250)).toBe(-2.5);
    });

    it("toStored converts display credits to stored (1.00 → 100)", () => {
      expect(CreditManager.toStored(1.0)).toBe(100);
      expect(CreditManager.toStored(38.0)).toBe(3800);
      expect(CreditManager.toStored(0)).toBe(0);
      expect(CreditManager.toStored(0.25)).toBe(25);
    });

    it("toDisplay rounds to nearest integer before dividing", () => {
      // Handles floating-point imprecision
      expect(CreditManager.toDisplay(99.9999999)).toBe(1.0);
      expect(CreditManager.toDisplay(100.0000001)).toBe(1.0);
    });

    it("toStored rounds to nearest integer", () => {
      // 1.005 * 100 = 100.49999... due to IEEE 754, so Math.round gives 100
      expect(CreditManager.toStored(1.005)).toBe(100);
      expect(CreditManager.toStored(0.999)).toBe(100); // Math.round(99.9) = 100
      expect(CreditManager.toStored(1.006)).toBe(101); // Math.round(100.6) = 101
    });
  });

  // ── createAccount ───────────────────────────────────────────

  describe("createAccount", () => {
    it("creates account with default initial credits", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await manager.createAccount(AGENT_ID);

      // Verify transaction sequence: BEGIN → INSERT account → INSERT transaction → COMMIT
      const calls = client.query.mock.calls;
      expect(calls[0][0]).toBe("BEGIN");
      expect(calls[1][0]).toContain("INSERT INTO credit_accounts");
      expect(calls[1][1]).toEqual([AGENT_ID, 5000]); // defaultInitialCredits
      expect(calls[2][0]).toContain("INSERT INTO credit_transactions");
      expect(calls[2][1]).toEqual([AGENT_ID, 5000]);
      expect(calls[3][0]).toBe("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    it("creates account with custom initial credits", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await manager.createAccount(AGENT_ID, 5000);

      const insertCall = client.query.mock.calls[1];
      expect(insertCall[1]).toEqual([AGENT_ID, 5000]);
    });

    it("skips transaction insert when initial credits is 0", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await manager.createAccount(AGENT_ID, 0);

      const calls = client.query.mock.calls;
      expect(calls[0][0]).toBe("BEGIN");
      expect(calls[1][0]).toContain("INSERT INTO credit_accounts");
      expect(calls[2][0]).toBe("COMMIT");
      // No credit_transactions INSERT — only 3 calls total
      expect(calls).toHaveLength(3);
    });

    it("is idempotent (ON CONFLICT DO NOTHING)", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query.mockResolvedValue({ rows: [], rowCount: 0 }); // 0 = conflict, did nothing

      await manager.createAccount(AGENT_ID);

      expect(client.query.mock.calls[1][0]).toContain("ON CONFLICT (agent_id) DO NOTHING");
    });

    it("rolls back on error and re-throws", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error("DB_ERROR")); // INSERT fails

      await expect(manager.createAccount(AGENT_ID)).rejects.toThrow("DB_ERROR");

      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });
  });

  // ── deductCredits ───────────────────────────────────────────

  describe("deductCredits", () => {
    it("deducts credits and returns new balance", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "5000",
            lifetime_spent: "1000",
            lifetime_earned: "6000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ total: "200" }] }) // daily spend check
        .mockResolvedValueOnce({}) // UPDATE credit_accounts
        .mockResolvedValueOnce({}) // INSERT credit_transactions
        .mockResolvedValueOnce({}); // COMMIT

      const result = await manager.deductCredits(AGENT_ID, 100, REQUEST_ID);

      expect(result.balanceAfter).toBe(4900);

      // Verify transaction amount is negative in the ledger
      const txInsert = client.query.mock.calls[4];
      expect(txInsert[1][1]).toBe(-100); // negative amount
      expect(txInsert[1][2]).toBe(4900); // balance_after
      expect(txInsert[1][3]).toBe("inference_spend"); // default type
      expect(txInsert[1][4]).toBe(REQUEST_ID);
    });

    it("rejects non-positive amount", async () => {
      const { manager } = createManager();

      await expect(manager.deductCredits(AGENT_ID, 0, REQUEST_ID)).rejects.toThrow("Deduction amount must be positive");
      await expect(manager.deductCredits(AGENT_ID, -5, REQUEST_ID)).rejects.toThrow("Deduction amount must be positive");
    });

    it("throws ACCOUNT_NOT_FOUND when agent has no account", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — no rows
        .mockResolvedValueOnce({ rows: [{ total: "0" }] }); // daily spend (skipped after account check, but mocked for ordering)

      await expect(manager.deductCredits(AGENT_ID, 100, REQUEST_ID)).rejects.toThrow("ACCOUNT_NOT_FOUND");
    });

    it("throws INSUFFICIENT_CREDITS when balance too low (non-purchased agent)", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "50",
            lifetime_spent: "100",
            lifetime_earned: "150",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] }); // daily spend

      await expect(manager.deductCredits(AGENT_ID, 100, REQUEST_ID)).rejects.toThrow("INSUFFICIENT_CREDITS");
    });

    it("allows overdraft for purchased agents up to minBalance floor", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100",
            lifetime_spent: "500",
            lifetime_earned: "600",
            has_purchased: true,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] }) // daily spend
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      // Balance is 100, deducting 500 → -400. Floor is -500 (minBalance). -400 >= -500, so allowed.
      const result = await manager.deductCredits(AGENT_ID, 500, REQUEST_ID);
      expect(result.balanceAfter).toBe(-400);
    });

    it("rejects overdraft beyond minBalance floor for purchased agents", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100",
            lifetime_spent: "500",
            lifetime_earned: "600",
            has_purchased: true,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] }); // daily spend

      // Balance 100, deducting 700 → -600. Floor is -500. -600 < -500, rejected.
      await expect(manager.deductCredits(AGENT_ID, 700, REQUEST_ID)).rejects.toThrow("INSUFFICIENT_CREDITS");
    });

    it("throws DAILY_SPEND_LIMIT when cap exceeded", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100000",
            lifetime_spent: "0",
            lifetime_earned: "100000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "49500" }] }); // daily spend already near cap

      // Daily cap is 50000. Already spent 49500 + new 1000 = 50500 > 50000.
      await expect(manager.deductCredits(AGENT_ID, 1000, REQUEST_ID)).rejects.toThrow("DAILY_SPEND_LIMIT");
    });

    it("skips daily spend check when maxDailySpend is 0 (unlimited)", async () => {
      const { pool, manager } = createManager({ maxDailySpend: 0 });
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100000",
            lifetime_spent: "0",
            lifetime_earned: "100000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        // No daily spend query — skipped
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await manager.deductCredits(AGENT_ID, 90000, REQUEST_ID);
      expect(result.balanceAfter).toBe(10000);

      // Verify no daily spend query was made (3rd call is UPDATE, not SELECT daily)
      const thirdCall = client.query.mock.calls[2][0];
      expect(thirdCall).toContain("UPDATE credit_accounts");
    });

    it("uses custom type parameter", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "5000",
            lifetime_spent: "0",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.deductCredits(AGENT_ID, 25, REQUEST_ID, "mcp_tool_call");

      const txInsert = client.query.mock.calls[4];
      expect(txInsert[1][3]).toBe("mcp_tool_call");
    });

    it("emits balance_changed event after commit", async () => {
      const { pool, manager, broadcaster } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "5000",
            lifetime_spent: "0",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.deductCredits(AGENT_ID, 100, REQUEST_ID);

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "credits.balance_changed",
          data: expect.objectContaining({
            agentId: AGENT_ID,
            balance: 49, // toDisplay(4900)
            deltaStored: -100,
            reason: "inference_spend",
          }),
        }),
      );
    });

    it("emits budget_alert when crossing low threshold", async () => {
      const { pool, manager, broadcaster, inboxSender } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "600", // above low threshold (500)
            lifetime_spent: "4400",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      // Deduct 200 → balance goes from 600 to 400, crossing below 500
      await manager.deductCredits(AGENT_ID, 200, REQUEST_ID);

      // Should emit budget_alert
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "credits.budget_alert",
          data: expect.objectContaining({ level: "low" }),
        }),
      );
      // Should send DM
      expect(inboxSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          toAgentId: AGENT_ID,
          messageType: "system",
          content: expect.stringContaining("running low"),
        }),
      );
    });

    it("emits critical alert when crossing critical threshold", async () => {
      const { pool, manager, broadcaster, inboxSender } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "150",
            lifetime_spent: "4850",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      // Deduct 100 → balance from 150 to 50, crossing below critical (100)
      await manager.deductCredits(AGENT_ID, 100, REQUEST_ID);

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "credits.budget_alert",
          data: expect.objectContaining({ level: "critical" }),
        }),
      );
      expect(inboxSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("critically low"),
        }),
      );
    });

    it("rolls back on error mid-transaction", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "5000",
            lifetime_spent: "0",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockRejectedValueOnce(new Error("UPDATE_FAILED")); // UPDATE fails

      await expect(manager.deductCredits(AGENT_ID, 100, REQUEST_ID)).rejects.toThrow("UPDATE_FAILED");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });
  });

  // ── addCredits ──────────────────────────────────────────────

  describe("addCredits", () => {
    it("adds credits and returns new balance", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "1000",
            lifetime_earned: "5000",
            has_purchased: false,
          }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await manager.addCredits(AGENT_ID, 500, "purchase", "stripe_abc");

      expect(result.balanceAfter).toBe(1500);

      // Verify positive amount in ledger
      const txInsert = client.query.mock.calls[3];
      expect(txInsert[1][1]).toBe(500); // positive amount
      expect(txInsert[1][2]).toBe(1500); // balance_after
      expect(txInsert[1][3]).toBe("purchase"); // type
      expect(txInsert[1][4]).toBe("stripe_abc"); // referenceId
    });

    it("rejects non-positive amount", async () => {
      const { manager } = createManager();

      await expect(manager.addCredits(AGENT_ID, 0, "refund")).rejects.toThrow("Amount must be positive");
      await expect(manager.addCredits(AGENT_ID, -10, "refund")).rejects.toThrow("Amount must be positive");
    });

    it("throws ACCOUNT_NOT_FOUND for missing agent", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // SELECT — no rows

      await expect(manager.addCredits(AGENT_ID, 100, "refund")).rejects.toThrow("ACCOUNT_NOT_FOUND");
    });

    it("sets referenceId to null when not provided", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ balance_credits: "1000", lifetime_earned: "1000", has_purchased: false }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.addCredits(AGENT_ID, 100, "refund");

      const txInsert = client.query.mock.calls[3];
      expect(txInsert[1][4]).toBeNull();
    });

    it("emits balance_changed event after commit", async () => {
      const { pool, manager, broadcaster } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ balance_credits: "1000", lifetime_earned: "1000", has_purchased: false }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.addCredits(AGENT_ID, 500, "purchase");

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "credits.balance_changed",
          data: expect.objectContaining({
            delta: 5, // toDisplay(500) = 5.0
            reason: "purchase",
          }),
        }),
      );
    });

    it("rolls back on error and re-throws", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_credits: "1000", lifetime_earned: "1000", has_purchased: false }] })
        .mockRejectedValueOnce(new Error("UPDATE_FAILED"));

      await expect(manager.addCredits(AGENT_ID, 100, "refund")).rejects.toThrow("UPDATE_FAILED");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });
  });

  // ── splitCredits ────────────────────────────────────────────

  describe("splitCredits", () => {
    it("splits credits from parent to child", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_credits: "10000", lifetime_earned: "10000" }] }) // SELECT parent
        .mockResolvedValueOnce({}) // UPDATE parent
        .mockResolvedValueOnce({}) // INSERT parent tx
        .mockResolvedValueOnce({}) // INSERT child account
        .mockResolvedValueOnce({}) // INSERT child tx
        .mockResolvedValueOnce({}); // COMMIT

      await manager.splitCredits(AGENT_ID, AGENT_B, 50);

      // Parent deducted 5000 (50% of 10000)
      const parentUpdate = client.query.mock.calls[2];
      expect(parentUpdate[1][0]).toBe(5000); // newParentBalance

      const parentTx = client.query.mock.calls[3];
      expect(parentTx[1][1]).toBe(-5000); // negative

      // Child credited 5000
      const childAccount = client.query.mock.calls[4];
      expect(childAccount[1][1]).toBe(5000);

      const childTx = client.query.mock.calls[5];
      expect(childTx[1][1]).toBe(5000); // positive
    });

    it("rejects invalid split percentage (0 or > 100)", async () => {
      const { manager } = createManager();

      await expect(manager.splitCredits(AGENT_ID, AGENT_B, 0)).rejects.toThrow("Split percentage must be 1-100");
      await expect(manager.splitCredits(AGENT_ID, AGENT_B, 101)).rejects.toThrow("Split percentage must be 1-100");
      await expect(manager.splitCredits(AGENT_ID, AGENT_B, -5)).rejects.toThrow("Split percentage must be 1-100");
    });

    it("creates child with zero credits when split amount is zero", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      // splitCredits connect → client
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_credits: "0", lifetime_earned: "0" }] }) // SELECT parent
        .mockResolvedValueOnce({}) // ROLLBACK (splitAmount <= 0 path)
        // createAccount also calls pool.connect → same client (default mock)
        .mockResolvedValueOnce({}) // BEGIN (createAccount)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT account (ON CONFLICT DO NOTHING)
        .mockResolvedValueOnce({}); // COMMIT (createAccount, no tx insert since credits = 0)

      await manager.splitCredits(AGENT_ID, AGENT_B, 1);

      // Verify the first transaction was rolled back
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      // Verify createAccount was called with 0 credits
      const insertCall = client.query.mock.calls[4];
      expect(insertCall[0]).toContain("INSERT INTO credit_accounts");
      expect(insertCall[1]).toEqual([AGENT_B, 0]);
    });

    it("throws PARENT_ACCOUNT_NOT_FOUND when parent missing", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // SELECT parent — no rows

      await expect(manager.splitCredits(AGENT_ID, AGENT_B, 50)).rejects.toThrow("PARENT_ACCOUNT_NOT_FOUND");
    });

    it("uses Math.floor for split amount", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      // 33% of 100 = 33.0 (exact), but 33% of 101 = 33.33 → floor to 33
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ balance_credits: "101", lifetime_earned: "101" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.splitCredits(AGENT_ID, AGENT_B, 33);

      const parentTx = client.query.mock.calls[3];
      expect(parentTx[1][1]).toBe(-33); // Math.floor(101 * 0.33) = 33
    });
  });

  // ── calculateCost ───────────────────────────────────────────

  describe("calculateCost", () => {
    it("calculates cost for known provider/model", () => {
      const { manager } = createManager();

      // gpt-4: 1000 credits/M prompt, 2000 credits/M completion
      // 1000 prompt tokens = ceil(1000/1M * 1000) = ceil(1) = 1
      // 500 completion = ceil(500/1M * 2000) = ceil(1) = 1
      const cost = manager.calculateCost("openai", "gpt-4", 1000, 500);
      expect(cost).toBe(2);
    });

    it("returns 0 for unknown provider", () => {
      const { manager } = createManager();
      expect(manager.calculateCost("unknown_provider", "model", 1000, 500)).toBe(0);
    });

    it("returns 0 for unknown model", () => {
      const { manager } = createManager();
      expect(manager.calculateCost("openai", "unknown_model", 1000, 500)).toBe(0);
    });

    it("uses Math.ceil for fractional costs", () => {
      const { manager } = createManager();

      // claude-3-opus: 1500 credits/M prompt, 3000 credits/M completion
      // 1 prompt token = ceil(1/1M * 1500) = ceil(0.0015) = 1
      const cost = manager.calculateCost("anthropic", "claude-3-opus", 1, 0);
      expect(cost).toBe(1); // Rounds up from fractional
    });

    it("handles zero tokens", () => {
      const { manager } = createManager();
      const cost = manager.calculateCost("openai", "gpt-4", 0, 0);
      expect(cost).toBe(0);
    });
  });

  // ── getBalance ──────────────────────────────────────────────

  describe("getBalance", () => {
    it("returns account info for existing agent", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({
        rows: [{
          balance_credits: "3800",
          lifetime_earned: "5000",
          lifetime_spent: "1200",
          auto_convert_pct: 10,
          status: "active",
        }],
      });

      const result = await manager.getBalance(AGENT_ID);

      expect(result).toEqual({
        balance: 3800,
        lifetimeEarned: 5000,
        lifetimeSpent: 1200,
        autoConvertPct: 10,
        status: "active",
      });
    });

    it("returns null for non-existent agent", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await manager.getBalance(AGENT_ID);
      expect(result).toBeNull();
    });
  });

  // ── getTransactions ─────────────────────────────────────────

  describe("getTransactions", () => {
    it("returns paginated transaction ledger", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: "tx_1",
            agent_id: AGENT_ID,
            amount_credits: "-100",
            balance_after: "4900",
            type: "inference_spend",
            reference_id: "req_123",
            created_at: new Date("2025-01-01T00:00:00Z"),
          },
          {
            id: "tx_2",
            agent_id: AGENT_ID,
            amount_credits: "3800",
            balance_after: "3800",
            type: "initial_deposit",
            reference_id: "deployment",
            created_at: new Date("2024-12-31T00:00:00Z"),
          },
        ],
      });

      const result = await manager.getTransactions(AGENT_ID, 10, 0);

      expect(result).toHaveLength(2);
      expect(result[0].amountCredits).toBe(-100);
      expect(result[0].balanceAfter).toBe(4900);
      expect(result[0].createdAt).toBe("2025-01-01T00:00:00.000Z");

      // Verify pagination params
      const queryCall = pool.query.mock.calls[0];
      expect(queryCall[1]).toEqual([AGENT_ID, 10, 0]);
    });

    it("returns empty array for agent with no transactions", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await manager.getTransactions(AGENT_ID, 10, 0);
      expect(result).toEqual([]);
    });
  });

  // ── getUsageSummary ─────────────────────────────────────────

  describe("getUsageSummary", () => {
    it("aggregates usage by provider and model", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({
        rows: [
          { provider: "openai", model: "gpt-4", req_count: "10", total_prompt: "5000", total_completion: "2000", total_cost: "300" },
          { provider: "openai", model: "gpt-3.5-turbo", req_count: "20", total_prompt: "8000", total_completion: "3000", total_cost: "100" },
          { provider: "anthropic", model: "claude-3-opus", req_count: "5", total_prompt: "3000", total_completion: "1000", total_cost: "200" },
        ],
      });

      const result = await manager.getUsageSummary(AGENT_ID, 7);

      expect(result.totalRequests).toBe(35);
      expect(result.totalPromptTokens).toBe(16000);
      expect(result.totalCompletionTokens).toBe(6000);
      expect(result.totalCostCredits).toBe(600);

      // By provider
      expect(result.byProvider.openai.requests).toBe(30);
      expect(result.byProvider.anthropic.requests).toBe(5);

      // By model
      expect(result.byModel["gpt-4"].requests).toBe(10);
      expect(result.byModel["gpt-3.5-turbo"].requests).toBe(20);
      expect(result.byModel["claude-3-opus"].requests).toBe(5);
    });

    it("returns empty summary when no usage", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await manager.getUsageSummary(AGENT_ID, 30);

      expect(result.totalRequests).toBe(0);
      expect(result.totalPromptTokens).toBe(0);
      expect(result.totalCostCredits).toBe(0);
      expect(result.byProvider).toEqual({});
      expect(result.byModel).toEqual({});
    });

    it("clamps days to 1-365 range", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValue({ rows: [] });

      await manager.getUsageSummary(AGENT_ID, 0); // → 1
      expect(pool.query.mock.calls[0][1][1]).toBe(1);

      await manager.getUsageSummary(AGENT_ID, 500); // → 365
      expect(pool.query.mock.calls[1][1][1]).toBe(365);

      await manager.getUsageSummary(AGENT_ID, -10); // → 1
      expect(pool.query.mock.calls[2][1][1]).toBe(1);
    });
  });

  // ── autoConvertEarnings ─────────────────────────────────────

  describe("autoConvertEarnings", () => {
    it("converts percentage of earnings to credits", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      // First query: read auto_convert_pct
      pool.query.mockResolvedValueOnce({ rows: [{ auto_convert_pct: 50 }] });

      // addCredits transaction
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_credits: "1000", lifetime_earned: "1000", has_purchased: false }] })
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const converted = await manager.autoConvertEarnings(AGENT_ID, 1000);

      expect(converted).toBe(500); // 50% of 1000
    });

    it("returns 0 when auto_convert_pct is 0", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rows: [{ auto_convert_pct: 0 }] });

      const converted = await manager.autoConvertEarnings(AGENT_ID, 1000);
      expect(converted).toBe(0);
    });

    it("returns 0 when agent has no account", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rows: [] });

      const converted = await manager.autoConvertEarnings(AGENT_ID, 1000);
      expect(converted).toBe(0);
    });
  });

  // ── setAutoConvertPct ───────────────────────────────────────

  describe("setAutoConvertPct", () => {
    it("updates the auto-convert percentage", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await manager.setAutoConvertPct(AGENT_ID, 75);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE credit_accounts SET auto_convert_pct"),
        [75, AGENT_ID],
      );
    });

    it("throws on invalid percentage (< 0 or > 100)", async () => {
      const { manager } = createManager();

      await expect(manager.setAutoConvertPct(AGENT_ID, -1)).rejects.toThrow("Auto-convert percentage must be 0-100");
      await expect(manager.setAutoConvertPct(AGENT_ID, 101)).rejects.toThrow("Auto-convert percentage must be 0-100");
    });

    it("throws ACCOUNT_NOT_FOUND when agent has no account", async () => {
      const { pool, manager } = createManager();

      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await expect(manager.setAutoConvertPct(AGENT_ID, 50)).rejects.toThrow("ACCOUNT_NOT_FOUND");
    });
  });

  // ── computeStatus (via deductCredits / addCredits) ──────────

  describe("status computation", () => {
    it("sets status to 'paused' when balance reaches zero (non-purchased)", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100",
            lifetime_spent: "4900",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.deductCredits(AGENT_ID, 100, REQUEST_ID);

      // Status should be "paused" (balance = 0 <= floor of 0)
      const updateCall = client.query.mock.calls[3];
      expect(updateCall[1][2]).toBe("paused");
    });

    it("sets status to 'low_power' when balance is below 5% of lifetime earned", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "300",
            lifetime_spent: "9700",
            lifetime_earned: "10000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      // Balance goes to 200, which is 2% of 10000 earned (below 5%)
      await manager.deductCredits(AGENT_ID, 100, REQUEST_ID);

      const updateCall = client.query.mock.calls[3];
      expect(updateCall[1][2]).toBe("low_power");
    });

    it("recovers to 'active' status when credits added", async () => {
      const { pool, manager } = createManager();
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "100", // was low
            lifetime_earned: "5000",
            has_purchased: false,
          }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.addCredits(AGENT_ID, 5000, "purchase");

      // Balance is now 5100, well above 5% of 10000 earned → active
      const updateCall = client.query.mock.calls[2];
      expect(updateCall[1][2]).toBe("active");
    });
  });

  // ── No broadcaster / inbox sender (null safety) ─────────────

  describe("null broadcaster/inbox safety", () => {
    it("does not throw when broadcaster is null", async () => {
      const pool = createMockPool();
      const manager = new CreditManager(pool, TEST_CONFIG);
      // Do NOT call setBroadcaster
      const client = pool._client;

      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            balance_credits: "5000",
            lifetime_spent: "0",
            lifetime_earned: "5000",
            has_purchased: false,
            budget_low_threshold: "500",
            budget_critical_threshold: "100",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      // Should not throw even without broadcaster
      await expect(manager.deductCredits(AGENT_ID, 100, REQUEST_ID)).resolves.toEqual({ balanceAfter: 4900 });
    });
  });
});
