/**
 * Semantic quality scoring service.
 *
 * Evaluates bounty submissions and knowledge bundle content using LLM-based
 * assessment. Scores on 4 dimensions: relevance, technical depth,
 * originality, completeness (0-100 composite).
 *
 * Also computes PageRank-weighted service review scores and feeds both
 * signals into the contribution scoring pipeline.
 *
 * @module services/qualityScorer
 */

import type { Pool } from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { InferenceProxy } from "./inferenceProxy.js";
import type { CreditManager } from "./creditManager.js";

// ============================================================
//  Types
// ============================================================

export interface QualityAssessment {
  contentCid: string;
  contentType: "bounty_submission" | "knowledge_bundle" | "post";
  qualityScore: number;
  assessment: {
    relevance: number;
    technicalDepth: number;
    originality: number;
    completeness: number;
    summary: string;
  };
  modelUsed: string;
}

export interface WeightedReviewScore {
  agentId: string;
  weightedScore: number;
  reviewCount: number;
  avgRating: number;
}

// ============================================================
//  QualityScorer
// ============================================================

export class QualityScorer {
  private readonly pool: Pool;
  private readonly inferenceProxy: InferenceProxy | null;
  private readonly creditManager: CreditManager | null;

  constructor(pool: Pool, inferenceProxy?: InferenceProxy, creditManager?: CreditManager) {
    this.pool = pool;
    this.inferenceProxy = inferenceProxy ?? null;
    this.creditManager = creditManager ?? null;
  }

  /**
   * Compute PageRank-weighted service review scores for all agents.
   *
   * Reviewer's PageRank scales their review's influence on the reviewee.
   * A 5-star review from a high-PR agent counts far more than one from
   * a fresh account.
   *
   * @param pageRankMap - Map of address -> PageRank score (from SDK)
   * @param floor - Minimum PageRank for influence (reviews from sub-floor agents ignored)
   */
  async computeWeightedReviewScores(
    pageRankMap?: Map<string, number>,
    floor = 0,
  ): Promise<WeightedReviewScore[]> {
    // Fetch all reviews with reviewer address
    const { rows } = await this.pool.query<{
      reviewee_agent_id: string;
      reviewer_address: string;
      rating: number;
    }>(
      `SELECT sr.reviewee_agent_id, a.address AS reviewer_address, sr.rating
       FROM service_reviews sr
       JOIN agents a ON a.id = sr.reviewer_agent_id`,
    );

    // Group by reviewee
    const revieweeMap = new Map<string, Array<{ reviewerAddress: string; rating: number }>>();
    for (const row of rows) {
      const list = revieweeMap.get(row.reviewee_agent_id) ?? [];
      list.push({ reviewerAddress: row.reviewer_address.toLowerCase(), rating: row.rating });
      revieweeMap.set(row.reviewee_agent_id, list);
    }

    const results: WeightedReviewScore[] = [];

    for (const [agentId, reviews] of revieweeMap) {
      let weightedSum = 0;
      let totalWeight = 0;

      for (const review of reviews) {
        if (pageRankMap) {
          const reviewerPR = pageRankMap.get(review.reviewerAddress) ?? 0;
          if (reviewerPR < floor) continue;
          weightedSum += reviewerPR * review.rating;
          totalWeight += reviewerPR;
        } else {
          // No PageRank available — equal weights
          weightedSum += review.rating;
          totalWeight += 1;
        }
      }

      const avgRating = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
      const weightedScore = totalWeight > 0
        ? (weightedSum / totalWeight / 5) * 100  // Normalize 1-5 rating to 0-100
        : avgRating / 5 * 100;

      results.push({
        agentId,
        weightedScore: Math.round(weightedScore * 100) / 100,
        reviewCount: reviews.length,
        avgRating: Math.round(avgRating * 100) / 100,
      });
    }

    return results;
  }

  /**
   * Assess content quality using LLM inference.
   *
   * Evaluates: relevance, technical depth, originality, completeness (0-100 each).
   * Returns composite score (average of 4 dimensions).
   *
   * Requires inferenceProxy to be configured.
   */
  async assessContent(
    agentId: string,
    contentCid: string,
    contentType: "bounty_submission" | "knowledge_bundle" | "post",
    contentText: string,
  ): Promise<QualityAssessment | null> {
    if (!this.inferenceProxy) return null;

    try {
      // Check if already assessed
      const { rows: existing } = await this.pool.query(
        `SELECT quality_score FROM quality_assessments WHERE content_cid = $1 AND content_type = $2`,
        [contentCid, contentType],
      );
      if (existing.length > 0) return null; // Already assessed

      const systemPrompt = `You are a content quality evaluator for a decentralized AI agent network.
Evaluate the following ${contentType.replace("_", " ")} on 4 dimensions, each scored 0-100:
- relevance: How relevant is this to the network's knowledge domains?
- technicalDepth: How technically deep and detailed is the content?
- originality: How novel or original is the contribution?
- completeness: How complete and well-structured is the content?

Respond in JSON only: {"relevance": N, "technicalDepth": N, "originality": N, "completeness": N, "summary": "one sentence"}`;

      const result = await this.inferenceProxy.chat(
        agentId,
        "anthropic", // Default provider
        {
          requestId: `quality-${contentCid}`,
          model: "claude-haiku-4-5-20251001",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: contentText.slice(0, 4000) },
          ],
          maxTokens: 200,
          temperature: 0.2,
          stream: false,
        },
      );

      // Parse LLM response
      const parsed = JSON.parse(result.content) as {
        relevance: number;
        technicalDepth: number;
        originality: number;
        completeness: number;
        summary: string;
      };

      const qualityScore = Math.round(
        (parsed.relevance + parsed.technicalDepth + parsed.originality + parsed.completeness) / 4,
      );

      // Store assessment
      await this.pool.query(
        `INSERT INTO quality_assessments (agent_id, content_cid, content_type, quality_score, assessment, model_used)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (content_cid, content_type) DO NOTHING`,
        [agentId, contentCid, contentType, qualityScore, JSON.stringify(parsed), result.model],
      );

      logSecurityEvent("info", "quality-assessment-created", {
        agentId,
        contentCid,
        contentType,
        qualityScore,
      });

      return {
        contentCid,
        contentType,
        qualityScore,
        assessment: parsed,
        modelUsed: result.model,
      };
    } catch (err) {
      logSecurityEvent("warn", "quality-assessment-failed", {
        error: err instanceof Error ? err.message : String(err),
        contentCid,
      });
      return null;
    }
  }

  /**
   * Get the average quality assessment score for an agent.
   */
  async getAgentQualityScore(agentId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ avg_score: string }>(
      `SELECT AVG(quality_score)::text AS avg_score
       FROM quality_assessments
       WHERE agent_id = $1`,
      [agentId],
    );
    const avg = parseFloat(rows[0]?.avg_score ?? "");
    return isNaN(avg) ? null : Math.round(avg * 100) / 100;
  }
}
