/**
 * Channel syncer — auto-creates channels from on-chain communities and guilds.
 *
 * Periodically polls idx_* tables for communities and guilds, and creates
 * corresponding channels in the database. Idempotent — skips if a channel
 * with the same source_id already exists.
 *
 * Runs on a configurable interval (default 60s). Only active when
 * CHANNEL_SYNC_ENABLED is true.
 *
 * @module services/channelSyncer
 */

import type pg from "pg";
import type { ChannelService } from "./channelService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export class ChannelSyncer {
  private readonly pool: pg.Pool;
  private readonly channelService: ChannelService;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    pool: pg.Pool,
    channelService: ChannelService,
    intervalMs = 60_000,
  ) {
    this.pool = pool;
    this.channelService = channelService;
    this.intervalMs = intervalMs;
  }

  /**
   * Start the periodic sync.
   */
  start(): void {
    // Run immediately on start, then on interval
    this.sync().catch((err) => {
      logSecurityEvent("warn", "channel-syncer-initial-sync-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.timer = setInterval(() => {
      this.sync().catch((err) => {
        logSecurityEvent("warn", "channel-syncer-periodic-sync-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);

    logSecurityEvent("info", "channel-syncer-started", {
      intervalMs: this.intervalMs,
    });
  }

  /**
   * Stop the periodic sync.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single sync cycle.
   */
  async sync(): Promise<void> {
    try {
      await Promise.all([
        this.syncCommunities(),
        this.syncGuilds(),
      ]);
    } catch (err) {
      logSecurityEvent("warn", "channel-sync-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  //  Community Sync
  // ============================================================

  private async syncCommunities(): Promise<void> {
    const { rows: communities } = await this.pool.query<{
      id: string;
      total_posts: number;
    }>(
      `SELECT id, total_posts
       FROM idx_communities
       ORDER BY total_posts DESC
       LIMIT 100`,
    );

    for (const community of communities) {
      // The community id is the slug in the idx_communities table
      const slug = community.id;
      const existing = await this.channelService.getChannelBySourceId(slug);
      if (existing) continue;

      // Create channel
      try {
        await this.channelService.createChannel({
          slug: `community-${slug}`,
          name: slug,
          description: `Channel for the ${slug} community`,
          channelType: "community",
          sourceId: slug,
          isPublic: true,
        });

        logSecurityEvent("info", "channel-synced-community", {
          communitySlug: slug,
        });
      } catch {
        // Slug conflict or other error — skip silently
      }
    }
  }

  // ============================================================
  //  Guild Sync
  // ============================================================

  private async syncGuilds(): Promise<void> {
    const { rows: guilds } = await this.pool.query<{
      id: string;
      guild_id: string;
      name: string;
      description_cid: string | null;
      status: string;
    }>(
      `SELECT id, guild_id, name, description_cid, status
       FROM idx_guilds
       WHERE status = 1
       LIMIT 100`,
    );

    for (const guild of guilds) {
      const guildId = guild.id;
      const existing = await this.channelService.getChannelBySourceId(guildId);

      // Fetch members for this guild
      const { rows: memberRows } = await this.pool.query<{ member_id: string }>(
        `SELECT member_id FROM idx_guild_members WHERE guild_id = $1`,
        [guild.guild_id],
      );
      const members = memberRows.map((m) => ({ agent: { id: m.member_id } }));

      if (existing) {
        // Sync membership: add missing members
        await this.syncGuildMembers(existing.id, members);
        continue;
      }

      // Create channel
      try {
        const channel = await this.channelService.createChannel({
          slug: `guild-${guildId.slice(0, 12)}`,
          name: guild.name ?? `Guild ${guildId.slice(0, 8)}`,
          description: guild.description_cid ?? undefined,
          channelType: "guild",
          sourceId: guildId,
          isPublic: false,
        });

        // Sync initial members
        await this.syncGuildMembers(channel.id, members);

        logSecurityEvent("info", "channel-synced-guild", { guildId });
      } catch {
        // Slug conflict or other error — skip silently
      }
    }
  }

  /**
   * Sync guild members from idx_guild_members to channel_members table.
   */
  private async syncGuildMembers(
    channelId: string,
    members: Array<{ agent: { id: string } }>,
  ): Promise<void> {
    for (const member of members) {
      // The idx agent id is the Ethereum address (lowercase)
      const address = member.agent.id.toLowerCase();

      // Look up agent in gateway by address (case-insensitive — checksum vs lowercase)
      const { rows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
        [address],
      );

      if (rows.length === 0) continue;

      // Join channel (idempotent via ON CONFLICT DO NOTHING)
      await this.channelService.joinChannel(channelId, rows[0].id);
    }
  }
}
