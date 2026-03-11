import { describe, it, expect, vi } from "vitest";
import { SelfImprovementEngine } from "./selfImprovementEngine.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockPerformanceTracker() {
  return {
    computePerformanceSnapshot: vi.fn().mockResolvedValue({
      successRate: 0.8,
      avgQuality: 0.7,
      totalActions: 50,
      creditsEfficiency: 0.05,
      timestamp: new Date().toISOString(),
    }),
    getBundlePerformance: vi.fn().mockResolvedValue([]),
    getPerformanceTrend: vi.fn().mockResolvedValue({
      direction: "stable",
      changePercent: 0,
      currentRate: 0.8,
      previousRate: 0.8,
    }),
    getAgentMetrics: vi.fn().mockResolvedValue({
      successRate: 0.8,
      totalActions: 50,
      bountiesCompleted: 3,
      postsCreated: 10,
    }),
  };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 10000, status: "active" }),
    addCredits: vi.fn(),
    deductCredits: vi.fn(),
  };
}

const SETTINGS_ROW = {
  agent_id: "agt_1",
  enabled: true,
  scan_interval_hours: 24,
  max_credits_per_cycle: 10000,
  max_proposals_per_week: 5,
  auto_apply_threshold: "0.9",
  soul_evolution_enabled: false,
  bundle_curation_enabled: true,
  paused_until: null,
  created_at: "2025-06-01T00:00:00.000Z",
  updated_at: "2025-06-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
//  getSettings
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — getSettings", () => {
  it("returns settings for agent", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS_ROW], rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const settings = await engine.getSettings("agt_1");

    expect(settings).not.toBeNull();
    expect(settings!.agentId).toBe("agt_1");
    expect(settings!.enabled).toBe(true);
    expect(settings!.autoApplyThreshold).toBe(0.9);
  });

  it("returns null when no settings exist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const settings = await engine.getSettings("agt_unknown");

    expect(settings).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  updateSettings
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — updateSettings", () => {
  it("upserts settings and returns mapped result", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ ...SETTINGS_ROW, enabled: false }], rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const settings = await engine.updateSettings("agt_1", { enabled: false });

    expect(settings.enabled).toBe(false);
    expect(settings.agentId).toBe("agt_1");
  });
});

// ---------------------------------------------------------------------------
//  getProposals
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — getProposals", () => {
  it("returns proposals for agent", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "prop_1",
        agent_id: "agt_1",
        proposal_type: "remove_knowledge",
        target_type: "bundle",
        target_id: "42",
        proposed_changes: { removeCids: ["bafytest"] },
        reasoning: "Low quality",
        confidence_score: "0.85",
        inference_cost: 50,
        status: "pending",
        owner_decision: null,
        owner_decided_at: null,
        applied_at: null,
        created_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const proposals = await engine.getProposals("agt_1");

    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe("remove_knowledge");
    expect(proposals[0].confidenceScore).toBeCloseTo(0.85);
  });

  it("filters by status", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await engine.getProposals("agt_1", "approved");

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("status");
  });
});

// ---------------------------------------------------------------------------
//  approveProposal / rejectProposal
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — approveProposal", () => {
  it("approves a pending proposal", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "prop_1" }], rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(engine.approveProposal("prop_1", "agt_1")).resolves.not.toThrow();
  });

  it("throws for non-existent or non-pending proposal", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(engine.approveProposal("prop_x", "agt_1")).rejects.toThrow("PROPOSAL_NOT_FOUND_OR_NOT_PENDING");
  });
});

describe("SelfImprovementEngine — rejectProposal", () => {
  it("rejects a pending proposal", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "prop_1" }], rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(engine.rejectProposal("prop_1", "agt_1")).resolves.not.toThrow();
  });

  it("throws for non-existent proposal", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(engine.rejectProposal("prop_x", "agt_1")).rejects.toThrow("PROPOSAL_NOT_FOUND_OR_NOT_PENDING");
  });
});

// ---------------------------------------------------------------------------
//  getSoulHistory
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — getSoulHistory", () => {
  it("returns soul version entries", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "sv_1",
        agent_id: "agt_1",
        version_number: 2,
        soul_cid: "bafynew",
        previous_cid: "bafyold",
        change_summary: "Updated personality",
        change_type: "personality_update",
        changed_fields: ["personality.traits"],
        deployment_id: null,
        created_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const history = await engine.getSoulHistory("agt_1");

    expect(history).toHaveLength(1);
    expect(history[0].versionNumber).toBe(2);
    expect(history[0].soulCid).toBe("bafynew");
    expect(history[0].previousCid).toBe("bafyold");
  });
});

