/**
 * Intent service — agents broadcast needs, get matched with proposals.
 *
 * Intents are off-chain (gateway DB) for v1. Accepted proposals optionally
 * bridge to ServiceMarketplace agreements for on-chain settlement.
 *
 * @module services/intentService
 */

import type pg from "pg";
import type { MessageBus } from "./messageBus.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { ProactiveScheduler } from "./proactiveScheduler.js";
import type { InboxService } from "./inboxService.js";
import type { SpecializationService } from "./specializationService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/* ---------- Row shapes ---------- */

export interface IntentRow {
  id: string;
  creator_id: string;
  creator_address: string;
  title: string;
  description: string;
  required_skills: string[];
  budget_amount: string;       // bigint stored as string
  budget_token: string | null;
  deadline: string | null;
  category: string | null;
  tags: string[];
  status: string;
  metadata: Record<string, unknown>;
  accepted_proposal_id: string | null;
  agreement_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProposalRow {
  id: string;
  intent_id: string;
  proposer_id: string;
  proposer_address: string;
  description: string;
  approach: string | null;
  estimated_cost: string;
  estimated_duration_hours: number | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* ---------- Input types ---------- */

export interface CreateIntentInput {
  creatorId: string;
  creatorAddress: string;
  title: string;
  description: string;
  requiredSkills?: string[];
  budgetAmount?: number;
  budgetToken?: string;
  deadline?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateIntentInput {
  title?: string;
  description?: string;
  requiredSkills?: string[];
  budgetAmount?: number;
  deadline?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateProposalInput {
  intentId: string;
  proposerId: string;
  proposerAddress: string;
  description: string;
  approach?: string;
  estimatedCost?: number;
  estimatedDurationHours?: number;
  metadata?: Record<string, unknown>;
}

export interface IntentSearchParams {
  status?: string;
  category?: string;
  tags?: string[];
  creatorId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/* ---------- Service ---------- */

export class IntentService {
  private readonly pool: pg.Pool;
  private messageBus: MessageBus | null = null;
  private embeddingService: EmbeddingService | null = null;
  private proactiveScheduler: ProactiveScheduler | null = null;
  private inboxService: InboxService | null = null;
  private specializationService: SpecializationService | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
  }

  setEmbeddingService(svc: EmbeddingService): void {
    this.embeddingService = svc;
  }

  setProactiveScheduler(svc: ProactiveScheduler): void {
    this.proactiveScheduler = svc;
  }

  setInboxService(svc: InboxService): void {
    this.inboxService = svc;
  }

  setSpecializationService(svc: SpecializationService): void {
    this.specializationService = svc;
  }

  /* ---- CRUD ---- */

  async createIntent(input: CreateIntentInput): Promise<IntentRow> {
    if (!input.title || input.title.trim().length < 3) {
      throw new Error("Title must be at least 3 characters");
    }
    if (!input.description || input.description.trim().length < 10) {
      throw new Error("Description must be at least 10 characters");
    }

    const tags = (input.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
    const skills = (input.requiredSkills ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean);

    const { rows } = await this.pool.query<IntentRow>(
      `INSERT INTO intents (creator_id, creator_address, title, description, required_skills,
         budget_amount, budget_token, deadline, category, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.creatorId,
        input.creatorAddress.toLowerCase(),
        input.title.trim(),
        input.description.trim(),
        skills,
        input.budgetAmount ?? 0,
        input.budgetToken ?? null,
        input.deadline ?? null,
        input.category ?? null,
        tags,
        input.metadata ?? {},
      ],
    );

    const intent = rows[0];

    // Publish to interest engine
    this.messageBus?.publish("entity:intent", {
      type: "entity:intent",
      data: {
        entityType: "intent",
        entityId: intent.id,
        title: intent.title,
        tags: [...tags, ...(input.category ? [input.category] : [])],
        skills,
      },
      timestamp: new Date().toISOString(),
    });

    // Embed fire-and-forget
    if (this.embeddingService) {
      const text = `${intent.title} ${intent.description} ${skills.join(" ")} ${tags.join(" ")}`;
      this.embeddingService.embedAndStore("intent", intent.id, text).catch(() => {});
    }

    // Notify matching agents (fire-and-forget)
    this.notifyMatchingAgents(intent).catch(() => {});

    return intent;
  }

  async getIntent(id: string): Promise<IntentRow | null> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT * FROM intents WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async searchIntents(params: IntentSearchParams): Promise<{ intents: IntentRow[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(params.status);
    }
    if (params.category) {
      conditions.push(`category = $${paramIndex++}`);
      values.push(params.category);
    }
    if (params.tags && params.tags.length > 0) {
      conditions.push(`tags && $${paramIndex++}`);
      values.push(params.tags);
    }
    if (params.creatorId) {
      conditions.push(`creator_id = $${paramIndex++}`);
      values.push(params.creatorId);
    }
    if (params.q) {
      conditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      values.push(`%${params.q}%`);
      paramIndex++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = Math.max(params.offset ?? 0, 0);

    const [dataResult, countResult] = await Promise.all([
      this.pool.query<IntentRow>(
        `SELECT * FROM intents ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        [...values, limit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM intents ${where}`,
        values,
      ),
    ]);

    return {
      intents: dataResult.rows,
      total: parseInt(countResult.rows[0]?.count ?? "0", 10),
    };
  }

  async updateIntent(id: string, creatorId: string, input: UpdateIntentInput): Promise<IntentRow | null> {
    const intent = await this.getIntent(id);
    if (!intent) throw new Error("Intent not found");
    if (intent.creator_id !== creatorId) throw new Error("Not the intent creator");
    if (intent.status !== "open") throw new Error("Can only update open intents");

    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.title !== undefined) {
      sets.push(`title = $${paramIndex++}`);
      values.push(input.title.trim());
    }
    if (input.description !== undefined) {
      sets.push(`description = $${paramIndex++}`);
      values.push(input.description.trim());
    }
    if (input.requiredSkills !== undefined) {
      sets.push(`required_skills = $${paramIndex++}`);
      values.push(input.requiredSkills.map((s) => s.toLowerCase().trim()));
    }
    if (input.budgetAmount !== undefined) {
      sets.push(`budget_amount = $${paramIndex++}`);
      values.push(input.budgetAmount);
    }
    if (input.deadline !== undefined) {
      sets.push(`deadline = $${paramIndex++}`);
      values.push(input.deadline);
    }
    if (input.category !== undefined) {
      sets.push(`category = $${paramIndex++}`);
      values.push(input.category);
    }
    if (input.tags !== undefined) {
      sets.push(`tags = $${paramIndex++}`);
      values.push(input.tags.map((t) => t.toLowerCase().trim()));
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${paramIndex++}`);
      values.push(input.metadata);
    }

    if (sets.length === 0) return intent;

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await this.pool.query<IntentRow>(
      `UPDATE intents SET ${sets.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  async cancelIntent(id: string, creatorId: string): Promise<IntentRow> {
    const intent = await this.getIntent(id);
    if (!intent) throw new Error("Intent not found");
    if (intent.creator_id !== creatorId) throw new Error("Not the intent creator");
    if (intent.status === "completed" || intent.status === "cancelled") {
      throw new Error(`Cannot cancel intent with status: ${intent.status}`);
    }

    const { rows } = await this.pool.query<IntentRow>(
      `UPDATE intents SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0];
  }

  async completeIntent(id: string, creatorId: string): Promise<IntentRow> {
    const intent = await this.getIntent(id);
    if (!intent) throw new Error("Intent not found");
    if (intent.creator_id !== creatorId) throw new Error("Not the intent creator");
    if (intent.status !== "in_progress") {
      throw new Error("Can only complete in-progress intents");
    }

    const { rows } = await this.pool.query<IntentRow>(
      `UPDATE intents SET status = 'completed', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0];
  }

  /* ---- Proposals ---- */

  async createProposal(input: CreateProposalInput): Promise<ProposalRow> {
    const intent = await this.getIntent(input.intentId);
    if (!intent) throw new Error("Intent not found");
    if (intent.status !== "open") throw new Error("Intent is not open for proposals");
    if (intent.creator_id === input.proposerId) {
      throw new Error("Cannot propose on your own intent");
    }
    if (!input.description || input.description.trim().length < 10) {
      throw new Error("Proposal description must be at least 10 characters");
    }

    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO intent_proposals (intent_id, proposer_id, proposer_address, description,
         approach, estimated_cost, estimated_duration_hours, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.intentId,
        input.proposerId,
        input.proposerAddress.toLowerCase(),
        input.description.trim(),
        input.approach ?? null,
        input.estimatedCost ?? 0,
        input.estimatedDurationHours ?? null,
        input.metadata ?? {},
      ],
    );

    return rows[0];
  }

  async listProposals(intentId: string): Promise<ProposalRow[]> {
    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT * FROM intent_proposals WHERE intent_id = $1 ORDER BY created_at ASC`,
      [intentId],
    );
    return rows;
  }

  async acceptProposal(
    intentId: string,
    proposalId: string,
    creatorId: string,
  ): Promise<{ intent: IntentRow; proposal: ProposalRow }> {
    const intent = await this.getIntent(intentId);
    if (!intent) throw new Error("Intent not found");
    if (intent.creator_id !== creatorId) throw new Error("Not the intent creator");
    if (intent.status !== "open") throw new Error("Intent is not open");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Accept the proposal
      const { rows: proposalRows } = await client.query<ProposalRow>(
        `UPDATE intent_proposals SET status = 'accepted', updated_at = NOW()
         WHERE id = $1 AND intent_id = $2 RETURNING *`,
        [proposalId, intentId],
      );
      if (proposalRows.length === 0) throw new Error("Proposal not found");

      // Reject all other pending proposals
      await client.query(
        `UPDATE intent_proposals SET status = 'rejected', updated_at = NOW()
         WHERE intent_id = $1 AND id != $2 AND status = 'pending'`,
        [intentId, proposalId],
      );

      // Update intent status
      const { rows: intentRows } = await client.query<IntentRow>(
        `UPDATE intents SET status = 'in_progress', accepted_proposal_id = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [proposalId, intentId],
      );

      await client.query("COMMIT");

      return { intent: intentRows[0], proposal: proposalRows[0] };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async rejectProposal(
    intentId: string,
    proposalId: string,
    creatorId: string,
  ): Promise<ProposalRow> {
    const intent = await this.getIntent(intentId);
    if (!intent) throw new Error("Intent not found");
    if (intent.creator_id !== creatorId) throw new Error("Not the intent creator");

    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE intent_proposals SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND intent_id = $2 AND status = 'pending' RETURNING *`,
      [proposalId, intentId],
    );
    if (rows.length === 0) throw new Error("Proposal not found or not pending");
    return rows[0];
  }

  async withdrawProposal(
    intentId: string,
    proposalId: string,
    proposerId: string,
  ): Promise<ProposalRow> {
    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE intent_proposals SET status = 'withdrawn', updated_at = NOW()
       WHERE id = $1 AND intent_id = $2 AND proposer_id = $3 AND status = 'pending' RETURNING *`,
      [proposalId, intentId, proposerId],
    );
    if (rows.length === 0) throw new Error("Proposal not found or not pending");
    return rows[0];
  }

  /* ---- Matching ---- */

  async matchAgentsToIntent(intentId: string, limit = 20): Promise<Array<{ agentId: string; address: string; name: string | null; matchScore: number }>> {
    const intent = await this.getIntent(intentId);
    if (!intent) return [];

    const skills = intent.required_skills ?? [];
    if (skills.length === 0) {
      // No skill filter — return top agents by contribution score
      const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null; total_score: string }>(
        `SELECT a.id AS agent_id, a.address, a.display_name,
                COALESCE(cs.total_score, 0)::text AS total_score
         FROM agents a
         LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
         WHERE a.id != $1
         ORDER BY cs.total_score DESC NULLS LAST
         LIMIT $2`,
        [intent.creator_id, limit],
      );
      return rows.map((r) => ({
        agentId: r.agent_id,
        address: r.address,
        name: r.display_name,
        matchScore: parseFloat(r.total_score) / 100,
      }));
    }

    // Skill-based matching: agents whose expertise overlaps with required skills
    const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null; overlap: string; total_score: string }>(
      `SELECT a.id AS agent_id, a.address, a.display_name,
              COALESCE(array_length(
                ARRAY(SELECT unnest(a.expertise) INTERSECT SELECT unnest($1::text[])),
                1
              ), 0)::text AS overlap,
              COALESCE(cs.total_score, 0)::text AS total_score
       FROM agents a
       LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
       WHERE a.id != $2
         AND a.expertise && $1::text[]
       ORDER BY overlap DESC, cs.total_score DESC NULLS LAST
       LIMIT $3`,
      [skills, intent.creator_id, limit],
    );

    const maxOverlap = skills.length;
    return rows.map((r) => ({
      agentId: r.agent_id,
      address: r.address,
      name: r.display_name,
      matchScore: (parseInt(r.overlap, 10) / maxOverlap) * 0.7 + (parseFloat(r.total_score) / 20000) * 0.3,
    }));
  }

  async matchIntentsToAgent(agentId: string, limit = 20): Promise<IntentRow[]> {
    // Find open intents whose required_skills overlap with agent's expertise
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT i.*
       FROM intents i
       WHERE i.status = 'open'
         AND i.creator_id != $1
         AND (
           i.required_skills = '{}' OR
           EXISTS (
             SELECT 1 FROM agents a
             WHERE a.id = $1
               AND a.expertise && i.required_skills
           )
         )
       ORDER BY i.created_at DESC
       LIMIT $2`,
      [agentId, limit],
    );
    return rows;
  }

  /* ---- Matching notifications ---- */

  /**
   * Notify top matching agents when an intent is created.
   * Mirrors the bounty matching logic: queries expertise_tags + endorsements,
   * ranks by endorsement avg rating, sends proactive signals + inbox messages.
   */
  private async notifyMatchingAgents(intent: IntentRow): Promise<void> {
    if (!this.proactiveScheduler && !this.inboxService) return;

    try {
      // Build skill keywords from required_skills + tags + title/description words
      const words = [
        ...intent.required_skills.map((s) => s.toLowerCase()),
        ...intent.tags.map((t) => t.toLowerCase()),
        ...intent.title.toLowerCase().split(/\s+/),
        ...intent.description.toLowerCase().split(/\s+/).slice(0, 30),
      ].filter((w) => w.length > 2);
      const skillKeywords = [...new Set(words)].slice(0, 15);

      if (skillKeywords.length === 0) return;

      // Query expertise_tags + endorsements for matching agents (top 5, exclude creator)
      const { rows: matches } = await this.pool.query<{
        agent_id: string;
        address: string;
        display_name: string | null;
        tag: string;
        confidence: number;
        endorsement_score: number;
      }>(
        `SELECT DISTINCT ON (a.id)
                a.id AS agent_id, a.address, a.display_name, et.tag, et.confidence,
                COALESCE(e_agg.avg_rating, 0) AS endorsement_score
         FROM expertise_tags et
         JOIN agents a ON a.id = et.agent_id
         LEFT JOIN (
           SELECT endorsee_id, skill, AVG(rating) AS avg_rating
           FROM endorsements
           WHERE LOWER(skill) = ANY($1::text[])
           GROUP BY endorsee_id, skill
         ) e_agg ON e_agg.endorsee_id = a.id AND LOWER(e_agg.skill) = LOWER(et.tag)
         WHERE LOWER(et.tag) = ANY($1::text[])
           AND a.status = 'active'
           AND LOWER(a.address) != $2
         ORDER BY a.id, COALESCE(e_agg.avg_rating, 0) DESC, et.confidence DESC
         LIMIT 5`,
        [skillKeywords, intent.creator_address.toLowerCase()],
      );

      if (matches.length === 0) return;

      const budgetDisplay = intent.budget_amount !== "0"
        ? ` — ${(Number(intent.budget_amount) / 1e6).toFixed(2)} budget`
        : "";

      for (const match of matches) {
        // Proactive signal
        if (this.proactiveScheduler) {
          this.proactiveScheduler.handleReactiveSignal(match.agent_id, {
            signalType: "intent_opportunity",
            senderAddress: intent.creator_address,
            intentId: intent.id,
            messagePreview: `New intent matches your expertise (${match.tag}): ${intent.title}${budgetDisplay}`,
            metadata: {
              title: intent.title,
              description: intent.description.slice(0, 200),
              requiredSkills: intent.required_skills,
              tags: intent.tags,
              budgetAmount: intent.budget_amount,
              category: intent.category,
            },
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", {
              signalType: "intent_opportunity", error: (err as Error).message,
            });
          });
        }

        // Inbox message
        if (this.inboxService) {
          this.inboxService.send({
            fromAgentId: intent.creator_id,
            toAgentId: match.agent_id,
            messageType: "intent_opportunity",
            content: `Your expertise in "${match.tag}" matches a new intent: "${intent.title}"${budgetDisplay}. Submit a proposal!`,
            metadata: { intentId: intent.id, matchedTag: match.tag, budgetAmount: intent.budget_amount },
          }).catch(() => {});
        }
      }

      // Record demand signals for matched skills
      if (this.specializationService) {
        const demandTags = intent.required_skills.length > 0 ? intent.required_skills : skillKeywords.slice(0, 5);
        for (const tag of demandTags) {
          this.specializationService.recordSignal(
            tag, "demand", 1.0, "intent", intent.id,
            { title: intent.title, category: intent.category, budgetAmount: intent.budget_amount },
          ).catch(() => {});
        }
      }

      logSecurityEvent("info", "intent-matching-notified", {
        intentId: intent.id, matchCount: matches.length, tags: skillKeywords.slice(0, 5),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("warn", "intent-matching-failed", { intentId: intent.id, error: msg });
    }
  }

  /* ---- Lifecycle ---- */

  async expireIntents(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE intents SET status = 'expired', updated_at = NOW()
       WHERE status = 'open' AND deadline IS NOT NULL AND deadline < NOW()`,
    );
    if (rowCount && rowCount > 0) {
      logSecurityEvent("info", "intents-expired", { count: rowCount });
    }
    return rowCount ?? 0;
  }
}
