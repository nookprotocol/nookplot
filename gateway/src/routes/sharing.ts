/**
 * File sharing routes — create share links for gateway-hosted files.
 *
 * Nice-to-have feature: generates tokenized links for file access
 * with optional expiration and access count limits.
 *
 * @module routes/sharing
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import { randomBytes } from "crypto";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { FileManager } from "../services/fileManager.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

export function createSharingRouter(
  pool: pg.Pool,
  hmacSecret: string,
  fileManager: FileManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /projects/:id/share — Create share link
  // -------------------------------------------------------
  router.post(
    "/projects/:id/share",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { filePath, sharedWithAddress, expiresInHours, maxAccess } = req.body;

      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "filePath is required." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        res.status(403).json({ error: "Editor role or higher required to share files." });
        return;
      }

      // Verify file exists
      const file = await fileManager.readFile(projectId, filePath);
      if (!file) {
        res.status(404).json({ error: "File not found." });
        return;
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = expiresInHours
        ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
        : null;

      // Resolve sharedWith to agent ID if provided
      let sharedWithId: string | null = null;
      if (sharedWithAddress) {
        const { rows } = await pool.query(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [sharedWithAddress],
        );
        sharedWithId = rows.length > 0 ? rows[0].id : null;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO shared_files (token, project_id, file_path, shared_by, shared_with, expires_at, max_access)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [token, projectId, filePath, agent.id, sharedWithId, expiresAt, maxAccess ?? null],
        );

        res.status(201).json({
          id: rows[0].id,
          token,
          url: `/v1/shared/${token}`,
          filePath,
          expiresAt,
          maxAccess: maxAccess ?? null,
          createdAt: rows[0].created_at?.toISOString(),
        });

        // If shared with a specific agent, send proactive signal
        if (proactiveScheduler && sharedWithId && sharedWithId !== agent.id) {
          proactiveScheduler.handleReactiveSignal(sharedWithId, {
            signalType: "file_shared",
            senderAddress: agent.address,
            projectId,
            shareId: rows[0].id,
            messagePreview: `Shared file: ${filePath}`,
          }).catch(() => {});
        }

        // WebSocket broadcast if targeted share
        if (eventBroadcaster && sharedWithId && sharedWithId !== agent.id) {
          eventBroadcaster.broadcast(sharedWithId, {
            type: "project.file_shared",
            timestamp: new Date().toISOString(),
            data: {
              projectId, filePath, sharedBy: agent.address,
              token, channelSlug: `project-${projectId}`,
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-share-failed", { error: message });
        res.status(500).json({ error: "Failed to create share link." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /shared/:token — Access shared file
  // -------------------------------------------------------
  router.get(
    "/shared/:token",
    async (req: Request, res: Response): Promise<void> => {
      const token = req.params.token as string;

      try {
        const { rows } = await pool.query(
          `SELECT sf.*, pf.content, pf.language, pf.size_bytes
           FROM shared_files sf
           JOIN project_files pf ON pf.project_id = sf.project_id AND pf.file_path = sf.file_path
           WHERE sf.token = $1`,
          [token],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Share link not found or file no longer exists." });
          return;
        }

        const share = rows[0];

        // Check expiration
        if (share.expires_at && new Date(share.expires_at) < new Date()) {
          res.status(410).json({ error: "Share link has expired." });
          return;
        }

        // Check access count
        if (share.max_access && share.access_count >= share.max_access) {
          res.status(410).json({ error: "Maximum access count reached." });
          return;
        }

        // Increment access count
        await pool.query(
          `UPDATE shared_files SET access_count = access_count + 1 WHERE id = $1`,
          [share.id],
        );

        res.json({
          filePath: share.file_path,
          content: share.content,
          language: share.language,
          size: share.size_bytes,
          projectId: share.project_id,
          accessCount: share.access_count + 1,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "access-shared-file-failed", { error: message });
        res.status(500).json({ error: "Failed to access shared file." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /agents/me/shared-files — Files shared with me
  // -------------------------------------------------------
  router.get(
    "/agents/me/shared-files",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { rows } = await pool.query(
          `SELECT sf.id, sf.token, sf.project_id, sf.file_path, sf.expires_at,
                  sf.access_count, sf.max_access, sf.created_at,
                  a.address AS shared_by_address, a.display_name AS shared_by_name,
                  p.name AS project_name
           FROM shared_files sf
           JOIN agents a ON a.id = sf.shared_by
           LEFT JOIN projects p ON p.project_id = sf.project_id
           WHERE sf.shared_with = $1
           ORDER BY sf.created_at DESC`,
          [agent.id],
        );

        res.json({
          sharedFiles: rows.map(r => ({
            id: r.id,
            token: r.token,
            projectId: r.project_id,
            projectName: r.project_name ?? null,
            filePath: r.file_path,
            sharedByAddress: r.shared_by_address,
            sharedByName: r.shared_by_name ?? null,
            expiresAt: r.expires_at?.toISOString() ?? null,
            accessCount: r.access_count,
            maxAccess: r.max_access,
            createdAt: r.created_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-shared-files-failed", { error: message });
        res.status(500).json({ error: "Failed to list shared files." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /projects/:id/share/:token — Revoke share link
  // -------------------------------------------------------
  router.delete(
    "/projects/:id/share/:token",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const token = req.params.token as string;

      try {
        // Only sharer or admin can revoke
        const { rows } = await pool.query(
          `SELECT shared_by FROM shared_files WHERE token = $1 AND project_id = $2`,
          [token, projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Share link not found." });
          return;
        }

        const access = await fileManager.getAccessLevel(projectId, agent.id);
        if (rows[0].shared_by !== agent.id && access < 2) {
          res.status(403).json({ error: "Only the sharer or admin can revoke." });
          return;
        }

        await pool.query(
          `DELETE FROM shared_files WHERE token = $1 AND project_id = $2`,
          [token, projectId],
        );
        res.json({ revoked: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "revoke-share-failed", { error: message });
        res.status(500).json({ error: "Failed to revoke share link." });
      }
    },
  );

  return router;
}
