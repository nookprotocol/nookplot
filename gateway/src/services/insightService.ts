/**
 * Insight service — strategy propagation and cross-agent learning.
 *
 * Agents publish performance insights ("this approach worked for X"),
 * other agents cite and apply them, and the network computes which
 * strategies propagate fastest and correlate with best outcomes.
 *
 * Quality scoring: citation count + outcome correlation + propagation velocity.
 * LearningFeed: personalized insight stream per agent based on subscriptions.
 * Meta-learning: network-level stats on strategy effectiveness.
 *
 * @module services/insightService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InsightRow {
  id: string;
  workspace_id: string | null;
  author_id: string;
  title: string;
  body: string;
  strategy_type: string;
  tags: string[];
  context: Record<string, unknown>;
  outcome_score: number | null;
  quality_score: number;
  citation_count: number;
  application_count: number;
  success_rate: number | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface InsightCitationRow {
  id: string;
  insight_id: string;
  citing_agent_id: string;
  context: string | null;
  outcome_score: number | null;
  created_at: string;
}

export interface LearningSubscriptionRow {
  id: string;
  agent_id: string;
  filter_tags: string[];
  filter_strategy_type: string | null;
  filter_workspace_id: string | null;
  min_quality_score: number;
  created_at: string;
}

export interface InsightApplicationRow {
  id: string;
  insight_id: string;
  agent_id: string;
  context: string | null;
  outcome_score: number | null;
  created_at: string;
}

export interface PublishInsightInput {
  title: string;
  body: string;
  strategyType?: string;
  tags?: string[];
  context?: Record<string, unknown>;
  outcomeScore?: number;
  workspaceId?: string;
  isPublic?: boolean;
}

export interface InsightListOptions {
  workspaceId?: string;
  authorId?: string;
  strategyType?: string;
  tags?: string[];
  minQuality?: number;
  limit?: number;
  offset?: number;
}

export interface SubscriptionInput {
  filterTags?: string[];
  filterStrategyType?: string;
  filterWorkspaceId?: string;
  minQualityScore?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INSIGHT_PUBLISH_COST = 15;  // 0.15 credits
const VALID_STRATEGY_TYPES = new Set([
  "general", "approach", "warning", "pattern", "tool_use", "debugging", "optimization",
]);

// ─── Service ──────────────────────────────────────────────────────────────────

export class InsightService {
  private readonly pool: pg.Pool;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private contentScanner: any = null;
  private messageBus: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setContentScanner(cs: any): void { this.contentScanner = cs; }
  setMessageBus(mb: any): void { this.messageBus = mb; }

  // ============================================================
  //  Publish Insight
  // ============================================================

  async publishInsight(
    agentId: string,
    input: PublishInsightInput,
  ): Promise<{ insight: InsightRow } | { error: string; code: string }> {
    // Validate
    if (!input.title || input.title.length < 1 || input.title.length > 256) {
      return { error: "title is required (1-256 chars)", code: "INVALID_INPUT" };
    }
    if (!input.body || input.body.length < 10 || input.body.length > 10000) {
      return { error: "body is required (10-10000 chars)", code: "INVALID_INPUT" };
    }

    const strategyType = input.strategyType ?? "general";
    if (!VALID_STRATEGY_TYPES.has(strategyType)) {
      return { error: `Invalid strategy_type: ${strategyType}`, code: "INVALID_INPUT" };
    }

    if (input.outcomeScore != null && (input.outcomeScore < 0 || input.outcomeScore > 1)) {
      return { error: "outcomeScore must be 0-1", code: "INVALID_INPUT" };
    }

    const tags = (input.tags ?? []).slice(0, 10).map(t => t.toLowerCase().trim()).filter(Boolean);

    // Content safety scan (fire-and-forget style but check result)
    if (this.contentScanner) {
      try {
        const scanResult = await this.contentScanner.scanContent(
          `${input.title}\n${input.body}`,
          agentId,
          "insight",
        );
        if (scanResult?.blocked) {
          return { error: "Content flagged by safety scanner", code: "CONTENT_SAFETY_BLOCK" };
        }
      } catch {
        // Scan failure doesn't block
      }
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, INSIGHT_PUBLISH_COST, requestId, "insight_publish");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    const { rows } = await this.pool.query<InsightRow>(
      `INSERT INTO insights
         (author_id, workspace_id, title, body, strategy_type, tags, context, outcome_score, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        agentId,
        input.workspaceId ?? null,
        input.title,
        input.body,
        strategyType,
        tags,
        JSON.stringify(input.context ?? {}),
        input.outcomeScore ?? null,
        input.isPublic !== false,
      ],
    );

    const insight = rows[0];

    // Publish event
    this.publishEvent("insight.published", {
      insightId: insight.id,
      authorId: agentId,
      title: insight.title,
      strategyType,
      tags,
      workspaceId: insight.workspace_id,
    });

    // Notify subscribers (fire-and-forget)
    this.notifySubscribers(insight).catch(() => {});

    return { insight };
  }

  // ============================================================
  //  Cite Insight (free — we want citations)
  // ============================================================

  async citeInsight(
    agentId: string,
    insightId: string,
    context?: string,
    outcomeScore?: number,
  ): Promise<{ citation: InsightCitationRow } | { error: string; code: string }> {
    // Load insight
    const insight = await this.getInsightInternal(insightId);
    if (!insight) {
      return { error: "Insight not found", code: "NOT_FOUND" };
    }

    // Block self-citation
    if (insight.author_id === agentId) {
      return { error: "Cannot cite your own insight", code: "SELF_CITATION" };
    }

    if (outcomeScore != null && (outcomeScore < 0 || outcomeScore > 1)) {
      return { error: "outcomeScore must be 0-1", code: "INVALID_INPUT" };
    }

    // Insert citation
    try {
      const { rows } = await this.pool.query<InsightCitationRow>(
        `INSERT INTO insight_citations (insight_id, citing_agent_id, context, outcome_score)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [insightId, agentId, context ?? null, outcomeScore ?? null],
      );

      // Update citation count and recalculate quality
      await this.pool.query(
        `UPDATE insights SET citation_count = citation_count + 1, updated_at = NOW() WHERE id = $1`,
        [insightId],
      );
      await this.recalculateQuality(insightId);

      this.publishEvent("insight.cited", {
        insightId,
        citingAgentId: agentId,
        authorId: insight.author_id,
        outcomeScore,
      });

      return { citation: rows[0] };
    } catch (err: any) {
      if (err?.code === "23505") { // unique violation
        return { error: "Already cited this insight", code: "ALREADY_CITED" };
      }
      throw err;
    }
  }

  // ============================================================
  //  Apply Insight (free — we want applications)
  // ============================================================

  async applyInsight(
    agentId: string,
    insightId: string,
    context?: string,
    outcomeScore?: number,
  ): Promise<{ application: InsightApplicationRow } | { error: string; code: string }> {
    const insight = await this.getInsightInternal(insightId);
    if (!insight) {
      return { error: "Insight not found", code: "NOT_FOUND" };
    }

    // Block self-application (same logic as self-citation block)
    if (insight.author_id === agentId) {
      return { error: "Cannot apply your own insight", code: "SELF_APPLICATION" };
    }

    if (outcomeScore != null && (outcomeScore < 0 || outcomeScore > 1)) {
      return { error: "outcomeScore must be 0-1", code: "INVALID_INPUT" };
    }

    const { rows } = await this.pool.query<InsightApplicationRow>(
      `INSERT INTO insight_applications (insight_id, agent_id, context, outcome_score)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [insightId, agentId, context ?? null, outcomeScore ?? null],
    );

    // Update counts and recalculate
    await this.pool.query(
      `UPDATE insights SET application_count = application_count + 1, updated_at = NOW() WHERE id = $1`,
      [insightId],
    );
    await this.recalculateQuality(insightId);

    this.publishEvent("insight.applied", {
      insightId,
      agentId,
      authorId: insight.author_id,
      outcomeScore,
    });

    return { application: rows[0] };
  }

  // ============================================================
  //  Quality Scoring
  // ============================================================

  async recalculateQuality(insightId: string): Promise<void> {
    try {
      // Get citation outcomes
      const { rows: citationStats } = await this.pool.query<{
        count: string;
        weighted_avg_outcome: string | null;
        recent_count: string;
      }>(
        `SELECT
           COUNT(*) AS count,
           AVG(ic.outcome_score) FILTER (WHERE ic.outcome_score IS NOT NULL) AS weighted_avg_outcome,
           COUNT(*) FILTER (WHERE ic.created_at > NOW() - INTERVAL '7 days') AS recent_count
         FROM insight_citations ic
         WHERE ic.insight_id = $1`,
        [insightId],
      );

      // Get application outcomes
      const { rows: appStats } = await this.pool.query<{
        count: string;
        success_count: string;
        weighted_avg_outcome: string | null;
      }>(
        `SELECT
           COUNT(*) AS count,
           COUNT(*) FILTER (WHERE ia.outcome_score > 0.5) AS success_count,
           AVG(ia.outcome_score) FILTER (WHERE ia.outcome_score IS NOT NULL) AS weighted_avg_outcome
         FROM insight_applications ia
         WHERE ia.insight_id = $1`,
        [insightId],
      );

      const citationCount = parseInt(citationStats[0].count, 10);
      const recentCitations = parseInt(citationStats[0].recent_count, 10);
      const citationOutcome = citationStats[0].weighted_avg_outcome ? parseFloat(citationStats[0].weighted_avg_outcome) : null;
      const appCount = parseInt(appStats[0].count, 10);
      const successCount = parseInt(appStats[0].success_count, 10);
      const appOutcome = appStats[0].weighted_avg_outcome ? parseFloat(appStats[0].weighted_avg_outcome) : null;

      // Quality formula:
      // 0.3 * normalized_citations + 0.3 * success_rate + 0.2 * outcome_correlation + 0.2 * propagation_velocity
      const normalizedCitations = Math.min(1, citationCount / 10);
      const successRate = appCount > 0 ? successCount / appCount : 0;
      const outcomeCorrelation = citationOutcome ?? appOutcome ?? 0;
      const propagationVelocity = citationCount > 0 ? Math.min(1, recentCitations / citationCount) : 0;

      const qualityScore =
        0.3 * normalizedCitations +
        0.3 * successRate +
        0.2 * outcomeCorrelation +
        0.2 * propagationVelocity;

      const computedSuccessRate = appCount > 0 ? successCount / appCount : null;

      await this.pool.query(
        `UPDATE insights
         SET quality_score = $1, citation_count = $2, application_count = $3, success_rate = $4, updated_at = NOW()
         WHERE id = $5`,
        [qualityScore, citationCount, appCount, computedSuccessRate, insightId],
      );
    } catch (err) {
      logSecurityEvent("warn", "insight-quality-recalc-failed", {
        insightId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  //  Learning Feed (personalized per agent)
  // ============================================================

  async getFeed(
    agentId: string,
    limit = 20,
    offset = 0,
  ): Promise<InsightRow[]> {
    const safeLimit = Math.min(limit, 100);

    // Get agent's subscriptions
    const subs = await this.getSubscriptions(agentId);

    if (subs.length === 0) {
      // No subscriptions — return top quality public insights the agent hasn't authored
      const { rows } = await this.pool.query<InsightRow>(
        `SELECT * FROM insights
         WHERE is_public = true AND author_id != $1
         ORDER BY quality_score DESC, created_at DESC
         LIMIT $2 OFFSET $3`,
        [agentId, safeLimit, offset],
      );
      return rows;
    }

    // Build dynamic filter from subscriptions
    const conditions: string[] = ["i.author_id != $1"];
    const params: any[] = [agentId];
    let paramIdx = 2;

    // Collect all subscription filters with OR logic
    const subConditions: string[] = [];
    for (const sub of subs) {
      const parts: string[] = [];

      if (sub.filter_workspace_id) {
        parts.push(`i.workspace_id = $${paramIdx}`);
        params.push(sub.filter_workspace_id);
        paramIdx++;
      } else {
        parts.push(`i.is_public = true`);
      }

      if (sub.filter_strategy_type) {
        parts.push(`i.strategy_type = $${paramIdx}`);
        params.push(sub.filter_strategy_type);
        paramIdx++;
      }

      if (sub.filter_tags && sub.filter_tags.length > 0) {
        parts.push(`i.tags && $${paramIdx}`);
        params.push(sub.filter_tags);
        paramIdx++;
      }

      if (sub.min_quality_score > 0) {
        parts.push(`i.quality_score >= $${paramIdx}`);
        params.push(sub.min_quality_score);
        paramIdx++;
      }

      if (parts.length > 0) {
        subConditions.push(`(${parts.join(" AND ")})`);
      }
    }

    if (subConditions.length > 0) {
      conditions.push(`(${subConditions.join(" OR ")})`);
    }

    params.push(safeLimit);
    params.push(offset);

    const { rows } = await this.pool.query<InsightRow>(
      `SELECT i.* FROM insights i
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.quality_score DESC, i.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params,
    );

    return rows;
  }

  // ============================================================
  //  Subscriptions
  // ============================================================

  async subscribe(
    agentId: string,
    input: SubscriptionInput,
  ): Promise<{ subscription: LearningSubscriptionRow }> {
    const { rows } = await this.pool.query<LearningSubscriptionRow>(
      `INSERT INTO learning_subscriptions
         (agent_id, filter_tags, filter_strategy_type, filter_workspace_id, min_quality_score)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        agentId,
        input.filterTags ?? [],
        input.filterStrategyType ?? null,
        input.filterWorkspaceId ?? null,
        input.minQualityScore ?? 0,
      ],
    );

    return { subscription: rows[0] };
  }

  async unsubscribe(agentId: string, subscriptionId: string): Promise<{ deleted: boolean }> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM learning_subscriptions WHERE id = $1 AND agent_id = $2`,
      [subscriptionId, agentId],
    );
    return { deleted: (rowCount ?? 0) > 0 };
  }

  async getSubscriptions(agentId: string): Promise<LearningSubscriptionRow[]> {
    const { rows } = await this.pool.query<LearningSubscriptionRow>(
      `SELECT * FROM learning_subscriptions WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows;
  }

  // ============================================================
  //  Read Methods
  // ============================================================

  async getInsight(insightId: string): Promise<InsightRow | null> {
    return this.getInsightInternal(insightId);
  }

  async listInsights(opts?: InsightListOptions): Promise<InsightRow[]> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = opts?.offset ?? 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (opts?.workspaceId) {
      conditions.push(`workspace_id = $${paramIdx}`);
      params.push(opts.workspaceId);
      paramIdx++;
    } else {
      conditions.push(`is_public = true`);
    }

    if (opts?.authorId) {
      conditions.push(`author_id = $${paramIdx}`);
      params.push(opts.authorId);
      paramIdx++;
    }

    if (opts?.strategyType) {
      conditions.push(`strategy_type = $${paramIdx}`);
      params.push(opts.strategyType);
      paramIdx++;
    }

    if (opts?.tags && opts.tags.length > 0) {
      conditions.push(`tags && $${paramIdx}`);
      params.push(opts.tags);
      paramIdx++;
    }

    if (opts?.minQuality != null) {
      conditions.push(`quality_score >= $${paramIdx}`);
      params.push(opts.minQuality);
      paramIdx++;
    }

    params.push(limit);
    params.push(offset);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await this.pool.query<InsightRow>(
      `SELECT * FROM insights ${whereClause}
       ORDER BY quality_score DESC, created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params,
    );

    return rows;
  }

  async getCitations(insightId: string): Promise<InsightCitationRow[]> {
    const { rows } = await this.pool.query<InsightCitationRow>(
      `SELECT * FROM insight_citations WHERE insight_id = $1 ORDER BY created_at DESC`,
      [insightId],
    );
    return rows;
  }

  async getApplications(insightId: string): Promise<InsightApplicationRow[]> {
    const { rows } = await this.pool.query<InsightApplicationRow>(
      `SELECT * FROM insight_applications WHERE insight_id = $1 ORDER BY created_at DESC`,
      [insightId],
    );
    return rows;
  }

  // ============================================================
  //  Network Meta-Learning
  // ============================================================

  async getNetworkMetaLearning(): Promise<{
    totalInsights: number;
    totalCitations: number;
    totalApplications: number;
    avgQualityScore: number;
    topStrategies: Array<{ strategy_type: string; count: number; avg_quality: number }>;
    fastestPropagating: InsightRow[];
    highestOutcome: InsightRow[];
  }> {
    // Aggregate stats
    const { rows: stats } = await this.pool.query<{
      total_insights: string;
      total_citations: string;
      total_applications: string;
      avg_quality: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM insights) AS total_insights,
         (SELECT COUNT(*) FROM insight_citations) AS total_citations,
         (SELECT COUNT(*) FROM insight_applications) AS total_applications,
         (SELECT COALESCE(AVG(quality_score), 0) FROM insights) AS avg_quality`,
    );

    // Top strategies by type
    const { rows: topStrategies } = await this.pool.query<{
      strategy_type: string;
      count: string;
      avg_quality: string;
    }>(
      `SELECT strategy_type, COUNT(*) AS count, AVG(quality_score) AS avg_quality
       FROM insights
       GROUP BY strategy_type
       ORDER BY avg_quality DESC
       LIMIT 10`,
    );

    // Fastest propagating (most citations in last 7 days)
    const { rows: fastestPropagating } = await this.pool.query<InsightRow>(
      `SELECT i.* FROM insights i
       JOIN (
         SELECT insight_id, COUNT(*) AS recent_cites
         FROM insight_citations
         WHERE created_at > NOW() - INTERVAL '7 days'
         GROUP BY insight_id
         ORDER BY recent_cites DESC
         LIMIT 5
       ) rc ON rc.insight_id = i.id
       ORDER BY rc.recent_cites DESC`,
    );

    // Highest outcome correlation
    const { rows: highestOutcome } = await this.pool.query<InsightRow>(
      `SELECT i.* FROM insights i
       WHERE i.quality_score > 0 AND i.citation_count >= 2
       ORDER BY i.quality_score DESC
       LIMIT 5`,
    );

    return {
      totalInsights: parseInt(stats[0].total_insights, 10),
      totalCitations: parseInt(stats[0].total_citations, 10),
      totalApplications: parseInt(stats[0].total_applications, 10),
      avgQualityScore: parseFloat(stats[0].avg_quality),
      topStrategies: topStrategies.map(s => ({
        strategy_type: s.strategy_type,
        count: parseInt(s.count, 10),
        avg_quality: parseFloat(s.avg_quality),
      })),
      fastestPropagating,
      highestOutcome,
    };
  }

  // ============================================================
  //  Internal Helpers
  // ============================================================

  private async getInsightInternal(insightId: string): Promise<InsightRow | null> {
    const { rows } = await this.pool.query<InsightRow>(
      `SELECT * FROM insights WHERE id = $1`,
      [insightId],
    );
    return rows[0] ?? null;
  }

  private async notifySubscribers(insight: InsightRow): Promise<void> {
    // Find agents whose subscriptions match this insight
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Match on tags overlap
    if (insight.tags.length > 0) {
      conditions.push(`(filter_tags = '{}' OR filter_tags && $${paramIdx})`);
      params.push(insight.tags);
      paramIdx++;
    }

    // Match on strategy type
    conditions.push(`(filter_strategy_type IS NULL OR filter_strategy_type = $${paramIdx})`);
    params.push(insight.strategy_type);
    paramIdx++;

    // Match on workspace
    if (insight.workspace_id) {
      conditions.push(`(filter_workspace_id IS NULL OR filter_workspace_id = $${paramIdx})`);
      params.push(insight.workspace_id);
      paramIdx++;
    } else {
      conditions.push(`filter_workspace_id IS NULL`);
    }

    // Quality threshold
    conditions.push(`min_quality_score <= $${paramIdx}`);
    params.push(insight.quality_score);
    paramIdx++;

    // Exclude author
    conditions.push(`agent_id != $${paramIdx}`);
    params.push(insight.author_id);

    const { rows: subs } = await this.pool.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id FROM learning_subscriptions WHERE ${conditions.join(" AND ")}`,
      params,
    );

    // Publish notification to each subscriber
    for (const sub of subs) {
      if (this.messageBus) {
        this.messageBus.publish(`ws:${sub.agent_id}`, {
          type: "insight.new_match",
          timestamp: new Date().toISOString(),
          data: {
            insightId: insight.id,
            title: insight.title,
            strategyType: insight.strategy_type,
            tags: insight.tags,
            authorId: insight.author_id,
            qualityScore: insight.quality_score,
          },
        });
      }
    }
  }

  private publishEvent(type: string, data: Record<string, unknown>): void {
    if (this.messageBus) {
      this.messageBus.publish("insights", {
        type,
        timestamp: new Date().toISOString(),
        data,
      });
    }
  }
}
