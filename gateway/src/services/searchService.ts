/**
 * Unified full-text search service.
 *
 * Uses Postgres `tsvector` + `plainto_tsquery` across 7 gateway-stored
 * tables. Each table has a GIN-indexed `search_tsv` column populated by
 * migration 040_unified_search.
 *
 * @module services/searchService
 */

import type pg from "pg";

// ---- Types ----

export type SearchResultType =
  | "project"
  | "channel"
  | "agent"
  | "discussion"
  | "task"
  | "bounty"
  | "paper"
  | "bundle"
  | "teaching";

export interface SearchResultItem {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  relevance: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UnifiedSearchResponse {
  results: SearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

export interface SearchScope {
  type: "project" | "guild";
  id: string;
}

export interface BundleFilters {
  bundleType?: string;
  tags?: string[];
}

const ALLOWED_TYPES: ReadonlySet<SearchResultType> = new Set([
  "project",
  "channel",
  "agent",
  "discussion",
  "task",
  "bounty",
  "paper",
  "bundle",
  "teaching",
]);

const PROJECT_SCOPED_TYPES: ReadonlySet<SearchResultType> = new Set([
  "task", "bounty", "discussion", "bundle", "agent", "paper",
]);

const GUILD_SCOPED_TYPES: ReadonlySet<SearchResultType> = new Set([
  "project", "agent", "discussion", "bundle", "task", "bounty",
]);

interface ScopeContext {
  internalId: string;       // UUID (projects.id or idx_guilds.id)
  projectId?: string;       // projects.project_id (for project scope)
  guildId?: string;         // idx_guilds.guild_id as string (for guild scope)
  addresses?: string[];     // lowercased collaborator addresses (for project scope)
}

// ---- Service ----

export class SearchService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Run a unified full-text search across all (or filtered) content types.
   *
   * Uses `plainto_tsquery` which is safe against SQL injection and treats
   * the input as plain prose (no special operators).
   */
  async search(
    query: string,
    types?: SearchResultType[],
    limit = 20,
    offset = 0,
    bundleFilters?: BundleFilters,
  ): Promise<UnifiedSearchResponse> {
    const requestedTypes: SearchResultType[] =
      types && types.length > 0
        ? types.filter((t) => ALLOWED_TYPES.has(t))
        : [...ALLOWED_TYPES];

    if (requestedTypes.length === 0) {
      return { results: [], total: 0, limit, offset, query };
    }

    // Fan out parallel queries, each returning up to (limit + offset) rows
    // so we can merge, sort, and paginate correctly.
    const perTypeLimit = limit + offset;
    const promises = requestedTypes.map((type) =>
      this.searchType(query, type, perTypeLimit, bundleFilters),
    );
    const perTypeResults = await Promise.all(promises);

    // Merge and sort by relevance descending
    const merged = perTypeResults.flat().sort((a, b) => b.relevance - a.relevance);

    const total = merged.length;
    const results = merged.slice(offset, offset + limit);

    return { results, total, limit, offset, query };
  }

  /**
   * Run a scoped full-text search within a project or guild context.
   */
  async scopedSearch(
    query: string,
    scope: SearchScope,
    types?: SearchResultType[],
    limit = 20,
    offset = 0,
    bundleFilters?: BundleFilters,
  ): Promise<UnifiedSearchResponse> {
    const allowedForScope = scope.type === "project" ? PROJECT_SCOPED_TYPES : GUILD_SCOPED_TYPES;

    const requestedTypes: SearchResultType[] =
      types && types.length > 0
        ? types.filter((t) => allowedForScope.has(t))
        : [...allowedForScope];

    if (requestedTypes.length === 0) {
      return { results: [], total: 0, limit, offset, query };
    }

    // Resolve scope ID to internal identifiers
    const scopeCtx = await this.resolveScopeContext(scope);
    if (!scopeCtx) {
      return { results: [], total: 0, limit, offset, query };
    }

    const perTypeLimit = limit + offset;
    const promises = requestedTypes.map((type) =>
      this.searchTypeScoped(query, type, scope, scopeCtx, perTypeLimit, bundleFilters),
    );
    const perTypeResults = await Promise.all(promises);

    const merged = perTypeResults.flat().sort((a, b) => b.relevance - a.relevance);
    const total = merged.length;
    const results = merged.slice(offset, offset + limit);

    return { results, total, limit, offset, query };
  }

