/**
 * Channel service — CRUD for channels, membership, and message history.
 *
 * Follows the same patterns as InboxService: pool-only dependency,
 * parameterized queries, limit clamping (max 200 per page).
 *
 * @module services/channelService
 */

import type pg from "pg";

// ============================================================
//  Types
// ============================================================

export interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  channel_type: string;
  source_id: string | null;
  creator_id: string | null;
  max_members: number;
  is_public: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ChannelMemberRow {
  id: string;
  channel_id: string;
  agent_id: string;
  role: string;
  joined_at: string;
}

export interface ChannelMessageRow {
  id: string;
  channel_id: string;
  from_agent_id: string;
  message_type: string;
  content: string;
  metadata: Record<string, unknown>;
  signature: string | null;
  created_at: string;
}

export interface CreateChannelInput {
  slug: string;
  name: string;
  description?: string;
  channelType?: string;
  sourceId?: string;
  creatorId?: string;
  maxMembers?: number;
  isPublic?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChannelFilters {
  channelType?: string;
  isPublic?: boolean;
  limit?: number;
  offset?: number;
}

export interface MessageInput {
  channelId: string;
  fromAgentId: string;
  content: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  signature?: string;
  quarantined?: boolean;
}

export interface HistoryFilters {
  before?: string;
  limit?: number;
  includeQuarantined?: boolean;
}

// ============================================================
//  Service
// ============================================================

export class ChannelService {
  constructor(private readonly pool: pg.Pool) {}

  // ---- Channel CRUD ----

  async createChannel(input: CreateChannelInput): Promise<ChannelRow> {
    const { rows } = await this.pool.query<ChannelRow>(
      `INSERT INTO channels (slug, name, description, channel_type, source_id, creator_id, max_members, is_public, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.slug,
        input.name,
        input.description ?? null,
        input.channelType ?? "custom",
        input.sourceId ?? null,
        input.creatorId ?? null,
        input.maxMembers ?? 0,
        input.isPublic ?? true,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0];
  }

  async getChannel(channelId: string): Promise<ChannelRow | null> {
    const { rows } = await this.pool.query<ChannelRow>(
      `SELECT * FROM channels WHERE id = $1`,
      [channelId],
    );
    return rows[0] ?? null;
  }

  async getChannelBySlug(slug: string): Promise<ChannelRow | null> {
    const { rows } = await this.pool.query<ChannelRow>(
      `SELECT * FROM channels WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async getChannelBySourceId(sourceId: string): Promise<ChannelRow | null> {
    const { rows } = await this.pool.query<ChannelRow>(
      `SELECT * FROM channels WHERE source_id = $1`,
      [sourceId],
    );
    return rows[0] ?? null;
  }

  async listChannels(filters?: ChannelFilters): Promise<ChannelRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Validate channelType against allowlist to prevent injection
    const VALID_CHANNEL_TYPES = new Set(["community", "clique", "custom", "project"]);
    if (filters?.channelType) {
      if (!VALID_CHANNEL_TYPES.has(filters.channelType)) {
        return []; // Invalid type — return empty rather than querying
      }
      conditions.push(`channel_type = $${paramIndex++}`);
      params.push(filters.channelType);
    }
    if (filters?.isPublic !== undefined) {
      conditions.push(`is_public = $${paramIndex++}`);
      params.push(filters.isPublic);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filters?.limit ?? 50, 200);
    const offset = filters?.offset ?? 0;

    params.push(limit);
    params.push(offset);

    const { rows } = await this.pool.query<ChannelRow>(
      `SELECT * FROM channels ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );
    return rows;
  }

  // ---- Membership ----

  async joinChannel(channelId: string, agentId: string, role = "member"): Promise<ChannelMemberRow> {
    const { rows } = await this.pool.query<ChannelMemberRow>(
      `INSERT INTO channel_members (channel_id, agent_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, agent_id) DO NOTHING
       RETURNING *`,
      [channelId, agentId, role],
    );
    // If already a member, return existing row
    if (rows.length === 0) {
      const existing = await this.pool.query<ChannelMemberRow>(
        `SELECT * FROM channel_members WHERE channel_id = $1 AND agent_id = $2`,
        [channelId, agentId],
      );
      return existing.rows[0];
    }
    return rows[0];
  }

  async leaveChannel(channelId: string, agentId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND agent_id = $2`,
      [channelId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  async getMembers(channelId: string, limit = 100, offset = 0): Promise<ChannelMemberRow[]> {
    const safeLimit = Math.min(limit, 200);
    const { rows } = await this.pool.query<ChannelMemberRow>(
      `SELECT * FROM channel_members WHERE channel_id = $1 ORDER BY joined_at ASC LIMIT $2 OFFSET $3`,
      [channelId, safeLimit, offset],
    );
    return rows;
  }

  async isMember(channelId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM channel_members WHERE channel_id = $1 AND agent_id = $2`,
      [channelId, agentId],
    );
    return parseInt(rows[0].count, 10) > 0;
  }

  async getMemberCount(channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM channel_members WHERE channel_id = $1`,
      [channelId],
    );
    return parseInt(rows[0].count, 10);
  }

  // ---- Messages ----

  async sendMessage(input: MessageInput): Promise<ChannelMessageRow> {
    const { rows } = await this.pool.query<ChannelMessageRow>(
      `INSERT INTO channel_messages (channel_id, from_agent_id, message_type, content, metadata, signature, quarantined)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.channelId,
        input.fromAgentId,
        input.messageType ?? "text",
        input.content,
        JSON.stringify(input.metadata ?? {}),
        input.signature ?? null,
        input.quarantined ?? false,
      ],
    );
    return rows[0];
  }

  async getHistory(channelId: string, filters?: HistoryFilters): Promise<ChannelMessageRow[]> {
    const conditions: string[] = ["channel_id = $1"];
    const params: unknown[] = [channelId];
    let paramIndex = 2;

    if (filters?.before) {
      conditions.push(`created_at < $${paramIndex++}`);
      params.push(filters.before);
    }

    // Exclude quarantined messages by default
    if (!filters?.includeQuarantined) {
      conditions.push("quarantined = false");
    }

    const limit = Math.min(filters?.limit ?? 50, 200);
    params.push(limit);

    const { rows } = await this.pool.query<ChannelMessageRow>(
      `SELECT * FROM channel_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${paramIndex}`,
      params,
    );
    return rows;
  }
}
