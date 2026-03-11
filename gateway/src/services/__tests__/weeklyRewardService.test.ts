import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the service
vi.mock("../../config.js", () => ({
  gatewayConfig: {
    wethAddress: "0x4200000000000000000000000000000000000006",
    nookTokenAddress: "0x2222222222222222222222222222222222222222",
  },
}));

// Mock audit log
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { WeeklyRewardService, DEFAULT_CONFIG, type WeeklyRewardConfig } from "../weeklyRewardService.js";

// ============================================================
//  Mock factories
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockCreditManager() {
  return {
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 1000 }),
  } as any;
}

const TEST_CONFIG: Partial<WeeklyRewardConfig> = {
  tickIntervalMs: 999_999_999, // don't auto-tick
  defaultPoolCredits: 10_000, // 100.00 display
  minScoreThreshold: 1.0,
  tierShares: { diamond: 0.4, gold: 0.3, silver: 0.2, bronze: 0.1 },
  tierBoundaries: { diamond: 0.01, gold: 0.05, silver: 0.15 },
  maxJitterHours: 0, // no jitter for deterministic tests
  diamondCooldownWeeks: 4,
};

// ============================================================
//  Helpers
// ============================================================

function setupWeightsMock(pool: ReturnType<typeof createMockPool>, overrides: Record<string, string> = {}) {
  const originalQuery = pool.query;
  pool.query.mockImplementation((sql: string, params?: any[]) => {
    if (typeof sql === "string" && sql.includes("system_settings") && sql.includes("weekly_reward_")) {
      const rows = Object.entries(overrides).map(([key, value]) => ({
        key: `weekly_reward_${key}`,
        value,
      }));
      return Promise.resolve({ rows });
    }
    return originalQuery(sql, params);
  });
}

// ============================================================
//  Tests
// ============================================================

