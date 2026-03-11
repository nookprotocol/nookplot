/**
 * Bundle discovery service.
 *
 * Finds relevant knowledge bundles for a given context (channel, project,
 * guild, or free-text keywords). Reuses the existing SearchService FTS
 * infrastructure.
 *
 * @module services/bundleDiscoveryService
 */

import type pg from "pg";
import type { SearchService } from "./searchService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface DiscoveredBundle {
  bundleId: number;
  name: string;
  summary: string | null;
  domain: string | null;
  tags: string[];
  creatorAddress: string;
  score: number;
}

export interface DiscoverInput {
  channelId?: string;
  projectId?: string;
  guildId?: string;
  keywords?: string;
  agentId?: string;
  faculty?: string;
  limit?: number;
}

// ============================================================
//  BundleDiscoveryService
// ============================================================

export class BundleDiscoveryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly searchService: SearchService,
  ) {}

  /**
   * Discover bundles relevant to the given context.
   *
   * Strategy priority:
   * 1. channelId → resolve channel type/source → delegate to project/guild
   * 2. projectId → collaborator-scoped bundle search (weight 1.0)
   * 3. guildId → guild-member-scoped bundle search (weight 0.8)
   * 4. keywords → FTS via SearchService (weight 0.7)
   */
  async discover(input: DiscoverInput): Promise<DiscoveredBundle[]> {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const results = new Map<number, DiscoveredBundle>();

    try {
      // Strategy 1: Channel → resolve to project/guild scope
      if (input.channelId) {
        const channelBundles = await this.discoverForChannel(input.channelId, limit);
        for (const b of channelBundles) {
          if (!results.has(b.bundleId)) results.set(b.bundleId, b);
        }
      }

      // Strategy 2: Project → collaborator overlap
      if (input.projectId) {
        const projectBundles = await this.discoverForProject(input.projectId, limit);
        for (const b of projectBundles) {
          if (!results.has(b.bundleId)) results.set(b.bundleId, b);
        }
      }

      // Strategy 3: Guild → guild member bundles
      if (input.guildId) {
        const guildBundles = await this.discoverForGuild(input.guildId, limit);
        for (const b of guildBundles) {
          const existing = results.get(b.bundleId);
          if (!existing || existing.score < b.score) {
            results.set(b.bundleId, b);
          }
        }
      }

      // Strategy 4: Keywords → FTS
      if (input.keywords && input.keywords.trim().length >= 2) {
        const keywordBundles = await this.discoverByKeywords(input.keywords, limit);
        for (const b of keywordBundles) {
          const existing = results.get(b.bundleId);
          if (!existing || existing.score < b.score) {
            results.set(b.bundleId, b);
          }
        }
      }

      // Strategy 5: Faculty → bundles whose content includes model resources of this faculty
      if (input.faculty && input.faculty.trim().length >= 2) {
        const facultyBundles = await this.discoverByFaculty(input.faculty, limit);
        for (const b of facultyBundles) {
          const existing = results.get(b.bundleId);
          if (!existing || existing.score < b.score) {
            results.set(b.bundleId, b);
          }
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "bundle-discovery-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Sort by score, return top N
    return [...results.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Discover bundles relevant to a channel's conversation context.
   * Resolves the channel type and extracts keywords from recent messages.
   */
  async discoverForChannel(channelId: string, limit = 5): Promise<DiscoveredBundle[]> {
    try {
      // Resolve channel type and source
      const { rows: chRows } = await this.pool.query<{
        channel_type: string;
        source_id: string | null;
      }>(
        `SELECT channel_type, source_id FROM channels WHERE id = $1 LIMIT 1`,
        [channelId],
      );

      if (chRows.length === 0) return [];

      const { channel_type, source_id } = chRows[0];

      // Delegate to project/guild scope if applicable
      if (channel_type === "project" && source_id) {
        return this.discoverForProject(source_id, limit);
      }
      if (channel_type === "guild" && source_id) {
        return this.discoverForGuild(source_id, limit);
      }

      // Fallback: extract keywords from recent messages
      const { rows: msgRows } = await this.pool.query<{ content: string }>(
        `SELECT content FROM channel_messages
         WHERE channel_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [channelId],
      );

      if (msgRows.length === 0) return [];

      const keywords = msgRows
        .map((r) => r.content)
        .join(" ")
        .slice(0, 200);

      return this.discoverByKeywords(keywords, limit);
    } catch (err) {
      logSecurityEvent("warn", "bundle-discovery-channel-failed", {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ----------------------------------------------------------
  //  Private strategies
  // ----------------------------------------------------------

  private async discoverForProject(projectId: string, limit: number): Promise<DiscoveredBundle[]> {
    try {
      // Get collaborator addresses for this project
      const { rows: collabRows } = await this.pool.query<{ address: string }>(
        `SELECT LOWER(a.address) AS address
         FROM project_collaborators pc
         JOIN agents a ON a.id = pc.agent_id
         WHERE pc.project_id = $1
         LIMIT 50`,
        [projectId],
      );

      if (collabRows.length === 0) return [];

      const addresses = collabRows.map((r) => r.address);
      const placeholders = addresses.map((_, i) => `$${i + 1}`).join(", ");

      const { rows } = await this.pool.query<{
        bundle_id: string;
        name: string;
        summary: string | null;
        domain: string | null;
        tags: string[] | null;
        creator_id: string;
      }>(
        `SELECT bundle_id, name, summary, domain, tags, creator_id
         FROM idx_knowledge_bundles
         WHERE is_active = TRUE AND LOWER(creator_id) IN (${placeholders})
         ORDER BY created_at DESC
         LIMIT $${addresses.length + 1}`,
        [...addresses, limit],
      );

      return rows.map((r, i) => ({
        bundleId: parseInt(r.bundle_id, 10),
        name: r.name,
        summary: r.summary,
        domain: r.domain,
        tags: r.tags ?? [],
        creatorAddress: r.creator_id,
        score: 1.0 - i * 0.05, // weight 1.0, slight ordering decay
      }));
    } catch {
      return [];
    }
  }

  private async discoverForGuild(guildId: string, limit: number): Promise<DiscoveredBundle[]> {
    try {
      // Get guild member addresses
      const { rows: memberRows } = await this.pool.query<{ member_id: string }>(
        `SELECT member_id FROM idx_guild_members WHERE guild_id = $1 LIMIT 50`,
        [guildId],
      );

      if (memberRows.length === 0) return [];

      const addresses = memberRows.map((r) => r.member_id.toLowerCase());
      const placeholders = addresses.map((_, i) => `$${i + 1}`).join(", ");

      const { rows } = await this.pool.query<{
        bundle_id: string;
        name: string;
        summary: string | null;
        domain: string | null;
        tags: string[] | null;
        creator_id: string;
      }>(
        `SELECT bundle_id, name, summary, domain, tags, creator_id
         FROM idx_knowledge_bundles
         WHERE is_active = TRUE AND LOWER(creator_id) IN (${placeholders})
         ORDER BY created_at DESC
         LIMIT $${addresses.length + 1}`,
        [...addresses, limit],
      );

      return rows.map((r, i) => ({
        bundleId: parseInt(r.bundle_id, 10),
        name: r.name,
        summary: r.summary,
        domain: r.domain,
        tags: r.tags ?? [],
        creatorAddress: r.creator_id,
        score: 0.8 - i * 0.04, // weight 0.8
      }));
    } catch {
      return [];
    }
  }

  private async discoverByFaculty(faculty: string, limit: number): Promise<DiscoveredBundle[]> {
    try {
      // Find bundles that contain resources matching this faculty.
      // Join knowledge_resources (faculty filter) → bundle content CIDs.
      // Also check bundles whose tags/domain overlap with faculty name.
      const { rows } = await this.pool.query<{
        bundle_id: string;
        name: string;
        summary: string | null;
        domain: string | null;
        tags: string[] | null;
        creator_id: string;
        model_count: string;
      }>(
        `SELECT b.bundle_id, b.name, b.summary, b.domain, b.tags, b.creator_id,
                COUNT(DISTINCT kr.id)::text AS model_count
         FROM idx_knowledge_bundles b
         JOIN LATERAL UNNEST(b.content_cids) AS cid ON TRUE
         JOIN knowledge_resources kr ON kr.content_cid = cid
         WHERE b.is_active = TRUE
           AND kr.faculty @> ARRAY[$1]::text[]
         GROUP BY b.bundle_id, b.name, b.summary, b.domain, b.tags, b.creator_id
         UNION
         SELECT b.bundle_id, b.name, b.summary, b.domain, b.tags, b.creator_id,
                '0' AS model_count
         FROM idx_knowledge_bundles b
         WHERE b.is_active = TRUE
           AND ($1 = ANY(b.tags) OR b.domain = $1)
         ORDER BY model_count DESC
         LIMIT $2`,
        [faculty, limit],
      );

      return rows.map((r, i) => ({
        bundleId: parseInt(r.bundle_id, 10),
        name: r.name,
        summary: r.summary,
        domain: r.domain,
        tags: r.tags ?? [],
        creatorAddress: r.creator_id,
        score: 0.9 - i * 0.04, // weight 0.9 — faculty is a strong signal
      }));
    } catch {
      return [];
    }
  }

  private async discoverByKeywords(keywords: string, limit: number): Promise<DiscoveredBundle[]> {
    try {
      const searchResults = await this.searchService.search(
        keywords.slice(0, 200),
        ["bundle"],
        limit,
        0,
      );

      return searchResults.results.map((r) => ({
        bundleId: parseInt(r.id, 10) || 0,
        name: r.title,
        summary: r.snippet,
        domain: (r.metadata?.domain as string) ?? null,
        tags: (r.metadata?.tags as string[]) ?? [],
        creatorAddress: (r.metadata?.creatorAddress as string) ?? "",
        score: r.relevance * 0.7, // weight 0.7
      }));
    } catch {
      return [];
    }
  }
}
