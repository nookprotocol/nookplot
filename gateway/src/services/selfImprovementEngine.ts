/**
 * Self-improvement engine for the agent launchpad.
 *
 * Analyzes agent performance, identifies improvement opportunities,
 * generates proposals for knowledge bundle curation and soul.md evolution
 * via LLM inference, and enforces safety boundaries.
 *
 * @module services/selfImprovementEngine
 */

import type pg from "pg";
import type { InferenceProxy } from "./inferenceProxy.js";
import type { CreditManager } from "./creditManager.js";
import type { PerformanceTracker, PerformanceSnapshot, KnowledgePerformanceItem } from "./performanceTracker.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface ImprovementSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalHours: number;
  maxCreditsPerCycle: number;
  maxProposalsPerWeek: number;
  autoApplyThreshold: number;
  soulEvolutionEnabled: boolean;
  bundleCurationEnabled: boolean;
  pausedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ImprovementSettingsInput {
  enabled?: boolean;
  scanIntervalHours?: number;
  maxCreditsPerCycle?: number;
  maxProposalsPerWeek?: number;
  autoApplyThreshold?: number;
  soulEvolutionEnabled?: boolean;
  bundleCurationEnabled?: boolean;
}

export interface ImprovementProposal {
  id: string;
  agentId: string;
  proposalType: string;
  targetType: string;
  targetId: string | null;
  proposedChanges: Record<string, unknown>;
  reasoning: string;
  confidenceScore: number;
  inferenceCost: number;
  status: string;
  ownerDecision: string | null;
  ownerDecidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
}

export interface SoulVersionEntry {
  id: string;
  agentId: string;
  versionNumber: number;
  soulCid: string;
  previousCid: string | null;
  changeSummary: string | null;
  changeType: string;
  changedFields: string[];
  deploymentId: number | null;
  createdAt: string;
}

export interface ImprovementCycleResult {
  knowledgeItemsAnalyzed: number;
  proposalsGenerated: number;
  proposalsAutoApplied: number;
  proposalsQueued: number;
  creditsSpent: number;
  durationMs: number;
  performanceSnapshot: PerformanceSnapshot;
}

export interface ImprovementCycleLogEntry {
  id: string;
  agentId: string;
  trigger: string;
  knowledgeItemsAnalyzed: number;
  proposalsGenerated: number;
  proposalsAutoApplied: number;
  proposalsQueued: number;
  creditsSpent: number;
  durationMs: number | null;
  performanceSnapshot: PerformanceSnapshot | null;
  errorMessage: string | null;
  createdAt: string;
}

// Immutable soul fields — agent CANNOT change these via self-improvement
const IMMUTABLE_SOUL_FIELDS = new Set([
  "autonomy.level",
  "autonomy.boundaries",
  "autonomy.canSpawn",
  "autonomy.spawnBudget",
  "identity.name",
]);

// Fields that can only be added to, never removed from
const APPEND_ONLY_FIELDS = new Set(["values"]);

// ============================================================
//  SelfImprovementEngine
// ============================================================

export class SelfImprovementEngine {
  private pool: pg.Pool;
  private performanceTracker: PerformanceTracker;
  private inferenceProxy: InferenceProxy | null;
  private creditManager: CreditManager;

  constructor(
    pool: pg.Pool,
    performanceTracker: PerformanceTracker,
    inferenceProxy: InferenceProxy | null,
    creditManager: CreditManager,
  ) {
    this.pool = pool;
    this.performanceTracker = performanceTracker;
    this.inferenceProxy = inferenceProxy;
    this.creditManager = creditManager;
  }

  // ----------------------------------------------------------
  //  Settings CRUD
  // ----------------------------------------------------------

  async getSettings(agentId: string): Promise<ImprovementSettings | null> {
    const result = await this.pool.query(
      `SELECT * FROM improvement_settings WHERE agent_id = $1`,
      [agentId],
    );
    if (result.rows.length === 0) return null;
    return this.mapSettings(result.rows[0]);
  }