  // ---- Scope resolution ----

  private async resolveScopeContext(scope: SearchScope): Promise<ScopeContext | null> {
    if (scope.type === "project") {
      const { rows } = await this.pool.query(
        `SELECT p.id, p.project_id, p.agent_id FROM projects p WHERE p.project_id = $1 AND p.status = 'active'`,
        [scope.id],
      );
      if (rows.length === 0) return null;
      // Get collaborator addresses
      const { rows: collabRows } = await this.pool.query(
        `SELECT a.address FROM agents a WHERE a.id = $1
         UNION
         SELECT a.address FROM project_collaborators pc
         JOIN agents a ON a.id = pc.agent_id
         WHERE pc.project_id = $1`,
        [rows[0].id],
      );
      return {
        internalId: rows[0].id,
        projectId: rows[0].project_id,
        addresses: collabRows.map((r) => r.address.toLowerCase()),
      };
    } else {
      // Guild scope — resolve from idx_guilds
      const { rows } = await this.pool.query(
        `SELECT id, guild_id FROM idx_guilds WHERE guild_id = $1`,
        [scope.id],
      );
      if (rows.length === 0) return null;
      return {
        internalId: rows[0].id,
        guildId: String(rows[0].guild_id),
      };
    }
  }

  // ---- Scoped per-type dispatcher ----

  private async searchTypeScoped(
    query: string,
    type: SearchResultType,
    scope: SearchScope,
    ctx: ScopeContext,
    limit: number,
    bundleFilters?: BundleFilters,
  ): Promise<SearchResultItem[]> {
    if (scope.type === "project") {
      switch (type) {
        case "task": return this.searchTasksScoped(query, ctx, limit);
        case "bounty": return this.searchBountiesScoped(query, ctx, limit);
        case "discussion": return this.searchDiscussionsScoped(query, ctx, "project", limit);
        case "agent": return this.searchAgentsScoped(query, ctx, limit);
        case "bundle": return this.searchBundlesScoped(query, ctx.addresses ?? [], limit, bundleFilters);
        case "paper": return this.searchPapersScoped(query, ctx.addresses ?? [], limit);
        default: return [];
      }
    } else {
      switch (type) {
        case "project": return this.searchProjectsScopedByGuild(query, ctx, limit);
        case "agent": return this.searchAgentsScopedByGuild(query, ctx, limit);
        case "discussion": return this.searchDiscussionsScoped(query, ctx, "clique", limit);
        case "bundle": return this.searchBundlesScopedByGuild(query, ctx, limit, bundleFilters);
        case "task": return this.searchTasksScopedByGuild(query, ctx, limit);
        case "bounty": return this.searchBountiesScopedByGuild(query, ctx, limit);
        default: return [];
      }
    }
  }

  // ---- Scoped query methods (project) ----

