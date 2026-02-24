/**
 * Performance tracker for the self-improvement loop.
 *
 * Tracks which knowledge items correlate with agent success,
 * computes agent-level performance metrics, and detects trends
 * to guide self-improvement decisions.
 *
 * @module services/performanceTracker
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "./subgraphGateway.js";

// ============================================================
//  Types
// ============================================================

export interface KnowledgePerformanceItem {
  contentCid: string;
  bundleId: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  avgQuality: number;
  lastUsedAt: string | null;
}

export interface AgentPerformanceMetrics {
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  successRate: number;
  /** Dynamic per-action-type completion counts (replaces hardcoded bountiesCompleted/postsCreated). */
  actionTypeBreakdown: Record<string, number>;
  /** @deprecated Use actionTypeBreakdown["claim_bounty"] instead. Kept for backward compatibility. */
  bountiesCompleted: number;
  /** @deprecated Use actionTypeBreakdown["create_post"] instead. Kept for backward compatibility. */
  postsCreated: number;
  avgAlignmentScore: number;
  creditsEarned: number;
  creditsSpent: number;
  periodDays: number;
}

export interface PerformanceTrend {
  direction: "improving" | "stable" | "declining";
  changePercent: number;
  currentRate: number;
  previousRate: number;
  windowDays: number;
}

export interface PerformanceSnapshot {
  successRate: number;
  avgQuality: number;
  totalActions: number;
  creditsEfficiency: number;
  timestamp: string;
}

// ============================================================
//  PerformanceTracker
// ============================================================

export class PerformanceTracker {
  private pool: pg.Pool;
  private subgraphGateway?: SubgraphGateway;

  constructor(pool: pg.Pool, subgraphGateway?: SubgraphGateway) {
    this.pool = pool;
    this.subgraphGateway = subgraphGateway;
  }

  // ----------------------------------------------------------
  //  Record knowledge usage/outcome
  // ----------------------------------------------------------

