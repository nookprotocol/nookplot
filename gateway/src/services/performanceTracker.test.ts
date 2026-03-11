import { describe, it, expect, vi } from "vitest";
import { PerformanceTracker } from "./performanceTracker.js";
import { createMockPool } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  recordUsage
// ---------------------------------------------------------------------------

describe("PerformanceTracker — recordUsage", () => {
  it("inserts or increments usage count", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const tracker = new PerformanceTracker(pool as any);
    await tracker.recordUsage("agt_1", "cid_abc", 1);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_performance"),
      ["agt_1", "cid_abc", 1],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
//  recordOutcome
// ---------------------------------------------------------------------------

describe("PerformanceTracker — recordOutcome", () => {
  it("increments success_count on success", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const tracker = new PerformanceTracker(pool as any);
    await tracker.recordOutcome("agt_1", "cid_abc", true);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("success_count"),
      ["agt_1", "cid_abc"],
    );
  });

  it("increments failure_count on failure", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const tracker = new PerformanceTracker(pool as any);
    await tracker.recordOutcome("agt_1", "cid_abc", false);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("failure_count"),
      ["agt_1", "cid_abc"],
    );
  });
});

// ---------------------------------------------------------------------------
//  getBundlePerformance
// ---------------------------------------------------------------------------

describe("PerformanceTracker — getBundlePerformance", () => {
  it("returns mapped knowledge items", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        content_cid: "cid_1",
        bundle_id: 1,
        usage_count: 10,
        success_count: 8,
        failure_count: 2,
        avg_quality: "0.80",
        last_used_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const items = await tracker.getBundlePerformance("agt_1", 1);

    expect(items).toHaveLength(1);
    expect(items[0].contentCid).toBe("cid_1");
    expect(items[0].usageCount).toBe(10);
    expect(items[0].avgQuality).toBeCloseTo(0.8);
    expect(items[0].lastUsedAt).toContain("2025-06-01");
  });

  it("handles null last_used_at", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        content_cid: "cid_1",
        bundle_id: 1,
        usage_count: 1,
        success_count: 0,
        failure_count: 0,
        avg_quality: "0",
        last_used_at: null,
      }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const items = await tracker.getBundlePerformance("agt_1", 1);

    expect(items[0].lastUsedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getAgentMetrics
// ---------------------------------------------------------------------------

describe("PerformanceTracker — getAgentMetrics", () => {
  it("returns correct metrics with action type breakdown", async () => {
    const pool = createMockPool();

    // Actions query
    pool.query.mockResolvedValueOnce({
      rows: [{ total_actions: "10", successful_actions: "7", failed_actions: "3", avg_cost: "50" }],
      rowCount: 1,
    });
    // Breakdown query
    pool.query.mockResolvedValueOnce({
      rows: [
        { action_type: "create_post", count: "5" },
        { action_type: "claim_bounty", count: "2" },
      ],
      rowCount: 2,
    });
    // Alignment query
    pool.query.mockResolvedValueOnce({
      rows: [{ avg_alignment: "0.75" }],
      rowCount: 1,
    });
    // Credits query
    pool.query.mockResolvedValueOnce({
      rows: [{ earned: "1000", spent: "500" }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const metrics = await tracker.getAgentMetrics("agt_1", 30);

    expect(metrics.totalActions).toBe(10);
    expect(metrics.successfulActions).toBe(7);
    expect(metrics.failedActions).toBe(3);
    expect(metrics.successRate).toBeCloseTo(0.7);
    expect(metrics.actionTypeBreakdown).toEqual({
      create_post: 5,
      claim_bounty: 2,
    });
    expect(metrics.postsCreated).toBe(5);
    expect(metrics.bountiesCompleted).toBe(2);
    expect(metrics.avgAlignmentScore).toBeCloseTo(0.75);
    expect(metrics.creditsEarned).toBe(1000);
    expect(metrics.creditsSpent).toBe(500);
    expect(metrics.periodDays).toBe(30);
  });

  it("returns zero success rate when no actions", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [{ total_actions: "0", successful_actions: "0", failed_actions: "0" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ avg_alignment: null }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ earned: "0", spent: "0" }], rowCount: 1 });

    const tracker = new PerformanceTracker(pool as any);
    const metrics = await tracker.getAgentMetrics("agt_1");

    expect(metrics.successRate).toBe(0);
    expect(metrics.bountiesCompleted).toBe(0);
    expect(metrics.postsCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  getPerformanceTrend
// ---------------------------------------------------------------------------

describe("PerformanceTracker — getPerformanceTrend", () => {
  it("detects improving trend (>10% change)", async () => {
    const pool = createMockPool();

    // Recent period: 8/10 = 0.80
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "8", total: "10" }],
      rowCount: 1,
    });
    // Prior period: 5/10 = 0.50
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "5", total: "10" }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const trend = await tracker.getPerformanceTrend("agt_1", 14);

    expect(trend.direction).toBe("improving");
    expect(trend.currentRate).toBeCloseTo(0.8);
    expect(trend.previousRate).toBeCloseTo(0.5);
    expect(trend.changePercent).toBeGreaterThan(10);
  });

  it("detects declining trend (<-10% change)", async () => {
    const pool = createMockPool();

    // Recent: 3/10 = 0.30
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "3", total: "10" }],
      rowCount: 1,
    });
    // Prior: 8/10 = 0.80
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "8", total: "10" }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const trend = await tracker.getPerformanceTrend("agt_1");

    expect(trend.direction).toBe("declining");
    expect(trend.changePercent).toBeLessThan(-10);
  });

  it("detects stable trend (within ±10%)", async () => {
    const pool = createMockPool();

    // Recent: 7/10 = 0.70
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "7", total: "10" }],
      rowCount: 1,
    });
    // Prior: 7/10 = 0.70
    pool.query.mockResolvedValueOnce({
      rows: [{ successes: "7", total: "10" }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const trend = await tracker.getPerformanceTrend("agt_1");

    expect(trend.direction).toBe("stable");
  });

  it("handles no activity in either period", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({ rows: [{ successes: "0", total: "0" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ successes: "0", total: "0" }], rowCount: 1 });

    const tracker = new PerformanceTracker(pool as any);
    const trend = await tracker.getPerformanceTrend("agt_1");

    expect(trend.direction).toBe("stable");
    expect(trend.currentRate).toBe(0);
    expect(trend.previousRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  getKnowledgeRankings
// ---------------------------------------------------------------------------

describe("PerformanceTracker — getKnowledgeRankings", () => {
  it("returns top and bottom ranked items", async () => {
    const pool = createMockPool();

    // Top query
    pool.query.mockResolvedValueOnce({
      rows: [{
        content_cid: "top_1",
        bundle_id: 1,
        usage_count: 20,
        success_count: 18,
        failure_count: 2,
        avg_quality: "0.90",
        last_used_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });
    // Bottom query
    pool.query.mockResolvedValueOnce({
      rows: [{
        content_cid: "bottom_1",
        bundle_id: 1,
        usage_count: 10,
        success_count: 2,
        failure_count: 8,
        avg_quality: "0.20",
        last_used_at: null,
      }],
      rowCount: 1,
    });

    const tracker = new PerformanceTracker(pool as any);
    const rankings = await tracker.getKnowledgeRankings("agt_1", 1);

    expect(rankings.top).toHaveLength(1);
    expect(rankings.top[0].contentCid).toBe("top_1");
    expect(rankings.top[0].avgQuality).toBeCloseTo(0.9);

    expect(rankings.bottom).toHaveLength(1);
    expect(rankings.bottom[0].contentCid).toBe("bottom_1");
    expect(rankings.bottom[0].avgQuality).toBeCloseTo(0.2);
  });
});