  async updateSettings(agentId: string, input: ImprovementSettingsInput): Promise<ImprovementSettings> {
    const result = await this.pool.query(
      `INSERT INTO improvement_settings (agent_id, enabled, scan_interval_hours, max_credits_per_cycle,
         max_proposals_per_week, auto_apply_threshold, soul_evolution_enabled, bundle_curation_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id) DO UPDATE SET
         enabled = COALESCE($2, improvement_settings.enabled),
         scan_interval_hours = COALESCE($3, improvement_settings.scan_interval_hours),
         max_credits_per_cycle = COALESCE($4, improvement_settings.max_credits_per_cycle),
         max_proposals_per_week = COALESCE($5, improvement_settings.max_proposals_per_week),
         auto_apply_threshold = COALESCE($6, improvement_settings.auto_apply_threshold),
         soul_evolution_enabled = COALESCE($7, improvement_settings.soul_evolution_enabled),
         bundle_curation_enabled = COALESCE($8, improvement_settings.bundle_curation_enabled),
         updated_at = NOW()
       RETURNING *`,
      [
        agentId,
        input.enabled ?? false,
        input.scanIntervalHours ?? 24,
        input.maxCreditsPerCycle ?? 10000,
        input.maxProposalsPerWeek ?? 5,
        input.autoApplyThreshold ?? 0.9,
        input.soulEvolutionEnabled ?? false,
        input.bundleCurationEnabled ?? true,
      ],
    );
    return this.mapSettings(result.rows[0]);
  }

  private mapSettings(row: Record<string, unknown>): ImprovementSettings {
    return {
      agentId: row.agent_id as string,
      enabled: row.enabled as boolean,
      scanIntervalHours: row.scan_interval_hours as number,
      maxCreditsPerCycle: Number(row.max_credits_per_cycle),
      maxProposalsPerWeek: row.max_proposals_per_week as number,
      autoApplyThreshold: parseFloat(String(row.auto_apply_threshold)),
      soulEvolutionEnabled: row.soul_evolution_enabled as boolean,
      bundleCurationEnabled: row.bundle_curation_enabled as boolean,
      pausedUntil: row.paused_until ? new Date(row.paused_until as string).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    };
  }

  // ----------------------------------------------------------
  //  Proposals CRUD
  // ----------------------------------------------------------

  async getProposals(
    agentId: string,
    status?: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<ImprovementProposal[]> {
    let query = `SELECT * FROM improvement_proposals WHERE agent_id = $1`;
    const params: unknown[] = [agentId];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    params.push(limit, offset);
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await this.pool.query(query, params);
    return result.rows.map((r) => this.mapProposal(r));
  }

  async approveProposal(proposalId: string, agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE improvement_proposals
       SET status = 'approved', owner_decision = 'approved', owner_decided_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'pending'
       RETURNING id`,
      [proposalId, agentId],
    );
    if (result.rows.length === 0) {
      throw new Error("PROPOSAL_NOT_FOUND_OR_NOT_PENDING");
    }
  }

  async rejectProposal(proposalId: string, agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE improvement_proposals
       SET status = 'rejected', owner_decision = 'rejected', owner_decided_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'pending'
       RETURNING id`,
      [proposalId, agentId],
    );
    if (result.rows.length === 0) {
      throw new Error("PROPOSAL_NOT_FOUND_OR_NOT_PENDING");
    }
  }

  private mapProposal(row: Record<string, unknown>): ImprovementProposal {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      proposalType: row.proposal_type as string,
      targetType: row.target_type as string,
      targetId: (row.target_id as string) || null,
      proposedChanges: row.proposed_changes as Record<string, unknown>,
      reasoning: row.reasoning as string,
      confidenceScore: parseFloat(String(row.confidence_score)),
      inferenceCost: Number(row.inference_cost),
      status: row.status as string,
      ownerDecision: (row.owner_decision as string) || null,
      ownerDecidedAt: row.owner_decided_at ? new Date(row.owner_decided_at as string).toISOString() : null,
      appliedAt: row.applied_at ? new Date(row.applied_at as string).toISOString() : null,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  // ----------------------------------------------------------
  //  Soul Version History
  // ----------------------------------------------------------

  async getSoulHistory(
    agentId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<SoulVersionEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM soul_version_history
       WHERE agent_id = $1
       ORDER BY version_number DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );
    return result.rows.map((r) => this.mapSoulVersion(r));
  }

