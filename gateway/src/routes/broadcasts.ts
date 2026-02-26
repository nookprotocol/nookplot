/**
 * Status broadcast and @mention routes for project collaboration.
 *
 * Provides project-level announcements, @mention parsing with proactive
 * signals to mentioned agents, and per-agent working status.
 *
 * @module routes/broadcasts
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { FileManager } from "../services/fileManager.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

// Match @0x followed by 40 hex chars
const MENTION_REGEX = /@(0x[a-fA-F0-9]{40})/g;

export function createBroadcastsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  fileManager: FileManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Helper: broadcast to project members
  async function broadcastToProjectMembers(
    projectId: string, excludeAgentId: string, event: RuntimeWsEvent,
  ): Promise<void> {
    if (!eventBroadcaster) return;
    try {
      const { rows } = await pool.query(
        `SELECT p.agent_id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id FROM project_collaborators pc
         JOIN projects p2 ON p2.id = pc.project_id WHERE p2.project_id = $1`,
        [projectId],
      );
      for (const { agent_id } of rows) {
        if (agent_id !== excludeAgentId) eventBroadcaster.broadcast(agent_id, event);
      }
    } catch { /* non-fatal */ }
  }

  // Helper: get all project member IDs
  async function getProjectMemberIds(projectId: string): Promise<string[]> {
    try {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id AS id FROM project_collaborators pc
         JOIN projects p2 ON p2.id = pc.project_id WHERE p2.project_id = $1`,
        [projectId],
      );
      return rows.map(r => r.id);
    } catch { return []; }
  }

  // -------------------------------------------------------
  //  POST /projects/:id/broadcasts — Create broadcast
  // -------------------------------------------------------
  router.post(
    "/projects/:id/broadcasts",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { body, type, metadata } = req.body;

      if (!body || typeof body !== "string" || body.length > 2000) {
        res.status(400).json({ error: "body is required (max 2000 chars)." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        res.status(403).json({ error: "Editor role or higher required to broadcast." });
        return;
      }

      // Parse @mentions from body
      const mentions: string[] = [];
      let match;
      while ((match = MENTION_REGEX.exec(body)) !== null) {
        mentions.push(match[1].toLowerCase());
      }

      const broadcastType = type || "update";

      try {
        const { rows } = await pool.query(
          `INSERT INTO project_broadcasts (project_id, author_id, author_address, type, body, mentions, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [projectId, agent.id, agent.address, broadcastType, body,
           mentions.length > 0 ? mentions : null, metadata ? JSON.stringify(metadata) : null],
        );

        const broadcastId = rows[0].id;

        res.status(201).json({
          id: broadcastId,
          projectId,
          type: broadcastType,
          body,
          mentions,
          authorAddress: agent.address,
          createdAt: rows[0].created_at?.toISOString(),
        });

        // WebSocket broadcast to all project members
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.broadcast",
          timestamp: new Date().toISOString(),
          data: {
            projectId, broadcastId, body: body.slice(0, 200),
            broadcastType, authorAddress: agent.address,
            mentions, channelSlug: `project-${projectId}`,
          },
        });

        // Proactive signal: project_status_update for all members
        if (proactiveScheduler) {
          const memberIds = await getProjectMemberIds(projectId);
          for (const memberId of memberIds) {
            if (memberId !== agent.id) {
              proactiveScheduler.handleReactiveSignal(memberId, {
                signalType: "project_status_update",
                senderAddress: agent.address,
                projectId,
                broadcastId,
                messagePreview: body.slice(0, 200),
              }).catch(() => {});
            }
          }
        }

        // Proactive signal: agent_mentioned for each @mentioned agent
        if (proactiveScheduler && mentions.length > 0) {
          for (const mentionedAddr of mentions) {
            const { rows: agentRows } = await pool.query(
              `SELECT id FROM agents WHERE LOWER(address) = $1`, [mentionedAddr],
            );
            if (agentRows.length > 0 && agentRows[0].id !== agent.id) {
              proactiveScheduler.handleReactiveSignal(agentRows[0].id, {
                signalType: "agent_mentioned",
                senderAddress: agent.address,
                projectId,
                broadcastId,
                messagePreview: body.slice(0, 200),
              }).catch(() => {});
            }
          }
        }

        // Activity log
        try {
          const { rows: projRows } = await pool.query(
            `SELECT name FROM projects WHERE project_id = $1`, [projectId],
          );
          await pool.query(
            `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
             VALUES ($1, $2, 'broadcast_posted', $3, $4, $5)`,
            [projectId, projRows[0]?.name ?? projectId, agent.id, agent.address,
             JSON.stringify({ broadcastId, type: broadcastType, preview: body.slice(0, 200), mentionCount: mentions.length })],
          );
        } catch { /* non-fatal */ }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-broadcast-failed", { error: message });
        res.status(500).json({ error: "Failed to create broadcast." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/broadcasts — List broadcasts
  // -------------------------------------------------------
  router.get(
    "/projects/:id/broadcasts",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT b.id, b.type, b.body, b.mentions, b.metadata, b.created_at,
                  b.author_address, a.display_name AS author_name
           FROM project_broadcasts b
           LEFT JOIN agents a ON a.id = b.author_id
           WHERE b.project_id = $1
           ORDER BY b.created_at DESC
           LIMIT $2 OFFSET $3`,
          [projectId, limit, offset],
        );

        res.json({
          broadcasts: rows.map(r => ({
            id: r.id,
            type: r.type,
            body: r.body,
            mentions: r.mentions ?? [],
            metadata: r.metadata ?? {},
            authorAddress: r.author_address,
            authorName: r.author_name ?? null,
            createdAt: r.created_at?.toISOString(),
          })),
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-broadcasts-failed", { error: message });
        res.status(500).json({ error: "Failed to list broadcasts." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /projects/:id/status — Set working status
  // -------------------------------------------------------
  router.put(
    "/projects/:id/status",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { status } = req.body;

      if (!status || typeof status !== "string" || status.length > 200) {
        res.status(400).json({ error: "status is required (max 200 chars)." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 0) {
        res.status(403).json({ error: "Must be a project collaborator." });
        return;
      }

      try {
        await pool.query(
          `INSERT INTO agent_project_status (agent_id, project_id, status, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (agent_id, project_id) DO UPDATE SET status = $3, updated_at = NOW()`,
          [agent.id, projectId, status],
        );
        res.json({ updated: true, status });

        // Notify project members about status change
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.status_updated",
          timestamp: new Date().toISOString(),
          data: { projectId, agentAddress: agent.address, status },
        });
        if (proactiveScheduler) {
          const { rows: memberRows } = await pool.query(
            `SELECT agent_id FROM project_collaborators WHERE project_id = $1 AND agent_id != $2`,
            [projectId, agent.id],
          );
          for (const { agent_id: memberId } of memberRows) {
            proactiveScheduler.handleReactiveSignal(memberId, {
              signalType: "status_updated",
              projectId,
              senderAddress: agent.address,
              messagePreview: `Status: ${status}`,
            }).catch(() => {});
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "set-status-failed", { error: message });
        res.status(500).json({ error: "Failed to update status." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/status — Get all collaborator statuses
  // -------------------------------------------------------
  router.get(
    "/projects/:id/status",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT s.status, s.updated_at, a.address, a.display_name
           FROM agent_project_status s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.project_id = $1
           ORDER BY s.updated_at DESC`,
          [projectId],
        );

        res.json({
          statuses: rows.map(r => ({
            address: r.address,
            displayName: r.display_name ?? null,
            status: r.status,
            updatedAt: r.updated_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-statuses-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve statuses." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /agents/me/mentions — My mentions across all projects
  // -------------------------------------------------------
  router.get(
    "/agents/me/mentions",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      try {
        const { rows } = await pool.query(
          `SELECT b.id, b.project_id, b.body, b.type, b.created_at,
                  b.author_address, a.display_name AS author_name,
                  p.name AS project_name
           FROM project_broadcasts b
           LEFT JOIN agents a ON a.id = b.author_id
           LEFT JOIN projects p ON p.project_id = b.project_id
           WHERE $1 = ANY(b.mentions)
           ORDER BY b.created_at DESC
           LIMIT $2`,
          [agent.address.toLowerCase(), limit],
        );

        res.json({
          mentions: rows.map(r => ({
            broadcastId: r.id,
            projectId: r.project_id,
            projectName: r.project_name ?? null,
            body: r.body,
            type: r.type,
            authorAddress: r.author_address,
            authorName: r.author_name ?? null,
            createdAt: r.created_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-mentions-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve mentions." });
      }
    },
  );

  return router;
}
