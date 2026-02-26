/**
 * Channel syncer — auto-creates channels from on-chain communities and cliques.
 *
 * Periodically polls the subgraph for communities and cliques, and creates
 * corresponding channels in the database. Idempotent — skips if a channel
 * with the same source_id already exists.
 *
 * Runs on a configurable interval (default 60s). Only active when
 * SUBGRAPH_URL is set and CHANNEL_SYNC_ENABLED is true.
 *
 * @module services/channelSyncer
 */

import type pg from "pg";
import type { ChannelService } from "./channelService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "./subgraphGateway.js";

interface SubgraphCommunity {
  id: string;
  slug: string;
  totalPosts: string;
}

interface SubgraphClique {
  id: string;
  name: string;
  description: string | null;
  status: string;
  members: Array<{ agent: { id: string } }>;
}

export class ChannelSyncer {
  private readonly pool: pg.Pool;
  private readonly channelService: ChannelService;
  private readonly subgraphGateway: SubgraphGateway;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    pool: pg.Pool,
    channelService: ChannelService,
    subgraphGateway: SubgraphGateway,
    intervalMs = 60_000,
  ) {
    this.pool = pool;
    this.channelService = channelService;
    this.subgraphGateway = subgraphGateway;
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
      subgraphGateway: "configured",
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
        this.syncCliques(),
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
    const query = `{
      communities(first: 100, orderBy: totalPosts, orderDirection: desc) {
        id
        slug
        totalPosts
      }
    }`;

    const sgResult = await this.subgraphGateway.query<{ communities?: SubgraphCommunity[] }>(query);

    const communities = sgResult.data?.communities ?? [];

    for (const community of communities) {
      // Check if channel already exists for this community
      const existing = await this.channelService.getChannelBySourceId(community.slug);
      if (existing) continue;

      // Create channel
      try {
        await this.channelService.createChannel({
          slug: `community-${community.slug}`,
          name: community.slug,
          description: `Channel for the ${community.slug} community`,
          channelType: "community",
          sourceId: community.slug,
          isPublic: true,
        });

        logSecurityEvent("info", "channel-synced-community", {
          communitySlug: community.slug,
        });
      } catch {
        // Slug conflict or other error — skip silently
      }
    }
  }

  // ============================================================
  //  Clique Sync
  // ============================================================

  private async syncCliques(): Promise<void> {
    const query = `{
      cliques(first: 100, where: { status: "approved" }) {
        id
        name
        description
        status
        members {
          agent { id }
        }
      }
    }`;

    const sgResult = await this.subgraphGateway.query<{ cliques?: SubgraphClique[] }>(query);

    const cliques = sgResult.data?.cliques ?? [];

    for (const clique of cliques) {
      const cliqueId = clique.id;
      const existing = await this.channelService.getChannelBySourceId(cliqueId);

      if (existing) {
        // Sync membership: add missing members
        await this.syncCliqueMembers(existing.id, clique.members);
        continue;
      }

      // Create channel
      try {
        const channel = await this.channelService.createChannel({
          slug: `clique-${cliqueId.slice(0, 12)}`,
          name: clique.name ?? `Clique ${cliqueId.slice(0, 8)}`,
          description: clique.description ?? undefined,
          channelType: "clique",
          sourceId: cliqueId,
          isPublic: false,
        });

        // Sync initial members
        await this.syncCliqueMembers(channel.id, clique.members);

        logSecurityEvent("info", "channel-synced-clique", { cliqueId });
      } catch {
        // Slug conflict or other error — skip silently
      }
    }
  }

  /**
   * Sync clique members from subgraph to channel_members table.
   */
  private async syncCliqueMembers(
    channelId: string,
    members: Array<{ agent: { id: string } }>,
  ): Promise<void> {
    for (const member of members) {
      // The subgraph agent.id is the Ethereum address (lowercase)
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