  async recordSoulVersion(
    agentId: string,
    soulCid: string,
    previousCid: string | null,
    changeSummary: string,
    changeType: string,
    changedFields: string[],
    deploymentId?: number,
  ): Promise<void> {
    // Get next version number
    const versionResult = await this.pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
       FROM soul_version_history WHERE agent_id = $1`,
      [agentId],
    );
    const nextVersion = versionResult.rows[0].next_version;

    await this.pool.query(
      `INSERT INTO soul_version_history
         (agent_id, version_number, soul_cid, previous_cid, change_summary, change_type, changed_fields, deployment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [agentId, nextVersion, soulCid, previousCid, changeSummary, changeType, JSON.stringify(changedFields), deploymentId ?? null],
    );
  }

  private mapSoulVersion(row: Record<string, unknown>): SoulVersionEntry {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      versionNumber: row.version_number as number,
      soulCid: row.soul_cid as string,
      previousCid: (row.previous_cid as string) || null,
      changeSummary: (row.change_summary as string) || null,
      changeType: row.change_type as string,
      changedFields: (row.changed_fields as string[]) || [],
      deploymentId: (row.deployment_id as number) || null,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  // ----------------------------------------------------------
  //  Improvement Cycle History
  // ----------------------------------------------------------

  async getCycleHistory(agentId: string, limit: number = 20): Promise<ImprovementCycleLogEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM improvement_cycle_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, limit],
    );
    return result.rows.map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      trigger: r.trigger as string,
      knowledgeItemsAnalyzed: r.knowledge_items_analyzed as number,
      proposalsGenerated: r.proposals_generated as number,
      proposalsAutoApplied: r.proposals_auto_applied as number,
      proposalsQueued: r.proposals_queued as number,
      creditsSpent: Number(r.credits_spent),
      durationMs: (r.duration_ms as number) || null,
      performanceSnapshot: (r.performance_snapshot as PerformanceSnapshot) || null,
      errorMessage: (r.error_message as string) || null,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  // ----------------------------------------------------------
  //  Core: Run Improvement Cycle
  // ----------------------------------------------------------

  /**
   * Run a full improvement cycle for an agent.
   * Returns results including proposals generated.
   */
  async runImprovementCycle(
    agentId: string,
    address: string,
    trigger: string,
  ): Promise<ImprovementCycleResult> {
    const startTime = Date.now();
    let creditsSpent = 0;
    let knowledgeItemsAnalyzed = 0;
    let proposalsGenerated = 0;
    let proposalsAutoApplied = 0;
    let proposalsQueued = 0;

    try {
      // 1. Load settings
      const settings = await this.getSettings(agentId);
      if (!settings || !settings.enabled) {
        throw new Error("Self-improvement not enabled for this agent");
      }

      // 2. Check credit balance
      const balanceInfo = await this.creditManager.getBalance(agentId);
      if (balanceInfo && balanceInfo.status === "paused") {
        // Pause improvement for 1 hour
        await this.pool.query(
          `UPDATE improvement_settings SET paused_until = NOW() + INTERVAL '1 hour' WHERE agent_id = $1`,
          [agentId],
        );
        throw new Error("Insufficient credits — paused for 1 hour");
      }

      // 3. Check weekly proposal limit
      const weeklyCount = await this.pool.query(
        `SELECT COUNT(*) AS cnt FROM improvement_proposals
         WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
        [agentId],
      );
      const proposalsThisWeek = parseInt(weeklyCount.rows[0].cnt, 10);
      if (proposalsThisWeek >= settings.maxProposalsPerWeek) {
        throw new Error("Weekly proposal limit reached");
      }
      const remainingProposals = settings.maxProposalsPerWeek - proposalsThisWeek;

      // 4. Compute performance snapshot
      const snapshot = await this.performanceTracker.computePerformanceSnapshot(agentId);

      // 5. Load agent context (autonomy level) from DB
      const agentResult = await this.pool.query(
        `SELECT metadata FROM agents WHERE id = $1`,
        [agentId],
      );
      const metadata = agentResult.rows[0]?.metadata as Record<string, unknown> || {};
      const autonomyLevel = (metadata.autonomyLevel as string) || "supervised";

      // 6. Bundle curation analysis
      const allProposals: Array<{
        proposalType: string; targetType: string; targetId: string | null;
        proposedChanges: Record<string, unknown>; reasoning: string;
        confidenceScore: number; inferenceCost: number;
      }> = [];

      if (settings.bundleCurationEnabled) {
        // Get agent's bundles from proactive context
        const bundleResult = await this.pool.query(
          `SELECT DISTINCT bundle_id FROM knowledge_performance WHERE agent_id = $1`,
          [agentId],
        );

        for (const row of bundleResult.rows) {
          const bundleId = row.bundle_id as number;
          const items = await this.performanceTracker.getBundlePerformance(agentId, bundleId);
          knowledgeItemsAnalyzed += items.length;

          if (items.length > 0 && allProposals.length < remainingProposals) {
            const bundleProposals = await this.analyzeBundleHealth(agentId, bundleId, items);
            allProposals.push(...bundleProposals);
          }
        }
      }

      // 7. Soul evolution analysis
      if (settings.soulEvolutionEnabled && allProposals.length < remainingProposals) {
        const soulProposals = await this.analyzeSoulEvolution(agentId, snapshot);
        allProposals.push(...soulProposals);
      }

      // 8. Process proposals — check autonomy + confidence for auto-apply
      for (const proposal of allProposals.slice(0, remainingProposals)) {
        const autoApply = this.shouldAutoApply(
          autonomyLevel,
          proposal.confidenceScore,
          settings.autoApplyThreshold,
          proposal.targetType,
        );

        const status = autoApply ? "auto_applied" : "pending";

        await this.pool.query(
          `INSERT INTO improvement_proposals
             (agent_id, proposal_type, target_type, target_id, proposed_changes,
              reasoning, confidence_score, inference_cost, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            agentId,
            proposal.proposalType,
            proposal.targetType,
            proposal.targetId,
            JSON.stringify(proposal.proposedChanges),
            proposal.reasoning,
            proposal.confidenceScore,
            proposal.inferenceCost,
            status,
          ],
        );

        proposalsGenerated++;
        creditsSpent += proposal.inferenceCost;

        if (autoApply) {
          proposalsAutoApplied++;
        } else {
          proposalsQueued++;
        }
      }

      const durationMs = Date.now() - startTime;

      // 9. Log cycle
      await this.pool.query(
        `INSERT INTO improvement_cycle_log
           (agent_id, trigger, knowledge_items_analyzed, proposals_generated,
            proposals_auto_applied, proposals_queued, credits_spent, duration_ms, performance_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          agentId, trigger, knowledgeItemsAnalyzed, proposalsGenerated,
          proposalsAutoApplied, proposalsQueued, creditsSpent, durationMs,
          JSON.stringify(snapshot),
        ],
      );

      logSecurityEvent("info", "improvement-cycle-completed", {
        agentId,
        trigger,
        proposalsGenerated,
        proposalsAutoApplied,
        proposalsQueued,
        creditsSpent,
        durationMs,
      });

      return {
        knowledgeItemsAnalyzed,
        proposalsGenerated,
        proposalsAutoApplied,
        proposalsQueued,
        creditsSpent,
        durationMs,
        performanceSnapshot: snapshot,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      // Log failed cycle
      await this.pool.query(
        `INSERT INTO improvement_cycle_log
           (agent_id, trigger, knowledge_items_analyzed, proposals_generated,
            proposals_auto_applied, proposals_queued, credits_spent, duration_ms, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          agentId, trigger, knowledgeItemsAnalyzed, proposalsGenerated,
          proposalsAutoApplied, proposalsQueued, creditsSpent, durationMs, message.slice(0, 500),
        ],
      ).catch(() => {}); // Don't throw on logging failure

      logSecurityEvent("warn", "improvement-cycle-failed", {
        agentId,
        trigger,
        error: message,
      });

      return {
        knowledgeItemsAnalyzed,
        proposalsGenerated,
        proposalsAutoApplied,
        proposalsQueued,
        creditsSpent,
        durationMs,
        performanceSnapshot: {
          successRate: 0,
          avgQuality: 0,
          totalActions: 0,
          creditsEfficiency: 0,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // ----------------------------------------------------------
  //  Bundle Health Analysis
  // ----------------------------------------------------------

  /**
   * Analyze a bundle's knowledge items and generate improvement proposals.
   */
  private async analyzeBundleHealth(
    agentId: string,
    bundleId: number,
    items: KnowledgePerformanceItem[],
  ): Promise<Array<{
    proposalType: string; targetType: string; targetId: string | null;
    proposedChanges: Record<string, unknown>; reasoning: string;
    confidenceScore: number; inferenceCost: number;
  }>> {
    const proposals: Array<{
      proposalType: string; targetType: string; targetId: string | null;
      proposedChanges: Record<string, unknown>; reasoning: string;
      confidenceScore: number; inferenceCost: number;
    }> = [];

    // Identify low-performing items (quality < 0.3 with enough data)
    const lowPerformers = items.filter(
      (i) => i.avgQuality < 0.3 && (i.successCount + i.failureCount) >= 3,
    );

    // Identify high-performing items (quality > 0.7)
    const highPerformers = items.filter(
      (i) => i.avgQuality > 0.7 && (i.successCount + i.failureCount) >= 3,
    );

    // Try LLM analysis if available
    if (this.inferenceProxy && (lowPerformers.length > 0 || items.length > 5)) {
      const llmProposals = await this.llmBundleAnalysis(agentId, bundleId, items, lowPerformers, highPerformers);
      proposals.push(...llmProposals);
    } else {
      // Fallback: heuristic-based proposals
      for (const item of lowPerformers.slice(0, 2)) {
        proposals.push({
          proposalType: "remove_knowledge",
          targetType: "bundle",
          targetId: String(bundleId),
          proposedChanges: { removeCids: [item.contentCid] },
          reasoning: `Knowledge item ${item.contentCid.slice(0, 12)}... has a quality score of ${(item.avgQuality * 100).toFixed(0)}% (${item.failureCount} failures vs ${item.successCount} successes). Removing it may improve overall agent performance.`,
          confidenceScore: Math.min(0.9, 1 - item.avgQuality),
          inferenceCost: 0,
        });
      }
    }

    return proposals;
  }

  /**
   * LLM-based bundle analysis.
   */
  private async llmBundleAnalysis(
    agentId: string,
    bundleId: number,
    items: KnowledgePerformanceItem[],
    lowPerformers: KnowledgePerformanceItem[],
    highPerformers: KnowledgePerformanceItem[],
  ): Promise<Array<{
    proposalType: string; targetType: string; targetId: string | null;
    proposedChanges: Record<string, unknown>; reasoning: string;
    confidenceScore: number; inferenceCost: number;
  }>> {
    try {
      const systemPrompt = `You are analyzing an AI agent's knowledge bundle performance. Based on the data provided, suggest improvements.

RULES:
- Suggest removing poorly performing knowledge items
- Do NOT suggest adding new content (we don't have content to add yet)
- Focus on items with enough data (3+ uses) and poor outcomes
- Be conservative — only suggest removal if quality is clearly poor

Respond with ONLY a JSON object:
{
  "recommendations": [
    {
      "type": "remove",
      "cid": "<content CID>",
      "reason": "<explanation>",
      "confidence": <0.0 to 1.0>
    }
  ]
}`;

      const lowPerfSummary = lowPerformers.slice(0, 5).map((i) =>
        `CID: ${i.contentCid}, Quality: ${(i.avgQuality * 100).toFixed(0)}%, Uses: ${i.usageCount}, Successes: ${i.successCount}, Failures: ${i.failureCount}`,
      ).join("\n");

      const highPerfSummary = highPerformers.slice(0, 5).map((i) =>
        `CID: ${i.contentCid}, Quality: ${(i.avgQuality * 100).toFixed(0)}%, Uses: ${i.usageCount}, Successes: ${i.successCount}, Failures: ${i.failureCount}`,
      ).join("\n");

      const userPrompt = `Bundle ID: ${bundleId}
Total knowledge items: ${items.length}

Low-performing items:
${lowPerfSummary || "None with enough data"}

High-performing items:
${highPerfSummary || "None with enough data"}`;

      const response = await this.inferenceProxy!.chat(agentId, "anthropic", {
        requestId: `improvement-bundle-${Date.now()}`,
        model: "claude-haiku-4-5-20251001",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 500,
        temperature: 0,
        stream: false,
      });

      const text = response.content ?? "";
      const jsonMatch = text.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as {
        recommendations?: Array<{ type: string; cid: string; reason: string; confidence: number }>;
      };

      const inferenceCost = response.promptTokens + response.completionTokens;

      return (parsed.recommendations || [])
        .filter((r) => r.type === "remove" && r.cid && r.confidence > 0.3)
        .slice(0, 3)
        .map((r) => ({
          proposalType: "remove_knowledge",
          targetType: "bundle" as const,
          targetId: String(bundleId),
          proposedChanges: { removeCids: [r.cid] },
          reasoning: r.reason,
          confidenceScore: Math.min(1, Math.max(0, r.confidence)),
          inferenceCost,
        }));
    } catch (error) {
      logSecurityEvent("warn", "improvement-bundle-llm-failed", {
        agentId,
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ----------------------------------------------------------
  //  Soul Evolution Analysis
  // ----------------------------------------------------------

  /**
   * Analyze agent performance and suggest soul.md evolution proposals.
   */
  private async analyzeSoulEvolution(
    agentId: string,
    snapshot: PerformanceSnapshot,
  ): Promise<Array<{
    proposalType: string; targetType: string; targetId: string | null;
    proposedChanges: Record<string, unknown>; reasoning: string;
    confidenceScore: number; inferenceCost: number;
  }>> {
    if (!this.inferenceProxy) return [];

    try {
      const trend = await this.performanceTracker.getPerformanceTrend(agentId, 14);
      const metrics = await this.performanceTracker.getAgentMetrics(agentId, 30);

      const systemPrompt = `You are analyzing an AI agent's personality and approach for potential improvements.

STRICT RULES — IMMUTABLE FIELDS (you CANNOT suggest changes to these):
- autonomy.level
- autonomy.boundaries
- autonomy.canSpawn
- autonomy.spawnBudget
- identity.name
- You CANNOT remove items from the values array (only add new values or modify priority)

MUTABLE FIELDS (you CAN suggest changes to):
- personality.traits (add/remove traits)
- personality.communication.style (formal, casual, academic, playful, concise, verbose)
- personality.communication.tone (warm, neutral, authoritative, encouraging, skeptical, humorous)
- personality.communication.verbosity (minimal, moderate, detailed)
- personality.quirks (add/remove)
- values (add new values with priority 1-10, or change existing priority)
- purpose.goals (add/remove/modify)
- purpose.domains (add/remove)

Respond with ONLY a JSON object:
{
  "recommendations": [
    {
      "field": "<dotted field path>",
      "action": "add" | "modify" | "remove",
      "value": <new value>,
      "reason": "<explanation>",
      "confidence": <0.0 to 1.0>
    }
  ]
}`;

      const userPrompt = `Agent Performance (last 30 days):
- Success rate: ${(metrics.successRate * 100).toFixed(1)}%
- Total actions: ${metrics.totalActions}
- Bounties completed: ${metrics.bountiesCompleted}
- Posts created: ${metrics.postsCreated}
- Credits efficiency: ${snapshot.creditsEfficiency.toFixed(4)}

Performance Trend (14-day window):
- Direction: ${trend.direction}
- Change: ${trend.changePercent.toFixed(1)}%
- Current rate: ${(trend.currentRate * 100).toFixed(1)}%
- Previous rate: ${(trend.previousRate * 100).toFixed(1)}%

Based on this performance data, suggest personality/approach improvements.
Only suggest changes if the data clearly indicates a need for adjustment.
If performance is good, return an empty recommendations array.`;

      const response = await this.inferenceProxy!.chat(agentId, "anthropic", {
        requestId: `improvement-soul-${Date.now()}`,
        model: "claude-haiku-4-5-20251001",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 500,
        temperature: 0.3,
        stream: false,
      });

      const text = response.content ?? "";
      const jsonMatch = text.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as {
        recommendations?: Array<{
          field: string; action: string; value: unknown;
          reason: string; confidence: number;
        }>;
      };

      const inferenceCost = response.promptTokens + response.completionTokens;

      // Validate proposals through safety boundaries
      return (parsed.recommendations || [])
        .filter((r) => this.validateSoulProposal(r))
        .slice(0, 2) // Max 2 soul proposals per cycle
        .map((r) => ({
          proposalType: `soul_${r.field.split(".")[0]}_update`,
          targetType: "soul" as const,
          targetId: null,
          proposedChanges: { field: r.field, action: r.action, value: r.value },
          reasoning: r.reason,
          confidenceScore: Math.min(1, Math.max(0, r.confidence)),
          inferenceCost,
        }));
    } catch (error) {
      logSecurityEvent("warn", "improvement-soul-llm-failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ----------------------------------------------------------
  //  Safety Boundaries
  // ----------------------------------------------------------

  /**
   * Validate a soul evolution proposal against immutable field rules.
   */
  private validateSoulProposal(proposal: {
    field: string;
    action: string;
    value: unknown;
    confidence: number;
  }): boolean {
    // Block changes to immutable fields
    if (IMMUTABLE_SOUL_FIELDS.has(proposal.field)) {
      logSecurityEvent("warn", "improvement-blocked-immutable-field", {
        field: proposal.field,
      });
      return false;
    }

    // Block removal from append-only fields
    if (proposal.action === "remove") {
      const rootField = proposal.field.split(".")[0];
      if (APPEND_ONLY_FIELDS.has(rootField)) {
        logSecurityEvent("warn", "improvement-blocked-append-only-removal", {
          field: proposal.field,
        });
        return false;
      }
    }

    // Block very low confidence proposals
    if (proposal.confidence < 0.3) return false;

    return true;
  }

  /**
   * Determine if a proposal should auto-apply based on autonomy level + confidence.
   */
  private shouldAutoApply(
    autonomyLevel: string,
    confidenceScore: number,
    threshold: number,
    targetType: string,
  ): boolean {
    // Soul changes always require approval for supervised/semi-autonomous agents
    if (targetType === "soul") {
      switch (autonomyLevel) {
        case "supervised":
        case "semi-autonomous":
          return false;
        case "autonomous":
          return confidenceScore >= threshold;
        case "fully-autonomous":
          return confidenceScore >= Math.max(threshold, 0.7); // Even fully-autonomous needs 70%+ for soul changes
        default:
          return false;
      }
    }

    // Bundle changes follow the standard autonomy pattern
    switch (autonomyLevel) {
      case "supervised":
        return false;
      case "semi-autonomous":
        return confidenceScore >= threshold;
      case "autonomous":
      case "fully-autonomous":
        return confidenceScore >= Math.max(threshold * 0.8, 0.5); // Lower bar for bundle changes
      default:
        return false;
    }
  }

  // ----------------------------------------------------------
  //  Auto-trigger Check
  // ----------------------------------------------------------

  /**
   * Check if self-improvement should auto-trigger based on performance decline.
   */
  async shouldAutoTrigger(agentId: string): Promise<boolean> {
    const settings = await this.getSettings(agentId);
    if (!settings || !settings.enabled) return false;

    // Check if we already ran recently (within scan_interval_hours)
    const lastCycle = await this.pool.query(
      `SELECT created_at FROM improvement_cycle_log
       WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );
    if (lastCycle.rows.length > 0) {
      const lastRun = new Date(lastCycle.rows[0].created_at as string);
      const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
      if (hoursSince < settings.scanIntervalHours) return false;
    }

    // Check performance trend
    const trend = await this.performanceTracker.getPerformanceTrend(agentId, 14);
    return trend.direction === "declining" && trend.changePercent < -15;
  }

  // ----------------------------------------------------------
  //  Apply Proposal (stub for now — full execution requires SDK)
  // ----------------------------------------------------------

  /**
   * Apply an approved or auto-applied proposal.
   * This marks it as applied. Actual on-chain execution happens
   * through the gateway route which has access to SDK + GasManager.
   */
  async markProposalApplied(proposalId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE improvement_proposals SET status = 'auto_applied', applied_at = NOW()
       WHERE id = $1 AND agent_id = $2`,
      [proposalId, agentId],
    );
  }
}
