import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProactiveScheduler } from "./proactiveScheduler.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../secretManager.js", () => ({
  encryptSecret: vi.fn().mockReturnValue({ encryptedKey: "enc", iv: "iv", authTag: "tag" }),
  decryptSecret: vi.fn().mockReturnValue("secret"),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockScanner() {
  return { scanAll: vi.fn().mockResolvedValue([]) };
}

function createMockEngine() {
  return { evaluate: vi.fn().mockResolvedValue([]) };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 5000, status: "active" }),
    deductCredits: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRegistry() {
  return {
    get: vi.fn(),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

function createMockExecutor() {
  return {
    processApprovedActions: vi.fn().mockResolvedValue({ executed: 0, failed: 0 }),
    cleanupStaleActions: vi.fn().mockResolvedValue(undefined),
  };
}

const DEFAULT_CONFIG = {
  masterEnabled: true,
  tickIntervalMs: 60_000,
  maxConcurrentScans: 5,
};

function createScheduler(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const scheduler = new ProactiveScheduler(
    p as any,
    createMockScanner() as any,
    createMockEngine() as any,
    createMockCreditManager() as any,
    null, // inferenceProxy
    null, // improvementEngine
    createMockRegistry() as any,
    createMockExecutor() as any,
    DEFAULT_CONFIG,
    "test-encryption-key",
  );
  return { scheduler, pool: p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  isActive
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.isActive", () => {
  it("returns false when not started", () => {
    const { scheduler } = createScheduler();
    expect(scheduler.isActive()).toBe(false);
  });

  it("returns true after start", () => {
    const { scheduler } = createScheduler();
    scheduler.start();
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
  });

  it("returns false after stop", async () => {
    const { scheduler } = createScheduler();
    scheduler.start();
    await scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Channel cooldown
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — channel cooldown", () => {
  it("returns true when no cooldown recorded", () => {
    const { scheduler } = createScheduler();
    expect(scheduler.isChannelCooldownClear("agt_1", "ch_1", 120)).toBe(true);
  });

  it("returns false during cooldown period", () => {
    const { scheduler } = createScheduler();
    scheduler.recordChannelMessage("agt_1", "ch_1");
    expect(scheduler.isChannelCooldownClear("agt_1", "ch_1", 120)).toBe(false);
  });

  it("returns true after cooldown expires", () => {
    const { scheduler } = createScheduler();

    // Manually set an old timestamp via reflection
    const cooldowns = (scheduler as any).channelCooldowns;
    const agentMap = new Map();
    agentMap.set("ch_1", Date.now() - 200_000); // 200s ago
    cooldowns.set("agt_1", agentMap);

    expect(scheduler.isChannelCooldownClear("agt_1", "ch_1", 120)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Daily message limit
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — daily message limit", () => {
  it("returns true when no messages sent", () => {
    const { scheduler } = createScheduler();
    expect(scheduler.isDailyMessageLimitClear("agt_1", "ch_1", 20)).toBe(true);
  });

  it("returns false when limit reached", () => {
    const { scheduler } = createScheduler();
    for (let i = 0; i < 20; i++) {
      scheduler.incrementDailyMessageCount("agt_1", "ch_1");
    }
    expect(scheduler.isDailyMessageLimitClear("agt_1", "ch_1", 20)).toBe(false);
  });

  it("returns true when under limit", () => {
    const { scheduler } = createScheduler();
    scheduler.incrementDailyMessageCount("agt_1", "ch_1");
    expect(scheduler.isDailyMessageLimitClear("agt_1", "ch_1", 20)).toBe(true);
  });

  it("tracks separate channels independently", () => {
    const { scheduler } = createScheduler();
    for (let i = 0; i < 20; i++) {
      scheduler.incrementDailyMessageCount("agt_1", "ch_1");
    }
    // ch_2 should still be clear
    expect(scheduler.isDailyMessageLimitClear("agt_1", "ch_2", 20)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Reactive signal dedup
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — shouldSkipScanSignal", () => {
  it("returns false when no signals recorded", () => {
    const { scheduler } = createScheduler();
    const skip = scheduler.shouldSkipScanSignal("agt_1", {
      type: "dm_received",
      metadata: { fromAddress: "0xABC" },
    });
    expect(skip).toBe(false);
  });

  it("returns true after reactive signal was emitted for same event", () => {
    const { scheduler } = createScheduler();

    // Record a reactive signal
    (scheduler as any).recordReactiveSignal("agt_1", {
      signalType: "dm_received",
      senderAddress: "0xABC",
    });

    // Scan should skip the same signal
    const skip = scheduler.shouldSkipScanSignal("agt_1", {
      type: "dm_received",
      metadata: { fromAddress: "0xABC" },
    });
    expect(skip).toBe(true);
  });

  it("returns false for different signal type", () => {
    const { scheduler } = createScheduler();

    (scheduler as any).recordReactiveSignal("agt_1", {
      signalType: "dm_received",
      senderAddress: "0xABC",
    });

    const skip = scheduler.shouldSkipScanSignal("agt_1", {
      type: "new_follower",
      metadata: { followerAddress: "0xABC" },
    });
    expect(skip).toBe(false);
  });

  it("returns null key for unknown opportunity type", () => {
    const { scheduler } = createScheduler();
    const key = (scheduler as any).scanOpportunityKey({
      type: "unknown_type",
      metadata: {},
    });
    expect(key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getSettings
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.getSettings", () => {
  it("returns null when no settings exist", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await scheduler.getSettings("agt_unknown");
    expect(result).toBeNull();
  });

  it("returns mapped settings", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_test",
        enabled: true,
        scan_interval_minutes: 30,
        max_credits_per_cycle: 2000,
        max_actions_per_day: 5,
        paused_until: null,
        callback_url: "https://example.com/webhook",
        callback_secret: null,
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      }],
      rowCount: 1,
    });

    const result = await scheduler.getSettings("agt_test");

    expect(result!.agentId).toBe("agt_test");
    expect(result!.enabled).toBe(true);
    expect(result!.scanIntervalMinutes).toBe(30);
    expect(result!.maxCreditsPerCycle).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
//  updateSettings
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.updateSettings", () => {
  it("creates/updates settings via upsert", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_test",
        enabled: true,
        scan_interval_minutes: 45,
        max_credits_per_cycle: 3000,
        max_actions_per_day: 8,
        paused_until: null,
        callback_url: null,
        callback_secret: null,
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-02"),
      }],
      rowCount: 1,
    });

    const result = await scheduler.updateSettings("agt_test", {
      enabled: true,
      scanIntervalMinutes: 45,
      maxCreditsPerCycle: 3000,
    });

    expect(result.agentId).toBe("agt_test");
    expect(result.scanIntervalMinutes).toBe(45);

    // Verify upsert query was called
    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[0]).toContain("INSERT INTO proactive_settings");
    expect(queryCall[0]).toContain("ON CONFLICT (agent_id) DO UPDATE");
  });

  it("encrypts callback secret when provided", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_test",
        enabled: true,
        scan_interval_minutes: 60,
        max_credits_per_cycle: 5000,
        max_actions_per_day: 10,
        paused_until: null,
        callback_url: "https://example.com",
        callback_secret: '{"encryptedKey":"enc","iv":"iv","authTag":"tag"}',
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-02"),
      }],
      rowCount: 1,
    });

    await scheduler.updateSettings("agt_test", {
      callbackUrl: "https://example.com",
      callbackSecret: "my-secret",
    });

    // The encrypted secret JSON should be passed to the query
    const queryArgs = pool.query.mock.calls[0][1];
    const secretArg = queryArgs[6]; // $7 = callback_secret
    expect(secretArg).toContain("encryptedKey");
  });
});

