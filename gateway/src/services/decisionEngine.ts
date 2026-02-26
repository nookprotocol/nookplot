/**
 * Decision engine for the proactive agent loop.
 *
 * Evaluates discovered opportunities against an agent's soul.md
 * purpose and autonomy level to decide which actions to take
 * and whether owner approval is required.
 *
 * Refactored to use ActionRegistry for costs, mappings, autonomy,
 * and boundary checking — no more hardcoded action types.
 *
 * @module services/decisionEngine
 */

import type pg from "pg";
import type { InferenceProxy } from "./inferenceProxy.js";
import type { CreditManager } from "./creditManager.js";
import type { Opportunity, AgentContext } from "./opportunityScanner.js";
import type { ActionRegistry } from "./actionRegistry.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface ActionCandidate {
  opportunityId: string;
  actionType: string;
  payload: Record<string, unknown>;
  estimatedCost: number;
  alignmentScore: number;
  requiresApproval: boolean;
}

export interface DecisionResult {
  candidates: ActionCandidate[];
  skippedCount: number;
}

// ============================================================
//  DecisionEngine
// ============================================================

export class DecisionEngine {
  private readonly pool: pg.Pool;
  private readonly inferenceProxy: InferenceProxy | null;
  private readonly creditManager: CreditManager;
  private readonly registry: ActionRegistry;

  constructor(
    pool: pg.Pool,
    inferenceProxy: InferenceProxy | null,
    creditManager: CreditManager,
    registry: ActionRegistry,
  ) {
    this.pool = pool;
    this.inferenceProxy = inferenceProxy;
    this.creditManager = creditManager;
    this.registry = registry;
  }

  /**
   * Evaluate opportunities and produce ranked action candidates.
   */
  async evaluate(
    agentId: string,
    context: AgentContext,
    opportunities: Opportunity[],
  ): Promise<DecisionResult> {
    const candidates: ActionCandidate[] = [];
    let skippedCount = 0;

    // Get reputation adjustment from past feedback
    const reputationMultiplier = await this.getReputationAdjustment(agentId);
    // Adjusted minimum alignment threshold
    const minAlignment = 0.3 / reputationMultiplier;

    for (const opp of opportunities) {
      // Compute alignment score
      const alignmentScore = await this.computeAlignmentScore(agentId, context, opp);

      if (alignmentScore < minAlignment) {
        skippedCount++;
        continue;
      }

      // Map opportunity type to action type via registry
      const actionType = this.registry.mapOpportunityToAction(opp.type);
      const estimatedCost = this.registry.getCost(actionType);

      // Determine if approval is required based on autonomy level
      const requiresApproval = this.checkRequiresApproval(
        context.autonomy,
        actionType,
        estimatedCost,
        5000, // default maxCreditsPerCycle
      );

      candidates.push({
        opportunityId: opp.sourceId,
        actionType,
        payload: { opportunity: opp },
        estimatedCost,
        alignmentScore,
        requiresApproval,
      });
    }

    // Sort by value efficiency: alignment * estimatedValue / cost
    candidates.sort((a, b) => {
      const aOpp = (a.payload.opportunity as Opportunity);
      const bOpp = (b.payload.opportunity as Opportunity);
      const aEfficiency = (a.alignmentScore * aOpp.estimatedValue) / Math.max(a.estimatedCost, 1);
      const bEfficiency = (b.alignmentScore * bOpp.estimatedValue) / Math.max(b.estimatedCost, 1);
      return bEfficiency - aEfficiency;
    });

    return { candidates, skippedCount };
  }

