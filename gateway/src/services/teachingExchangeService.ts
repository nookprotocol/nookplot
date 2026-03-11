/**
 * @module services/teachingExchangeService
 * Teaching Exchange System — lifecycle, actionability, teacher search, gap detection, stats.
 */
import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import type { ChannelService } from "./channelService.js";

// ─── Credit Constants ─────────────────────────────────────────────────────────

export const TEACHING_CREDIT_PROPOSE = 15;
export const TEACHING_CREDIT_ACCEPT = 10;
export const TEACHING_CREDIT_REWARD = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeachingStatus = "proposed" | "accepted" | "delivered" | "approved" | "rejected" | "expired";
export type OfferingType = "bundle" | "community" | "channel" | "guild" | "project" | "insight";

export interface TeachingExchangeRow {
  id: string;
  teacher_id: string;
  learner_id: string;
  goal: string;
  status: TeachingStatus;
  channel_id: string | null;
  teacher_notes: string | null;
  learner_feedback: string | null;
  rating: number | null;
  credit_cost_teacher: number;
  credit_cost_learner: number;
  credit_reward_teacher: number;
  proposed_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  resolved_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeachingOfferingRow {
  id: string;
  exchange_id: string;
  offering_type: OfferingType;
  reference_id: string | null;
  insight_cid: string | null;
  description: string | null;
  actionable: boolean;
  actionability_reason: string | null;
  created_at: string;
}

export interface KnowledgeGapRow {
  id: string;
  query_text: string;
  query_domain: string | null;
  result_count: number;
  max_relevance: number;
  searcher_id: string | null;
  filled: boolean;
  filled_by: string | null;
  filled_bundle_id: string | null;
  filled_at: string | null;
  created_at: string;
}

export interface TeachingStatsRow {
  agent_id: string;
  total_taught: number;
  total_learned: number;
  successful_teachings: number;
  rejected_teachings: number;
  unique_learners: number;
  unique_teachers: number;
  gaps_filled: number;
  avg_rating: number;
  approval_rate: number;
  teaching_reputation: number;
  last_taught_at: string | null;
  last_learned_at: string | null;
  updated_at: string;
}

export interface ProposeInput {
  teacherId: string;
  learnerId: string;
  goal: string;
  offerings: Array<{
    type: OfferingType;
    referenceId?: string;
    insightCid?: string;
    description?: string;
  }>;
}

export interface ActionabilityResult {
  offeringId: string;
  offeringType: OfferingType;
  actionable: boolean;
  reason?: string;
}

export interface TeacherSearchResult {
  address: string;
  displayName: string | null;
  bundleId: string;
  bundleTitle: string;
  relevance: number;
  teachingReputation: number;
  approvalRate: number;
  compositeScore: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class TeachingExchangeService {
  private readonly pool: pg.Pool;
  private creditManager: CreditManager | null = null;
  private channelService: ChannelService | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setCreditManager(cm: CreditManager): void {
    this.creditManager = cm;
  }

  setChannelService(cs: ChannelService): void {
    this.channelService = cs;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async propose(input: ProposeInput): Promise<{
    exchange: TeachingExchangeRow;
    offerings: TeachingOfferingRow[];
    actionabilityResults: ActionabilityResult[];
  }> {
    if (input.teacherId === input.learnerId) {
      throw new Error("Cannot teach yourself");
    }

    // Validate learner exists
    const { rows: agentRows } = await this.pool.query(
      `SELECT id FROM agents WHERE id = $1`,
      [input.learnerId],
    );
    if (agentRows.length === 0) {
      throw new Error("Learner not found");
    }

    // Deduct credits from teacher
    if (this.creditManager) {
      await this.creditManager.deductCredits(
        input.teacherId,
        TEACHING_CREDIT_PROPOSE,
        `teaching-propose-${Date.now()}`,
        "teaching_propose",
      );
    }

    // Insert exchange
    const { rows: exchangeRows } = await this.pool.query<TeachingExchangeRow>(
      `INSERT INTO teaching_exchanges (teacher_id, learner_id, goal, status, credit_cost_teacher, proposed_at, expires_at)
       VALUES ($1, $2, $3, 'proposed', $4, NOW(), NOW() + INTERVAL '7 days')
       RETURNING *`,
      [input.teacherId, input.learnerId, input.goal, TEACHING_CREDIT_PROPOSE],
    );
    const exchange = exchangeRows[0];

    // Insert offerings
    const offerings: TeachingOfferingRow[] = [];
    for (const off of input.offerings) {
      const { rows } = await this.pool.query<TeachingOfferingRow>(
        `INSERT INTO teaching_offerings (exchange_id, offering_type, reference_id, insight_cid, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [exchange.id, off.type, off.referenceId ?? null, off.insightCid ?? null, off.description ?? null],
      );
      offerings.push(rows[0]);
    }

    // Check actionability for the learner
    const actionabilityResults = await this.checkActionability(offerings, input.learnerId);

    // Update offerings with actionability results
    for (const result of actionabilityResults) {
      if (!result.actionable) {
        await this.pool.query(
          `UPDATE teaching_offerings SET actionable = FALSE, actionability_reason = $1 WHERE id = $2`,
          [result.reason ?? null, result.offeringId],
        );
      }
    }

    return { exchange, offerings, actionabilityResults };
  }

  async accept(exchangeId: string, learnerId: string): Promise<TeachingExchangeRow> {
    // Verify status and ownership
    const exchange = await this.getExchangeForUpdate(exchangeId, "proposed", "learner_id", learnerId);

    // Deduct credits from learner
    if (this.creditManager) {
      await this.creditManager.deductCredits(
        learnerId,
        TEACHING_CREDIT_ACCEPT,
        `teaching-accept-${exchangeId}`,
        "teaching_accept",
      );
    }

    // Create private channel for the teaching session
    let channelId: string | null = null;
    if (this.channelService) {
      const shortId = exchangeId.slice(0, 8);
      const goalTrunc = exchange.goal.length > 40 ? exchange.goal.slice(0, 40) + "..." : exchange.goal;
      const channel = await this.channelService.createChannel({
        slug: `teaching-${shortId}`,
        name: `Teaching: ${goalTrunc}`,
        description: `Private teaching channel for exchange ${shortId}`,
        channelType: "teaching",
        isPublic: false,
        creatorId: learnerId,
      });
      channelId = channel.id;

      // Join both participants
      await this.channelService.joinChannel(channelId, exchange.teacher_id);
      await this.channelService.joinChannel(channelId, learnerId);
    }

    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `UPDATE teaching_exchanges
       SET status = 'accepted', accepted_at = NOW(), channel_id = $1,
           credit_cost_learner = $2, expires_at = NOW() + INTERVAL '14 days'
       WHERE id = $3
       RETURNING *`,
      [channelId, TEACHING_CREDIT_ACCEPT, exchangeId],
    );
    return rows[0];
  }

  async deliver(exchangeId: string, teacherId: string, notes?: string): Promise<TeachingExchangeRow> {
    await this.getExchangeForUpdate(exchangeId, "accepted", "teacher_id", teacherId);

    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `UPDATE teaching_exchanges
       SET status = 'delivered', delivered_at = NOW(), teacher_notes = $1
       WHERE id = $2
       RETURNING *`,
      [notes ?? null, exchangeId],
    );
    return rows[0];
  }

  async approve(
    exchangeId: string,
    learnerId: string,
    feedback?: string,
    rating?: number,
  ): Promise<TeachingExchangeRow> {
    if (rating !== undefined && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
      throw new Error("Rating must be an integer between 1 and 5");
    }

    const exchange = await this.getExchangeForUpdate(exchangeId, "delivered", "learner_id", learnerId);

    // Reward the teacher
    if (this.creditManager) {
      await this.creditManager.addCredits(
        exchange.teacher_id,
        TEACHING_CREDIT_REWARD,
        "teaching_reward",
        exchangeId,
      );
    }

    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `UPDATE teaching_exchanges
       SET status = 'approved', resolved_at = NOW(), learner_feedback = $1,
           rating = $2, credit_reward_teacher = $3
       WHERE id = $4
       RETURNING *`,
      [feedback ?? null, rating ?? null, TEACHING_CREDIT_REWARD, exchangeId],
    );

    // Recompute stats for both participants
    await this.recomputeStats(exchange.teacher_id);
    await this.recomputeStats(learnerId);

    return rows[0];
  }

  async reject(exchangeId: string, learnerId: string, feedback?: string): Promise<TeachingExchangeRow> {
    const exchange = await this.getExchangeForUpdate(exchangeId, "delivered", "learner_id", learnerId);

    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `UPDATE teaching_exchanges
       SET status = 'rejected', resolved_at = NOW(), learner_feedback = $1
       WHERE id = $2
       RETURNING *`,
      [feedback ?? null, exchangeId],
    );

    // Recompute stats for both
    await this.recomputeStats(exchange.teacher_id);
    await this.recomputeStats(learnerId);

    return rows[0];
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async getExchange(exchangeId: string): Promise<{
    exchange: TeachingExchangeRow;
    offerings: TeachingOfferingRow[];
  } | null> {
    const { rows: exRows } = await this.pool.query<TeachingExchangeRow>(
      `SELECT * FROM teaching_exchanges WHERE id = $1`,
      [exchangeId],
    );
    if (exRows.length === 0) return null;

    const { rows: offRows } = await this.pool.query<TeachingOfferingRow>(
      `SELECT * FROM teaching_offerings WHERE exchange_id = $1 ORDER BY created_at`,
      [exchangeId],
    );
    return { exchange: exRows[0], offerings: offRows };
  }

  async listExchanges(options: {
    agentId: string;
    role?: "teacher" | "learner" | "both";
    status?: TeachingStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ exchanges: TeachingExchangeRow[]; total: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const role = options.role ?? "both";

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (role === "teacher") {
      conditions.push(`teacher_id = $${paramIndex++}`);
      params.push(options.agentId);
    } else if (role === "learner") {
      conditions.push(`learner_id = $${paramIndex++}`);
      params.push(options.agentId);
    } else {
      conditions.push(`(teacher_id = $${paramIndex} OR learner_id = $${paramIndex})`);
      params.push(options.agentId);
      paramIndex++;
    }

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM teaching_exchanges ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `SELECT * FROM teaching_exchanges ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset],
    );

    return { exchanges: rows, total };
  }

  async getStats(agentId: string): Promise<TeachingStatsRow | null> {
    const { rows } = await this.pool.query<TeachingStatsRow>(
      `SELECT * FROM teaching_stats WHERE agent_id = $1`,
      [agentId],
    );
    return rows[0] ?? null;
  }

  // ─── Teacher Search ───────────────────────────────────────────────────────

  async searchTeachers(goal: string, limit = 10): Promise<TeacherSearchResult[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const tsQuery = goal
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 10)
      .join(" | ");

    if (!tsQuery) return [];

    const { rows } = await this.pool.query<{
      address: string;
      display_name: string | null;
      bundle_id: string;
      bundle_title: string;
      relevance: number;
      teaching_reputation: number;
      approval_rate: number;
    }>(
      `SELECT
         kb.creator_address AS address,
         a.display_name,
         kb.bundle_id,
         kb.title AS bundle_title,
         ts_rank(kb.search_tsv, to_tsquery('english', $1)) AS relevance,
         COALESCE(ts.teaching_reputation, 0) AS teaching_reputation,
         COALESCE(ts.approval_rate, 0) AS approval_rate
       FROM idx_knowledge_bundles kb
       LEFT JOIN agents a ON LOWER(a.address) = LOWER(kb.creator_address)
       LEFT JOIN teaching_stats ts ON ts.agent_id = a.id
       WHERE kb.search_tsv @@ to_tsquery('english', $1)
       ORDER BY
         (0.5 * ts_rank(kb.search_tsv, to_tsquery('english', $1))
          + 0.3 * (COALESCE(ts.teaching_reputation, 0) / 100.0)
          + 0.2 * COALESCE(ts.approval_rate, 0)) DESC
       LIMIT $2`,
      [tsQuery, safeLimit],
    );

    return rows.map((r) => ({
      address: r.address,
      displayName: r.display_name,
      bundleId: r.bundle_id,
      bundleTitle: r.bundle_title,
      relevance: r.relevance,
      teachingReputation: r.teaching_reputation,
      approvalRate: r.approval_rate,
      compositeScore:
        0.5 * r.relevance + 0.3 * (r.teaching_reputation / 100) + 0.2 * r.approval_rate,
    }));
  }

  // ─── Actionability ────────────────────────────────────────────────────────

  async checkActionability(
    offerings: TeachingOfferingRow[],
    learnerId: string,
  ): Promise<ActionabilityResult[]> {
    const results: ActionabilityResult[] = [];

    for (const off of offerings) {
      let actionable = true;
      let reason: string | undefined;

      switch (off.offering_type) {
        case "bundle":
        case "insight":
          // Always actionable
          break;

        case "community": {
          if (!off.reference_id) {
            actionable = false;
            reason = "No community reference provided";
            break;
          }
          const { rows: commRows } = await this.pool.query(
            `SELECT id FROM idx_communities WHERE id = $1`,
            [off.reference_id],
          );
          if (commRows.length === 0) {
            actionable = false;
            reason = "Community not found or inactive";
          }
          break;
        }

        case "channel": {
          if (!off.reference_id) {
            actionable = false;
            reason = "No channel reference provided";
            break;
          }
          const { rows: chanRows } = await this.pool.query(
            `SELECT id, is_public FROM channels WHERE id = $1`,
            [off.reference_id],
          );
          if (chanRows.length === 0) {
            actionable = false;
            reason = "Channel not found";
          } else if (!chanRows[0].is_public) {
            // Check if learner is a member
            const { rows: memRows } = await this.pool.query(
              `SELECT id FROM channel_members WHERE channel_id = $1 AND agent_id = $2`,
              [off.reference_id, learnerId],
            );
            if (memRows.length === 0) {
              actionable = false;
              reason = "Channel is private and learner is not a member";
            }
          }
          break;
        }

        case "guild": {
          if (!off.reference_id) {
            actionable = false;
            reason = "No guild reference provided";
            break;
          }
          const { rows: guildRows } = await this.pool.query(
            `SELECT guild_id, status FROM idx_guilds WHERE guild_id = $1`,
            [off.reference_id],
          );
          if (guildRows.length === 0) {
            actionable = false;
            reason = "Guild not found";
          } else if (guildRows[0].status !== 2) {
            actionable = false;
            reason = "Guild is not active";
          } else {
            // Check if learner is already a member (pointless to teach)
            const { rows: memberRows } = await this.pool.query(
              `SELECT member_id FROM idx_guild_members WHERE guild_id = $1 AND LOWER(member_id) = LOWER($2)`,
              [off.reference_id, learnerId],
            );
            if (memberRows.length > 0) {
              actionable = false;
              reason = "Learner is already a guild member";
            }
          }
          break;
        }

        case "project": {
          if (!off.reference_id) {
            actionable = false;
            reason = "No project reference provided";
            break;
          }
          const { rows: projRows } = await this.pool.query(
            `SELECT id, status FROM idx_projects WHERE id = $1`,
            [off.reference_id],
          );
          if (projRows.length === 0) {
            actionable = false;
            reason = "Project not found";
          } else if (projRows[0].status !== "active") {
            actionable = false;
            reason = "Project is not active";
          }
          break;
        }
      }

      results.push({ offeringId: off.id, offeringType: off.offering_type, actionable, reason });
    }

    return results;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async recomputeStats(agentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO teaching_stats (agent_id, total_taught, total_learned, successful_teachings,
         rejected_teachings, unique_learners, unique_teachers, avg_rating, approval_rate,
         teaching_reputation, last_taught_at, last_learned_at, updated_at)
       SELECT
         $1 AS agent_id,
         COUNT(*) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected')) AS total_taught,
         COUNT(*) FILTER (WHERE learner_id = $1 AND status IN ('approved','rejected')) AS total_learned,
         COUNT(*) FILTER (WHERE teacher_id = $1 AND status = 'approved') AS successful_teachings,
         COUNT(*) FILTER (WHERE teacher_id = $1 AND status = 'rejected') AS rejected_teachings,
         COUNT(DISTINCT learner_id) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected')) AS unique_learners,
         COUNT(DISTINCT teacher_id) FILTER (WHERE learner_id = $1 AND status IN ('approved','rejected')) AS unique_teachers,
         COALESCE(AVG(rating) FILTER (WHERE teacher_id = $1 AND status = 'approved' AND rating IS NOT NULL), 0) AS avg_rating,
         CASE
           WHEN COUNT(*) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected')) > 0
           THEN COUNT(*) FILTER (WHERE teacher_id = $1 AND status = 'approved')::DOUBLE PRECISION
                / COUNT(*) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected'))
           ELSE 0
         END AS approval_rate,
         -- Composite reputation: 40% success count + 30% approval rate + 20% unique learners + 10% avg rating
         (0.4 * LEAST(COUNT(*) FILTER (WHERE teacher_id = $1 AND status = 'approved'), 50) / 50.0
          + 0.3 * CASE
                    WHEN COUNT(*) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected')) > 0
                    THEN COUNT(*) FILTER (WHERE teacher_id = $1 AND status = 'approved')::DOUBLE PRECISION
                         / COUNT(*) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected'))
                    ELSE 0
                  END
          + 0.2 * LEAST(COUNT(DISTINCT learner_id) FILTER (WHERE teacher_id = $1 AND status IN ('approved','rejected')), 20) / 20.0
          + 0.1 * COALESCE(AVG(rating) FILTER (WHERE teacher_id = $1 AND status = 'approved' AND rating IS NOT NULL), 0) / 5.0
         ) * 100 AS teaching_reputation,
         MAX(resolved_at) FILTER (WHERE teacher_id = $1) AS last_taught_at,
         MAX(resolved_at) FILTER (WHERE learner_id = $1) AS last_learned_at,
         NOW() AS updated_at
       FROM teaching_exchanges
       WHERE teacher_id = $1 OR learner_id = $1
       ON CONFLICT (agent_id) DO UPDATE SET
         total_taught = EXCLUDED.total_taught,
         total_learned = EXCLUDED.total_learned,
         successful_teachings = EXCLUDED.successful_teachings,
         rejected_teachings = EXCLUDED.rejected_teachings,
         unique_learners = EXCLUDED.unique_learners,
         unique_teachers = EXCLUDED.unique_teachers,
         avg_rating = EXCLUDED.avg_rating,
         approval_rate = EXCLUDED.approval_rate,
         teaching_reputation = EXCLUDED.teaching_reputation,
         last_taught_at = EXCLUDED.last_taught_at,
         last_learned_at = EXCLUDED.last_learned_at,
         updated_at = NOW()`,
      [agentId],
    );
  }

  // ─── Gap Detection ────────────────────────────────────────────────────────

  async recordGapSignal(
    query: string,
    resultCount: number,
    maxRelevance: number,
    searcherId?: string,
  ): Promise<void> {
    // Only record if results < 3 and query is non-trivial
    if (resultCount >= 3 || query.length < 10) return;

    // Extract domain from query keywords (simple heuristic)
    const domain = this.inferDomain(query);

    await this.pool.query(
      `INSERT INTO knowledge_gap_signals (query_text, query_domain, result_count, max_relevance, searcher_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [query, domain, resultCount, maxRelevance, searcherId ?? null],
    );
  }

  async getGapSignals(options: {
    domain?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ gaps: KnowledgeGapRow[]; total: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: string[] = ["filled = FALSE"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.domain) {
      conditions.push(`query_domain = $${paramIndex++}`);
      params.push(options.domain);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM knowledge_gap_signals ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const { rows } = await this.pool.query<KnowledgeGapRow>(
      `SELECT * FROM knowledge_gap_signals ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset],
    );

    return { gaps: rows, total };
  }

  async markGapFilled(gapId: string, filledBy: string, bundleId: string): Promise<KnowledgeGapRow | null> {
    const { rows } = await this.pool.query<KnowledgeGapRow>(
      `UPDATE knowledge_gap_signals
       SET filled = TRUE, filled_by = $1, filled_bundle_id = $2, filled_at = NOW()
       WHERE id = $3 AND filled = FALSE
       RETURNING *`,
      [filledBy, bundleId, gapId],
    );

    if (rows.length === 0) return null;

    // Increment gaps_filled in teaching_stats
    await this.pool.query(
      `INSERT INTO teaching_stats (agent_id, gaps_filled, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         gaps_filled = teaching_stats.gaps_filled + 1,
         updated_at = NOW()`,
      [filledBy],
    );

    return rows[0];
  }

  // ─── Expiration ───────────────────────────────────────────────────────────

  async expireStaleExchanges(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE teaching_exchanges
       SET status = 'expired', resolved_at = NOW(), updated_at = NOW()
       WHERE status IN ('proposed', 'accepted') AND expires_at < NOW()`,
    );
    return rowCount ?? 0;
  }

  // ─── Search (for unified search) ─────────────────────────────────────────

  async searchExchanges(query: string, limit: number): Promise<Array<{
    id: string;
    goal: string;
    status: string;
    teacher_id: string;
    learner_id: string;
    rating: number | null;
    relevance: number;
  }>> {
    const tsQuery = query
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 10)
      .join(" & ");

    if (!tsQuery) return [];

    const { rows } = await this.pool.query(
      `SELECT id, goal, status, teacher_id, learner_id, rating,
              ts_rank(search_tsv, plainto_tsquery('english', $1)) AS relevance
       FROM teaching_exchanges
       WHERE status = 'approved' AND search_tsv @@ plainto_tsquery('english', $1)
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async getExchangeForUpdate(
    exchangeId: string,
    expectedStatus: TeachingStatus,
    ownerField: "teacher_id" | "learner_id",
    ownerId: string,
  ): Promise<TeachingExchangeRow> {
    const { rows } = await this.pool.query<TeachingExchangeRow>(
      `SELECT * FROM teaching_exchanges WHERE id = $1`,
      [exchangeId],
    );
    if (rows.length === 0) {
      throw new Error("Exchange not found");
    }
    const exchange = rows[0];
    if (exchange.status !== expectedStatus) {
      throw new Error(`Exchange is not in '${expectedStatus}' status (current: ${exchange.status})`);
    }
    if (exchange[ownerField] !== ownerId) {
      throw new Error("Not authorized for this exchange");
    }
    return exchange;
  }

  private inferDomain(query: string): string | null {
    const lower = query.toLowerCase();
    const domains: Array<[string, string[]]> = [
      ["defi", ["defi", "yield", "swap", "liquidity", "lending", "borrow"]],
      ["nft", ["nft", "token", "collectible", "mint"]],
      ["governance", ["governance", "dao", "vote", "proposal"]],
      ["security", ["security", "audit", "vulnerability", "exploit"]],
      ["trading", ["trading", "price", "market", "arbitrage"]],
      ["development", ["solidity", "contract", "deploy", "code", "build"]],
    ];
    for (const [domain, keywords] of domains) {
      if (keywords.some((kw) => lower.includes(kw))) return domain;
    }
    return null;
  }
}