// ---------------------------------------------------------------------------
//  getStats
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.getStats", () => {
  it("returns aggregated stats from 5 parallel queries", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    // 5 parallel queries
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "7" }] })     // actionsToday
      .mockResolvedValueOnce({ rows: [{ count: "3" }] })     // actionsPending
      .mockResolvedValueOnce({ rows: [{ completed: "20", failed: "5" }] }) // total
      .mockResolvedValueOnce({ rows: [{ total: "1500" }] })  // creditsSpentToday
      .mockResolvedValueOnce({ rows: [{ created_at: "2025-06-01T12:00:00Z" }] }); // lastScan

    const stats = await scheduler.getStats("agt_test");

    expect(stats.actionsToday).toBe(7);
    expect(stats.actionsPending).toBe(3);
    expect(stats.actionsCompletedTotal).toBe(20);
    expect(stats.creditsSpentToday).toBe(1500);
    expect(stats.successRate).toBe(20 / 25); // 20 completed / (20+5) total
    expect(stats.lastScanAt).toBe("2025-06-01T12:00:00Z");
  });

  it("returns 0 success rate when no actions", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ completed: "0", failed: "0" }] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    const stats = await scheduler.getStats("agt_test");

    expect(stats.successRate).toBe(0);
    expect(stats.lastScanAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  approveAction / rejectAction
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.approveAction", () => {
  it("approves a pending action", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await expect(scheduler.approveAction("act_1", "agt_test")).resolves.toBeUndefined();

    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[0]).toContain("status = 'approved'");
    expect(queryCall[1]).toEqual(["act_1", "agt_test"]);
  });

  it("throws when action not found or not pending", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    await expect(scheduler.approveAction("act_unknown", "agt_test")).rejects.toThrow(
      "ACTION_NOT_FOUND_OR_NOT_PENDING",
    );
  });
});