  private async searchTasksScoped(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.title, t.project_id,
              ts_headline('english', COALESCE(t.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(t.search_tsv, q) AS relevance,
              t.status, t.priority, t.labels, t.created_at
       FROM project_tasks t, plainto_tsquery('english', $1) q
       WHERE t.search_tsv @@ q AND t.project_id = $2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.internalId, limit],
    );
    return rows.map((r) => ({
      type: "task" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, priority: r.priority, labels: r.labels },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchBountiesScoped(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT b.id, b.title, b.project_id,
              ts_headline('english', COALESCE(b.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(b.search_tsv, q) AS relevance,
              b.status, b.reward_amount, b.created_at
       FROM project_bounties b, plainto_tsquery('english', $1) q
       WHERE b.search_tsv @@ q AND b.project_id = $2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.internalId, limit],
    );
    return rows.map((r) => ({
      type: "bounty" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, reward: r.reward_amount },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchDiscussionsScoped(
    query: string, ctx: ScopeContext, channelType: string, limit: number,
  ): Promise<SearchResultItem[]> {
    const sourceId = channelType === "project" ? ctx.projectId : ctx.guildId;
    const { rows } = await this.pool.query(
      `SELECT cm.id, cm.content,
              ts_headline('english', cm.content, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(cm.search_tsv, q) AS relevance,
              c.name AS channel_name, c.slug AS channel_slug,
              a.display_name AS author_name, a.address AS author_address,
              cm.created_at
       FROM channel_messages cm
       JOIN channels c ON c.id = cm.channel_id
       JOIN agents a ON a.id = cm.from_agent_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE cm.search_tsv @@ q AND c.channel_type = $2 AND c.source_id = $3
       ORDER BY relevance DESC
       LIMIT $4`,
      [query, channelType, sourceId, limit],
    );
    return rows.map((r) => ({
      type: "discussion" as const,
      id: r.id,
      title: `Message in #${r.channel_name}`,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        channelSlug: r.channel_slug,
        channelName: r.channel_name,
        authorName: r.author_name,
        authorAddress: r.author_address,
      },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchAgentsScoped(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    if (!ctx.addresses || ctx.addresses.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT a.id, a.address, a.display_name,
              ts_headline('english', COALESCE(a.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(a.search_tsv, q) AS relevance,
              a.capabilities, a.created_at
       FROM agents a, plainto_tsquery('english', $1) q
       WHERE a.search_tsv @@ q AND a.status = 'active' AND LOWER(a.address) = ANY($2)
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.addresses, limit],
    );
    return rows.map((r) => ({
      type: "agent" as const,
      id: r.address,
      title: r.display_name ?? r.address,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { address: r.address, capabilities: r.capabilities },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchBundlesScoped(
    query: string, addresses: string[], limit: number,
    filters?: BundleFilters,
  ): Promise<SearchResultItem[]> {
    if (addresses.length === 0) return [];

    const params: unknown[] = [query, addresses, limit];
    const filterClauses: string[] = [];
    let paramIdx = 4;

    if (filters?.bundleType) {
      filterClauses.push(`AND b.bundle_type = $${paramIdx++}`);
      params.push(filters.bundleType);
    }
    if (filters?.tags && filters.tags.length > 0) {
      filterClauses.push(`AND b.tags && $${paramIdx++}`);
      params.push(filters.tags);
    }

    const { rows } = await this.pool.query(
      `SELECT DISTINCT b.bundle_id, b.name, b.cid_count, b.contributor_count,
              b.creator_id, b.created_at, b.bundle_type, b.tags, b.domain,
              ts_headline('english', COALESCE(b.name, '') || ' ' || COALESCE(b.summary, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(b.search_tsv, q) AS relevance
       FROM idx_knowledge_bundles b
       LEFT JOIN idx_bundle_contributors bc ON bc.bundle_id = b.bundle_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE b.search_tsv @@ q AND b.is_active = true
         AND (LOWER(b.creator_id) = ANY($2) OR LOWER(bc.contributor_id) = ANY($2))
         ${filterClauses.join(" ")}
       ORDER BY relevance DESC
       LIMIT $3`,
      params,
    );
    return rows.map((r) => ({
      type: "bundle" as const,
      id: String(r.bundle_id),
      title: r.name || `Bundle #${r.bundle_id}`,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        bundleId: String(r.bundle_id),
        cidCount: r.cid_count,
        contributorCount: r.contributor_count,
        creatorId: r.creator_id,
        bundleType: r.bundle_type ?? null,
        tags: r.tags ?? [],
        domain: r.domain ?? null,
      },
      createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : "",
    }));
  }

  private async searchPapersScoped(
    query: string, addresses: string[], limit: number,
  ): Promise<SearchResultItem[]> {
    if (addresses.length === 0) return [];
    // Papers inside bundles created/contributed by project collaborators
    const { rows } = await this.pool.query(
      `SELECT DISTINCT a.id, a.arxiv_id, a.title,
              ts_headline('english', a.title, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(a.search_tsv, q) AS relevance,
              a.authors, a.categories, a.citation_count, a.published_date, a.ingested_at
       FROM arxiv_content_map a
       JOIN idx_knowledge_bundles b ON a.content_cid = ANY(b.content_cids)
       LEFT JOIN idx_bundle_contributors bc ON bc.bundle_id = b.bundle_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE a.search_tsv @@ q AND b.is_active = true
         AND (LOWER(b.creator_id) = ANY($2) OR LOWER(bc.contributor_id) = ANY($2))
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, addresses, limit],
    );
    return rows.map((r) => ({
      type: "paper" as const,
      id: r.arxiv_id ?? String(r.id),
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        arxivId: r.arxiv_id,
        authors: r.authors,
        categories: r.categories,
        citationCount: r.citation_count,
      },
      createdAt: (r.published_date ?? r.ingested_at)?.toISOString?.() ?? String(r.published_date ?? r.ingested_at ?? ""),
    }));
  }

  // ---- Scoped query methods (guild) ----

  private async searchProjectsScopedByGuild(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT p.project_id, p.name,
              ts_headline('english', COALESCE(p.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(p.search_tsv, q) AS relevance,
              p.status, p.languages, p.tags, p.created_at
       FROM projects p
       JOIN guild_projects gp ON gp.project_id = p.id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE p.search_tsv @@ q AND p.status = 'active' AND gp.guild_id = $2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.internalId, limit],
    );
    return rows.map((r) => ({
      type: "project" as const,
      id: r.project_id,
      title: r.name,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { status: r.status, languages: r.languages, tags: r.tags },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchAgentsScopedByGuild(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.address, a.display_name,
              ts_headline('english', COALESCE(a.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(a.search_tsv, q) AS relevance,
              a.capabilities, a.created_at
       FROM agents a
       JOIN idx_guild_members igm ON LOWER(igm.member_id) = LOWER(a.address)
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE a.search_tsv @@ q AND a.status = 'active'
         AND igm.guild_id = $2 AND igm.status = 2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.guildId, limit],
    );
    return rows.map((r) => ({
      type: "agent" as const,
      id: r.address,
      title: r.display_name ?? r.address,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { address: r.address, capabilities: r.capabilities },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchBundlesScopedByGuild(
    query: string, ctx: ScopeContext, limit: number,
    filters?: BundleFilters,
  ): Promise<SearchResultItem[]> {
    const params: unknown[] = [query, ctx.guildId, limit];
    const filterClauses: string[] = [];
    let paramIdx = 4;

    if (filters?.bundleType) {
      filterClauses.push(`AND b.bundle_type = $${paramIdx++}`);
      params.push(filters.bundleType);
    }
    if (filters?.tags && filters.tags.length > 0) {
      filterClauses.push(`AND b.tags && $${paramIdx++}`);
      params.push(filters.tags);
    }

    // Bundles created by guild members
    const { rows } = await this.pool.query(
      `SELECT DISTINCT b.bundle_id, b.name, b.cid_count, b.contributor_count,
              b.creator_id, b.created_at, b.bundle_type, b.tags, b.domain,
              ts_headline('english', COALESCE(b.name, '') || ' ' || COALESCE(b.summary, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(b.search_tsv, q) AS relevance
       FROM idx_knowledge_bundles b
       JOIN idx_guild_members igm ON LOWER(igm.member_id) = LOWER(b.creator_id)
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE b.search_tsv @@ q AND b.is_active = true
         AND igm.guild_id = $2 AND igm.status = 2
         ${filterClauses.join(" ")}
       ORDER BY relevance DESC
       LIMIT $3`,
      params,
    );
    return rows.map((r) => ({
      type: "bundle" as const,
      id: String(r.bundle_id),
      title: r.name || `Bundle #${r.bundle_id}`,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        bundleId: String(r.bundle_id),
        cidCount: r.cid_count,
        contributorCount: r.contributor_count,
        creatorId: r.creator_id,
        bundleType: r.bundle_type ?? null,
        tags: r.tags ?? [],
        domain: r.domain ?? null,
      },
      createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : "",
    }));
  }

  private async searchTasksScopedByGuild(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.title, t.project_id,
              ts_headline('english', COALESCE(t.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(t.search_tsv, q) AS relevance,
              t.status, t.priority, t.labels, t.created_at
       FROM project_tasks t
       JOIN guild_projects gp ON gp.project_id = t.project_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE t.search_tsv @@ q AND gp.guild_id = $2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.internalId, limit],
    );
    return rows.map((r) => ({
      type: "task" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, priority: r.priority, labels: r.labels },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchBountiesScopedByGuild(
    query: string, ctx: ScopeContext, limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT b.id, b.title, b.project_id,
              ts_headline('english', COALESCE(b.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(b.search_tsv, q) AS relevance,
              b.status, b.reward_amount, b.created_at
       FROM project_bounties b
       JOIN guild_projects gp ON gp.project_id = b.project_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE b.search_tsv @@ q AND gp.guild_id = $2
       ORDER BY relevance DESC
       LIMIT $3`,
      [query, ctx.internalId, limit],
    );
    return rows.map((r) => ({
      type: "bounty" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, reward: r.reward_amount },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  // ---- Per-type queries (global) ----

  private async searchType(
    query: string,
    type: SearchResultType,
    limit: number,
    bundleFilters?: BundleFilters,
  ): Promise<SearchResultItem[]> {
    switch (type) {
      case "project":
        return this.searchProjects(query, limit);
      case "channel":
        return this.searchChannels(query, limit);
      case "agent":
        return this.searchAgents(query, limit);
      case "discussion":
        return this.searchDiscussions(query, limit);
      case "task":
        return this.searchTasks(query, limit);
      case "bounty":
        return this.searchBounties(query, limit);
      case "paper":
        return this.searchPapers(query, limit);
      case "bundle":
        return this.searchBundles(query, limit, bundleFilters);
      case "teaching":
        return this.searchTeachingExchanges(query, limit);
      default:
        return [];
    }
  }

  private async searchProjects(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    // Fan out: search project name/description AND README content, merge by best relevance
    const [projectRows, readmeRows] = await Promise.all([
      this.pool.query(
        `SELECT p.project_id, p.name,
                ts_headline('english', COALESCE(p.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
                ts_rank(p.search_tsv, q) AS relevance,
                p.status, p.languages, p.tags, p.created_at,
                p.source, p.github_stars
         FROM projects p, plainto_tsquery('english', $1) q
         WHERE p.search_tsv @@ q AND p.status = 'active'
         ORDER BY relevance DESC
         LIMIT $2`,
        [query, limit],
      ),
      this.pool.query(
        `SELECT p.project_id, p.name,
                ts_headline('english', grc.content, q, 'MaxWords=35,MinWords=15') AS snippet,
                ts_rank(grc.search_tsv, q) * 0.8 AS relevance,
                p.status, p.languages, p.tags, p.created_at,
                p.source, p.github_stars
         FROM github_readme_content grc
         JOIN projects p ON p.id = grc.project_id
         CROSS JOIN plainto_tsquery('english', $1) q
         WHERE grc.search_tsv @@ q AND p.status = 'active'
         ORDER BY relevance DESC
         LIMIT $2`,
        [query, limit],
      ),
    ]);

    // Merge: deduplicate by project_id, keep higher relevance
    const seen = new Map<string, SearchResultItem>();
    const allRows = [...projectRows.rows, ...readmeRows.rows];

    for (const r of allRows) {
      const relevance = parseFloat(r.relevance);
      const existing = seen.get(r.project_id);
      if (!existing || relevance > existing.relevance) {
        seen.set(r.project_id, {
          type: "project" as const,
          id: r.project_id,
          title: r.name,
          snippet: r.snippet,
          relevance,
          metadata: {
            status: r.status,
            languages: r.languages,
            tags: r.tags,
            source: r.source ?? "manual",
            githubStars: r.github_stars ?? null,
          },
          createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
        });
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  private async searchChannels(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.name, c.slug,
              ts_headline('english', COALESCE(c.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(c.search_tsv, q) AS relevance,
              c.channel_type, c.is_public, c.created_at
       FROM channels c, plainto_tsquery('english', $1) q
       WHERE c.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "channel" as const,
      id: r.id,
      title: r.name,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { slug: r.slug, channelType: r.channel_type, isPublic: r.is_public },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchAgents(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    // Search both search_tsv (name/description) and skill_tsv (expertise tags).
    // skill_tsv uses 'simple' config (no stemming), so we query with both configs.
    const { rows } = await this.pool.query(
      `SELECT a.id, a.address, a.display_name,
              ts_headline('english', COALESCE(a.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              GREATEST(
                ts_rank(a.search_tsv, q),
                COALESCE(ts_rank(a.skill_tsv, sq), 0) * 0.8
              ) AS relevance,
              a.capabilities, a.created_at,
              (a.skill_tsv @@ sq) AS skill_match
       FROM agents a,
            plainto_tsquery('english', $1) q,
            plainto_tsquery('simple', $1) sq
       WHERE (a.search_tsv @@ q OR a.skill_tsv @@ sq)
         AND a.status = 'active'
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "agent" as const,
      id: r.address,
      title: r.display_name ?? r.address,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        address: r.address,
        capabilities: r.capabilities,
        skillMatch: r.skill_match ?? false,
      },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchDiscussions(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT cm.id, cm.content,
              ts_headline('english', cm.content, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(cm.search_tsv, q) AS relevance,
              c.name AS channel_name, c.slug AS channel_slug,
              a.display_name AS author_name, a.address AS author_address,
              cm.created_at
       FROM channel_messages cm
       JOIN channels c ON c.id = cm.channel_id
       JOIN agents a ON a.id = cm.from_agent_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE cm.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "discussion" as const,
      id: r.id,
      title: `Message in #${r.channel_name}`,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        channelSlug: r.channel_slug,
        channelName: r.channel_name,
        authorName: r.author_name,
        authorAddress: r.author_address,
      },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchTasks(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.title, t.project_id,
              ts_headline('english', COALESCE(t.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(t.search_tsv, q) AS relevance,
              t.status, t.priority, t.labels, t.created_at
       FROM project_tasks t, plainto_tsquery('english', $1) q
       WHERE t.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "task" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, priority: r.priority, labels: r.labels },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchBounties(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT b.id, b.title, b.project_id,
              ts_headline('english', COALESCE(b.description, ''), q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(b.search_tsv, q) AS relevance,
              b.status, b.reward_amount, b.created_at
       FROM project_bounties b, plainto_tsquery('english', $1) q
       WHERE b.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "bounty" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: { projectId: r.project_id, status: r.status, reward: r.reward_amount },
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  private async searchPapers(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.arxiv_id, a.title,
              ts_headline('english', a.title, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(a.search_tsv, q) AS relevance,
              a.authors, a.categories, a.citation_count, a.published_date, a.ingested_at
       FROM arxiv_content_map a, plainto_tsquery('english', $1) q
       WHERE a.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      type: "paper" as const,
      id: r.arxiv_id ?? String(r.id),
      title: r.title,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        arxivId: r.arxiv_id,
        authors: r.authors,
        categories: r.categories,
        citationCount: r.citation_count,
      },
      createdAt: (r.published_date ?? r.ingested_at)?.toISOString?.() ?? String(r.published_date ?? r.ingested_at ?? ""),
    }));
  }

  private async searchBundles(
    query: string,
    limit: number,
    filters?: BundleFilters,
  ): Promise<SearchResultItem[]> {
    const params: unknown[] = [query, limit];
    const filterClauses: string[] = [];
    let paramIdx = 3;

    if (filters?.bundleType) {
      filterClauses.push(`AND b.bundle_type = $${paramIdx++}`);
      params.push(filters.bundleType);
    }
    if (filters?.tags && filters.tags.length > 0) {
      filterClauses.push(`AND b.tags && $${paramIdx++}`);
      params.push(filters.tags);
    }

    const filterSQL = filterClauses.join(" ");

    const { rows } = await this.pool.query(
      `WITH q AS (SELECT plainto_tsquery('english', $1) AS tsq),
       direct AS (
         SELECT b.bundle_id, b.name, b.cid_count, b.contributor_count, b.creator_id, b.created_at,
                b.bundle_type, b.tags, b.domain,
                ts_headline('english', COALESCE(b.name, '') || ' ' || COALESCE(b.summary, ''), q.tsq, 'MaxWords=35,MinWords=15') AS snippet,
                ts_rank(b.search_tsv, q.tsq) AS relevance
         FROM idx_knowledge_bundles b, q
         WHERE b.search_tsv @@ q.tsq AND b.is_active = true ${filterSQL}
       ),
       via_paper AS (
         SELECT DISTINCT ON (b.bundle_id)
                b.bundle_id, b.name, b.cid_count, b.contributor_count, b.creator_id, b.created_at,
                b.bundle_type, b.tags, b.domain,
                'Contains: ' || a.title AS snippet,
                ts_rank(a.search_tsv, q.tsq) * 0.6 AS relevance
         FROM idx_knowledge_bundles b
         JOIN arxiv_content_map a ON a.content_cid = ANY(b.content_cids)
         CROSS JOIN q
         WHERE a.search_tsv @@ q.tsq AND b.is_active = true
               AND b.bundle_id NOT IN (SELECT bundle_id FROM direct)
               ${filterSQL}
       )
       SELECT * FROM direct
       UNION ALL
       SELECT * FROM via_paper
       ORDER BY relevance DESC
       LIMIT $2`,
      params,
    );
    return rows.map((r) => ({
      type: "bundle" as const,
      id: String(r.bundle_id),
      title: r.name || `Bundle #${r.bundle_id}`,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        bundleId: String(r.bundle_id),
        cidCount: r.cid_count,
        contributorCount: r.contributor_count,
        creatorId: r.creator_id,
        bundleType: r.bundle_type ?? null,
        tags: r.tags ?? [],
        domain: r.domain ?? null,
      },
      createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : "",
    }));
  }

  private async searchTeachingExchanges(
    query: string,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const { rows } = await this.pool.query<{
      id: string;
      goal: string;
      snippet: string;
      relevance: string;
      teacher_id: string;
      learner_id: string;
      rating: number | null;
      created_at: string;
    }>(
      `SELECT te.id, te.goal,
              ts_headline('english', te.goal, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(te.search_tsv, q) AS relevance,
              te.teacher_id, te.learner_id, te.rating, te.created_at
       FROM teaching_exchanges te, plainto_tsquery('english', $1) q
       WHERE te.status = 'approved' AND te.search_tsv @@ q
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );

    return rows.map((r) => ({
      type: "teaching" as const,
      id: r.id,
      title: r.goal,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
      metadata: {
        teacherId: r.teacher_id,
        learnerId: r.learner_id,
        rating: r.rating,
      },
      createdAt: r.created_at,
    }));
  }
}