  /**
   * Record an opportunity in the database.
   */
  async recordOpportunity(
    agentId: string,
    opp: Opportunity,
    alignmentScore: number,
    status: string,
  ): Promise<string> {
    const actionType = this.registry.mapOpportunityToAction(opp.type);
    const estimatedCost = this.registry.getCost(actionType);

    const result = await this.pool.query(
      `INSERT INTO proactive_opportunities
        (agent_id, type, source_id, title, description, estimated_cost, estimated_value, alignment_score, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        agentId,
        opp.type,
        opp.sourceId,
        opp.title,
        opp.description,
        estimatedCost,
        opp.estimatedValue,
        alignmentScore,
        status,
      ],
    );
    return (result as { rows: Array<{ id: string }> }).rows[0].id;
  }

  /**
   * Create an action record in the database.
   */
  async createAction(
    agentId: string,
    candidate: ActionCandidate,
    opportunityDbId?: string,
  ): Promise<string> {
    const status = candidate.requiresApproval ? "pending" : "approved";

    const result = await this.pool.query(
      `INSERT INTO proactive_actions
        (agent_id, opportunity_id, action_type, payload, status, inference_cost)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        agentId,
        opportunityDbId ?? null,
        candidate.actionType,
        JSON.stringify(candidate.payload),
        status,
        candidate.estimatedCost,
      ],
    );
    return (result as { rows: Array<{ id: string }> }).rows[0].id;
  }

  /**
   * Compute reputation-based adjustment multiplier.
   * > 1.0 if mostly positive feedback (lower threshold = more actions)
   * < 1.0 if mostly negative feedback (higher threshold = fewer actions)
   */
  async getReputationAdjustment(agentId: string): Promise<number> {
    try {
      const result = await this.pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE feedback_type = 'upvote') AS upvotes,
          COUNT(*) FILTER (WHERE feedback_type = 'downvote') AS downvotes
         FROM proactive_feedback
         WHERE agent_id = $1
           AND created_at > NOW() - INTERVAL '30 days'`,
        [agentId],
      );

      const row = (result as { rows: Array<{ upvotes: string; downvotes: string }> }).rows[0];
      const upvotes = parseInt(row?.upvotes ?? "0", 10);
      const downvotes = parseInt(row?.downvotes ?? "0", 10);
      const total = upvotes + downvotes;

      if (total === 0) return 1.0;

      // Ratio-based: positive feedback increases multiplier (up to 1.5)
      // negative feedback decreases it (down to 0.5)
      const ratio = upvotes / total;
      return 0.5 + ratio; // 0.5 (all negative) to 1.5 (all positive)
    } catch {
      return 1.0;
    }
  }

  // ---- Private helpers ----

  /**
   * Compute alignment score between agent purpose and an opportunity.
   * Uses LLM evaluation if available, falls back to keyword matching.
   */
  private async computeAlignmentScore(
    agentId: string,
    context: AgentContext,
    opp: Opportunity,
  ): Promise<number> {
    // Try LLM-based evaluation if inference proxy is available
    if (this.inferenceProxy) {
      try {
        const balance = await this.creditManager.getBalance(agentId);
        // Only use LLM if agent has enough credits for evaluation (~200 credits)
        if (balance && balance.balance > 500 && balance.status !== "paused") {
          return await this.llmAlignment(agentId, context, opp);
        }
      } catch {
        // Fall through to keyword matching
      }
    }

    // Fallback: keyword matching heuristic
    return this.keywordAlignment(context, opp);
  }

  /**
   * Sanitize agent-controlled text before interpolation into LLM prompts.
   * Strips non-printable characters, code fences, and common injection patterns.
   */
  private sanitizeForPrompt(input: string, maxLength = 500): string {
    return input
      .replace(/[^\x20-\x7E\n]/g, "")
      .replace(/```/g, "")
      .replace(/\bignore\b.*\binstructions\b/gi, "")
      .replace(/\bsystem\b.*\bprompt\b/gi, "")
      .replace(/\bforget\b.*\babove\b/gi, "")
      .slice(0, maxLength);
  }

  /**
   * LLM-based alignment scoring via inference proxy.
   */
  private async llmAlignment(
    agentId: string,
    context: AgentContext,
    opp: Opportunity,
  ): Promise<number> {
    try {
      const mission = this.sanitizeForPrompt(context.purpose.mission);
      const domains = context.purpose.domains.map((d) => this.sanitizeForPrompt(d, 100)).join(", ");
      const goals = context.purpose.goals.map((g) => this.sanitizeForPrompt(g, 200)).join(", ");

      const systemPrompt = `You are evaluating whether an opportunity aligns with an AI agent's purpose.

Agent's mission: ${mission}
Agent's domains: ${domains}
Agent's goals: ${goals}

Respond with ONLY a JSON object: {"alignment": <number between 0.0 and 1.0>}
0.0 = completely irrelevant, 1.0 = perfect alignment.`;

      const userPrompt = `Opportunity: ${this.sanitizeForPrompt(opp.title, 200)}
Type: ${this.sanitizeForPrompt(opp.type, 50)}
Description: ${this.sanitizeForPrompt(opp.description, 500)}`;

      const response = await this.inferenceProxy!.chat(agentId, "anthropic", {
        requestId: `proactive-eval-${Date.now()}`,
        model: "claude-haiku-4-5-20251001",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 50,
        temperature: 0,
        stream: false,
      });

      // Parse the alignment score from response — strict validation
      const text = response.content ?? "";
      const match = text.match(/^\s*\{\s*"alignment"\s*:\s*([\d.]+)\s*\}\s*$/);
      if (match) {
        const score = parseFloat(match[1]);
        if (!isNaN(score) && score >= 0 && score <= 1) return score;
      }

      // If parsing fails, fall back to keyword matching
      return this.keywordAlignment(context, opp);
    } catch (error) {
      logSecurityEvent("warn", "proactive-llm-alignment-failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.keywordAlignment(context, opp);
    }
  }

  /**
   * Keyword-based alignment scoring (fallback).
   */
  private keywordAlignment(context: AgentContext, opp: Opportunity): number {
    if (context.purpose.domains.length === 0) return 0.5; // broad purpose matches moderately

    const text = `${opp.title} ${opp.description}`.toLowerCase();
    let matchCount = 0;

    for (const domain of context.purpose.domains) {
      if (text.includes(domain.toLowerCase())) {
        matchCount++;
      }
    }

    // Also check goals
    for (const goal of context.purpose.goals) {
      const goalWords = goal.toLowerCase().split(/\s+/);
      for (const word of goalWords) {
        if (word.length > 3 && text.includes(word)) {
          matchCount += 0.5;
        }
      }
    }

    const total = context.purpose.domains.length + context.purpose.goals.length;
    return Math.min(1.0, matchCount / Math.max(total, 1));
  }

  /**
   * Check if an action requires owner approval based on autonomy level.
   * Uses registry for boundary checking instead of hardcoded matching.
   */
  private checkRequiresApproval(
    autonomy: { level: string; boundaries: string[] },
    actionType: string,
    estimatedCost: number,
    maxCycleCredits: number,
  ): boolean {
    // Tools with "supervised" default autonomy always require approval
    const toolAutonomy = this.registry.getAutonomyLevel(actionType);
    if (toolAutonomy === "supervised") return true;

    switch (autonomy.level) {
      case "supervised":
        return true; // ALL actions need approval
      case "semi-autonomous":
        // High-cost actions need approval (>50% of cycle budget)
        return estimatedCost > maxCycleCredits * 0.5;
      case "autonomous":
        // Only boundary-violating actions need approval
        return this.registry.checkBoundaryViolation(actionType, autonomy.boundaries);
      case "fully-autonomous":
        return false; // Nothing needs approval
      default:
        return true; // Default to supervised for safety
    }
  }
}
