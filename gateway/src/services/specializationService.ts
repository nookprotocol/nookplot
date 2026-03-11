/**
 * SpecializationService — Emergent specialization: niche detection,
 * skill gap analysis, demand/supply signals, and recommendations.
 *
 * Detects market needs from
 * zero-result queries, tracks skill demand/supply, and generates
 * personalized specialization recommendations.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_SIGNAL_TYPES = new Set(["demand", "supply", "gap", "trending"]);
const VALID_SOURCE_TYPES = new Set(["query", "bounty", "swarm", "insight", "marketplace"]);

// ─── Service ──────────────────────────────────────────────────────────────────

export class SpecializationService {
  private readonly pool: pg.Pool;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private messageBus: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setMessageBus(mb: any): void { this.messageBus = mb; }

  // ============================================================
  //  Skill Gap Detection
  // ============================================================

  /**
   * Record a skill gap (zero-result query). Called internally by search services.
   * Returns matching skills from the registry if any exist for the gap tags.
   */
  async recordGap(queryText: string, queryTags: string[], communityId?: string): Promise<{ matchingSkills?: any[] }> {
    if (!queryText) return {};

    // Upsert: increment count if same query seen before
    await this.pool.query(
      `INSERT INTO skill_gaps (query_text, query_tags, community_id)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT skill_gaps_pkey DO NOTHING`,
      [queryText.slice(0, 500), queryTags.slice(0, 10), communityId || null],
    ).catch(() => {
      // No unique constraint on query_text, so just insert and update separately
    });

    // Try to find and increment existing
    const existing = await this.pool.query(
      `UPDATE skill_gaps SET gap_count = gap_count + 1, last_seen = NOW()
       WHERE query_text = $1 AND resolved = false
       RETURNING id`,
      [queryText.slice(0, 500)],
    );

    if (existing.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO skill_gaps (query_text, query_tags, community_id)
         VALUES ($1, $2, $3)`,
        [queryText.slice(0, 500), queryTags.slice(0, 10), communityId || null],
      );
    }

    // Emit demand signal for each tag
    for (const tag of queryTags.slice(0, 5)) {
      await this.recordSignal(tag, "demand", 1.0, "query");
    }

    // Surface matching skills from the registry
    const matchingSkills = await this.findMatchingSkills(queryTags);
    return matchingSkills.length > 0 ? { matchingSkills } : {};
  }

  /**
   * Query the skill registry for skills whose tags overlap with the given tags.
   * Used to bridge skill gaps → registry discovery.
   */
  async findMatchingSkills(tags: string[], limit: number = 5): Promise<any[]> {
    if (!tags || tags.length === 0) return [];

    try {
      const loweredTags = tags.slice(0, 10).map(t => t.toLowerCase());
      const { rows } = await this.pool.query(
        `SELECT id, name, slug, description, tags, category, package_type,
                rating_avg, rating_count, install_count
         FROM skill_packages
         WHERE status = 'active' AND tags && $1::text[]
         ORDER BY
           rating_avg * LEAST(rating_count, 10) DESC,
           install_count DESC
         LIMIT $2`,
        [loweredTags, Math.min(limit, 20)],
      );
      return rows;
    } catch {
      // skill_packages table may not exist — graceful skip
      return [];
    }
  }

  /** Mark a skill gap as resolved by an agent. */
  async resolveGap(agentId: string, gapId: string): Promise<any> {
    const result = await this.pool.query(
      `UPDATE skill_gaps SET resolved = true, resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 AND resolved = false
       RETURNING *`,
      [agentId, gapId],
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Gap not found or already resolved"), { code: "NOT_FOUND" });
    }
    return result.rows[0];
  }

  /** List open skill gaps. */
  async listGaps(opts?: {
    tag?: string;
    communityId?: string;
    minCount?: number;
    limit?: number;
  }): Promise<any[]> {
    const params: any[] = [];
    const conditions: string[] = ["resolved = false"];

    if (opts?.tag) {
      params.push(opts.tag);
      conditions.push(`$${params.length} = ANY(query_tags)`);
    }
    if (opts?.communityId) {
      params.push(opts.communityId);
      conditions.push(`community_id = $${params.length}`);
    }
    if (opts?.minCount) {
      params.push(opts.minCount);
      conditions.push(`gap_count >= $${params.length}`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(opts?.limit || 50, 100);
    params.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM skill_gaps ${where} ORDER BY gap_count DESC, last_seen DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  // ============================================================
  //  Specialization Signals
  // ============================================================

  /** Record a specialization signal (demand/supply/gap/trending). */
  async recordSignal(
    skillDomain: string,
    signalType: string,
    intensity: number = 1.0,
    sourceType?: string,
    sourceId?: string,
    metadata?: any,
  ): Promise<void> {
    if (!VALID_SIGNAL_TYPES.has(signalType)) return;

    await this.pool.query(
      `INSERT INTO specialization_signals (skill_domain, signal_type, intensity, source_type, source_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        skillDomain.toLowerCase().slice(0, 100),
        signalType,
        Math.max(0, Math.min(100, intensity)),
        sourceType || null,
        sourceId || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  /** Get aggregated demand/supply signals per skill domain. */
  async getSignals(opts?: {
    skillDomain?: string;
    signalType?: string;
    days?: number;
    limit?: number;
  }): Promise<any[]> {
    const days = opts?.days || 30;
    const params: any[] = [days];
    const conditions: string[] = [`created_at > NOW() - ($1 || ' days')::interval`];

    if (opts?.skillDomain) {
      params.push(opts.skillDomain.toLowerCase());
      conditions.push(`skill_domain = $${params.length}`);
    }
    if (opts?.signalType) {
      params.push(opts.signalType);
      conditions.push(`signal_type = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(opts?.limit || 50, 100);
    params.push(limit);

    const result = await this.pool.query(
      `SELECT skill_domain, signal_type,
              COUNT(*) AS signal_count,
              AVG(intensity) AS avg_intensity,
              MAX(created_at) AS last_seen
       FROM specialization_signals
       ${where}
       GROUP BY skill_domain, signal_type
       ORDER BY signal_count DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  // ============================================================
  //  Agent Specialization Profiles
  // ============================================================

  /** Update an agent's proficiency in a skill domain. */
  async updateProficiency(
    agentId: string,
    skillDomain: string,
    proficiency: number,
  ): Promise<any> {
    if (proficiency < 0 || proficiency > 100) {
      throw Object.assign(new Error("Proficiency must be 0-100"), { code: "VALIDATION" });
    }

    const result = await this.pool.query(
      `INSERT INTO agent_specializations (agent_id, skill_domain, proficiency)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, skill_domain) DO UPDATE SET
         proficiency = EXCLUDED.proficiency,
         updated_at = NOW()
       RETURNING *`,
      [agentId, skillDomain.toLowerCase(), proficiency],
    );
    return result.rows[0];
  }

  /** Get an agent's specialization profile, enriched with on-chain endorsement boosts. */
  async getProfile(agentId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_specializations WHERE agent_id = $1 ORDER BY gap_opportunity DESC`,
      [agentId],
    );

    // Enrich with endorsement-based confidence boost
    try {
      // Get agent address for endorsement lookup
      const { rows: agentRows } = await this.pool.query<{ address: string }>(
        `SELECT address FROM agents WHERE id = $1`,
        [agentId],
      );
      if (agentRows.length > 0) {
        const addr = agentRows[0].address.toLowerCase();

        // Fetch endorsements grouped by skill with avg rating + count
        const { rows: endorseStats } = await this.pool.query<{
          skill: string;
          avg_rating: string;
          endorsement_count: string;
        }>(
          `SELECT e.skill,
                  AVG(e.rating)::text AS avg_rating,
                  COUNT(*)::text AS endorsement_count
           FROM idx_endorsements e
           WHERE e.endorsee = $1
             AND e.is_active = TRUE
           GROUP BY e.skill`,
          [addr],
        );

        const endorseMap = new Map<string, { avgRating: number; count: number }>();
        for (const row of endorseStats) {
          endorseMap.set(row.skill.toLowerCase(), {
            avgRating: parseFloat(row.avg_rating),
            count: parseInt(row.endorsement_count, 10),
          });
        }

        // Apply confidence boost: 0.15 × avg_rating/5 × count (capped at 0.30)
        for (const spec of result.rows) {
          const eData = endorseMap.get((spec.skill_domain as string).toLowerCase());
          if (eData) {
            const boost = Math.min(0.30, 0.15 * (eData.avgRating / 5) * eData.count);
            spec.endorsement_boost = boost;
            spec.endorsement_count = eData.count;
            spec.endorsement_avg_rating = eData.avgRating;
          }
        }
      }
    } catch {
      // Graceful degradation if idx_endorsements doesn't exist
    }

    return result.rows;
  }

  // ============================================================
  //  Sync from ExpertiseProfiler
  // ============================================================

  /**
   * Sync expertise tags into agent_specializations.
   * Called after ExpertiseProfiler runs to bridge auto-inferred
   * skills into the specialization system.
   *
   * Only syncs tags with confidence >= 0.5 and never downgrades
   * existing proficiency (only upgrades).
   *
   * @returns The number of specializations updated.
   */
  async syncFromExpertise(agentId: string): Promise<number> {
    try {
      const { rows: tags } = await this.pool.query<{
        tag: string;
        confidence: number;
      }>(
        `SELECT tag, confidence FROM expertise_tags
         WHERE agent_id = $1 AND confidence >= 0.5
         ORDER BY confidence DESC`,
        [agentId],
      );

      let updated = 0;
      for (const { tag, confidence } of tags) {
        const proficiency = Math.round(confidence * 100);
        const result = await this.pool.query(
          `INSERT INTO agent_specializations (agent_id, skill_domain, proficiency)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, skill_domain) DO UPDATE SET
             proficiency = GREATEST(agent_specializations.proficiency, EXCLUDED.proficiency),
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [agentId, tag.toLowerCase(), proficiency],
        );
        if (result.rowCount && result.rowCount > 0) updated++;
      }

      return updated;
    } catch {
      // expertise_tags or agent_specializations table may not exist — graceful skip
      return 0;
    }
  }

  // ============================================================
  //  Recommendations
  // ============================================================

  /** Generate specialization recommendations for an agent. */
  async generateRecommendations(agentId: string): Promise<any[]> {
    // Get current agent skills
    const profileResult = await this.pool.query(
      `SELECT skill_domain, proficiency FROM agent_specializations WHERE agent_id = $1`,
      [agentId],
    );
    const currentSkills = new Map<string, number>();
    for (const row of profileResult.rows) {
      currentSkills.set(row.skill_domain, Number(row.proficiency));
    }

    // Get top demand signals from last 30 days
    const demandResult = await this.pool.query(
      `SELECT skill_domain, COUNT(*) AS demand, AVG(intensity) AS avg_intensity
       FROM specialization_signals
       WHERE signal_type = 'demand' AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY skill_domain
       ORDER BY demand DESC
       LIMIT 20`,
    );

    // Get supply (how many agents have each skill)
    const supplyResult = await this.pool.query(
      `SELECT skill_domain, COUNT(DISTINCT agent_id) AS supply, AVG(proficiency) AS avg_proficiency
       FROM agent_specializations
       WHERE proficiency >= 30
       GROUP BY skill_domain`,
    );
    const supplyMap = new Map<string, { supply: number; avgProficiency: number }>();
    for (const row of supplyResult.rows) {
      supplyMap.set(row.skill_domain, { supply: Number(row.supply), avgProficiency: Number(row.avg_proficiency) });
    }

    // Compute opportunity scores and generate recommendations
    const recommendations: any[] = [];

    for (const demand of demandResult.rows) {
      const domain = demand.skill_domain;
      const currentProf = currentSkills.get(domain) || 0;
      const supply = supplyMap.get(domain)?.supply || 0;
      const demandScore = Number(demand.demand);
      const opportunity = Math.max(0, (demandScore * Number(demand.avg_intensity)) - (supply * 10));

      // Only recommend if there's meaningful opportunity and agent is somewhat close
      if (opportunity < 5) continue;

      const targetProf = Math.min(100, currentProf + 30); // suggest 30-point improvement

      let recommendation: string;
      if (currentProf >= 70) {
        recommendation = `You're already strong in ${domain} (${currentProf}%). Network demand is high with low supply — you're well-positioned.`;
      } else if (currentProf >= 30) {
        recommendation = `Network needs ${domain} expertise. You're ${currentProf}% there — investing to ${targetProf}% would fill a significant gap.`;
      } else {
        recommendation = `High demand for ${domain} with only ${supply} capable agents. Building this skill would give you a unique network position.`;
      }

      recommendations.push({
        skill_domain: domain,
        recommendation,
        current_proficiency: currentProf,
        target_proficiency: targetProf,
        gap_opportunity: opportunity,
        demand_score: demandScore,
        supply_count: supply,
      });
    }

    // Sort by opportunity
    recommendations.sort((a, b) => b.gap_opportunity - a.gap_opportunity);

    // Enrich recommendations with matching skills from the registry
    for (const rec of recommendations) {
      const skills = await this.findMatchingSkills([rec.skill_domain], 3);
      if (skills.length > 0) {
        rec.suggested_skills = skills.map((s: any) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          rating_avg: s.rating_avg,
          install_count: s.install_count,
          package_type: s.package_type,
        }));
      }
    }

    // Save top recommendations
    for (const rec of recommendations.slice(0, 5)) {
      await this.pool.query(
        `INSERT INTO specialization_recommendations (agent_id, skill_domain, recommendation, current_proficiency, target_proficiency, gap_opportunity, actions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [agentId, rec.skill_domain, rec.recommendation, rec.current_proficiency, rec.target_proficiency, rec.gap_opportunity,
         rec.suggested_skills ? JSON.stringify({ suggested_skills: rec.suggested_skills }) : null],
      );

      // Update agent_specializations with demand/supply/opportunity
      await this.pool.query(
        `INSERT INTO agent_specializations (agent_id, skill_domain, demand_score, supply_score, gap_opportunity, recommended)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (agent_id, skill_domain) DO UPDATE SET
           demand_score = EXCLUDED.demand_score,
           supply_score = EXCLUDED.supply_score,
           gap_opportunity = EXCLUDED.gap_opportunity,
           recommended = true,
           updated_at = NOW()`,
        [agentId, rec.skill_domain, rec.demand_score, rec.supply_count, rec.gap_opportunity],
      );
    }

    this.publishEvent(agentId, "specialization.recommendations", {
      agentId, count: recommendations.length,
    });

    return recommendations.slice(0, 10);
  }

  /** Get existing recommendations for an agent. */
  async getRecommendations(agentId: string, status?: string): Promise<any[]> {
    const params: any[] = [agentId];
    let where = "WHERE agent_id = $1";
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const result = await this.pool.query(
      `SELECT * FROM specialization_recommendations ${where} ORDER BY gap_opportunity DESC`,
      params,
    );
    return result.rows;
  }

  /** Dismiss a recommendation. */
  async dismissRecommendation(agentId: string, recommendationId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE specialization_recommendations SET status = 'dismissed', dismissed_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'active'`,
      [recommendationId, agentId],
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Recommendation not found"), { code: "NOT_FOUND" });
    }
  }

  // ============================================================
  //  Network Overview
  // ============================================================

  /** Get network-wide skill landscape: demand vs supply per domain. */
  async getSkillLandscape(days?: number): Promise<any> {
    const windowDays = days || 30;

    // Demand signals
    const demandResult = await this.pool.query(
      `SELECT skill_domain, COUNT(*) AS demand_count, AVG(intensity) AS avg_intensity
       FROM specialization_signals
       WHERE signal_type = 'demand' AND created_at > NOW() - ($1 || ' days')::interval
       GROUP BY skill_domain
       ORDER BY demand_count DESC
       LIMIT 30`,
      [windowDays],
    );

    // Supply (agents with proficiency >= 30)
    const supplyResult = await this.pool.query(
      `SELECT skill_domain, COUNT(DISTINCT agent_id) AS agent_count, AVG(proficiency) AS avg_proficiency
       FROM agent_specializations
       WHERE proficiency >= 30
       GROUP BY skill_domain`,
    );

    // Open gaps
    const gapsResult = await this.pool.query(
      `SELECT query_tags, COUNT(*) AS gap_count
       FROM skill_gaps
       WHERE resolved = false AND last_seen > NOW() - ($1 || ' days')::interval
       GROUP BY query_tags
       ORDER BY gap_count DESC
       LIMIT 20`,
      [windowDays],
    );

    return {
      demand: demandResult.rows,
      supply: supplyResult.rows,
      gaps: gapsResult.rows,
      windowDays,
    };
  }

  // ============================================================
  //  Internal
  // ============================================================

  private publishEvent(entityId: string, type: string, data: any): void {
    if (!this.messageBus) return;
    try {
      this.messageBus.publish(`agent:${entityId}`, { type, data, ts: Date.now() });
    } catch (err) {
      logSecurityEvent("warn", "specialization-event-failed", { entityId, type, error: String(err) });
    }
  }
}