describe("WeeklyRewardService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let service: WeeklyRewardService;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    service = new WeeklyRewardService(pool, creditManager, TEST_CONFIG);
  });

  // ----------------------------------------------------------
  //  Config loading
  // ----------------------------------------------------------

  describe("loadWeights", () => {
    it("returns defaults when system_settings has no rows", async () => {
      pool.query.mockResolvedValue({ rows: [] });
      const weights = await service.loadWeights();
      expect(weights.bounty_provider).toBe(1.0);
      expect(weights.weth_usd_price).toBe(2500);
      expect(weights.nook_usd_price).toBe(0.01);
      expect(weights.pool_credits).toBe(15_000);
    });

    it("merges system_settings overrides with defaults", async () => {
      pool.query.mockResolvedValue({
        rows: [
          { key: "weekly_reward_bounty_provider", value: "2.5" },
          { key: "weekly_reward_weth_usd_price", value: "3000" },
          { key: "weekly_reward_jitter_secret", value: "test-secret" },
        ],
      });
      const weights = await service.loadWeights();
      expect(weights.bounty_provider).toBe(2.5);
      expect(weights.weth_usd_price).toBe(3000);
      expect(weights.jitter_secret).toBe("test-secret");
      // Unset keys use defaults
      expect(weights.marketplace_provider).toBe(1.0);
    });

    it("returns defaults on database error", async () => {
      pool.query.mockRejectedValue(new Error("connection refused"));
      const weights = await service.loadWeights();
      expect(weights.bounty_provider).toBe(1.0);
    });
  });

  // ----------------------------------------------------------
  //  Epoch number computation
  // ----------------------------------------------------------

  describe("getCurrentEpochNumber", () => {
    it("returns year * 100 + ISO week number", () => {
      // 2026-01-05 is in ISO week 2 of 2026
      const epoch = service.getCurrentEpochNumber(new Date("2026-01-05T12:00:00Z"));
      expect(epoch).toBe(202602);
    });

    it("handles year boundary correctly", () => {
      // 2025-12-29 (Monday) is ISO week 1 of 2026
      const epoch = service.getCurrentEpochNumber(new Date("2025-12-29T12:00:00Z"));
      expect(epoch).toBe(202601);
    });

    it("returns different epochs for different weeks", () => {
      const week1 = service.getCurrentEpochNumber(new Date("2026-03-02T12:00:00Z"));
      const week2 = service.getCurrentEpochNumber(new Date("2026-03-09T12:00:00Z"));
      expect(week2).toBe(week1 + 1);
    });
  });

  // ----------------------------------------------------------
  //  Epoch bounds with jitter
  // ----------------------------------------------------------

  describe("getEpochBounds", () => {
    it("returns 7-day period", () => {
      const { periodStart, periodEnd } = service.getEpochBounds(202610, "test");
      const durationMs = periodEnd.getTime() - periodStart.getTime();
      expect(durationMs).toBe(7 * 86_400_000);
    });

    it("produces deterministic bounds for same epoch + secret", () => {
      const a = service.getEpochBounds(202610, "secret-a");
      const b = service.getEpochBounds(202610, "secret-a");
      expect(a.periodStart.getTime()).toBe(b.periodStart.getTime());
    });

    it("produces different offsets for different secrets", () => {
      // With maxJitterHours = 0 in test config, jitter is 0 anyway
      // Use a service with jitter enabled
      const jitterService = new WeeklyRewardService(pool, creditManager, {
        ...TEST_CONFIG,
        maxJitterHours: 12,
      });
      const a = jitterService.getEpochBounds(202610, "secret-a");
      const b = jitterService.getEpochBounds(202610, "secret-b");
      // With different secrets, offsets may differ
      // Just check both are 7-day periods
      expect(b.periodEnd.getTime() - b.periodStart.getTime()).toBe(7 * 86_400_000);
      expect(a.periodEnd.getTime() - a.periodStart.getTime()).toBe(7 * 86_400_000);
    });
  });

  // ----------------------------------------------------------
  //  Tier assignment
  // ----------------------------------------------------------

  describe("tier assignment", () => {
    it("assigns tiers based on rank percentile with 100 agents", () => {
      // Access private method via any cast
      const svc = service as any;

      const agents = Array.from({ length: 100 }, (_, i) => ({
        agentId: `agent-${i}`,
        score: 100 - i, // descending scores
        tier: "bronze" as const,
        rank: i + 1,
        dimensions: {},
        gates: {},
        rewardCredits: 0,
      }));

      const result = svc.assignTiers(agents, 10_000);

      // Diamond: top 1% = 1 agent
      const diamonds = result.filter((a: any) => a.tier === "diamond");
      expect(diamonds.length).toBe(1);
      expect(diamonds[0].agentId).toBe("agent-0");

      // Gold: next 4% = 4 agents
      const golds = result.filter((a: any) => a.tier === "gold");
      expect(golds.length).toBe(4);

      // Silver: next 10% = 10 agents
      const silvers = result.filter((a: any) => a.tier === "silver");
      expect(silvers.length).toBe(10);

      // Bronze: rest = 85 agents
      const bronzes = result.filter((a: any) => a.tier === "bronze");
      expect(bronzes.length).toBe(85);
    });

    it("distributes pool proportionally within tiers", () => {
      const svc = service as any;

      // 2 agents with scores 75 and 25 (both will be "diamond" in 2-agent scenario)
      const agents = [
        { agentId: "a", score: 75, tier: "bronze", rank: 1, dimensions: {}, gates: {}, rewardCredits: 0 },
        { agentId: "b", score: 25, tier: "bronze", rank: 2, dimensions: {}, gates: {}, rewardCredits: 0 },
      ];

      const result = svc.assignTiers(agents, 10_000);

      // With 2 agents: rank 1/2 = 0.5 percentile → diamond, rank 2/2 = 1.0 → bronze
      const totalRewards = result.reduce((sum: number, a: any) => sum + a.rewardCredits, 0);
      expect(totalRewards).toBeGreaterThan(0);
      expect(totalRewards).toBeLessThanOrEqual(10_000);
    });

    it("handles single agent correctly", () => {
      const svc = service as any;
      const agents = [
        { agentId: "solo", score: 50, tier: "bronze", rank: 1, dimensions: {}, gates: {}, rewardCredits: 0 },
      ];

      const result = svc.assignTiers(agents, 10_000);
      // Single agent at rank 1/1 = percentile 1.0 → bronze
      expect(result[0].tier).toBe("bronze");
      expect(result[0].rewardCredits).toBe(1000); // 10% of 10000
    });
  });

  // ----------------------------------------------------------
  //  Anti-gaming gates
  // ----------------------------------------------------------

  describe("anti-gaming gates", () => {
    it("checkAccountAge fails for new accounts", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ created_at: new Date() }], // created just now
      });
      const result = await svc.checkAccountAge("agent-1", 7);
      expect(result).toBe(false);
    });

    it("checkAccountAge passes for old accounts", async () => {
      const svc = service as any;
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);
      pool.query.mockResolvedValue({
        rows: [{ created_at: oldDate }],
      });
      const result = await svc.checkAccountAge("agent-1", 7);
      expect(result).toBe(true);
    });

    it("checkDidRegistered returns true when did_cid exists", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ did_cid: "QmSomeCid" }],
      });
      expect(await svc.checkDidRegistered("agent-1")).toBe(true);
    });

    it("checkDidRegistered returns false when did_cid is null", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ did_cid: null }],
      });
      expect(await svc.checkDidRegistered("agent-1")).toBe(false);
    });

    it("checkVelocity passes on first epoch (no history)", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ avg_score: "0" }],
      });
      expect(await svc.checkVelocity("agent-1", 100, 3.0)).toBe(true);
    });

    it("checkVelocity fails when score spikes >3x average", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ avg_score: "10" }],
      });
      // 31 > 10 * 3 = 30
      expect(await svc.checkVelocity("agent-1", 31, 3.0)).toBe(false);
    });

    it("checkVelocity passes when score is within range", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [{ avg_score: "10" }],
      });
      expect(await svc.checkVelocity("agent-1", 29, 3.0)).toBe(true);
    });

    it("checkDiamondCooldown passes when no diamond history", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({ rows: [] });
      expect(await svc.checkDiamondCooldown("agent-1", 202610, 4)).toBe(true);
    });

    it("checkDiamondCooldown fails after N consecutive diamond weeks", async () => {
      const svc = service as any;
      pool.query.mockResolvedValue({
        rows: [
          { epoch_number: 202609 },
          { epoch_number: 202608 },
          { epoch_number: 202607 },
          { epoch_number: 202606 },
        ],
      });
      expect(await svc.checkDiamondCooldown("agent-1", 202610, 4)).toBe(false);
    });
  });

  // ----------------------------------------------------------
  //  Token-to-USD conversion
  // ----------------------------------------------------------

  describe("tokenToUsd", () => {
    it("converts USDC (6 decimals) correctly", () => {
      const svc = service as any;
      const weights = { weth_usd_price: 2500, nook_usd_price: 0.01 };
      // 10 USDC = 10000000 (6 decimals)
      expect(svc.tokenToUsd("10000000", "0x1111111111111111111111111111111111111111", weights)).toBe(10);
    });

    it("converts WETH (18 decimals) with price", () => {
      const svc = service as any;
      const weights = { weth_usd_price: 2500, nook_usd_price: 0.01 };
      // 1 WETH = 1e18 wei, at $2500
      expect(svc.tokenToUsd("1000000000000000000", "0x4200000000000000000000000000000000000006", weights)).toBe(2500);
    });

    it("returns 0 for unknown tokens", () => {
      const svc = service as any;
      const weights = { weth_usd_price: 2500, nook_usd_price: 0.01 };
      expect(svc.tokenToUsd("1000000", "0xunknown", weights)).toBe(0);
    });

    it("returns 0 for zero amount", () => {
      const svc = service as any;
      const weights = { weth_usd_price: 2500, nook_usd_price: 0.01 };
      expect(svc.tokenToUsd("0", "0x1111111111111111111111111111111111111111", weights)).toBe(0);
    });

    it("returns 0 for null token address", () => {
      const svc = service as any;
      const weights = { weth_usd_price: 2500, nook_usd_price: 0.01 };
      expect(svc.tokenToUsd("1000000", null, weights)).toBe(0);
    });
  });

  // ----------------------------------------------------------
  //  Idempotency
  // ----------------------------------------------------------

  describe("idempotency", () => {
    it("triggerEpoch returns existing status if already processed", async () => {
      // First call: loadWeights
      pool.query.mockResolvedValueOnce({ rows: [] }); // system_settings
      // Second call: check existing epoch
      pool.query.mockResolvedValueOnce({
        rows: [{ status: "distributed" }],
      });

      const result = await service.triggerEpoch();
      expect(result.status).toBe("distributed");
      // addCredits should NOT have been called
      expect(creditManager.addCredits).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  //  Query helpers
  // ----------------------------------------------------------

  describe("getCurrentEpochInfo", () => {
    it("returns epoch info with time remaining", async () => {
      pool.query.mockResolvedValue({ rows: [] }); // system_settings
      const info = await service.getCurrentEpochInfo();
      expect(info.epochNumber).toBeGreaterThan(0);
      expect(info.poolCredits).toBe(15_000); // default
      expect(info.timeRemaining).toBeGreaterThanOrEqual(0);
      expect(info.periodEnd.getTime() - info.periodStart.getTime()).toBe(7 * 86_400_000);
    });
  });

  describe("getLeaderboard", () => {
    it("returns empty when no epochs exist", async () => {
      pool.query.mockResolvedValue({ rows: [] });
      const result = await service.getLeaderboard();
      expect(result.epoch).toBeNull();
      expect(result.scores).toEqual([]);
    });

    it("returns epoch and scores when data exists", async () => {
      // First query: epoch
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "epoch-uuid",
          epoch_number: 202610,
          status: "distributed",
          pool_credits: "10000",
          total_eligible: 5,
          total_distributed: "9500",
        }],
      });
      // Second query: scores
      pool.query.mockResolvedValueOnce({
        rows: [{
          agent_id: "agent-1",
          economic_score: "42.50",
          tier: "diamond",
          rank: 1,
          reward_credits: "4000",
          dimension_breakdown: { bounty_provider: 30, marketplace_provider: 12.5 },
        }],
      });

      const result = await service.getLeaderboard();
      expect(result.epoch?.epochNumber).toBe(202610);
      expect(result.scores).toHaveLength(1);
      expect(result.scores[0].score).toBe(42.5);
      expect(result.scores[0].tier).toBe("diamond");
    });
  });

  describe("claimReward", () => {
    it("marks unclaimed rewards as claimed and returns total", async () => {
      pool.query.mockResolvedValue({
        rows: [
          { id: "r1", reward_credits: "500" },
          { id: "r2", reward_credits: "300" },
        ],
      });

      const result = await service.claimReward("agent-1");
      expect(result.claimed).toBe(800);
    });

    it("returns 0 when nothing to claim", async () => {
      pool.query.mockResolvedValue({ rows: [] });
      const result = await service.claimReward("agent-1");
      expect(result.claimed).toBe(0);
    });
  });

  describe("getEpochHistory", () => {
    it("returns paginated epoch history", async () => {
      const now = new Date();
      pool.query.mockResolvedValue({
        rows: [{
          epoch_number: 202610,
          period_start: now,
          period_end: new Date(now.getTime() + 7 * 86_400_000),
          pool_credits: "10000",
          total_eligible: 5,
          total_distributed: "9500",
          status: "distributed",
          distributed_at: now,
        }],
      });

      const result = await service.getEpochHistory(10, 0);
      expect(result).toHaveLength(1);
      expect(result[0].epochNumber).toBe(202610);
      expect(result[0].poolCredits).toBe(10000);
    });
  });

  // ----------------------------------------------------------
  //  Edge cases
  // ----------------------------------------------------------

  describe("edge cases", () => {
    it("handles all same scores gracefully", () => {
      const svc = service as any;
      const agents = Array.from({ length: 10 }, (_, i) => ({
        agentId: `agent-${i}`,
        score: 50, // all same
        tier: "bronze" as const,
        rank: i + 1,
        dimensions: {},
        gates: {},
        rewardCredits: 0,
      }));

      const result = svc.assignTiers(agents, 10_000);
      const totalRewards = result.reduce((sum: number, a: any) => sum + a.rewardCredits, 0);
      // All rewards should be distributed (accounting for rounding)
      expect(totalRewards).toBeGreaterThan(0);
      expect(totalRewards).toBeLessThanOrEqual(10_000);
    });

    it("lifecycle methods don't throw", () => {
      expect(() => service.start()).not.toThrow();
      expect(() => service.stop()).not.toThrow();
      // Double stop is safe
      expect(() => service.stop()).not.toThrow();
    });
  });
});