  /**
   * Record that a knowledge CID was referenced during an inference call.
   */
  async recordUsage(agentId: string, contentCid: string, bundleId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_performance (agent_id, content_cid, bundle_id, usage_count, last_used_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (agent_id, content_cid) DO UPDATE SET
         usage_count = knowledge_performance.usage_count + 1,
         last_used_at = NOW(),
         updated_at = NOW()`,
      [agentId, contentCid, bundleId],
    );
  }

  /**
   * Record a success or failure outcome for a knowledge CID.
   * Recomputes avg_quality = success_count / (success_count + failure_count).
   */
  async recordOutcome(agentId: string, contentCid: string, success: boolean): Promise<void> {
    const col = success ? "success_count" : "failure_count";
    await this.pool.query(
      `UPDATE knowledge_performance
       SET ${col} = ${col} + 1,
           avg_quality = CASE
             WHEN (success_count + failure_count + 1) = 0 THEN 0
             ELSE (success_count ${success ? "+ 1" : ""})::REAL / (success_count + failure_count + 1)::REAL
           END,
           updated_at = NOW()
       WHERE agent_id = $1 AND content_cid = $2`,
      [agentId, contentCid],
    );
  }

  // ----------------------------------------------------------
  //  Query performance data
  // ----------------------------------------------------------

  /**
   * Get performance metrics for all knowledge items in a bundle.
   */
  async getBundlePerformance(agentId: string, bundleId: number): Promise<KnowledgePerformanceItem[]> {
    const result = await this.pool.query(
      `SELECT content_cid, bundle_id, usage_count, success_count, failure_count,
              avg_quality, last_used_at
       FROM knowledge_performance
       WHERE agent_id = $1 AND bundle_id = $2
       ORDER BY avg_quality DESC, usage_count DESC`,
      [agentId, bundleId],
    );

    return result.rows.map((r) => ({
      contentCid: r.content_cid,
      bundleId: r.bundle_id,
      usageCount: r.usage_count,
      successCount: r.success_count,
      failureCount: r.failure_count,
      avgQuality: parseFloat(r.avg_quality),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    }));
  }

  /**
   * Get agent's overall performance metrics.
   * Aggregates from proactive_actions, proactive_feedback, and credit_transactions.
   */
  async getAgentMetrics(agentId: string, periodDays: number = 30): Promise<AgentPerformanceMetrics> {
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    // Query proactive actions — overall counts + dynamic per-action-type breakdown
    const [actionsResult, breakdownResult, alignResult, creditsResult] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS total_actions,
           COUNT(*) FILTER (WHERE status = 'completed') AS successful_actions,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed_actions,
           AVG(CASE WHEN status IN ('completed', 'failed') THEN inference_cost ELSE NULL END) AS avg_cost
         FROM proactive_actions
         WHERE agent_id = $1 AND created_at >= $2`,
        [agentId, since],
      ),
      // Dynamic per-action-type breakdown (replaces hardcoded bounties/posts counts)
      this.pool.query<{ action_type: string; count: string }>(
        `SELECT action_type, COUNT(*) AS count
         FROM proactive_actions
         WHERE agent_id = $1 AND created_at >= $2 AND status = 'completed'
         GROUP BY action_type`,
        [agentId, since],
      ),
      // Query average alignment score from opportunities
      this.pool.query(
        `SELECT AVG(alignment_score) AS avg_alignment
         FROM proactive_opportunities
         WHERE agent_id = $1 AND created_at >= $2 AND alignment_score > 0`,
        [agentId, since],
      ),
      // Query credit flows
      this.pool.query(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE type IN ('auto_convert', 'top_up', 'bounty_reward', 'initial_deposit')), 0) AS earned,
           COALESCE(SUM(amount) FILTER (WHERE type = 'inference_spend'), 0) AS spent
         FROM credit_transactions
         WHERE agent_id = $1 AND created_at >= $2`,
        [agentId, since],
      ),
    ]);

    const a = actionsResult.rows[0];
    const total = parseInt(a.total_actions || "0", 10);
    const successful = parseInt(a.successful_actions || "0", 10);
    const failed = parseInt(a.failed_actions || "0", 10);

    // Build dynamic action type breakdown
    const actionTypeBreakdown: Record<string, number> = {};
    for (const row of breakdownResult.rows) {
      actionTypeBreakdown[row.action_type] = parseInt(row.count || "0", 10);
    }

    return {
      totalActions: total,
      successfulActions: successful,
      failedActions: failed,
      successRate: total > 0 ? successful / total : 0,
      actionTypeBreakdown,
      bountiesCompleted: actionTypeBreakdown["claim_bounty"] ?? 0,
      postsCreated: actionTypeBreakdown["create_post"] ?? 0,
      avgAlignmentScore: parseFloat(alignResult.rows[0]?.avg_alignment || "0"),
      creditsEarned: parseInt(creditsResult.rows[0]?.earned || "0", 10),
      creditsSpent: parseInt(creditsResult.rows[0]?.spent || "0", 10),
      periodDays,
    };
  }

  /**
   * Detect performance trend over a window by comparing recent vs prior period.
   * Compares success rate in the recent N/2 days vs the prior N/2 days.
   */
  async getPerformanceTrend(agentId: string, windowDays: number = 14): Promise<PerformanceTrend> {
    const halfWindow = Math.floor(windowDays / 2);
    const now = Date.now();
    const midpoint = new Date(now - halfWindow * 24 * 60 * 60 * 1000).toISOString();
    const start = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // Recent period (second half of window)
    const recentResult = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS successes,
         COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS total
       FROM proactive_actions
       WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, midpoint],
    );

    // Prior period (first half of window)
    const priorResult = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS successes,
         COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS total
       FROM proactive_actions
       WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`,
      [agentId, start, midpoint],
    );

    const recentTotal = parseInt(recentResult.rows[0]?.total || "0", 10);
    const recentSuccesses = parseInt(recentResult.rows[0]?.successes || "0", 10);
    const priorTotal = parseInt(priorResult.rows[0]?.total || "0", 10);
    const priorSuccesses = parseInt(priorResult.rows[0]?.successes || "0", 10);

    const currentRate = recentTotal > 0 ? recentSuccesses / recentTotal : 0;
    const previousRate = priorTotal > 0 ? priorSuccesses / priorTotal : 0;

    let changePercent = 0;
    if (previousRate > 0) {
      changePercent = ((currentRate - previousRate) / previousRate) * 100;
    }

    let direction: "improving" | "stable" | "declining" = "stable";
    if (changePercent > 10) direction = "improving";
    else if (changePercent < -10) direction = "declining";

    return { direction, changePercent, currentRate, previousRate, windowDays };
  }

  /**
   * Get top-performing and worst-performing knowledge items.
   */
  async getKnowledgeRankings(
    agentId: string,
    bundleId: number,
    limit: number = 5,
  ): Promise<{ top: KnowledgePerformanceItem[]; bottom: KnowledgePerformanceItem[] }> {
    const topResult = await this.pool.query(
      `SELECT content_cid, bundle_id, usage_count, success_count, failure_count,
              avg_quality, last_used_at
       FROM knowledge_performance
       WHERE agent_id = $1 AND bundle_id = $2 AND (success_count + failure_count) > 0
       ORDER BY avg_quality DESC, usage_count DESC
       LIMIT $3`,
      [agentId, bundleId, limit],
    );

    const bottomResult = await this.pool.query(
      `SELECT content_cid, bundle_id, usage_count, success_count, failure_count,
              avg_quality, last_used_at
       FROM knowledge_performance
       WHERE agent_id = $1 AND bundle_id = $2 AND (success_count + failure_count) > 0
       ORDER BY avg_quality ASC, failure_count DESC
       LIMIT $3`,
      [agentId, bundleId, limit],
    );

    const mapRow = (r: Record<string, unknown>): KnowledgePerformanceItem => ({
      contentCid: r.content_cid as string,
      bundleId: r.bundle_id as number,
      usageCount: r.usage_count as number,
      successCount: r.success_count as number,
      failureCount: r.failure_count as number,
      avgQuality: parseFloat(String(r.avg_quality)),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null,
    });

    return {
      top: topResult.rows.map(mapRow),
      bottom: bottomResult.rows.map(mapRow),
    };
  }

  /**
   * Compute a performance snapshot for logging in improvement_cycle_log.
   */
  async computePerformanceSnapshot(agentId: string): Promise<PerformanceSnapshot> {
    const metrics = await this.getAgentMetrics(agentId, 30);

    // Average knowledge quality across all items
    const qualityResult = await this.pool.query(
      `SELECT AVG(avg_quality) AS avg_quality
       FROM knowledge_performance
       WHERE agent_id = $1 AND (success_count + failure_count) > 0`,
      [agentId],
    );

    const avgQuality = parseFloat(qualityResult.rows[0]?.avg_quality || "0");
    const creditsEfficiency =
      metrics.creditsSpent > 0 ? metrics.successfulActions / metrics.creditsSpent : 0;

    return {
      successRate: metrics.successRate,
      avgQuality,
      totalActions: metrics.totalActions,
      creditsEfficiency,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Optional: query subgraph for additional performance signals.
   * Falls back gracefully if no endpoint configured.
   */
  private async querySubgraph(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    if (!this.subgraphGateway) return null;

    try {
      const result = await this.subgraphGateway.query<Record<string, unknown>>(query, variables);
      return result.data ?? null;
    } catch {
      logSecurityEvent("warn", "performance-tracker-subgraph-query-failed", {});
      return null;
    }
  }
}
