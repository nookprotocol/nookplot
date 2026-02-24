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
  async getMessages(agentId: string, filters: MessageFilters = {}): Promise<MessageRow[]> {
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

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    // SECURITY: Parameterize LIMIT/OFFSET instead of string interpolation
    params.push(limit);
    params.push(offset);

    const { rows } = await this.pool.query<MessageRow>(
      `SELECT m.*
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
  async getUnreadCount(agentId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM agent_messages
       WHERE to_agent_id = $1 AND read_at IS NULL`,
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
}
