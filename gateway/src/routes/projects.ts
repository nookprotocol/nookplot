/**
 * Project management routes for the Agent Coding Sandbox.
 *
 * POST   /v1/projects                      — 410 Gone (use POST /v1/prepare/project)
 * GET    /v1/projects                      — List my projects
 * GET    /v1/projects/network              — Browse all active projects (paginated, public)
 * GET    /v1/projects/:id                  — Get project details (public)
 * PATCH  /v1/projects/:id                  — 410 Gone (use POST /v1/prepare/project/:id)
 * POST   /v1/projects/:id/collaborators    — Add collaborator (gateway-only, owner only)
 * DELETE /v1/projects/:id/collaborators/:target — Remove collaborator (gateway-only, owner only)
 * POST   /v1/projects/:id/versions         — 410 Gone (use POST /v1/prepare/project/:id/versions)
 * DELETE /v1/projects/:id                  — 410 Gone
 *
 * @module routes/projects
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import {
  validateCreateProjectBody,
  validateUpdateProjectBody,
  validateProjectIdParam,
  validateAddCollaboratorBody,
  validateSnapshotBody,
  validateTargetParam,
} from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { SearchService } from "../services/searchService.js";
import type { FileManager } from "../services/fileManager.js";

export function createProjectsRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
  searchService?: SearchService,
  fileManager?: FileManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/projects/discover — Mandatory pre-creation discovery
  // -------------------------------------------------------
  router.post(
    "/projects/discover",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { name, description, tags, languages } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required." });
        return;
      }

      try {
        // Combine results from multiple search strategies
        const seen = new Set<string>();
        const similarProjects: Array<{
          projectId: string;
          name: string;
          description: string | null;
          languages: string[];
          tags: string[];
          relevance: number;
          creatorAddress: string;
          creatorName: string | null;
          createdAt: string;
        }> = [];

        // Strategy 1: Full-text search via SearchService
        if (searchService) {
          const searchQuery = [name, description].filter(Boolean).join(" ");
          const ftsResults = await searchService.search(searchQuery, ["project"], 20, 0);
          for (const r of ftsResults.results) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              const meta = r.metadata as Record<string, unknown>;
              similarProjects.push({
                projectId: r.id,
                name: r.title,
                description: r.snippet ?? null,
                languages: (meta.languages as string[]) ?? [],
                tags: (meta.tags as string[]) ?? [],
                relevance: r.relevance,
                creatorAddress: "",
                creatorName: null,
                createdAt: r.createdAt,
              });
            }
          }
        }

        // Strategy 2: Tag overlap
        const tagArr: string[] = Array.isArray(tags) ? tags : [];
        if (tagArr.length > 0) {
          const { rows: tagRows } = await pool.query(
            `SELECT p.project_id, p.name, p.description, p.languages, p.tags, p.created_at,
                    a.address AS creator_address, a.display_name AS creator_name
             FROM projects p
             LEFT JOIN agents a ON a.id = p.agent_id
             WHERE p.tags && $1::text[] AND p.status = 'active'
             LIMIT 20`,
            [tagArr],
          );
          for (const r of tagRows) {
            const pid = r.project_id as string;
            if (!seen.has(pid)) {
              seen.add(pid);
              const overlap = (r.tags as string[]).filter((t: string) => tagArr.includes(t)).length;
              similarProjects.push({
                projectId: pid,
                name: r.name,
                description: r.description ?? null,
                languages: r.languages ?? [],
                tags: r.tags ?? [],
                relevance: overlap / Math.max(tagArr.length, 1),
                creatorAddress: r.creator_address ?? "",
                creatorName: r.creator_name ?? null,
                createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
              });
            }
          }
        }

        // Strategy 3: Language overlap
        const langArr: string[] = Array.isArray(languages) ? languages : [];
        if (langArr.length > 0) {
          const { rows: langRows } = await pool.query(
            `SELECT p.project_id, p.name, p.description, p.languages, p.tags, p.created_at,
                    a.address AS creator_address, a.display_name AS creator_name
             FROM projects p
             LEFT JOIN agents a ON a.id = p.agent_id
             WHERE p.languages && $1::text[] AND p.status = 'active'
             LIMIT 20`,
            [langArr],
          );
          for (const r of langRows) {
            const pid = r.project_id as string;
            if (!seen.has(pid)) {
              seen.add(pid);
              const overlap = (r.languages as string[]).filter((l: string) => langArr.includes(l)).length;
              similarProjects.push({
                projectId: pid,
                name: r.name,
                description: r.description ?? null,
                languages: r.languages ?? [],
                tags: r.tags ?? [],
                relevance: overlap / Math.max(langArr.length, 1) * 0.5,
                creatorAddress: r.creator_address ?? "",
                creatorName: r.creator_name ?? null,
                createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
              });
            }
          }
        }

        // Sort by relevance descending
        similarProjects.sort((a, b) => b.relevance - a.relevance);

        // Insert discovery record
        const { rows: discRows } = await pool.query(
          `INSERT INTO project_discoveries (agent_id, search_name, search_tags, search_languages, results_count)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [agent.id, name.trim().slice(0, 200), tagArr, langArr, similarProjects.length],
        );
        const discoveryId = discRows[0].id as string;

        logSecurityEvent("info", "project-discovery", {
          agentId: agent.id,
          discoveryId,
          searchName: name.trim(),
          resultsCount: similarProjects.length,
        });

        res.json({
          discoveryId,
          similarProjects,
          total: similarProjects.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "project-discovery-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to search for similar projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/projects",
    authMiddleware,
    registeredMiddleware,
    validateCreateProjectBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/project",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects — List my projects
  // -------------------------------------------------------
  router.get(
    "/projects",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        // Projects I created + projects I collaborate on
        const { rows } = await pool.query(
          `SELECT DISTINCT p.*, a.address AS creator_address, a.display_name AS creator_name
           FROM projects p
           LEFT JOIN project_collaborators pc ON pc.project_id = p.id
           LEFT JOIN agents a ON a.id = p.agent_id
           WHERE (p.agent_id = $1 OR pc.agent_id = $1)
             AND p.status = 'active'
           ORDER BY p.created_at DESC`,
          [agent.id],
        );

        res.json({
          projects: rows.map((r) => ({
            projectId: r.project_id,
            name: r.name,
            description: r.description,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            languages: r.languages,
            tags: r.tags,
            license: r.license,
            metadataCid: r.metadata_cid,
            status: r.status,
            createdAt: r.created_at,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name,
          })),
          total: rows.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "project-list-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to list projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/trending — Active projects ranked by recent activity (public)
  // -------------------------------------------------------
  router.get(
    "/projects/trending",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 6, 1), 20);
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);

      try {
        // Count activity events per project in the time window, join project metadata
        const { rows } = await pool.query(
          `SELECT
             pa.project_id,
             COALESCE(pa.project_name, p.name) AS name,
             p.description,
             p.languages,
             p.tags,
             a.address AS creator_address,
             a.display_name AS creator_name,
             COUNT(*)::int AS event_count,
             COUNT(DISTINCT pa.actor_address)::int AS contributor_count,
             MAX(pa.created_at) AS last_activity,
             ARRAY_AGG(DISTINCT pa.event_type) FILTER (WHERE pa.event_type IS NOT NULL) AS event_types
           FROM project_activity pa
           LEFT JOIN projects p ON p.project_id = pa.project_id
           LEFT JOIN agents a ON a.id = p.agent_id
           WHERE pa.created_at > NOW() - make_interval(days => $2::int)
           GROUP BY pa.project_id, pa.project_name, p.name, p.description, p.languages, p.tags, a.address, a.display_name
           ORDER BY event_count DESC, last_activity DESC
           LIMIT $1`,
          [limit, days],
        );

        // For each project, fetch the top 3 recent contributors
        const projects = await Promise.all(
          rows.map(async (r) => {
            const { rows: contribRows } = await pool.query(
              `SELECT pa.actor_address, a.display_name,
                      COUNT(*)::int AS actions
               FROM project_activity pa
               LEFT JOIN agents a ON LOWER(a.address) = LOWER(pa.actor_address)
               WHERE pa.project_id = $1
                 AND pa.created_at > NOW() - make_interval(days => $2::int)
                 AND pa.actor_address IS NOT NULL
               GROUP BY pa.actor_address, a.display_name
               ORDER BY actions DESC
               LIMIT 3`,
              [r.project_id, days],
            );

            return {
              projectId: r.project_id,
              name: r.name,
              description: r.description ?? null,
              languages: r.languages ?? [],
              tags: r.tags ?? [],
              creatorAddress: r.creator_address ?? null,
              creatorName: r.creator_name ?? null,
              eventCount: r.event_count,
              contributorCount: r.contributor_count,
              lastActivity: r.last_activity,
              eventTypes: r.event_types ?? [],
              topContributors: contribRows.map((c) => ({
                address: c.actor_address,
                name: c.display_name ?? null,
                actions: c.actions,
              })),
            };
          }),
        );

        res.json({ projects, days });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "trending-projects-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch trending projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/network — Browse all active projects (public)
  // -------------------------------------------------------
  router.get(
    "/projects/network",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
        const q = (req.query.q as string || "").trim();
        const language = (req.query.language as string || "").trim();
        const tag = (req.query.tag as string || "").trim();
        const creator = (req.query.creator as string || "").trim();
        const sort = (req.query.sort as string || "newest").trim();

        // Build dynamic WHERE clause with parameterized conditions
        const conditions: string[] = ["p.status = 'active'"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (q) {
          conditions.push(
            `(p.name ILIKE $${paramIdx} OR p.description ILIKE $${paramIdx} OR p.project_id ILIKE $${paramIdx})`,
          );
          params.push(`%${q}%`);
          paramIdx++;
        }
        if (language) {
          conditions.push(`p.languages && ARRAY[$${paramIdx}]::text[]`);
          params.push(language);
          paramIdx++;
        }
        if (tag) {
          conditions.push(`p.tags && ARRAY[$${paramIdx}]::text[]`);
          params.push(tag);
          paramIdx++;
        }
        if (creator) {
          conditions.push(`LOWER(a.address) = LOWER($${paramIdx})`);
          params.push(creator);
          paramIdx++;
        }

        // GitHub Knowledge filters
        const source = (req.query.source as string || "").trim();
        if (source && ["github", "github-auto", "manual"].includes(source)) {
          conditions.push(`p.source = $${paramIdx}`);
          params.push(source);
          paramIdx++;
        }
        const minStars = parseInt(req.query.minStars as string) || 0;
        if (minStars > 0) {
          conditions.push(`p.github_stars >= $${paramIdx}`);
          params.push(minStars);
          paramIdx++;
        }

        const whereClause = conditions.join(" AND ");

        // Build ORDER BY based on sort parameter
        let orderClause: string;
        let selectExtra = "";
        let joinExtra = "";
        switch (sort) {
          case "oldest":
            orderClause = "p.created_at ASC";
            break;
          case "name":
            orderClause = "p.name ASC";
            break;
          case "recent_activity":
            orderClause = "p.updated_at DESC";
            break;
          case "most_active":
            // Count messages in the project's discussion channel
            selectExtra = `, COALESCE(msg_counts.msg_count, 0) AS msg_count`;
            joinExtra = `LEFT JOIN (
              SELECT c.source_id, COUNT(cm.id)::int AS msg_count
              FROM channels c
              JOIN channel_messages cm ON cm.channel_id = c.id
              WHERE c.channel_type = 'project'
              GROUP BY c.source_id
            ) msg_counts ON msg_counts.source_id = p.project_id`;
            orderClause = "msg_count DESC, p.created_at DESC";
            break;
          default: // "newest"
            orderClause = "p.created_at DESC";
            break;
        }

        const [{ rows }, { rows: countRows }] = await Promise.all([
          pool.query(
            `SELECT p.*, a.address AS creator_address, a.display_name AS creator_name${selectExtra}
             FROM projects p
             LEFT JOIN agents a ON a.id = p.agent_id
             ${joinExtra}
             WHERE ${whereClause}
             ORDER BY ${orderClause}
             LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            [...params, limit, offset],
          ),
          pool.query(
            `SELECT COUNT(*)::int AS total
             FROM projects p
             LEFT JOIN agents a ON a.id = p.agent_id
             WHERE ${whereClause}`,
            params,
          ),
        ]);

        res.json({
          projects: rows.map((r) => ({
            projectId: r.project_id,
            name: r.name,
            description: r.description,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            languages: r.languages,
            tags: r.tags,
            license: r.license,
            metadataCid: r.metadata_cid,
            status: r.status,
            createdAt: r.created_at,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name,
            // GitHub Knowledge fields
            source: r.source ?? "manual",
            githubStars: r.github_stars ?? null,
            githubForks: r.github_forks ?? null,
            githubTopics: r.github_topics ?? [],
            githubIsArchived: r.github_is_archived ?? false,
            readmeSnippet: r.readme_snippet ?? null,
          })),
          total: countRows[0]?.total ?? 0,
          limit,
          offset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "network-project-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list network projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id — Get project details (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id",
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;

      try {
        const { rows: projectRows } = await pool.query(
          `SELECT p.*, a.address AS creator_address, a.display_name AS creator_name,
                  ig.name AS guild_name, ig.guild_id AS guild_numeric_id
           FROM projects p
           LEFT JOIN agents a ON a.id = p.agent_id
           LEFT JOIN idx_guilds ig ON CAST(ig.guild_id AS TEXT) = p.guild_id
           WHERE p.project_id = $1`,
          [projectId],
        );

        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        const project = projectRows[0];

        // Get collaborators
        const { rows: collabRows } = await pool.query(
          `SELECT pc.role, a.address, a.display_name
           FROM project_collaborators pc
           JOIN agents a ON a.id = pc.agent_id
           WHERE pc.project_id = $1
           ORDER BY pc.created_at`,
          [project.id],
        );

        res.json({
          projectId: project.project_id,
          name: project.name,
          description: project.description,
          repoUrl: project.repo_url,
          defaultBranch: project.default_branch,
          languages: project.languages,
          tags: project.tags,
          license: project.license,
          metadataCid: project.metadata_cid,
          onChainTx: project.on_chain_tx,
          status: project.status,
          createdAt: project.created_at,
          updatedAt: project.updated_at,
          creatorAddress: project.creator_address,
          creatorName: project.creator_name,
          guildId: project.guild_id ?? null,
          guildName: project.guild_name ?? null,
          collaborators: collabRows.map((c) => ({
            address: c.address,
            name: c.display_name,
            role: c.role,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "project-get-failed", { error: message });
        res.status(500).json({ error: "Failed to get project." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/related-bundles — Algorithmic bundle suggestions
  // -------------------------------------------------------
  router.get(
    "/projects/:id/related-bundles",
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);

      try {
        // Look up project
        const { rows: projectRows } = await pool.query(
          `SELECT p.id, p.project_id, p.name, p.description, p.tags, p.languages, p.agent_id
           FROM projects p
           WHERE p.project_id = $1 AND p.status = 'active'`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const project = projectRows[0];

        // Get collaborator addresses (owner + collaborators)
        const { rows: collabRows } = await pool.query(
          `SELECT a.address FROM agents a WHERE a.id = $1
           UNION
           SELECT a.address FROM project_collaborators pc
           JOIN agents a ON a.id = pc.agent_id
           WHERE pc.project_id = $1`,
          [project.id],
        );
        const collabAddresses = collabRows.map((r) => r.address.toLowerCase());

        // Score map: bundleId → { bundle data, score, reasons }
        const scoreMap = new Map<string, {
          bundleId: string;
          name: string;
          cidCount: number;
          contributorCount: number;
          creatorAddress: string;
          createdAt: string;
          score: number;
          reasons: string[];
        }>();

        // Strategy 1: Contributor overlap (weight 1.0)
        if (collabAddresses.length > 0) {
          const { rows: overlapRows } = await pool.query(
            `SELECT DISTINCT b.bundle_id, b.name, b.cid_count, b.contributor_count,
                    b.creator_id, b.created_at
             FROM idx_knowledge_bundles b
             LEFT JOIN idx_bundle_contributors bc ON bc.bundle_id = b.bundle_id
             WHERE b.is_active = true
               AND (LOWER(b.creator_id) = ANY($1) OR LOWER(bc.contributor_id) = ANY($1))`,
            [collabAddresses],
          );
          for (const r of overlapRows) {
            const bid = String(r.bundle_id);
            const existing = scoreMap.get(bid);
            if (existing) {
              existing.score += 1.0;
              existing.reasons.push("contributor_overlap");
            } else {
              scoreMap.set(bid, {
                bundleId: bid,
                name: r.name || `Bundle #${bid}`,
                cidCount: r.cid_count ?? 0,
                contributorCount: r.contributor_count ?? 0,
                creatorAddress: r.creator_id ?? "",
                createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : "",
                score: 1.0,
                reasons: ["contributor_overlap"],
              });
            }
          }
        }

        // Strategy 2: FTS similarity (weight 0.7)
        if (searchService) {
          const searchText = [project.name, project.description, ...(project.tags ?? [])].filter(Boolean).join(" ");
          if (searchText.trim().length >= 2) {
            const ftsResults = await searchService.search(searchText, ["bundle"], 20, 0);
            for (const r of ftsResults.results) {
              const bid = r.id;
              const scaled = r.relevance * 0.7;
              const existing = scoreMap.get(bid);
              if (existing) {
                existing.score += scaled;
                if (!existing.reasons.includes("text_similarity")) {
                  existing.reasons.push("text_similarity");
                }
              } else {
                const meta = r.metadata as Record<string, unknown>;
                scoreMap.set(bid, {
                  bundleId: bid,
                  name: r.title,
                  cidCount: (meta.cidCount as number) ?? 0,
                  contributorCount: (meta.contributorCount as number) ?? 0,
                  creatorAddress: (meta.creatorId as string) ?? "",
                  createdAt: r.createdAt,
                  score: scaled,
                  reasons: ["text_similarity"],
                });
              }
            }
          }
        }

        // Strategy 3: Tag/language match via papers (weight 0.5)
        const searchTerms = [...(project.tags ?? []), ...(project.languages ?? [])].filter(Boolean);
        if (searchTerms.length > 0) {
          const ilikeClauses = searchTerms.map((_, i) => `a.title ILIKE $${i + 1}`).join(" OR ");
          const likeParams = searchTerms.map((t) => `%${t}%`);
          const { rows: paperRows } = await pool.query(
            `SELECT DISTINCT b.bundle_id, b.name, b.cid_count, b.contributor_count,
                    b.creator_id, b.created_at
             FROM idx_knowledge_bundles b
             JOIN arxiv_content_map a ON a.content_cid = ANY(b.content_cids)
             WHERE b.is_active = true AND (${ilikeClauses})
             LIMIT 20`,
            likeParams,
          );
          for (const r of paperRows) {
            const bid = String(r.bundle_id);
            const existing = scoreMap.get(bid);
            if (existing) {
              existing.score += 0.5;
              if (!existing.reasons.includes("tag_match")) {
                existing.reasons.push("tag_match");
              }
            } else {
              scoreMap.set(bid, {
                bundleId: bid,
                name: r.name || `Bundle #${bid}`,
                cidCount: r.cid_count ?? 0,
                contributorCount: r.contributor_count ?? 0,
                creatorAddress: r.creator_id ?? "",
                createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : "",
                score: 0.5,
                reasons: ["tag_match"],
              });
            }
          }
        }

        // Sort by score descending and take top N
        const sorted = [...scoreMap.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        res.json({
          bundles: sorted.map((b) => ({
            bundleId: b.bundleId,
            name: b.name,
            cidCount: b.cidCount,
            contributorCount: b.contributorCount,
            creatorAddress: b.creatorAddress,
            createdAt: b.createdAt,
            relevanceScore: Math.round(b.score * 100) / 100,
            matchReasons: b.reasons,
          })),
          total: sorted.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "related-bundles-failed", { projectId, error: message });
        res.status(500).json({ error: "Failed to find related bundles." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/projects/:id — 410 Gone
  // -------------------------------------------------------
  router.patch(
    "/projects/:id",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    validateUpdateProjectBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/project/:id",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/collaborators — Add collaborator (gateway-only)
  // -------------------------------------------------------
  router.post(
    "/projects/:id/collaborators",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id as string;

      // Accept role as string ("viewer"/"editor"/"admin") or number (0/1/2)
      const roleInput = req.body.role;
      const roleMap: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };
      let dbRole: number;
      if (typeof roleInput === "string" && roleInput in roleMap) {
        dbRole = roleMap[roleInput];
      } else if (typeof roleInput === "number" && [0, 1, 2].includes(roleInput)) {
        dbRole = roleInput;
      } else {
        res.status(400).json({ error: "role is required: 'viewer' (0), 'editor' (1), or 'admin' (2)." });
        return;
      }

      const collaboratorAddress = req.body.collaborator;
      if (!collaboratorAddress || typeof collaboratorAddress !== "string") {
        res.status(400).json({ error: "collaborator (Ethereum address) is required." });
        return;
      }

      try {
        // Look up project — verify it exists and caller is owner
        const { rows: projectRows } = await pool.query(
          `SELECT p.id, p.name, p.project_id, p.agent_id, a.address AS owner_address
           FROM projects p JOIN agents a ON a.id = p.agent_id
           WHERE p.project_id = $1 AND p.status = 'active'`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const project = projectRows[0];

        // Only owner can add collaborators
        if (project.agent_id !== agent.id) {
          res.status(403).json({ error: "Only the project owner can add collaborators." });
          return;
        }

        // Look up collaborator agent by address
        const { rows: collabAgents } = await pool.query(
          `SELECT id, address, display_name FROM agents WHERE LOWER(address) = LOWER($1)`,
          [collaboratorAddress],
        );
        if (collabAgents.length === 0) {
          res.status(404).json({ error: "Agent not found. They must be registered on Nookplot." });
          return;
        }
        const collabAgent = collabAgents[0];

        // Prevent adding self
        if (collabAgent.id === agent.id) {
          res.status(400).json({ error: "Cannot add yourself as a collaborator." });
          return;
        }

        // Insert collaborator (ON CONFLICT update role)
        await pool.query(
          `INSERT INTO project_collaborators (project_id, agent_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, agent_id)
           DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
          [project.id, collabAgent.id, dbRole],
        );

        // Auto-join collaborator to project discussion channel (if exists)
        const { rows: channels } = await pool.query(
          `SELECT id FROM channels WHERE channel_type = 'project' AND source_id = $1 LIMIT 1`,
          [projectId],
        );
        if (channels.length > 0) {
          await pool.query(
            `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [channels[0].id, collabAgent.id],
          );
        }

        const roleNames = ["viewer", "editor", "admin"];
        const roleName = roleNames[dbRole] ?? "unknown";

        // Write activity event
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'collaborator_added', $3, $4, $5)`,
          [
            project.project_id,
            project.name,
            agent.id,
            agent.address,
            JSON.stringify({
              collaboratorAddress: collabAgent.address,
              collaboratorName: collabAgent.display_name,
              role: dbRole,
              roleName,
            }),
          ],
        );

        // Broadcast WebSocket event to the added collaborator
        if (eventBroadcaster) {
          eventBroadcaster.broadcast(collabAgent.id, {
            type: "project.collaborator_added",
            timestamp: new Date().toISOString(),
            data: {
              projectId,
              projectName: project.name,
              role: roleName,
              addedBy: agent.address,
            },
          });
        }

        // Proactive scheduler (for offline agents)
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(collabAgent.id, {
            signalType: "collaborator_added",
            senderAddress: agent.address,
            projectId,
            messagePreview: `Added as ${roleName} to project ${project.name}`,
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", { signalType: "collaborator_added", error: (err as Error).message });
          });
        }

        logSecurityEvent("info", "collaborator-added", {
          projectId,
          collaborator: collabAgent.address,
          role: roleName,
          addedBy: agent.id,
        });

        res.status(201).json({
          message: "Collaborator added.",
          collaborator: {
            address: collabAgent.address,
            name: collabAgent.display_name,
            role: dbRole,
            roleName,
          },
        });
      } catch (error) {
        logSecurityEvent("error", "collaborator-add-error", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to add collaborator." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/projects/:id/collaborators/:target — Remove collaborator (gateway-only)
  // -------------------------------------------------------
  router.delete(
    "/projects/:id/collaborators/:target",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id;
      const targetAddress = req.params.target;

      try {
        // Look up project — verify caller is owner
        const { rows: projectRows } = await pool.query(
          `SELECT p.id, p.agent_id FROM projects p
           WHERE p.project_id = $1 AND p.status = 'active'`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        if (projectRows[0].agent_id !== agent.id) {
          res.status(403).json({ error: "Only the project owner can remove collaborators." });
          return;
        }

        // Look up target agent
        const { rows: collabAgents } = await pool.query(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [targetAddress],
        );
        if (collabAgents.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        // Delete collaborator
        const { rowCount } = await pool.query(
          `DELETE FROM project_collaborators WHERE project_id = $1 AND agent_id = $2`,
          [projectRows[0].id, collabAgents[0].id],
        );

        if (!rowCount || rowCount === 0) {
          res.status(404).json({ error: "Agent is not a collaborator on this project." });
          return;
        }

        logSecurityEvent("info", "collaborator-removed", {
          projectId,
          collaborator: targetAddress,
          removedBy: agent.id,
        });

        res.json({ message: "Collaborator removed." });
      } catch (error) {
        logSecurityEvent("error", "collaborator-remove-error", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to remove collaborator." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/versions — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/projects/:id/versions",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    validateSnapshotBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/project/:id/versions",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/projects/:id — 410 Gone
  // -------------------------------------------------------
  router.delete(
    "/projects/:id",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/project/:id/deactivate",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/guild — Set guild attribution (gateway-only, owner only)
  // -------------------------------------------------------
  router.post(
    "/projects/:id/guild",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id as string;
      const { guildId } = req.body;

      if (!guildId || typeof guildId !== "string") {
        res.status(400).json({ error: "guildId is required." });
        return;
      }

      try {
        // Verify project exists and caller is owner
        const { rows: projectRows } = await pool.query(
          `SELECT id, agent_id FROM projects WHERE project_id = $1 AND status = 'active'`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        if (projectRows[0].agent_id !== agent.id) {
          res.status(403).json({ error: "Only the project owner can set guild attribution." });
          return;
        }

        // Verify guild exists
        const { rows: guildRows } = await pool.query(
          `SELECT guild_id, name FROM idx_guilds WHERE guild_id = $1`,
          [guildId],
        );
        if (guildRows.length === 0) {
          res.status(404).json({ error: "Guild not found." });
          return;
        }

        // Set guild_id
        await pool.query(
          `UPDATE projects SET guild_id = $1 WHERE id = $2`,
          [guildId, projectRows[0].id],
        );

        logSecurityEvent("info", "project-guild-attribution-set", {
          projectId,
          guildId,
          guildName: guildRows[0].name,
          setBy: agent.id,
        });

        res.json({
          message: "Guild attribution set.",
          projectId,
          guildId,
          guildName: guildRows[0].name,
        });
      } catch (error) {
        logSecurityEvent("error", "project-guild-attribution-error", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to set guild attribution." });
      }
    },
  );

  // -------------------------------------------------------
  // NOTE: POST /v1/projects/:id/fork is handled by the files router (createFilesRouter)
  // which has the complete implementation with in-DB file copy, commit_log, and proactive signals.

  // -------------------------------------------------------
  //  POST /v1/projects/:id/merge-requests — Create merge request
  // -------------------------------------------------------
  router.post(
    "/projects/:id/merge-requests",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const sourceProjectId = req.params.id as string;
      const { title, description, commitIds } = req.body;

      if (!title || typeof title !== "string" || title.length > 200) {
        res.status(400).json({ error: "title is required (max 200 chars)." });
        return;
      }
      if (!Array.isArray(commitIds) || commitIds.length === 0) {
        res.status(400).json({ error: "commitIds array is required." });
        return;
      }

      try {
        // Verify source project exists and is a fork
        const { rows: sourceRows } = await pool.query(
          `SELECT p.id, p.project_id, p.name, p.forked_from, p.agent_id
           FROM projects p
           WHERE p.project_id = $1 AND p.status = 'active'`,
          [sourceProjectId],
        );
        if (sourceRows.length === 0) {
          res.status(404).json({ error: "Source project not found." });
          return;
        }
        const source = sourceRows[0];

        if (!source.forked_from) {
          res.status(400).json({ error: "Project is not a fork. Merge requests can only be created from forked projects." });
          return;
        }

        // Check caller is fork owner or editor
        if (fileManager) {
          const access = await fileManager.getAccessLevel(sourceProjectId, agent.id);
          if (access < 1 && access !== 3) {
            res.status(403).json({ error: "Must be fork owner or editor to create merge requests." });
            return;
          }
        } else if (source.agent_id !== agent.id) {
          res.status(403).json({ error: "Must be fork owner to create merge requests." });
          return;
        }

        // forked_from is the UUID (projects.id) of the parent project
        const targetProjectUuid = source.forked_from as string;

        // Verify target project exists (lookup by internal UUID since forked_from references projects.id)
        const { rows: targetRows } = await pool.query(
          `SELECT p.id, p.project_id, p.name, p.agent_id
           FROM projects p
           WHERE p.id = $1 AND p.status = 'active'`,
          [targetProjectUuid],
        );
        if (targetRows.length === 0) {
          res.status(404).json({ error: "Target (parent) project not found." });
          return;
        }
        const target = targetRows[0];

        // Validate commitIds exist in source project
        const { rows: commitRows } = await pool.query(
          `SELECT id FROM file_commits
           WHERE project_id = $1 AND id = ANY($2::uuid[])`,
          [sourceProjectId, commitIds],
        );
        if (commitRows.length !== commitIds.length) {
          res.status(400).json({ error: "One or more commitIds not found in source project." });
          return;
        }

        // Create merge request (source_project_id and target_project_id are UUID FKs to projects.id)
        const { rows: mrRows } = await pool.query(
          `INSERT INTO merge_requests (source_project_id, target_project_id, author_id, title, description, commit_ids)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at`,
          [source.id, target.id, agent.id, title.trim(), description ?? null, commitIds],
        );
        const mrId = mrRows[0].id as string;

        const targetProjectSlug = target.project_id as string;

        // Log activity on target project
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'merge_request_created', $3, $4, $5)`,
          [
            targetProjectSlug,
            target.name,
            agent.id,
            agent.address,
            JSON.stringify({
              mergeRequestId: mrId,
              title: title.trim(),
              sourceProjectId,
              sourceProjectName: source.name,
              commitCount: commitIds.length,
            }),
          ],
        );

        // Notify target project owner via proactive signal
        if (proactiveScheduler && target.agent_id !== agent.id) {
          proactiveScheduler.handleReactiveSignal(target.agent_id, {
            signalType: "merge_request_created",
            senderAddress: agent.address,
            projectId: targetProjectSlug,
            mergeRequestId: mrId,
            messagePreview: `Merge request: ${title.trim().slice(0, 100)}`,
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", { signalType: "merge_request_created", error: (err as Error).message });
          });
        }

        logSecurityEvent("info", "merge-request-created", {
          mrId,
          sourceProjectId,
          targetProjectId: targetProjectSlug,
          authorId: agent.id,
          commitCount: commitIds.length,
        });

        res.status(201).json({
          id: mrId,
          sourceProjectId,
          targetProjectId: targetProjectSlug,
          title: title.trim(),
          description: description ?? null,
          commitIds,
          status: "open",
          authorAddress: agent.address,
          createdAt: mrRows[0].created_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "merge-request-create-failed", {
          sourceProjectId,
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to create merge request." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/merge-requests — List merge requests (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/merge-requests",
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const status = (req.query.status as string || "").trim();

      try {
        const { rows: projCheck } = await pool.query(
          "SELECT id FROM projects WHERE project_id = $1",
          [projectId],
        );
        if (projCheck.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const projectUuid = projCheck[0].id as string;

        let query = `SELECT mr.id, mr.source_project_id, mr.target_project_id,
                             sp.project_id AS source_project_slug,
                             tp.project_id AS target_project_slug,
                             mr.title, mr.description, mr.commit_ids, mr.status,
                             mr.review_comment, mr.merged_commit_id,
                             mr.created_at, mr.updated_at,
                             a.address AS author_address, a.display_name AS author_name,
                             ra.address AS reviewer_address, ra.display_name AS reviewer_name
                      FROM merge_requests mr
                      LEFT JOIN projects sp ON sp.id = mr.source_project_id
                      LEFT JOIN projects tp ON tp.id = mr.target_project_id
                      LEFT JOIN agents a ON a.id = mr.author_id
                      LEFT JOIN agents ra ON ra.id = mr.reviewer_id
                      WHERE mr.target_project_id = $1`;
        const params: unknown[] = [projectUuid];

        if (status && ["open", "merged", "closed"].includes(status)) {
          query += ` AND mr.status = $2`;
          params.push(status);
        }

        query += ` ORDER BY mr.created_at DESC`;

        const { rows } = await pool.query(query, params);

        res.json({
          mergeRequests: rows.map((r) => ({
            id: r.id,
            sourceProjectId: r.source_project_slug,
            targetProjectId: r.target_project_slug,
            title: r.title,
            description: r.description,
            commitIds: r.commit_ids,
            status: r.status,
            reviewComment: r.review_comment,
            mergedCommitId: r.merged_commit_id,
            authorAddress: r.author_address,
            authorName: r.author_name ?? null,
            reviewerAddress: r.reviewer_address ?? null,
            reviewerName: r.reviewer_name ?? null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
          total: rows.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "merge-request-list-failed", { projectId, error: message });
        res.status(500).json({ error: "Failed to list merge requests." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/merge-requests/:mrId — Merge request detail (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/merge-requests/:mrId",
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const mrId = req.params.mrId as string;

      try {
        const { rows: projCheck } = await pool.query(
          "SELECT id FROM projects WHERE project_id = $1",
          [projectId],
        );
        if (projCheck.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const projectUuid = projCheck[0].id as string;

        const { rows } = await pool.query(
          `SELECT mr.id, mr.source_project_id, mr.target_project_id,
                  sp.project_id AS source_project_slug,
                  tp.project_id AS target_project_slug,
                  mr.title, mr.description, mr.commit_ids, mr.status,
                  mr.review_comment, mr.merged_commit_id,
                  mr.created_at, mr.updated_at,
                  a.address AS author_address, a.display_name AS author_name,
                  ra.address AS reviewer_address, ra.display_name AS reviewer_name
           FROM merge_requests mr
           LEFT JOIN projects sp ON sp.id = mr.source_project_id
           LEFT JOIN projects tp ON tp.id = mr.target_project_id
           LEFT JOIN agents a ON a.id = mr.author_id
           LEFT JOIN agents ra ON ra.id = mr.reviewer_id
           WHERE mr.id = $1 AND mr.target_project_id = $2`,
          [mrId, projectUuid],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Merge request not found." });
          return;
        }

        const mr = rows[0];

        // Fetch commit diffs for each commit in the MR
        const commitDiffs: Array<{
          commitId: string;
          message: string;
          authorAddress: string | null;
          filesChanged: number;
          linesAdded: number;
          linesRemoved: number;
          createdAt: string;
        }> = [];

        if (fileManager && Array.isArray(mr.commit_ids)) {
          for (const cid of mr.commit_ids) {
            const detail = await fileManager.getCommitDetail(cid);
            if (detail) {
              commitDiffs.push({
                commitId: detail.id,
                message: detail.message,
                authorAddress: detail.authorAddress,
                filesChanged: detail.filesChanged,
                linesAdded: detail.linesAdded,
                linesRemoved: detail.linesRemoved,
                createdAt: detail.createdAt,
              });
            }
          }
        }

        res.json({
          id: mr.id,
          sourceProjectId: mr.source_project_slug,
          targetProjectId: mr.target_project_slug,
          title: mr.title,
          description: mr.description,
          commitIds: mr.commit_ids,
          status: mr.status,
          reviewComment: mr.review_comment,
          mergedCommitId: mr.merged_commit_id,
          authorAddress: mr.author_address,
          authorName: mr.author_name ?? null,
          reviewerAddress: mr.reviewer_address ?? null,
          reviewerName: mr.reviewer_name ?? null,
          createdAt: mr.created_at,
          updatedAt: mr.updated_at,
          commits: commitDiffs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "merge-request-detail-failed", { projectId, mrId, error: message });
        res.status(500).json({ error: "Failed to get merge request details." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/merge-requests/:mrId/merge — Merge (target owner/admin only)
  // -------------------------------------------------------
  router.post(
    "/projects/:id/merge-requests/:mrId/merge",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id as string;
      const mrId = req.params.mrId as string;
      const { comment } = req.body;

      if (!fileManager) {
        res.status(500).json({ error: "File manager not available." });
        return;
      }

      try {
        // Check caller has admin/owner access to target project
        const access = await fileManager.getAccessLevel(projectId, agent.id);
        if (access < 2) {
          res.status(403).json({ error: "Only project owner or admin can merge." });
          return;
        }

        // Resolve project slug to UUID for merge_requests FK lookup
        const { rows: projLookup } = await pool.query(
          "SELECT id FROM projects WHERE project_id = $1",
          [projectId],
        );
        if (projLookup.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const projectUuid = projLookup[0].id as string;

        // Load merge request
        const { rows: mrRows } = await pool.query(
          `SELECT mr.id, mr.source_project_id, mr.target_project_id, mr.commit_ids,
                  mr.status, mr.title,
                  sp.project_id AS source_project_slug
           FROM merge_requests mr
           LEFT JOIN projects sp ON sp.id = mr.source_project_id
           WHERE mr.id = $1 AND mr.target_project_id = $2`,
          [mrId, projectUuid],
        );
        if (mrRows.length === 0) {
          res.status(404).json({ error: "Merge request not found." });
          return;
        }
        const mr = mrRows[0];

        if (mr.status !== "open") {
          res.status(400).json({ error: `Merge request is already ${mr.status}.` });
          return;
        }

        // For each commit in the MR, get file changes and apply to target project
        const allFiles: Array<{ path: string; content: string | null }> = [];
        const seen = new Set<string>();

        for (const commitId of mr.commit_ids) {
          const detail = await fileManager.getCommitDetail(commitId);
          if (!detail) continue;

          for (const change of detail.changes) {
            // Later commits override earlier ones for the same file
            if (seen.has(change.filePath)) {
              // Remove previous entry
              const idx = allFiles.findIndex((f) => f.path === change.filePath);
              if (idx !== -1) allFiles.splice(idx, 1);
            }
            seen.add(change.filePath);

            if (change.changeType === "delete") {
              allFiles.push({ path: change.filePath, content: null });
            } else {
              allFiles.push({ path: change.filePath, content: change.newContent });
            }
          }
        }

        if (allFiles.length === 0) {
          res.status(400).json({ error: "No file changes found in the referenced commits." });
          return;
        }

        // Commit to target project
        const commitResult = await fileManager.commitFiles(
          projectId,
          allFiles,
          `Merge: ${mr.title} (from ${mr.source_project_slug ?? mr.source_project_id})`,
          agent.id,
          agent.address,
        );

        // Update merge request status
        await pool.query(
          `UPDATE merge_requests
           SET status = 'merged', reviewer_id = $1, review_comment = $2,
               merged_commit_id = $3, updated_at = NOW()
           WHERE id = $4`,
          [agent.id, comment ?? null, commitResult.commitId, mrId],
        );

        // Log activity
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, (SELECT name FROM projects WHERE project_id = $1), 'merge_request_merged', $2, $3, $4)`,
          [
            projectId,
            agent.id,
            agent.address,
            JSON.stringify({
              mergeRequestId: mrId,
              title: mr.title,
              sourceProjectId: mr.source_project_slug ?? mr.source_project_id,
              mergedCommitId: commitResult.commitId,
              filesChanged: commitResult.filesChanged,
            }),
          ],
        );

        logSecurityEvent("info", "merge-request-merged", {
          mrId,
          projectId,
          mergedCommitId: commitResult.commitId,
          mergedBy: agent.id,
        });

        res.json({
          id: mrId,
          status: "merged",
          mergedCommitId: commitResult.commitId,
          filesChanged: commitResult.filesChanged,
          linesAdded: commitResult.linesAdded,
          linesRemoved: commitResult.linesRemoved,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "merge-request-merge-failed", { projectId, mrId, error: message });
        res.status(500).json({ error: "Failed to merge." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/merge-requests/:mrId/close — Close MR
  // -------------------------------------------------------
  router.post(
    "/projects/:id/merge-requests/:mrId/close",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id as string;
      const mrId = req.params.mrId as string;
      const { comment } = req.body;

      try {
        // Resolve project slug to UUID for merge_requests FK lookup
        const { rows: projLookup } = await pool.query(
          "SELECT id FROM projects WHERE project_id = $1",
          [projectId],
        );
        if (projLookup.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const projectUuid = projLookup[0].id as string;

        // Load merge request
        const { rows: mrRows } = await pool.query(
          `SELECT mr.id, mr.author_id, mr.target_project_id, mr.status, mr.title
           FROM merge_requests mr
           WHERE mr.id = $1 AND mr.target_project_id = $2`,
          [mrId, projectUuid],
        );
        if (mrRows.length === 0) {
          res.status(404).json({ error: "Merge request not found." });
          return;
        }
        const mr = mrRows[0];

        if (mr.status !== "open") {
          res.status(400).json({ error: `Merge request is already ${mr.status}.` });
          return;
        }

        // Must be target project owner/admin OR the MR author
        const isAuthor = mr.author_id === agent.id;
        let isAdmin = false;
        if (fileManager) {
          const access = await fileManager.getAccessLevel(projectId, agent.id);
          isAdmin = access >= 2;
        } else {
          const { rows: ownerCheck } = await pool.query(
            `SELECT agent_id FROM projects WHERE project_id = $1`,
            [projectId],
          );
          isAdmin = ownerCheck.length > 0 && ownerCheck[0].agent_id === agent.id;
        }

        if (!isAuthor && !isAdmin) {
          res.status(403).json({ error: "Only the MR author or target project owner/admin can close." });
          return;
        }

        await pool.query(
          `UPDATE merge_requests
           SET status = 'closed', reviewer_id = $1, review_comment = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [agent.id, comment ?? null, mrId],
        );

        // Log activity
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, (SELECT name FROM projects WHERE project_id = $1), 'merge_request_closed', $2, $3, $4)`,
          [
            projectId,
            agent.id,
            agent.address,
            JSON.stringify({ mergeRequestId: mrId, title: mr.title }),
          ],
        );

        logSecurityEvent("info", "merge-request-closed", { mrId, projectId, closedBy: agent.id });

        res.json({
          id: mrId,
          status: "closed",
          reviewComment: comment ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "merge-request-close-failed", { projectId, mrId, error: message });
        res.status(500).json({ error: "Failed to close merge request." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/import-url — Import files from public GitHub repo
  // -------------------------------------------------------
  router.post(
    "/projects/:id/import-url",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const projectId = req.params.id as string;
      const { url } = req.body;

      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required." });
        return;
      }

      if (!fileManager) {
        res.status(500).json({ error: "File manager not available." });
        return;
      }

      // Check caller has admin/owner access
      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Only project owner or admin can import." });
        return;
      }

      try {
        // Parse GitHub URL
        const ghMatch = url.match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
        if (!ghMatch) {
          res.status(400).json({ error: "URL must be a GitHub repository URL (e.g. github.com/owner/repo)." });
          return;
        }
        const owner = ghMatch[1];
        const repo = ghMatch[2].replace(/\.git$/, "");

        // Get default branch
        const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Nookplot-Gateway" },
          signal: AbortSignal.timeout(15000),
        });
        if (!repoResponse.ok) {
          res.status(400).json({ error: `GitHub repo not found or not public: ${owner}/${repo}` });
          return;
        }
        const repoData = await repoResponse.json() as { default_branch: string };
        const branch = repoData.default_branch || "main";

        // Get file tree
        const treeResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
          {
            headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Nookplot-Gateway" },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!treeResponse.ok) {
          res.status(400).json({ error: "Failed to read repository file tree." });
          return;
        }
        const treeData = await treeResponse.json() as {
          tree: Array<{ path: string; type: string; size?: number }>;
        };

        // Filter to blobs (files), skip too-large, limit count
        const MAX_FILES = 100;
        const MAX_SIZE = 1_048_576; // 1MB
        const fileEntries = treeData.tree
          .filter((e) => e.type === "blob" && (e.size ?? 0) <= MAX_SIZE)
          .slice(0, MAX_FILES);

        if (fileEntries.length === 0) {
          res.status(400).json({ error: "No importable files found in repository." });
          return;
        }

        // Fetch file contents
        const filesToCommit: Array<{ path: string; content: string }> = [];
        for (const entry of fileEntries) {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${entry.path}`;
            const fileResponse = await fetch(rawUrl, {
              signal: AbortSignal.timeout(10000),
            });
            if (!fileResponse.ok) continue;
            const content = await fileResponse.text();
            // Skip binary-looking content
            if (content.includes("\0")) continue;
            filesToCommit.push({ path: entry.path, content });
          } catch {
            // Skip files that fail to fetch
            continue;
          }
        }

        if (filesToCommit.length === 0) {
          res.status(400).json({ error: "No text files could be fetched from repository." });
          return;
        }

        // Commit all files (may need multiple commits if > 50 files)
        let totalFilesImported = 0;
        const commitResults = [];

        for (let i = 0; i < filesToCommit.length; i += 50) {
          const batch = filesToCommit.slice(i, i + 50);
          const batchNum = Math.floor(i / 50) + 1;
          const totalBatches = Math.ceil(filesToCommit.length / 50);
          const msg = totalBatches > 1
            ? `Import from ${owner}/${repo} (batch ${batchNum}/${totalBatches})`
            : `Import from ${owner}/${repo}`;

          const result = await fileManager.commitFiles(
            projectId,
            batch,
            msg,
            agent.id,
            agent.address,
          );
          commitResults.push(result);
          totalFilesImported += batch.length;
        }

        // Log activity
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, (SELECT name FROM projects WHERE project_id = $1), 'files_imported', $2, $3, $4)`,
          [
            projectId,
            agent.id,
            agent.address,
            JSON.stringify({
              source: `github.com/${owner}/${repo}`,
              branch,
              filesImported: totalFilesImported,
              commits: commitResults.length,
            }),
          ],
        );

        logSecurityEvent("info", "project-import-url", {
          projectId,
          agentId: agent.id,
          source: `${owner}/${repo}`,
          filesImported: totalFilesImported,
        });

        res.json({
          filesImported: totalFilesImported,
          source: `github.com/${owner}/${repo}`,
          branch,
          commits: commitResults.map((r) => ({
            commitId: r.commitId,
            filesChanged: r.filesChanged,
            linesAdded: r.linesAdded,
            linesRemoved: r.linesRemoved,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "project-import-url-failed", {
          projectId,
          agentId: agent.id,
          url,
          error: message,
        });
        res.status(500).json({ error: "Failed to import from URL." });
      }
    },
  );

  return router;
}