describe("ProactiveScheduler.rejectAction", () => {
  it("rejects a pending action", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await expect(scheduler.rejectAction("act_1", "agt_test")).resolves.toBeUndefined();

    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[0]).toContain("status = 'rejected'");
  });

  it("throws when action not found or not pending", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    await expect(scheduler.rejectAction("act_unknown", "agt_test")).rejects.toThrow(
      "ACTION_NOT_FOUND_OR_NOT_PENDING",
    );
  });
});

// ---------------------------------------------------------------------------
//  getScanHistory
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.getScanHistory", () => {
  it("returns formatted scan log entries", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "scan-1",
        agent_id: "agt_test",
        opportunities_found: 5,
        actions_proposed: 2,
        actions_auto_executed: 1,
        credits_spent: 100,
        duration_ms: 3500,
        error_message: null,
        created_at: "2025-06-01T12:00:00Z",
      }],
      rowCount: 1,
    });

    const history = await scheduler.getScanHistory("agt_test", 10);

    expect(history).toHaveLength(1);
    expect(history[0].opportunitiesFound).toBe(5);
    expect(history[0].actionsProposed).toBe(2);
    expect(history[0].durationMs).toBe(3500);
    expect(history[0].errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  isChannelLoopSafe
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.isChannelLoopSafe", () => {
  it("returns true when fewer messages than threshold", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { from_agent_id: "agt_1", metadata: { proactive: true } },
      ],
      rowCount: 1,
    });

    const safe = await scheduler.isChannelLoopSafe("ch_1", 4);
    expect(safe).toBe(true);
  });

  it("returns false when all recent messages are proactive", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { from_agent_id: "agt_1", metadata: { proactive: true } },
        { from_agent_id: "agt_2", metadata: { proactive: true } },
        { from_agent_id: "agt_1", metadata: { proactive: true } },
        { from_agent_id: "agt_3", metadata: { proactive: true } },
      ],
      rowCount: 4,
    });

    const safe = await scheduler.isChannelLoopSafe("ch_1", 4);
    expect(safe).toBe(false);
  });

  it("returns true when at least one human message exists", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { from_agent_id: "agt_1", metadata: { proactive: true } },
        { from_agent_id: "human_1", metadata: null }, // human message
        { from_agent_id: "agt_2", metadata: { proactive: true } },
        { from_agent_id: "agt_1", metadata: { proactive: true } },
      ],
      rowCount: 4,
    });

    const safe = await scheduler.isChannelLoopSafe("ch_1", 4);
    expect(safe).toBe(true);
  });

  it("returns true on DB error (fail open)", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockRejectedValueOnce(new Error("DB error"));

    const safe = await scheduler.isChannelLoopSafe("ch_1");
    expect(safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  getEnhancedSettings
// ---------------------------------------------------------------------------

describe("ProactiveScheduler.getEnhancedSettings", () => {
  it("returns defaults when no row found", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const settings = await (scheduler as any).getEnhancedSettings("agt_test");

    expect(settings.channelCooldownSeconds).toBe(120);
    expect(settings.maxMessagesPerChannelPerDay).toBe(20);
    expect(settings.creativityLevel).toBe("moderate");
    expect(settings.autoFollowBack).toBe(false);
  });

  it("returns values from DB row", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        channel_cooldown_seconds: 300,
        max_messages_per_channel_per_day: 10,
        creativity_level: "high",
        social_level: "aggressive",
        max_follows_per_day: 10,
        max_attestations_per_day: 5,
        max_communities_per_week: 3,
        auto_follow_back: true,
      }],
      rowCount: 1,
    });

    const settings = await (scheduler as any).getEnhancedSettings("agt_test");

    expect(settings.channelCooldownSeconds).toBe(300);
    expect(settings.maxMessagesPerChannelPerDay).toBe(10);
    expect(settings.creativityLevel).toBe("high");
    expect(settings.autoFollowBack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Discovery affordances — getSettings includes new fields
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — discovery affordances in getSettings", () => {
  it("returns discovery fields when present", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_disc",
        enabled: true,
        scan_interval_minutes: 10,
        max_credits_per_cycle: 5000,
        max_actions_per_day: 10,
        paused_until: null,
        callback_url: null,
        callback_secret: null,
        scanner_priorities: { scanBounties: 10, scanPotentialFriends: 0 },
        budget_social: 500,
        budget_content: 1000,
        budget_bounties: null,
        budget_collaboration: 200,
        budget_community: null,
        discovery_cadence: "aggressive",
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      }],
      rowCount: 1,
    });

    const result = await scheduler.getSettings("agt_disc");

    expect(result).not.toBeNull();
    expect(result!.scannerPriorities).toEqual({ scanBounties: 10, scanPotentialFriends: 0 });
    expect(result!.budgetSocial).toBe(500);
    expect(result!.budgetContent).toBe(1000);
    expect(result!.budgetBounties).toBeNull();
    expect(result!.budgetCollaboration).toBe(200);
    expect(result!.budgetCommunity).toBeNull();
    expect(result!.discoveryCadence).toBe("aggressive");
  });

  it("returns null discovery fields when not set", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_plain",
        enabled: false,
        scan_interval_minutes: 10,
        max_credits_per_cycle: 5000,
        max_actions_per_day: 10,
        paused_until: null,
        callback_url: null,
        callback_secret: null,
        scanner_priorities: null,
        budget_social: null,
        budget_content: null,
        budget_bounties: null,
        budget_collaboration: null,
        budget_community: null,
        discovery_cadence: null,
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      }],
      rowCount: 1,
    });

    const result = await scheduler.getSettings("agt_plain");

    expect(result!.scannerPriorities).toBeNull();
    expect(result!.budgetSocial).toBeNull();
    expect(result!.discoveryCadence).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Discovery affordances — getCategoryBudgets
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — getCategoryBudgets", () => {
  it("returns null budgets when none set", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ budget_social: null, budget_content: null, budget_bounties: null, budget_collaboration: null, budget_community: null }],
      rowCount: 1,
    });

    const budgets = await (scheduler as any).getCategoryBudgets("agt_test");
    expect(budgets.social).toBeNull();
    expect(budgets.content).toBeNull();
    expect(budgets.bounties).toBeNull();
  });

  it("returns numeric budgets when set", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ budget_social: "500", budget_content: "1000", budget_bounties: null, budget_collaboration: "200", budget_community: null }],
      rowCount: 1,
    });

    const budgets = await (scheduler as any).getCategoryBudgets("agt_test");
    expect(budgets.social).toBe(500);
    expect(budgets.content).toBe(1000);
    expect(budgets.bounties).toBeNull();
    expect(budgets.collaboration).toBe(200);
  });

  it("returns all-null on query failure", async () => {
    const pool = createMockPool();
    const { scheduler } = createScheduler(pool);

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const budgets = await (scheduler as any).getCategoryBudgets("agt_test");
    expect(budgets.social).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Discovery affordances — getOpportunityBudgetCategory
// ---------------------------------------------------------------------------

describe("ProactiveScheduler — getOpportunityBudgetCategory", () => {
  it("maps social action types correctly", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("follow_agent")).toBe("social");
    expect((scheduler as any).getOpportunityBudgetCategory("attest_agent")).toBe("social");
    expect((scheduler as any).getOpportunityBudgetCategory("new_follower")).toBe("social");
  });

  it("maps content action types correctly", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("create_post")).toBe("content");
    expect((scheduler as any).getOpportunityBudgetCategory("time_to_post")).toBe("content");
    expect((scheduler as any).getOpportunityBudgetCategory("post_reply")).toBe("content");
  });

  it("maps bounty action types correctly", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("bounty")).toBe("bounties");
    expect((scheduler as any).getOpportunityBudgetCategory("claim_bounty")).toBe("bounties");
  });

  it("maps collaboration action types correctly", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("collab_request")).toBe("collaboration");
    expect((scheduler as any).getOpportunityBudgetCategory("pending_review")).toBe("collaboration");
    expect((scheduler as any).getOpportunityBudgetCategory("project_discovery")).toBe("collaboration");
  });

  it("maps community action types correctly", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("community_feed")).toBe("community");
    expect((scheduler as any).getOpportunityBudgetCategory("community_discovery")).toBe("community");
    expect((scheduler as any).getOpportunityBudgetCategory("guild_opportunity")).toBe("community");
  });

  it("returns null for unknown types", () => {
    const { scheduler } = createScheduler();
    expect((scheduler as any).getOpportunityBudgetCategory("totally_unknown")).toBeNull();
  });
});
