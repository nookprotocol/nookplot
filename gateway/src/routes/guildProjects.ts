/**
 * Guild-Project association routes.
 *
 * Links projects to guilds. Any approved guild member who owns
 * a project can link it. The original linker or guild proposer can unlink.
 *
 * POST   /v1/guilds/:id/projects              — Link a project to a guild
 * DELETE /v1/guilds/:id/projects/:projectId    — Unlink a project from a guild
 * GET    /v1/guilds/:id/projects               — List projects linked to a guild
 * GET    /v1/projects/:id/guilds               — List guilds linked to a project
 *
 * @module routes/guildProjects
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createGuildProjectsRouter(
  pool: pg.Pool,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/guilds/:id/projects — Link a project to a guild
  // -------------------------------------------------------
  router.post(
    "/guilds/:id/projects",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const guildId = req.params.id;
      const { projectId } = req.body;

      if (!projectId || typeof projectId !== "string") {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      try {
        // Resolve guild entity ID from numeric guild_id
        const { rows: guildRows } = await pool.query(
          `SELECT id, guild_id, proposer_id FROM idx_guilds WHERE guild_id = $1`,
          [guildId],
        );
        if (guildRows.length === 0) {
          res.status(404).json({ error: "Guild not found." });
          return;
        }
        const guild = guildRows[0];
        const guildEntityId = guild.id as string;

        // Verify caller is an approved guild member (status=2)
        // NOTE: idx_guild_members.guild_id is the hex entity ID (e.g. "0x0a"),
        // NOT the numeric guild_id. Must use guildEntityId here.
        const { rows: memberRows } = await pool.query(
          `SELECT member_id FROM idx_guild_members
           WHERE guild_id = $1 AND LOWER(member_id) = LOWER($2) AND status = 2`,
          [guildEntityId, agent.address],
        );
        if (memberRows.length === 0) {
          res.status(403).json({ error: "You must be an approved guild member to link projects." });
          return;
        }

        // Verify project exists and caller is the owner
        const { rows: projectRows } = await pool.query(
          `SELECT id, project_id, name, agent_id FROM projects WHERE project_id = $1 AND status = 'active'`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const project = projectRows[0];
        if (project.agent_id !== agent.id) {
          res.status(403).json({ error: "Only the project owner can link it to a guild." });
          return;
        }

        // Insert link (idempotent)
        const { rowCount } = await pool.query(
          `INSERT INTO guild_projects (guild_id, project_id, linked_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (guild_id, project_id) DO NOTHING`,
          [guildEntityId, project.id, agent.id],
        );

        const status = rowCount && rowCount > 0 ? 201 : 200;
        logSecurityEvent("info", "guild-project-linked", {
          guildId,
          projectId,
          linkedBy: agent.id,
        });

        res.status(status).json({
          message: status === 201 ? "Project linked to guild." : "Project already linked.",
          guildId,
          projectId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "guild-project-link-failed", { error: message });
        res.status(500).json({ error: "Failed to link project to guild." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/guilds/:id/projects/:projectId — Unlink a project
  // -------------------------------------------------------
  router.delete(
    "/guilds/:id/projects/:projectId",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const guildId = req.params.id;
      const projectId = req.params.projectId;

      try {
        // Resolve guild
        const { rows: guildRows } = await pool.query(
          `SELECT id, guild_id, proposer_id FROM idx_guilds WHERE guild_id = $1`,
          [guildId],
        );
        if (guildRows.length === 0) {
          res.status(404).json({ error: "Guild not found." });
          return;
        }
        const guild = guildRows[0];
        const guildEntityId = guild.id as string;

        // Resolve project
        const { rows: projectRows } = await pool.query(
          `SELECT id FROM projects WHERE project_id = $1`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        // Check link exists and get linked_by
        const { rows: linkRows } = await pool.query(
          `SELECT id, linked_by FROM guild_projects WHERE guild_id = $1 AND project_id = $2`,
          [guildEntityId, projectRows[0].id],
        );
        if (linkRows.length === 0) {
          res.status(404).json({ error: "Project is not linked to this guild." });
          return;
        }

        // Must be original linker OR guild proposer
        const isLinker = linkRows[0].linked_by === agent.id;
        const isProposer = guild.proposer_id && guild.proposer_id.toLowerCase() === agent.address.toLowerCase();
        if (!isLinker && !isProposer) {
          res.status(403).json({ error: "Only the original linker or guild proposer can unlink." });
          return;
        }

        await pool.query(`DELETE FROM guild_projects WHERE id = $1`, [linkRows[0].id]);

        logSecurityEvent("info", "guild-project-unlinked", {
          guildId,
          projectId,
          unlinkedBy: agent.id,
        });

        res.json({ message: "Project unlinked from guild." });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "guild-project-unlink-failed", { error: message });
        res.status(500).json({ error: "Failed to unlink project from guild." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/guilds/:id/projects — List projects linked to a guild
  // -------------------------------------------------------
  router.get(
    "/guilds/:id/projects",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const guildId = req.params.id;
      const limit = Math.min(parseInt(String(req.query.limit ?? "25"), 10) || 25, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

      try {
        // Resolve guild
        const { rows: guildRows } = await pool.query(
          `SELECT id FROM idx_guilds WHERE guild_id = $1`,
          [guildId],
        );
        if (guildRows.length === 0) {
          res.status(404).json({ error: "Guild not found." });
          return;
        }
        const guildEntityId = guildRows[0].id as string;

        const [{ rows }, { rows: countRows }] = await Promise.all([
          pool.query(
            `SELECT p.project_id, p.name, p.description, p.languages, p.tags, p.status, p.created_at,
                    p.guild_id,
                    a.address AS creator_address, a.display_name AS creator_name,
                    gp.created_at AS linked_at,
                    ig_attr.name AS guild_name,
                    COALESCE(task_stats.total, 0) AS total_tasks,
                    COALESCE(task_stats.completed, 0) AS completed_tasks,
                    COALESCE(task_stats.in_progress, 0) AS in_progress_tasks,
                    recent_activity.last_activity_at
             FROM guild_projects gp
             JOIN projects p ON p.id = gp.project_id
             LEFT JOIN agents a ON a.id = p.agent_id
             LEFT JOIN idx_guilds ig_attr ON CAST(ig_attr.guild_id AS TEXT) = p.guild_id
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS total,
                      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress
               FROM project_tasks WHERE project_id = p.project_id
             ) task_stats ON TRUE
             LEFT JOIN LATERAL (
               SELECT MAX(created_at) AS last_activity_at
               FROM project_activity WHERE project_id = p.project_id
             ) recent_activity ON TRUE
             WHERE gp.guild_id = $1
             ORDER BY gp.created_at DESC
             LIMIT $2 OFFSET $3`,
            [guildEntityId, limit, offset],
          ),
          pool.query(
            `SELECT COUNT(*)::int AS total FROM guild_projects WHERE guild_id = $1`,
            [guildEntityId],
          ),
        ]);

        res.json({
          projects: rows.map((r) => ({
            projectId: r.project_id,
            name: r.name,
            description: r.description,
            languages: r.languages,
            tags: r.tags,
            status: r.status,
            createdAt: r.created_at,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name,
            linkedAt: r.linked_at,
            guildId: r.guild_id,
            guildName: r.guild_name,
            totalTasks: r.total_tasks,
            completedTasks: r.completed_tasks,
            inProgressTasks: r.in_progress_tasks,
            lastActivityAt: r.last_activity_at,
          })),
          total: countRows[0]?.total ?? 0,
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "guild-projects-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list guild projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/guilds — List guilds linked to a project
  // -------------------------------------------------------
  router.get(
    "/projects/:id/guilds",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id;

      try {
        // Resolve project
        const { rows: projectRows } = await pool.query(
          `SELECT id FROM projects WHERE project_id = $1`,
          [projectId],
        );
        if (projectRows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        const { rows } = await pool.query(
          `SELECT ig.guild_id, ig.name, ig.status,
                  COUNT(DISTINCT igm.member_id)::int AS member_count,
                  gp.created_at AS linked_at
           FROM guild_projects gp
           JOIN idx_guilds ig ON ig.id = gp.guild_id
           LEFT JOIN idx_guild_members igm ON igm.guild_id = ig.id AND igm.status = 2
           WHERE gp.project_id = $1
           GROUP BY ig.guild_id, ig.name, ig.status, gp.created_at
           ORDER BY gp.created_at DESC`,
          [projectRows[0].id],
        );

        res.json({
          guilds: rows.map((r) => ({
            guildId: r.guild_id,
            name: r.name,
            status: r.status,
            memberCount: r.member_count,
            linkedAt: r.linked_at,
          })),
          total: rows.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "project-guilds-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list project guilds." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/guilds/:id/members/expertise — Member expertise across guild projects
  // -------------------------------------------------------
  router.get(
    "/guilds/:id/members/expertise",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const guildId = req.params.id;

      try {
        // Resolve guild
        const { rows: guildRows } = await pool.query(
          `SELECT id, guild_id FROM idx_guilds WHERE guild_id = $1`,
          [guildId],
        );
        if (guildRows.length === 0) {
          res.status(404).json({ error: "Guild not found." });
          return;
        }
        const guildEntityId = guildRows[0].id as string;

        // Get accepted members (status=2)
        // NOTE: idx_guild_members.guild_id is a TEXT entity ID (e.g. "0x05"),
        // NOT the numeric guild_id. Use guildEntityId (the `id` field).
        const { rows: memberRows } = await pool.query(
          `SELECT DISTINCT LOWER(igm.member_id) AS member_address
           FROM idx_guild_members igm
           WHERE igm.guild_id = $1 AND igm.status = 2`,
          [guildEntityId],
        );

        if (memberRows.length === 0) {
          res.json({ members: [] });
          return;
        }

        const memberAddresses = memberRows.map((r) => r.member_address as string);

        // Batch-fetch expertise tags for all members
        const { rows: expertiseRows } = await pool.query(
          `SELECT a.address, et.tag, et.confidence, et.source,
                  COALESCE(et.category, et.source) AS category,
                  COALESCE(et.verification_level, 'inferred') AS verification_level,
                  COALESCE(et.evidence_count, 0)::int AS evidence_count
           FROM expertise_tags et
           JOIN agents a ON a.id = et.agent_id
           WHERE LOWER(a.address) = ANY($1)
           ORDER BY et.confidence DESC`,
          [memberAddresses],
        );

        // Batch-fetch self-declared capabilities from agents table
        const { rows: capRows } = await pool.query(
          `SELECT LOWER(a.address) AS address, a.capabilities
           FROM agents a
           WHERE LOWER(a.address) = ANY($1)
             AND a.capabilities IS NOT NULL`,
          [memberAddresses],
        );

        // Batch-fetch task assignment counts across guild-linked projects
        const { rows: taskRows } = await pool.query(
          `SELECT LOWER(pt.assigned_address) AS member_address,
                  COUNT(*)::int AS tasks_assigned,
                  COUNT(*) FILTER (WHERE pt.status = 'completed')::int AS tasks_completed
           FROM project_tasks pt
           JOIN projects p ON p.project_id = pt.project_id
           JOIN guild_projects gp ON gp.project_id = p.id
           WHERE gp.guild_id = $1
             AND LOWER(pt.assigned_address) = ANY($2)
           GROUP BY LOWER(pt.assigned_address)`,
          [guildEntityId, memberAddresses],
        );

        // Build lookup maps
        const expertiseMap = new Map<string, Array<{
          tag: string; confidence: number; source: string;
          category: string; verificationLevel: string; evidenceCount: number;
        }>>();
        for (const r of expertiseRows) {
          const addr = (r.address as string).toLowerCase();
          if (!expertiseMap.has(addr)) expertiseMap.set(addr, []);
          expertiseMap.get(addr)!.push({
            tag: r.tag,
            confidence: r.confidence,
            source: r.source,
            category: r.category,
            verificationLevel: r.verification_level,
            evidenceCount: r.evidence_count,
          });
        }

        // Merge self-declared capabilities as fallback expertise tags
        for (const r of capRows) {
          const addr = r.address as string;
          const caps = r.capabilities as string[] | null;
          if (!Array.isArray(caps) || caps.length === 0) continue;
          const existing = expertiseMap.get(addr) ?? [];
          const existingTags = new Set(existing.map((e) => e.tag.toLowerCase()));
          for (const cap of caps) {
            if (!cap || existingTags.has(cap.toLowerCase())) continue;
            existing.push({
              tag: cap,
              confidence: 0.5,
              source: "self_declared",
              category: "capability",
              verificationLevel: "self_reported",
              evidenceCount: 0,
            });
            existingTags.add(cap.toLowerCase());
          }
          if (existing.length > 0) expertiseMap.set(addr, existing);
        }

        const taskMap = new Map<string, { assigned: number; completed: number }>();
        for (const r of taskRows) {
          taskMap.set(r.member_address, {
            assigned: r.tasks_assigned,
            completed: r.tasks_completed,
          });
        }

        // Assemble response
        const members = memberAddresses.map((addr) => ({
          address: addr,
          expertiseTags: expertiseMap.get(addr) ?? [],
          tasksAssigned: taskMap.get(addr)?.assigned ?? 0,
          tasksCompleted: taskMap.get(addr)?.completed ?? 0,
        }));

        // Sort by total tasks assigned descending, then by expertise tag count
        members.sort((a, b) =>
          b.tasksAssigned - a.tasksAssigned || b.expertiseTags.length - a.expertiseTags.length,
        );

        res.json({ members });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "guild-member-expertise-failed", { error: message });
        res.status(500).json({ error: "Failed to load member expertise." });
      }
    },
  );

  return router;
}
