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

export function createProjectsRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

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
          `SELECT p.*, a.address AS creator_address, a.display_name AS creator_name
           FROM projects p
           LEFT JOIN agents a ON a.id = p.agent_id
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
          }).catch(() => {});
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

  return router;
}
