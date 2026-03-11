import { describe, it, expect, vi, beforeEach } from "vitest";
import { TreasuryService } from "../treasuryService.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 400 }),
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 500 }),
  };
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_ADMIN = "a-admin";
const AGENT_MEMBER = "a-member";
const GUILD_ID = "0x0a";
const BOUNTY_ID = "bounty-001";

const TREASURY_ROW = {
  guild_id: GUILD_ID,
  balance: 5000,
  total_deposited: 10000,
  total_withdrawn: 2000,
  total_funded: 1000,
  total_distributed: 2000,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const messageBus = createMockMessageBus();
  const service = new TreasuryService(pool);
  service.setCreditManager(creditManager);
  service.setMessageBus(messageBus);
  return { pool, creditManager, messageBus, service };
}

/** Set up pool.query mock to handle guild membership check then treasury ops. */
function mockMemberCheck(pool: any) {
  pool.query.mockImplementation((sql: string, _params: any[]) => {
    if (sql.includes("idx_guild_members") && sql.includes("agents")) {
      return { rowCount: 1, rows: [{ member_id: "0xABC" }] };
    }
    if (sql.includes("INSERT INTO guild_treasuries")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("UPDATE guild_treasuries")) {
      return { rowCount: 1, rows: [{ balance: 5100 }] };
    }
    if (sql.includes("INSERT INTO treasury_transactions")) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
}

function mockAdminCheck(pool: any) {
  pool.query.mockImplementation((sql: string, _params: any[]) => {
    if (sql.includes("idx_guilds") && sql.includes("proposer_id")) {
      return { rowCount: 1, rows: [{}] };
    }
    if (sql.includes("UPDATE guild_treasuries")) {
      return { rowCount: 1, rows: [{ balance: 4900 }] };
    }
    if (sql.includes("INSERT INTO treasury_transactions")) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TreasuryService", () => {
  // ── Deposit ──
  describe("deposit", () => {
    it("deducts agent credits and credits treasury", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      mockMemberCheck(pool);

      const result = await service.deposit(AGENT_MEMBER, GUILD_ID, 100, "Monthly dues");
      expect(creditManager.deductCredits).toHaveBeenCalledWith(AGENT_MEMBER, 100, `treasury_deposit:${GUILD_ID}`, "treasury_deposit");
      expect(result.transaction.tx_type).toBe("deposit");
      expect(result.transaction.amount).toBe(100);
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects deposit below minimum", async () => {
      const { service } = createService();
      await expect(service.deposit(AGENT_MEMBER, GUILD_ID, 5)).rejects.toThrow("Minimum deposit");
    });

    it("rejects non-member deposit", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.deposit(AGENT_MEMBER, GUILD_ID, 100)).rejects.toThrow("Not a guild member");
    });

    it("rejects when insufficient credits", async () => {
      const { pool, creditManager, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guild_members")) return { rowCount: 1, rows: [{}] };
        return { rowCount: 0, rows: [] };
      });
      creditManager.deductCredits.mockRejectedValue(new Error("Insufficient balance"));
      await expect(service.deposit(AGENT_MEMBER, GUILD_ID, 100)).rejects.toThrow("Insufficient credits");
    });
  });

  // ── Withdraw ──
  describe("withdraw", () => {
    it("debits treasury and credits agent", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      mockAdminCheck(pool);

      const result = await service.withdraw(AGENT_ADMIN, GUILD_ID, 100, "Refund");
      expect(creditManager.addCredits).toHaveBeenCalledWith(AGENT_ADMIN, 100, "treasury_withdraw", GUILD_ID);
      expect(result.transaction.tx_type).toBe("withdraw");
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects withdraw below minimum", async () => {
      const { service } = createService();
      await expect(service.withdraw(AGENT_ADMIN, GUILD_ID, 5)).rejects.toThrow("Minimum withdrawal");
    });

    it("rejects non-admin withdraw", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.withdraw(AGENT_MEMBER, GUILD_ID, 100)).rejects.toThrow("Not a guild admin");
    });

    it("rejects when insufficient treasury balance", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("UPDATE guild_treasuries")) return { rowCount: 0, rows: [] }; // insufficient
        return { rowCount: 0, rows: [] };
      });
      await expect(service.withdraw(AGENT_ADMIN, GUILD_ID, 100)).rejects.toThrow("Insufficient treasury");
    });
  });

  // ── Fund Bounty ──
  describe("fundBounty", () => {
    it("debits treasury for bounty funding", async () => {
      const { pool, messageBus, service } = createService();
      mockAdminCheck(pool);

      const result = await service.fundBounty(AGENT_ADMIN, GUILD_ID, BOUNTY_ID, 500);
      expect(result.transaction.tx_type).toBe("fund_bounty");
      expect(result.transaction.amount).toBe(500);
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects bounty funding below minimum", async () => {
      const { pool, service } = createService();
      // Admin check must pass first (runs before amount validation)
      mockAdminCheck(pool);
      await expect(service.fundBounty(AGENT_ADMIN, GUILD_ID, BOUNTY_ID, 50)).rejects.toThrow("Minimum bounty funding");
    });

    it("rejects non-admin without proposal", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.fundBounty(AGENT_MEMBER, GUILD_ID, BOUNTY_ID, 500)).rejects.toThrow("Not a guild admin");
    });
  });

  // ── Revenue Distribution ──
  describe("distributeRevenue", () => {
    it("distributes proportional to contribution scores", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      let callIdx = 0;
      pool.query.mockImplementation((sql: string) => {
        // Admin check
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        // Treasury balance
        if (sql.includes("SELECT balance FROM guild_treasuries")) return { rowCount: 1, rows: [{ balance: 10000 }] };
        // Revenue config
        if (sql.includes("guild_revenue_configs")) return { rowCount: 1, rows: [{ treasury_pct: 20, member_pct: 80, distribution_mode: "contribution" }] };
        // Guild members
        if (sql.includes("idx_guild_members") && sql.includes("agents")) {
          return {
            rowCount: 2,
            rows: [
              { agent_id: "a-001", address: "0xAAA" },
              { agent_id: "a-002", address: "0xBBB" },
            ],
          };
        }
        // Contribution scores
        if (sql.includes("contribution_scores")) {
          callIdx++;
          return { rowCount: 1, rows: [{ overall_score: callIdx === 1 ? 300 : 100 }] };
        }
        // Treasury debit
        if (sql.includes("UPDATE guild_treasuries")) return { rowCount: 1, rows: [{ balance: 2000 }] };
        // Distribution record + transaction log
        return { rowCount: 1, rows: [] };
      });

      const result = await service.distributeRevenue(AGENT_ADMIN, GUILD_ID);
      expect(result.recipients).toBe(2);
      expect(result.totalDistributed).toBeGreaterThan(0);
      expect(creditManager.addCredits).toHaveBeenCalled();
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("distributes equally when mode is equal", async () => {
      const { pool, creditManager, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("SELECT balance FROM guild_treasuries")) return { rowCount: 1, rows: [{ balance: 10000 }] };
        if (sql.includes("guild_revenue_configs")) return { rowCount: 1, rows: [{ treasury_pct: 0, member_pct: 100, distribution_mode: "equal" }] };
        if (sql.includes("idx_guild_members") && sql.includes("agents")) {
          return {
            rowCount: 2,
            rows: [
              { agent_id: "a-001", address: "0xAAA" },
              { agent_id: "a-002", address: "0xBBB" },
            ],
          };
        }
        if (sql.includes("UPDATE guild_treasuries")) return { rowCount: 1, rows: [{ balance: 0 }] };
        return { rowCount: 1, rows: [] };
      });

      const result = await service.distributeRevenue(AGENT_ADMIN, GUILD_ID);
      expect(result.recipients).toBe(2);
      // Each should get half
      expect(creditManager.addCredits).toHaveBeenCalledTimes(2);
    });

    it("rejects when distributable amount too small", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("SELECT balance FROM guild_treasuries")) return { rowCount: 1, rows: [{ balance: 50 }] };
        if (sql.includes("guild_revenue_configs")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      });
      await expect(service.distributeRevenue(AGENT_ADMIN, GUILD_ID)).rejects.toThrow("too small");
    });

    it("rejects non-admin", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.distributeRevenue(AGENT_MEMBER, GUILD_ID)).rejects.toThrow("Not a guild admin");
    });
  });

  // ── Revenue Config ──
  describe("setRevenueConfig", () => {
    it("upserts config", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("INSERT INTO guild_treasuries")) return { rowCount: 1, rows: [] };
        if (sql.includes("INSERT INTO guild_revenue_configs")) {
          return { rowCount: 1, rows: [{ guild_id: GUILD_ID, treasury_pct: 30, member_pct: 70, distribution_mode: "contribution" }] };
        }
        return { rowCount: 0, rows: [] };
      });

      const result = await service.setRevenueConfig(AGENT_ADMIN, GUILD_ID, {
        treasuryPct: 30,
        memberPct: 70,
      });
      expect(result.treasury_pct).toBe(30);
    });

    it("rejects when percentages don't sum to 100", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("INSERT INTO guild_treasuries")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      });
      await expect(service.setRevenueConfig(AGENT_ADMIN, GUILD_ID, {
        treasuryPct: 30,
        memberPct: 60,
      })).rejects.toThrow("must equal 100");
    });

    it("rejects invalid distribution mode", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("idx_guilds") && sql.includes("proposer_id")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("INSERT INTO guild_treasuries")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      });
      await expect(service.setRevenueConfig(AGENT_ADMIN, GUILD_ID, {
        distributionMode: "invalid_mode",
      })).rejects.toThrow("Invalid distribution mode");
    });
  });

  // ── Read Methods ──
  describe("read methods", () => {
    it("getTreasury returns stats", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [TREASURY_ROW] });
      const result = await service.getTreasury(GUILD_ID);
      expect(result.guild_id).toBe(GUILD_ID);
      expect(result.balance).toBe(5000);
    });

    it("getTreasury returns defaults when not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      const result = await service.getTreasury(GUILD_ID);
      expect(result.balance).toBe(0);
    });

    it("getTransactions returns history", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 2, rows: [{ id: "tx-1" }, { id: "tx-2" }] });
      const result = await service.getTransactions(GUILD_ID, { limit: 10 });
      expect(result).toHaveLength(2);
    });

    it("getDistributions returns payout records", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "d-1", amount: 500 }] });
      const result = await service.getDistributions(GUILD_ID);
      expect(result).toHaveLength(1);
    });
  });

  // ── Ensure Treasury ──
  describe("ensureTreasury", () => {
    it("creates treasury idempotently", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await service.ensureTreasury(GUILD_ID);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO guild_treasuries"),
        [GUILD_ID],
      );
    });
  });
});