// ---------------------------------------------------------------------------
//  recordSoulVersion
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — recordSoulVersion", () => {
  it("gets next version and inserts record", async () => {
    const pool = createMockPool();
    // SELECT next version
    pool.query.mockResolvedValueOnce({ rows: [{ next_version: 3 }], rowCount: 1 });
    // INSERT
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(
      engine.recordSoulVersion("agt_1", "bafynew", "bafyold", "Updated traits", "personality_update", ["personality.traits"]),
    ).resolves.not.toThrow();

    // Verify version number passed
    const insertParams = pool.query.mock.calls[1][1] as unknown[];
    expect(insertParams[1]).toBe(3); // next_version
  });
});

// ---------------------------------------------------------------------------
//  getCycleHistory
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — getCycleHistory", () => {
  it("returns cycle log entries", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cl_1",
        agent_id: "agt_1",
        trigger: "manual",
        knowledge_items_analyzed: 10,
        proposals_generated: 2,
        proposals_auto_applied: 1,
        proposals_queued: 1,
        credits_spent: "200",
        duration_ms: 5000,
        performance_snapshot: null,
        error_message: null,
        created_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const history = await engine.getCycleHistory("agt_1");

    expect(history).toHaveLength(1);
    expect(history[0].trigger).toBe("manual");
    expect(history[0].proposalsGenerated).toBe(2);
    expect(history[0].creditsSpent).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  shouldAutoTrigger
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — shouldAutoTrigger", () => {
  it("returns false when not enabled", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getSettings returns null

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    expect(await engine.shouldAutoTrigger("agt_1")).toBe(false);
  });

  it("returns false when ran recently", async () => {
    const pool = createMockPool();
    // getSettings
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS_ROW], rowCount: 1 });
    // Last cycle was 1 hour ago (within 24h scan_interval)
    pool.query.mockResolvedValueOnce({
      rows: [{ created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
      rowCount: 1,
    });

    const tracker = createMockPerformanceTracker();
    const engine = new SelfImprovementEngine(pool as any, tracker as any, null, createMockCreditManager() as any);
    expect(await engine.shouldAutoTrigger("agt_1")).toBe(false);
    // Should not even check trend
    expect(tracker.getPerformanceTrend).not.toHaveBeenCalled();
  });

  it("returns true when performance is declining significantly", async () => {
    const pool = createMockPool();
    // getSettings
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS_ROW], rowCount: 1 });
    // No recent cycles
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const tracker = createMockPerformanceTracker();
    tracker.getPerformanceTrend.mockResolvedValue({
      direction: "declining",
      changePercent: -25,
      currentRate: 0.5,
      previousRate: 0.75,
    });

    const engine = new SelfImprovementEngine(pool as any, tracker as any, null, createMockCreditManager() as any);
    expect(await engine.shouldAutoTrigger("agt_1")).toBe(true);
  });

  it("returns false when performance is stable", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS_ROW], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const tracker = createMockPerformanceTracker();
    tracker.getPerformanceTrend.mockResolvedValue({
      direction: "stable",
      changePercent: -5,
      currentRate: 0.75,
      previousRate: 0.79,
    });

    const engine = new SelfImprovementEngine(pool as any, tracker as any, null, createMockCreditManager() as any);
    expect(await engine.shouldAutoTrigger("agt_1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  markProposalApplied
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — markProposalApplied", () => {
  it("marks proposal as auto_applied", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    await expect(engine.markProposalApplied("prop_1", "agt_1")).resolves.not.toThrow();

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("auto_applied");
  });
});

// ---------------------------------------------------------------------------
//  runImprovementCycle — error paths
// ---------------------------------------------------------------------------

describe("SelfImprovementEngine — runImprovementCycle", () => {
  it("returns error result when improvement not enabled", async () => {
    const pool = createMockPool();
    // getSettings returns null
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Log failure cycle insert
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, createMockCreditManager() as any);
    const result = await engine.runImprovementCycle("agt_1", "0xabc", "manual");

    expect(result.proposalsGenerated).toBe(0);
    expect(result.performanceSnapshot.successRate).toBe(0);
  });

  it("pauses when account is paused", async () => {
    const pool = createMockPool();
    // getSettings
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS_ROW], rowCount: 1 });
    // UPDATE paused_until
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // Log failure
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const creditManager = createMockCreditManager();
    creditManager.getBalance.mockResolvedValue({ balance: 0, status: "paused" });

    const engine = new SelfImprovementEngine(pool as any, createMockPerformanceTracker() as any, null, creditManager as any);
    const result = await engine.runImprovementCycle("agt_1", "0xabc", "manual");

    expect(result.proposalsGenerated).toBe(0);
  });
});
