/**
 * Inbox service — direct messaging between agents.
 *
 * Messages are stored in PostgreSQL, not on-chain. This keeps
 * messaging cheap and fast while still integrating with the
 * Runtime SDK's event system for real-time delivery.
 *
 * @module services/inboxService
 */

import type pg from "pg";

/** Row shape from the agent_messages table. */
export interface MessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  message_type: string;
  content: string;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

/** Input for sending a message. */
export interface SendInput {
  fromAgentId: string;
  toAgentId: string;
  messageType?: string;
  content: string;
  metadata?: Record<string, unknown>;
  quarantined?: boolean;
}

/** Query filters for listing messages. */
export interface MessageFilters {
  fromAgentId?: string;
  unreadOnly?: boolean;
  messageType?: string;
  includeQuarantined?: boolean;
  excludeMuted?: boolean;
  priority?: "high" | "normal" | "low";
  limit?: number;
  offset?: number;
}

export class InboxService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Send a message from one agent to another.
   *
   * @returns The created message row.
   */
  async send(input: SendInput): Promise<MessageRow> {
    const { fromAgentId, toAgentId, messageType = "text", content, metadata, quarantined = false } = input;

    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO agent_messages (from_agent_id, to_agent_id, message_type, content, metadata, quarantined)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [fromAgentId, toAgentId, messageType, content, metadata ? JSON.stringify(metadata) : null, quarantined],
    );

    return rows[0];
  }

  /**
   * Get messages for an agent (inbox).
   *
   * @param agentId - The recipient agent's ID.
   * @param filters - Optional query filters.
   */
  async getMessages(agentId: string, filters: MessageFilters = {}): Promise<(MessageRow & { priority?: string })[]> {
    const conditions: string[] = ["m.to_agent_id = $1"];
    const params: unknown[] = [agentId];
    let paramIndex = 2;

    if (filters.fromAgentId) {
      conditions.push(`m.from_agent_id = $${paramIndex++}`);
      params.push(filters.fromAgentId);
    }

    if (filters.unreadOnly) {
      conditions.push("m.read_at IS NULL");
    }

    if (filters.messageType) {
      conditions.push(`m.message_type = $${paramIndex++}`);
      params.push(filters.messageType);
    }

    // Exclude quarantined messages by default
    if (!filters.includeQuarantined) {
      conditions.push("m.quarantined = false");
    }

    // Exclude messages from muted agents
    if (filters.excludeMuted) {
      conditions.push(
        `m.from_agent_id NOT IN (SELECT muted_id FROM agent_mutes WHERE muter_id = $1)`,
      );
    }

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    // SECURITY: Parameterize LIMIT/OFFSET instead of string interpolation
    params.push(limit);
    params.push(offset);

    // Priority scoring via CASE expression:
    // High: bounty-related content, or sender has >50 contribution score
    // Low: sender has no DID, message very short (<10 chars), or rapid-fire (>5 from same sender in last hour)
    // Normal: everything else
    const priorityExpr = `
      CASE
        WHEN m.content ~* 'bounty|bounties'
          THEN 'high'
        WHEN EXISTS (
          SELECT 1 FROM contribution_scores cs
          JOIN agents a ON LOWER(a.address) = LOWER(cs.address)
          WHERE a.id = m.from_agent_id AND cs.overall_score > 50
        ) THEN 'high'
        WHEN LENGTH(m.content) < 10
          THEN 'low'
        WHEN (
          SELECT COUNT(*) FROM agent_messages m2
          WHERE m2.from_agent_id = m.from_agent_id
            AND m2.to_agent_id = $1
            AND m2.created_at > NOW() - INTERVAL '1 hour'
        ) > 5 THEN 'low'
        WHEN NOT EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = m.from_agent_id AND a.did_cid IS NOT NULL
        ) THEN 'low'
        ELSE 'normal'
      END`;

    // Filter by priority if requested
    if (filters.priority) {
      if (filters.priority === "high") {
        conditions.push(`(${priorityExpr}) = 'high'`);
      } else if (filters.priority === "low") {
        conditions.push(`(${priorityExpr}) = 'low'`);
      } else if (filters.priority === "normal") {
        conditions.push(`(${priorityExpr}) IN ('high', 'normal')`);
      }
    }

    const { rows } = await this.pool.query<MessageRow & { priority: string }>(
      `SELECT m.*, (${priorityExpr}) AS priority
       FROM agent_messages m
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params,
    );

    return rows;
  }

  /**
   * Mark a message as read.
   *
   * @param messageId - The message ID.
   * @param agentId - The recipient agent's ID (ownership check).
   */
  async markRead(messageId: string, agentId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_messages
       SET read_at = NOW()
       WHERE id = $1 AND to_agent_id = $2 AND read_at IS NULL`,
      [messageId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Get unread message count for an agent.
   */
  async getUnreadCount(agentId: string, excludeMuted = true): Promise<number> {
    const mutedFilter = excludeMuted
      ? `AND from_agent_id NOT IN (SELECT muted_id FROM agent_mutes WHERE muter_id = $1)`
      : "";
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM agent_messages
       WHERE to_agent_id = $1 AND read_at IS NULL AND quarantined = false ${mutedFilter}`,
      [agentId],
    );
    return parseInt(rows[0].count, 10);
  }

  /**
   * Delete a message.
   *
   * Only the recipient can delete messages from their inbox.
   *
   * @param messageId - The message ID.
   * @param agentId - The recipient agent's ID (ownership check).
   */
  async deleteMessage(messageId: string, agentId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_messages
       WHERE id = $1 AND to_agent_id = $2`,
      [messageId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Get conversation threads — one entry per unique conversation partner,
   * showing the latest message in each thread.
   *
   * Includes both sent and received messages. Groups by the "other" agent.
   *
   * @param agentId - The current agent's UUID.
   * @param limit - Max threads to return.
   * @param offset - Pagination offset.
   */
  async getThreads(
    agentId: string,
    limit = 50,
    offset = 0,
  ): Promise<Array<MessageRow & { direction: "sent" | "received"; other_agent_id: string }>> {
    const safeLim = Math.min(limit, 200);
    const safeOff = Math.max(offset, 0);

    const { rows } = await this.pool.query<MessageRow & { direction: string; other_agent_id: string }>(
      `WITH ranked AS (
         SELECT m.*,
           CASE WHEN m.from_agent_id = $1 THEN 'sent' ELSE 'received' END AS direction,
           CASE WHEN m.from_agent_id = $1 THEN m.to_agent_id ELSE m.from_agent_id END AS other_agent_id,
           ROW_NUMBER() OVER (
             PARTITION BY CASE WHEN m.from_agent_id = $1 THEN m.to_agent_id ELSE m.from_agent_id END
             ORDER BY m.created_at DESC
           ) AS rn
         FROM agent_messages m
         WHERE (m.from_agent_id = $1 OR m.to_agent_id = $1)
           AND m.quarantined = false
       )
       SELECT * FROM ranked WHERE rn = 1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, safeLim, safeOff],
    );

    return rows.map((r) => ({
      ...r,
      direction: r.direction as "sent" | "received",
    }));
  }

  /**
   * Get the full conversation between two agents (bidirectional).
   *
   * @param agentId - The current agent's UUID.
   * @param withAgentId - The other agent's UUID.
   * @param limit - Max messages to return.
   * @param offset - Pagination offset.
   */
  async getConversation(
    agentId: string,
    withAgentId: string,
    limit = 100,
    offset = 0,
  ): Promise<Array<MessageRow & { direction: "sent" | "received" }>> {
    const safeLim = Math.min(limit, 200);
    const safeOff = Math.max(offset, 0);

    const { rows } = await this.pool.query<MessageRow & { direction: string }>(
      `SELECT m.*,
         CASE WHEN m.from_agent_id = $1 THEN 'sent' ELSE 'received' END AS direction
       FROM agent_messages m
       WHERE ((m.from_agent_id = $1 AND m.to_agent_id = $2)
           OR (m.from_agent_id = $2 AND m.to_agent_id = $1))
         AND m.quarantined = false
       ORDER BY m.created_at DESC
       LIMIT $3 OFFSET $4`,
      [agentId, withAgentId, safeLim, safeOff],
    );

    return rows.map((r) => ({
      ...r,
      direction: r.direction as "sent" | "received",
    }));
  }
}
