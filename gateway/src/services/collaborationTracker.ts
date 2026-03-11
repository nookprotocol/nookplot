/**
 * Collaboration history tracker.
 *
 * Periodically scans completed service agreements and bounty completions
 * to record pairwise collaboration outcomes. Used by SkillMatchingService
 * to weight match results by collaboration success rate.
 *
 * @module services/collaborationTracker
 */

import type { Pool } from "pg";

export class CollaborationTracker {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Scan all completed collaborations and record them.
   * Idempotent via UNIQUE(agent_a_id, agent_b_id, collaboration_type, source_id).
   *
   * @returns Number of new collaboration records inserted.
   */
  async trackAll(): Promise<number> {
    let inserted = 0;

    // 1. Service agreements (completed) — provider ↔ buyer
    try {
      const { rows: agreements } = await this.pool.query<{
        id: string;
        provider_id: string;
        buyer_id: string;
        rating: number | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `SELECT sa.id, sa.provider_id, sa.buyer_id,
                sr.rating, sa.completed_at, sa.created_at
         FROM service_agreements sa
         LEFT JOIN service_reviews sr ON sr.agreement_id = sa.id
         WHERE sa.status = 'completed'
           AND sa.provider_id IS NOT NULL
           AND sa.buyer_id IS NOT NULL`,
      );

      for (const a of agreements) {
        // Ensure agent_a_id < agent_b_id for consistent ordering
        const [agentA, agentB] = a.provider_id < a.buyer_id
          ? [a.provider_id, a.buyer_id]
          : [a.buyer_id, a.provider_id];

        const quality = a.rating ? a.rating / 5.0 : null;
        const outcome = a.rating && a.rating >= 3 ? "success" : a.rating ? "mixed" : "unknown";

        const { rowCount } = await this.pool.query(
          `INSERT INTO collaboration_history
             (agent_a_id, agent_b_id, collaboration_type, source_id, outcome, quality_score, started_at, completed_at)
           VALUES ($1, $2, 'service_agreement', $3, $4, $5, $6, $7)
           ON CONFLICT (agent_a_id, agent_b_id, collaboration_type, source_id) DO UPDATE SET
             outcome = EXCLUDED.outcome,
             quality_score = EXCLUDED.quality_score,
             completed_at = EXCLUDED.completed_at`,
          [agentA, agentB, a.id, outcome, quality, a.created_at, a.completed_at],
        );
        if (rowCount && rowCount > 0) inserted++;
      }
    } catch {
      // service_agreements table may not exist — graceful skip
    }

    // 2. Bounty completions — bounty creator ↔ claimer (both as agent UUIDs)
    try {
      const { rows: bounties } = await this.pool.query<{
        bounty_id: string;
        creator_agent_id: string;
        claimer_agent_id: string;
        completed_at: string | null;
      }>(
        `SELECT ib.id::text AS bounty_id,
                creator_a.id AS creator_agent_id,
                claimer_a.id AS claimer_agent_id,
                ib.updated_at AS completed_at
         FROM idx_bounties ib
         JOIN agents creator_a ON LOWER(creator_a.address) = LOWER(ib.creator)
         JOIN agents claimer_a ON LOWER(claimer_a.address) = LOWER(ib.claimer)
         WHERE ib.status IN ('3', '4')
           AND ib.claimer IS NOT NULL`,
      );

      for (const b of bounties) {
        const [agentA, agentB] = b.creator_agent_id < b.claimer_agent_id
          ? [b.creator_agent_id, b.claimer_agent_id]
          : [b.claimer_agent_id, b.creator_agent_id];

        const { rowCount } = await this.pool.query(
          `INSERT INTO collaboration_history
             (agent_a_id, agent_b_id, collaboration_type, source_id, outcome, quality_score, completed_at)
           VALUES ($1, $2, 'bounty', $3, 'success', 1.0, $4)
           ON CONFLICT (agent_a_id, agent_b_id, collaboration_type, source_id) DO NOTHING`,
          [agentA, agentB, `bounty-${b.bounty_id}`, b.completed_at],
        );
        if (rowCount && rowCount > 0) inserted++;
      }
    } catch {
      // idx_bounties table may not exist — graceful skip
    }

    // 3. Project collaborators — pairwise within same project
    try {
      const { rows: collabPairs } = await this.pool.query<{
        project_id: string;
        agent_a: string;
        agent_b: string;
      }>(
        `SELECT pc1.project_id::text, pc1.agent_id AS agent_a, pc2.agent_id AS agent_b
         FROM project_collaborators pc1
         JOIN project_collaborators pc2
           ON pc1.project_id = pc2.project_id
           AND pc1.agent_id < pc2.agent_id`,
      );

      for (const pair of collabPairs) {
        const { rowCount } = await this.pool.query(
          `INSERT INTO collaboration_history
             (agent_a_id, agent_b_id, collaboration_type, source_id, outcome)
           VALUES ($1, $2, 'project', $3, 'ongoing')
           ON CONFLICT (agent_a_id, agent_b_id, collaboration_type, source_id) DO NOTHING`,
          [pair.agent_a, pair.agent_b, `project-${pair.project_id}`],
        );
        if (rowCount && rowCount > 0) inserted++;
      }
    } catch {
      // project_collaborators may not exist — graceful skip
    }

    return inserted;
  }

  /**
   * Get collaboration success rate for an agent.
   * Returns a value between 0 and 1.
   */
  async getCollabSuccessRate(agentId: string): Promise<number> {
    try {
      const { rows } = await this.pool.query<{
        total: string;
        successes: string;
      }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE outcome = 'success')::text AS successes
         FROM collaboration_history
         WHERE (agent_a_id = $1 OR agent_b_id = $1)
           AND outcome IS NOT NULL
           AND outcome <> 'ongoing'`,
        [agentId],
      );

      const total = parseInt(rows[0]?.total ?? "0", 10);
      const successes = parseInt(rows[0]?.successes ?? "0", 10);

      if (total === 0) return 0.7; // Default for agents with no history
      return successes / total;
    } catch {
      return 0.7;
    }
  }
}
