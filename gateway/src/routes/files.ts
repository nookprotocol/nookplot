/**
 * Gateway-hosted file operations, commit history, and code review routes.
 *
 * Provides file CRUD without GitHub, atomic multi-file commits,
 * commit review system with approval thresholds, and export to GitHub.
 *
 * All endpoints require authentication. Write operations require
 * project owner or collaborator role.
 *
 * @module routes/files
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { FileManager } from "../services/fileManager.js";
import type { GitHubClient } from "../services/githubClient.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

// ============================================================
//  Types
// ============================================================

interface GitHubCredentialRecord {
  agent_id: string;
  github_username: string;
  encrypted_pat: string;
  pat_iv: string;
  pat_auth_tag: string;
  scopes: string[];
}

// ============================================================
//  Route Factory
// ============================================================

export function createFilesRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  githubClient: GitHubClient,
  hmacSecret: string,
  fileManager: FileManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Helper: broadcast event to project owner + collaborators (excluding the actor)
  async function broadcastToProjectMembers(
    projectId: string, excludeAgentId: string, event: RuntimeWsEvent,
  ): Promise<void> {
    if (!eventBroadcaster) return;
    try {
      const { rows } = await pool.query(
        `SELECT p.agent_id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id FROM project_collaborators pc WHERE pc.project_id = $1`,
        [projectId],
      );
      for (const { agent_id } of rows) {
        if (agent_id !== excludeAgentId) eventBroadcaster.broadcast(agent_id, event);
      }
    } catch { /* non-fatal — don't break the response */ }
  }

  // Helper: parse owner/repo from a project's repo_url
  function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  // Helper: decrypt PAT
  async function getDecryptedPAT(agentId: string): Promise<{ pat: string; username: string } | null> {
    const { rows } = await pool.query<GitHubCredentialRecord>(
      "SELECT * FROM github_credentials WHERE agent_id = $1",
      [agentId],
    );
    if (rows.length === 0) return null;
    const cred = rows[0];
    try {
      const pat = githubClient.decryptPAT(cred.encrypted_pat, cred.pat_iv, cred.pat_auth_tag);
      return { pat, username: cred.github_username };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------
  //  GET /v1/projects/:id/gateway-files — List files
  // -------------------------------------------------------
  router.get(
    "/projects/:id/gateway-files",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      try {
        const files = await fileManager.listFiles(projectId);
        res.json({ files, total: files.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/gateway-files/* — Read file
  // -------------------------------------------------------
  router.get(
    "/projects/:id/gateway-files/*",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      // Express wildcard: everything after /gateway-files/
      const filePath = (req.params as Record<string, string>)[0];
      if (!filePath) {
        res.status(400).json({ error: "File path is required." });
        return;
      }

      try {
        const file = await fileManager.readFile(projectId, filePath);
        if (!file) {
          res.status(404).json({ error: "File not found." });
          return;
        }
        res.json(file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/gateway-commit — Commit files
  // -------------------------------------------------------
  router.post(
    "/projects/:id/gateway-commit",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { files, message } = req.body;

      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "files array is required." });
        return;
      }
      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "message is required." });
        return;
      }

      // Validate each file entry
      for (const f of files) {
        if (!f.path || typeof f.path !== "string") {
          res.status(400).json({ error: "Each file must have a path." });
          return;
        }
        if (f.content !== null && f.content !== undefined && typeof f.content !== "string") {
          res.status(400).json({ error: `File "${f.path}": content must be a string or null.` });
          return;
        }
      }

      // Check access
      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        // -1 = no access/project not found, 0 = viewer (can't write)
        if (access === -1) {
          res.status(404).json({ error: "Project not found or you don't have access." });
        } else {
          res.status(403).json({ error: "Viewers cannot commit files. Need Editor role or higher." });
        }
        return;
      }

      try {
        const result = await fileManager.commitFiles(
          projectId,
          files.map((f: { path: string; content?: string | null }) => ({
            path: f.path,
            content: f.content ?? null,
          })),
          message,
          agent.id,
          agent.address,
        );
        res.status(201).json(result);

        // Broadcast to project owner + collaborators
        const { rows: projDesc } = await pool.query(
          `SELECT description FROM projects WHERE project_id = $1`, [projectId],
        ).catch(() => ({ rows: [] }));
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.files_committed",
          timestamp: new Date().toISOString(),
          data: {
            projectId, commitId: result.commitId, message,
            filesChanged: result.filesChanged, linesAdded: result.linesAdded,
            linesRemoved: result.linesRemoved, author: agent.address,
            projectDescription: projDesc[0]?.description ?? null,
            channelSlug: `project-${projectId}`,
          },
        });

        // Also notify via proactive scheduler (so offline agents get the signal)
        if (proactiveScheduler) {
          try {
            const { rows: memberRows } = await pool.query<{ id: string }>(
              `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
               UNION
               SELECT pc.agent_id AS id FROM project_collaborators pc
               JOIN projects p ON p.id = pc.project_id WHERE p.project_id = $1`,
              [projectId],
            );
            for (const { id } of memberRows) {
              if (id !== agent.id) {
                proactiveScheduler.handleReactiveSignal(id, {
                  signalType: "files_committed",
                  senderAddress: agent.address,
                  projectId, commitId: result.commitId,
                  messagePreview: `${agent.address.slice(0, 10)} committed: ${message.slice(0, 100)}`,
                }).catch(() => {});
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "gateway-commit-failed", {
          agentId: agent.id, projectId, error: msg,
        });
        if (msg.includes("Secret detected")) {
          res.status(400).json({ error: msg });
          return;
        }
        if (msg.includes("limit") || msg.includes("exceed") || msg.includes("Invalid path") || msg.includes("required")) {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg || "Failed to commit files." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/projects/:id/gateway-files/* — Delete file
  // -------------------------------------------------------
  router.delete(
    "/projects/:id/gateway-files/*",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const filePath = (req.params as Record<string, string>)[0];
      if (!filePath) {
        res.status(400).json({ error: "File path is required." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        res.status(403).json({ error: "Insufficient access to delete files." });
        return;
      }

      try {
        await fileManager.deleteFile(projectId, filePath, agent.id, agent.address);
        res.json({ deleted: true, path: filePath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits — Commit history
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      try {
        const commits = await fileManager.getCommitHistory(projectId, limit, offset);
        res.json({ commits, limit, offset });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId — Commit detail
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const commitId = req.params.commitId as string;

      try {
        const detail = await fileManager.getCommitDetail(commitId);
        if (!detail) {
          res.status(404).json({ error: "Commit not found." });
          return;
        }
        res.json(detail);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/commits/:commitId/review — Submit review
  // -------------------------------------------------------
  router.post(
    "/projects/:id/commits/:commitId/review",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const commitId = req.params.commitId as string;
      const { verdict, body } = req.body;

      if (!verdict || typeof verdict !== "string") {
        res.status(400).json({ error: "verdict is required (approve, request_changes, or comment)." });
        return;
      }

      try {
        const review = await fileManager.submitReview(
          commitId,
          agent.id,
          agent.address,
          verdict,
          body,
        );
        res.status(201).json(review);

        // Notify commit author that their code was reviewed
        try {
          const { rows: commitRows } = await pool.query<{ author_id: string; project_id: string }>(
            `SELECT fc.author_id, fc.project_id FROM file_commits fc WHERE fc.id = $1`,
            [commitId],
          );
          if (commitRows.length > 0 && commitRows[0].author_id !== agent.id) {
            // WebSocket broadcast (for online agents)
            if (eventBroadcaster) {
              eventBroadcaster.broadcast(commitRows[0].author_id, {
                type: "project.review_submitted",
                timestamp: new Date().toISOString(),
                data: {
                  projectId: commitRows[0].project_id, commitId,
                  reviewer: agent.address, reviewerName: review.reviewerName,
                  verdict, channelSlug: `project-${commitRows[0].project_id}`,
                },
              });
            }

            // Proactive scheduler (for offline agents)
            if (proactiveScheduler) {
              proactiveScheduler.handleReactiveSignal(commitRows[0].author_id, {
                signalType: "review_submitted",
                senderAddress: agent.address,
                projectId: commitRows[0].project_id, commitId,
                messagePreview: `${verdict} review from ${agent.address.slice(0, 10)} on commit ${commitId.slice(0, 8)}`,
              }).catch(() => {});
            }
          }
        } catch { /* non-fatal */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found") || msg.includes("Cannot review")) {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId/reviews — List reviews
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId/reviews",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const commitId = req.params.commitId as string;

      try {
        const reviews = await fileManager.getReviews(commitId);
        res.json({ reviews, total: reviews.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/activity — Project activity feed
  // -------------------------------------------------------
  router.get(
    "/projects/:id/activity",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      try {
        const activity = await fileManager.getProjectActivity(projectId, limit);
        res.json({ activity, total: activity.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/export-github — Export to GitHub
  // -------------------------------------------------------
  router.post(
    "/projects/:id/export-github",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;

      try {
        const result = await fileManager.exportToGithub(
          projectId,
          agent.id,
          agent.address,
          getDecryptedPAT,
          parseRepoUrl,
        );
        res.json(result);

        // Notify collaborators about export
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.exported_to_github",
          timestamp: new Date().toISOString(),
          data: { projectId, ...result, exportedBy: agent.address,
                  channelSlug: `project-${projectId}` },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "export-github-failed", {
          agentId: agent.id, projectId, error: msg,
        });
        if (msg.includes("not connected") || msg.includes("Only project")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg || "Failed to export to GitHub." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/activity — Global project activity feed
  // -------------------------------------------------------
  // Public endpoint — project activity is non-sensitive data and needs
  // to be accessible on the homepage dashboard without an API key.
  router.get(
    "/activity",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      try {
        const activity = await fileManager.getGlobalActivity(limit);
        res.json({ activity, total: activity.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  return router;
}
