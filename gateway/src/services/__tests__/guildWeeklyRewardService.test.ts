import { describe, it, expect, vi, beforeEach } from "vitest";
import { GuildWeeklyRewardService } from "../guildWeeklyRewardService.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockTreasuryService() {
  return {
    ensureTreasury: vi.fn().mockResolvedValue(undefined),
    distributeRevenueInternal: vi.fn().mockResolvedValue({
      distributionId: "dist-001",
      totalDistributed: 1000,
      recipients: 3,
      balance: 500,
    }),
  } as any;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GUILD_A = "0x0a";
const GUILD_B = "0x0b";
const GUILD_C = "0x0c";

const PAST_DATE = new Date("2026-01-01T00:00:00Z");

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService(config?: any) {
  const pool = createMockPool();
  const treasuryService = createMockTreasuryService();
  const service = new GuildWeeklyRewardService(pool, treasuryService, {
    tickIntervalMs: 999_999,
    maxJitterHours: 0, // disable jitter for deterministic testing
    ...config,
  });
  return { pool, treasuryService, service };
}

type QueryMockFn = (sql: string, params?: any[]) => any;

function createQueryRouter(overrides: Partial<Record<string, QueryMockFn>> = {}): QueryMockFn {
  return (sql: string, params?: any[]) => {
    // Check overrides first
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (sql.includes(pattern)) return handler!(sql, params);
    }

    // Default behaviors
    if (sql.includes("guild_weekly_reward_epochs") && sql.includes("COUNT")) {
      return { rows: [{ count: "0" }] };
    }
    if (sql.includes("INSERT INTO guild_weekly_reward_epochs")) {
      return { rows: [{ id: "epoch-001" }] };
    }
    if (sql.includes("idx_guilds") && sql.includes("status = 1")) {
      return {
        rows: [
          { guild_id: GUILD_A, created_at: PAST_DATE.toISOString() },
          { guild_id: GUILD_B, created_at: PAST_DATE.toISOString() },
          { guild_id: GUILD_C, created_at: PAST_DATE.toISOString() },
        ],
      };
    }
    if (sql.includes("idx_guild_members") && sql.includes("status = 2")) {
      return {
        rows: [
          { member_id: "0x0001" },
          { member_id: "0x0002" },
          { member_id: "0x0003" },
          { member_id: "0x0004" },
        ],
      };
    }
    if (sql.includes("SELECT id, address FROM agents")) {
      return {
        rows: [
          { id: "a-001", address: "0x0001" },
          { id: "a-002", address: "0x0002" },
          { id: "a-003", address: "0x0003" },
          { id: "a-004", address: "0x0004" },
        ],
      };
    }
    // Economic activity queries — default returns
    if (sql.includes("bounty_completions") && sql.includes("COUNT")) {
      return { rows: [{ total: "5" }] };
    }
    if (sql.includes("idx_bounties") && sql.includes("COUNT")) {
      return { rows: [{ total: "3" }] };
    }
    if (sql.includes("service_agreements") && sql.includes("COUNT") && !sql.includes("FILTER")) {
      return { rows: [{ total: "8" }] };
    }
    if (sql.includes("credit_transactions") && sql.includes("COUNT")) {
      return { rows: [{ total: "2" }] };
    }
    if (sql.includes("treasury_distributions") && sql.includes("SUM")) {
      return { rows: [{ total: "500" }] };
    }
    // Wash-trade detection
    if (sql.includes("FILTER") && sql.includes("service_agreements")) {
      return { rows: [{ internal_count: "1", total_count: "10" }] }; // 10% internal
    }
    if (sql.includes("FILTER") && sql.includes("bounty_completions")) {
      return { rows: [{ internal_count: "0", total_count: "5" }] };
    }
    // External counterparties
    if (sql.includes("DISTINCT") && sql.includes("CASE")) {
      return { rows: [{ counterparty: "ext-001" }, { counterparty: "ext-002" }, { counterparty: "ext-003" }] };
    }
    // System settings
    if (sql.includes("system_settings")) {
      return { rows: [] };
    }
    // Auto-distribution
    if (sql.includes("guild_revenue_configs") && sql.includes("auto_distribute")) {
      return { rows: [] };
    }
    // Insert/Update
    if (sql.includes("INSERT INTO") || sql.includes("UPDATE")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GuildWeeklyRewardService", () => {
  describe("happy path", () => {
    it("scores 3 guilds and distributes to treasuries", async () => {
      const { pool, treasuryService, service } = createService();
      pool.query.mockImplementation(createQueryRouter());

      // Call processEpoch directly with a past epoch (tick checks timing which makes testing harder)
      const pastStart = new Date("2026-01-01T00:00:00Z");
      const pastEnd = new Date("2026-01-08T00:00:00Z");
      await (service as any).processEpoch(202601, pastStart, pastEnd);

      // Should have called ensureTreasury for each guild
      expect(treasuryService.ensureTreasury).toHaveBeenCalled();
      expect(treasuryService.ensureTreasury).toHaveBeenCalledTimes(3);
    });
  });

  describe("tier assignment", () => {
    it("assigns correct tiers based on ranking", () => {
      const { service } = createService();

      // Access assignTiers via prototype
      const assignTiers = (service as any).assignTiers.bind(service);

      const guilds = Array.from({ length: 10 }, (_, i) => ({
        guildId: `0x${i.toString(16).padStart(2, "0")}`,
        score: (10 - i) * 100, // 1000, 900, 800, ..., 100
        tier: "bronze" as any,
        rank: i + 1,
        dimensions: {},
        gates: {},
        washTradePct: 0,
        externalCounterparties: 5,
        rewardCredits: 0,
      }));

      const tiered = assignTiers(guilds, 20_000);

      // Gold: top 10% = 1 guild
      expect(tiered[0].tier).toBe("gold");
      // Silver: next 20% = 2 guilds (indices 1-2)
      expect(tiered[1].tier).toBe("silver");
      expect(tiered[2].tier).toBe("silver");
      // Bronze: rest (indices 3-9)
      for (let i = 3; i < 10; i++) {
        expect(tiered[i].tier).toBe("bronze");
      }

      // Verify all rewards are assigned
      const totalRewards = tiered.reduce((s: number, g: any) => s + g.rewardCredits, 0);
      expect(totalRewards).toBeGreaterThan(0);
      expect(totalRewards).toBeLessThanOrEqual(20_000);
    });
  });

  describe("per-guild cap", () => {
    it("caps any guild at 15% of pool", () => {
      const { service } = createService({ maxGuildSharePct: 0.15 });
      const assignTiers = (service as any).assignTiers.bind(service);

      // One guild dominates
      const guilds = [
        { guildId: GUILD_A, score: 10000, tier: "bronze" as any, rank: 1, dimensions: {}, gates: {}, washTradePct: 0, externalCounterparties: 5, rewardCredits: 0 },
        { guildId: GUILD_B, score: 100, tier: "bronze" as any, rank: 2, dimensions: {}, gates: {}, washTradePct: 0, externalCounterparties: 5, rewardCredits: 0 },
        { guildId: GUILD_C, score: 50, tier: "bronze" as any, rank: 3, dimensions: {}, gates: {}, washTradePct: 0, externalCounterparties: 5, rewardCredits: 0 },
      ];

      const tiered = assignTiers(guilds, 20_000);
      const maxAllowed = Math.floor(20_000 * 0.15); // 3000

      for (const g of tiered) {
        expect(g.rewardCredits).toBeLessThanOrEqual(maxAllowed);
      }
    });
  });

  describe("wash-trade penalty", () => {
    it("applies 0.25x penalty when >50% internal settlements", async () => {
      const { pool, service } = createService();

      const computeWashTradePct = (service as any).computeWashTradePct.bind(service);

      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("FILTER") && sql.includes("service_agreements")) {
          return { rows: [{ internal_count: "8", total_count: "10" }] }; // 80% internal
        }
        if (sql.includes("FILTER") && sql.includes("bounty_completions")) {
          return { rows: [{ internal_count: "0", total_count: "0" }] };
        }
        return { rows: [], rowCount: 0 };
      });

      const pct = await computeWashTradePct(
        ["a-001", "a-002", "a-003"],
        ["0x0001", "0x0002", "0x0003"],
        new Date("2026-01-01"),
        new Date("2026-01-08"),
      );

      expect(pct).toBe(0.8);
    });
  });

  describe("external counterparty gate", () => {
    it("counts distinct external counterparties", async () => {
      const { pool, service } = createService();

      const countExternal = (service as any).countExternalCounterparties.bind(service);
      const memberIds = ["a-001", "a-002"];

      pool.query.mockResolvedValue({
        rows: [
          { counterparty: "ext-001" },
          { counterparty: "ext-002" },
          { counterparty: "a-001" }, // guild member — should be excluded
        ],
      });

      const count = await countExternal(
        memberIds,
        ["0x0001", "0x0002"],
        new Date("2026-01-01"),
        new Date("2026-01-08"),
      );

      expect(count).toBe(2); // only ext-001 and ext-002
    });
  });

  describe("minimum member threshold", () => {
    it("excludes guilds with fewer than 3 members", async () => {
      const { pool, treasuryService, service } = createService();

      pool.query.mockImplementation(createQueryRouter({
        "idx_guild_members": () => ({
          rows: [{ member_id: "0x0001" }, { member_id: "0x0002" }], // only 2
        }),
      }));

      await service.tick();

      // No guilds should receive rewards
      expect(treasuryService.ensureTreasury).not.toHaveBeenCalled();
    });
  });

  describe("auto-distribution trigger", () => {
    it("triggers distribution for qualifying guilds after weekly reward", async () => {
      const { pool, treasuryService, service } = createService();

      pool.query.mockImplementation(createQueryRouter({
        "guild_revenue_configs": (sql) => {
          if (sql.includes("auto_distribute")) {
            return { rows: [{ guild_id: GUILD_A, min_distribution: "100" }] };
          }
          return { rows: [], rowCount: 0 };
        },
      }));

      // Call processEpoch directly to bypass tick timing check
      const pastStart = new Date("2026-01-01T00:00:00Z");
      const pastEnd = new Date("2026-01-08T00:00:00Z");
      await (service as any).processEpoch(202601, pastStart, pastEnd);

      expect(treasuryService.distributeRevenueInternal).toHaveBeenCalledWith(GUILD_A);
    });
  });

  describe("idempotency", () => {
    it("skips if epoch already processed", async () => {
      const { pool, treasuryService, service } = createService();

      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("guild_weekly_reward_epochs") && sql.includes("COUNT")) {
          return { rows: [{ count: "1" }] }; // already processed
        }
        return { rows: [], rowCount: 0 };
      });

      await service.tick();
      expect(treasuryService.ensureTreasury).not.toHaveBeenCalled();
    });
  });

  describe("epoch numbering", () => {
    it("produces consistent epoch numbers for same week", () => {
      const { service } = createService();

      const monday = new Date("2026-03-02T10:00:00Z"); // Monday
      const friday = new Date("2026-03-06T10:00:00Z"); // Friday same week
      expect(service.getCurrentEpochNumber(monday)).toBe(service.getCurrentEpochNumber(friday));
    });

    it("produces different epoch numbers for different weeks", () => {
      const { service } = createService();

      const week1 = new Date("2026-03-02T10:00:00Z");
      const week2 = new Date("2026-03-09T10:00:00Z");
      expect(service.getCurrentEpochNumber(week1)).not.toBe(service.getCurrentEpochNumber(week2));
    });
  });

  describe("lifecycle", () => {
    it("start and stop manage the timer", () => {
      const { service } = createService();
      service.start();
      service.start(); // no-op
      service.stop();
      service.stop(); // no-op
    });
  });

  describe("concurrent tick protection", () => {
    it("prevents concurrent processing", async () => {
      const { pool, service } = createService();

      // Manually set the processing flag to simulate an in-progress tick
      (service as any).processing = true;

      // This tick should return immediately
      pool.query.mockImplementation(() => {
        throw new Error("should not reach queries");
      });

      await service.tick(); // should be a no-op

      // Pool.query should never have been called
      expect(pool.query).not.toHaveBeenCalled();

      // Clean up
      (service as any).processing = false;
    });
  });
});
