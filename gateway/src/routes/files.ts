/**
 * Gateway-hosted file operations, commit history, and code review routes.
 *
 * Provides file CRUD without GitHub, atomic multi-file commits,
 * commit review system with approval thresholds, and export to GitHub.
 *
 * All GET endpoints are public (project existence check only).
 * Write operations (POST/PATCH/DELETE) require authentication
 * and editor role or higher.
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
  //  GET /v1/projects/:id/gateway-files — List files (public)
  // -------------------------------------------------------
  // Public endpoint — file names/sizes/languages are non-sensitive metadata.
  // Actual file content (the wildcard route below) remains authenticated.
  router.get(
    "/projects/:id/gateway-files",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      try {
        // Verify project exists (no auth context to lean on)
        const { rows } = await pool.query(
          "SELECT 1 FROM projects WHERE project_id = $1",
          [projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }
        const files = await fileManager.listFiles(projectId);
        res.json({ files, total: files.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-files-failed", { error: message });
        res.status(500).json({ error: "Failed to list files." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/gateway-files/* — Read file (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/gateway-files/*",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      // Express wildcard: everything after /gateway-files/
      const filePath = (req.params as Record<string, string>)[0];
      if (!filePath) {
        res.status(400).json({ error: "File path is required." });
        return;
      }

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "read-file-failed", { error: message });
        res.status(500).json({ error: "Failed to read file." });
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
      const { files, message, parentCommitId } = req.body;

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

      // Check access (supports open lab mode — any registered agent can commit)
      const commitCheck = await fileManager.canCommit(projectId, agent.id);
      if (!commitCheck.allowed) {
        const status = commitCheck.reason?.includes("not found") ? 404 : 403;
        res.status(status).json({ error: commitCheck.reason });
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
          parentCommitId ?? null,
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
                }).catch((err) => {
                  logSecurityEvent("debug", "reactive-signal-failed", { signalType: "files_committed", error: (err as Error).message });
                });
              }
            }
          } catch { /* non-fatal */ }
        }

        // Task-commit auto-linking: emit task_completed + milestone_reached signals
        const linkedTasks = fileManager.consumeLinkedTasks();
        if (linkedTasks.length > 0 && proactiveScheduler) {
          try {
            const { rows: memberRows2 } = await pool.query<{ id: string }>(
              `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
               UNION
               SELECT pc.agent_id AS id FROM project_collaborators pc
               JOIN projects p ON p.id = pc.project_id WHERE p.project_id = $1`,
              [projectId],
            );
            for (const task of linkedTasks) {
              // Broadcast task_completed
              broadcastToProjectMembers(projectId, agent.id, {
                type: "project.task_completed",
                timestamp: new Date().toISOString(),
                data: { projectId, taskId: task.taskId, title: task.title, completedBy: agent.address, linkedCommitId: result.commitId },
              });
              for (const { id } of memberRows2) {
                if (id !== agent.id) {
                  proactiveScheduler.handleReactiveSignal(id, {
                    signalType: "task_completed",
                    senderAddress: agent.address,
                    projectId, taskId: task.taskId,
                    messagePreview: `Completed via commit: ${task.title}`,
                  }).catch((err) => {
                    logSecurityEvent("debug", "reactive-signal-failed", { signalType: "task_completed", error: (err as Error).message });
                  });
                }
              }

              // Check milestone completion
              if (task.milestoneId) {
                const { rows: remaining } = await pool.query(
                  `SELECT COUNT(*) FILTER (WHERE status != 'completed') AS cnt
                   FROM project_tasks WHERE milestone_id = $1`,
                  [task.milestoneId],
                );
                if (Number(remaining[0].cnt) === 0) {
                  await pool.query(
                    `UPDATE project_milestones SET status = 'completed', completed_at = NOW(), updated_at = NOW()
                     WHERE id = $1 AND status != 'completed'`,
                    [task.milestoneId],
                  );
                  const { rows: msRows } = await pool.query(
                    `SELECT title FROM project_milestones WHERE id = $1`, [task.milestoneId],
                  );
                  broadcastToProjectMembers(projectId, agent.id, {
                    type: "project.milestone_reached",
                    timestamp: new Date().toISOString(),
                    data: { projectId, milestoneId: task.milestoneId, title: msRows[0]?.title, completedBy: agent.address },
                  });
                  for (const { id } of memberRows2) {
                    proactiveScheduler.handleReactiveSignal(id, {
                      signalType: "milestone_reached",
                      senderAddress: agent.address,
                      projectId, milestoneId: task.milestoneId,
                      messagePreview: `Milestone completed: ${msRows[0]?.title}`,
                    }).catch((err) => {
                      logSecurityEvent("debug", "reactive-signal-failed", { signalType: "milestone_reached", error: (err as Error).message });
                    });
                  }
                }
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
        res.status(500).json({ error: "Failed to commit files." });
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "delete-file-failed", { error: message });
        res.status(500).json({ error: "Failed to delete file." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits — Commit history (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const commits = await fileManager.getCommitHistory(projectId, limit, offset);
        res.json({ commits, limit, offset });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-commits-failed", { error: message });
        res.status(500).json({ error: "Failed to list commits." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/leaves — Frontier commits (public)
  //  MUST be before commits/:commitId to avoid "leaves" matching as a commitId.
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/leaves",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1", [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const leaves = await fileManager.getLeafCommits(projectId, limit);
        res.json({ leaves, total: leaves.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-leaf-commits-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve leaf commits." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId — Commit detail (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const commitId = req.params.commitId as string;

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const detail = await fileManager.getCommitDetail(commitId);
        if (!detail) {
          res.status(404).json({ error: "Commit not found." });
          return;
        }
        res.json(detail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-commit-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve commit." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId/children — Commit children (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId/children",
    async (req: Request, res: Response): Promise<void> => {
      const commitId = req.params.commitId as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      try {
        const children = await fileManager.getCommitChildren(commitId, limit);
        res.json({ children, total: children.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-commit-children-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve commit children." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId/lineage — Commit ancestry (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId/lineage",
    async (req: Request, res: Response): Promise<void> => {
      const commitId = req.params.commitId as string;
      const maxDepth = Math.min(parseInt(String(req.query.maxDepth ?? "50"), 10), 100);

      try {
        const lineage = await fileManager.getCommitLineage(commitId, maxDepth);
        res.json({ lineage, total: lineage.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-commit-lineage-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve commit lineage." });
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
      const { verdict, body, comments } = req.body;

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

        // Insert inline review comments if provided
        let commentCount = 0;
        let hasSuggestions = false;
        if (Array.isArray(comments) && comments.length > 0) {
          for (const c of comments) {
            if (!c.filePath || !c.body) continue;
            await pool.query(
              `INSERT INTO review_comments (commit_id, review_id, author_id, author_address, file_path, line_start, line_end, body, suggestion)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [commitId, review.id, agent.id, agent.address, c.filePath,
               c.lineStart ?? null, c.lineEnd ?? null, c.body, c.suggestion ?? null],
            );
            commentCount++;
            if (c.suggestion) hasSuggestions = true;
          }
        }

        res.status(201).json({ ...review, commentCount, hasSuggestions });

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
                  verdict, commentCount, hasSuggestions,
                  channelSlug: `project-${commitRows[0].project_id}`,
                },
              });
            }

            // Proactive scheduler (for offline agents)
            if (proactiveScheduler) {
              proactiveScheduler.handleReactiveSignal(commitRows[0].author_id, {
                signalType: "review_submitted",
                senderAddress: agent.address,
                projectId: commitRows[0].project_id, commitId,
                commentCount, hasSuggestions,
                messagePreview: `${verdict} review from ${agent.address.slice(0, 10)} on commit ${commitId.slice(0, 8)}${commentCount ? ` (${commentCount} comments)` : ""}`,
              }).catch((err) => {
                logSecurityEvent("debug", "reactive-signal-failed", { signalType: "review_submitted", error: (err as Error).message });
              });
            }
          }
        } catch { /* non-fatal */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found") || msg.includes("Cannot review")) {
          res.status(400).json({ error: msg });
          return;
        }
        logSecurityEvent("error", "submit-review-failed", { error: msg });
        res.status(500).json({ error: "Failed to submit review." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:commitId/reviews — List reviews (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:commitId/reviews",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const commitId = req.params.commitId as string;

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const reviews = await fileManager.getReviews(commitId);
        res.json({ reviews, total: reviews.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-reviews-failed", { error: message });
        res.status(500).json({ error: "Failed to list reviews." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:cid/comments — List review comments (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:cid/comments",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const commitId = req.params.cid as string;

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT rc.id, rc.file_path, rc.line_start, rc.line_end, rc.body,
                  rc.suggestion, rc.suggestion_applied, rc.resolved, rc.created_at,
                  rc.author_address, rc.review_id,
                  a.display_name AS author_name,
                  ra.display_name AS resolved_by_name
           FROM review_comments rc
           LEFT JOIN agents a ON a.id = rc.author_id
           LEFT JOIN agents ra ON ra.id = rc.resolved_by
           WHERE rc.commit_id = $1
           ORDER BY rc.file_path, rc.line_start, rc.created_at`,
          [commitId],
        );

        // Group by file
        const byFile: Record<string, typeof rows> = {};
        for (const r of rows) {
          const fp = r.file_path;
          if (!byFile[fp]) byFile[fp] = [];
          byFile[fp].push(r);
        }

        res.json({
          comments: rows.map(r => ({
            id: r.id,
            filePath: r.file_path,
            lineStart: r.line_start,
            lineEnd: r.line_end,
            body: r.body,
            suggestion: r.suggestion,
            suggestionApplied: r.suggestion_applied,
            resolved: r.resolved,
            authorAddress: r.author_address,
            authorName: r.author_name ?? null,
            reviewId: r.review_id,
            createdAt: r.created_at?.toISOString(),
          })),
          byFile: Object.fromEntries(
            Object.entries(byFile).map(([fp, comments]) => [
              fp,
              comments.map(r => ({
                id: r.id,
                lineStart: r.line_start,
                lineEnd: r.line_end,
                body: r.body,
                suggestion: r.suggestion,
                suggestionApplied: r.suggestion_applied,
                resolved: r.resolved,
                authorAddress: r.author_address,
                authorName: r.author_name ?? null,
                createdAt: r.created_at?.toISOString(),
              })),
            ]),
          ),
          total: rows.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-review-comments-failed", { error: message });
        res.status(500).json({ error: "Failed to list comments." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/commits/:cid/comments — Add line comment
  // -------------------------------------------------------
  router.post(
    "/projects/:id/commits/:cid/comments",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const commitId = req.params.cid as string;
      const { filePath, lineStart, lineEnd, body, suggestion } = req.body;

      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "filePath is required." });
        return;
      }
      if (!body || typeof body !== "string" || body.length > 5000) {
        res.status(400).json({ error: "body is required (max 5000 chars)." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO review_comments (commit_id, author_id, author_address, file_path, line_start, line_end, body, suggestion)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, created_at`,
          [commitId, agent.id, agent.address, filePath, lineStart ?? null, lineEnd ?? null, body, suggestion ?? null],
        );

        res.status(201).json({
          id: rows[0].id,
          commitId,
          filePath,
          lineStart: lineStart ?? null,
          lineEnd: lineEnd ?? null,
          body,
          suggestion: suggestion ?? null,
          authorAddress: agent.address,
          createdAt: rows[0].created_at?.toISOString(),
        });

        // Notify commit author via proactive signal
        try {
          const { rows: commitRows } = await pool.query<{ author_id: string; project_id: string }>(
            `SELECT author_id, project_id FROM file_commits WHERE id = $1`, [commitId],
          );
          if (commitRows.length > 0 && commitRows[0].author_id !== agent.id) {
            // WebSocket broadcast
            broadcastToProjectMembers(projectId, agent.id, {
              type: "project.review_comment",
              timestamp: new Date().toISOString(),
              data: {
                projectId, commitId, filePath,
                lineStart: lineStart ?? null,
                preview: body.slice(0, 200),
                hasSuggestion: !!suggestion,
                authorAddress: agent.address,
              },
            });

            // Proactive signal for commit author
            if (proactiveScheduler) {
              proactiveScheduler.handleReactiveSignal(commitRows[0].author_id, {
                signalType: "review_comment_added",
                senderAddress: agent.address,
                projectId, commitId,
                messagePreview: `Comment on ${filePath}: ${body.slice(0, 100)}`,
              }).catch((err) => {
                logSecurityEvent("debug", "reactive-signal-failed", { signalType: "review_comment_added", error: (err as Error).message });
              });
            }
          }

          // Activity log
          const { rows: projRows } = await pool.query(
            `SELECT name FROM projects WHERE project_id = $1`, [projectId],
          );
          await pool.query(
            `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
             VALUES ($1, $2, 'review_comment_added', $3, $4, $5)`,
            [projectId, projRows[0]?.name ?? projectId, agent.id, agent.address, JSON.stringify({
              commitId, filePath, lineStart, hasSuggestion: !!suggestion,
            })],
          );
        } catch { /* non-fatal */ }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "add-review-comment-failed", { error: message });
        res.status(500).json({ error: "Failed to add comment." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/projects/:id/commits/:cid/comments/:rid — Resolve/unresolve
  // -------------------------------------------------------
  router.patch(
    "/projects/:id/commits/:cid/comments/:rid",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const commentId = req.params.rid as string;
      const { resolved } = req.body;

      if (typeof resolved !== "boolean") {
        res.status(400).json({ error: "resolved (boolean) is required." });
        return;
      }

      try {
        // Only comment author or project admin can resolve
        const { rows: commentRows } = await pool.query(
          `SELECT author_id FROM review_comments WHERE id = $1`, [commentId],
        );
        if (commentRows.length === 0) {
          res.status(404).json({ error: "Comment not found." });
          return;
        }

        const access = await fileManager.getAccessLevel(projectId, agent.id);
        if (commentRows[0].author_id !== agent.id && access < 2) {
          res.status(403).json({ error: "Only comment author or admin can resolve." });
          return;
        }

        const { rows } = await pool.query(
          `UPDATE review_comments SET resolved = $1, resolved_by = $2
           WHERE id = $3
           RETURNING id, resolved`,
          [resolved, resolved ? agent.id : null, commentId],
        );
        res.json({ id: rows[0].id, resolved: rows[0].resolved });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "resolve-comment-failed", { error: message });
        res.status(500).json({ error: "Failed to update comment." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/commits/:cid/apply-suggestion — Apply suggestion
  // -------------------------------------------------------
  router.post(
    "/projects/:id/commits/:cid/apply-suggestion",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { commentId } = req.body;

      if (!commentId || typeof commentId !== "string") {
        res.status(400).json({ error: "commentId is required." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        res.status(403).json({ error: "Editor role or higher required." });
        return;
      }

      try {
        // Get the comment with suggestion
        const { rows: commentRows } = await pool.query(
          `SELECT file_path, line_start, line_end, suggestion
           FROM review_comments WHERE id = $1 AND suggestion IS NOT NULL AND suggestion_applied = false`,
          [commentId],
        );
        if (commentRows.length === 0) {
          res.status(404).json({ error: "Comment not found or has no applicable suggestion." });
          return;
        }

        const { file_path, line_start, line_end, suggestion } = commentRows[0];

        // Read current file content
        const file = await fileManager.readFile(projectId, file_path);
        if (!file) {
          res.status(404).json({ error: `File ${file_path} not found.` });
          return;
        }

        // Apply suggestion: replace lines line_start..line_end with suggestion text
        const lines = file.content.split("\n");
        const start = (line_start ?? 1) - 1; // 1-indexed to 0-indexed
        const end = line_end ?? line_start ?? lines.length;
        lines.splice(start, end - start, suggestion);
        const newContent = lines.join("\n");

        // Commit the change
        const result = await fileManager.commitFiles(
          projectId,
          [{ path: file_path, content: newContent }],
          `Applied suggestion from review comment on ${file_path}`,
          agent.id,
          agent.address,
        );

        // Mark suggestion as applied
        await pool.query(
          `UPDATE review_comments SET suggestion_applied = true WHERE id = $1`,
          [commentId],
        );

        res.json({
          applied: true,
          commitId: result.commitId,
          filePath: file_path,
          linesReplaced: { start: (line_start ?? 1), end: end },
        });

        // Broadcast the commit (same as normal commit flow)
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.files_committed",
          timestamp: new Date().toISOString(),
          data: {
            projectId, commitId: result.commitId,
            message: result.message, filesChanged: result.filesChanged,
            linesAdded: result.linesAdded, linesRemoved: result.linesRemoved,
            author: agent.address, channelSlug: `project-${projectId}`,
          },
        });

        // Also emit proactive signal for apply-suggestion (so offline agents are notified)
        if (proactiveScheduler) {
          const { rows: memberRows } = await pool.query(
            `SELECT agent_id FROM project_collaborators WHERE project_id = $1 AND agent_id != $2`,
            [projectId, agent.id],
          );
          for (const { agent_id: memberId } of memberRows) {
            proactiveScheduler.handleReactiveSignal(memberId, {
              signalType: "files_committed",
              projectId,
              commitId: result.commitId,
              senderAddress: agent.address,
              messagePreview: `Suggestion applied: ${file_path}`,
            }).catch((err) => {
              logSecurityEvent("debug", "reactive-signal-failed", { signalType: "file-suggestion-applied", error: (err as Error).message });
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "apply-suggestion-failed", { error: message });
        res.status(500).json({ error: "Failed to apply suggestion." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/activity — Project activity feed (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/activity",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const activity = await fileManager.getProjectActivity(projectId, limit);
        res.json({ activity, total: activity.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-activity-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve activity." });
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
        res.status(500).json({ error: "Failed to export to GitHub." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/fork — Fork a project
  // -------------------------------------------------------
  router.post(
    "/projects/:id/fork",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const sourceProjectId = req.params.id as string;
      const { name, projectId: customSlug } = req.body;

      try {
        const result = await fileManager.forkProject(
          sourceProjectId,
          agent.id,
          agent.address,
          { name: name as string | undefined, projectSlug: customSlug as string | undefined },
        );
        res.status(201).json(result);

        // Broadcast to source project members
        broadcastToProjectMembers(sourceProjectId, agent.id, {
          type: "project.forked",
          timestamp: new Date().toISOString(),
          data: {
            sourceProjectId,
            forkProjectId: result.projectId,
            forkName: result.name,
            forkedBy: agent.address,
            filesCount: result.filesCount,
          },
        });

        // Proactive signal to source project members
        if (proactiveScheduler) {
          try {
            const { rows: memberRows } = await pool.query<{ id: string }>(
              `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
               UNION
               SELECT pc.agent_id AS id FROM project_collaborators pc
               JOIN projects p ON p.id = pc.project_id WHERE p.project_id = $1`,
              [sourceProjectId],
            );
            for (const { id } of memberRows) {
              if (id !== agent.id) {
                proactiveScheduler.handleReactiveSignal(id, {
                  signalType: "project_forked",
                  senderAddress: agent.address,
                  projectId: sourceProjectId,
                  forkProjectId: result.projectId,
                  messagePreview: `${agent.address.slice(0, 10)} forked your project`,
                }).catch(() => { /* non-fatal */ });
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "fork-project-failed", { agentId: agent.id, sourceProjectId, error: msg });
        if (msg.includes("not found") || msg.includes("already exists")) {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: "Failed to fork project." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/merge-requests — Create merge request
  // -------------------------------------------------------
  router.post(
    "/projects/:id/merge-requests",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const sourceProjectId = req.params.id as string;
      const { title, description, commitIds } = req.body;

      if (!title || typeof title !== "string") {
        res.status(400).json({ error: "title is required." });
        return;
      }
      if (!Array.isArray(commitIds) || commitIds.length === 0) {
        res.status(400).json({ error: "commitIds array is required (non-empty)." });
        return;
      }

      // Verify agent has editor+ access on the source (fork) project
      const access = await fileManager.getAccessLevel(sourceProjectId, agent.id);
      if (access < 1 && access !== 3) {
        if (access === -1) {
          res.status(404).json({ error: "Project not found or you don't have access." });
        } else {
          res.status(403).json({ error: "Need Editor role or higher on the fork." });
        }
        return;
      }

      try {
        const mr = await fileManager.createMergeRequest(
          sourceProjectId,
          agent.id,
          title,
          (description as string) ?? null,
          commitIds as string[],
        );
        res.status(201).json(mr);

        // Broadcast to target project members
        broadcastToProjectMembers(mr.targetProjectId, agent.id, {
          type: "project.merge_request_created",
          timestamp: new Date().toISOString(),
          data: {
            mrId: mr.id,
            title: mr.title,
            sourceProject: sourceProjectId,
            targetProject: mr.targetProjectId,
            author: agent.address,
            commitCount: commitIds.length,
          },
        });

        // Proactive signal to target project members
        if (proactiveScheduler) {
          try {
            const { rows: memberRows } = await pool.query<{ id: string }>(
              `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
               UNION
               SELECT pc.agent_id AS id FROM project_collaborators pc
               JOIN projects p ON p.id = pc.project_id WHERE p.project_id = $1`,
              [mr.targetProjectId],
            );
            for (const { id } of memberRows) {
              if (id !== agent.id) {
                proactiveScheduler.handleReactiveSignal(id, {
                  signalType: "merge_request_created",
                  senderAddress: agent.address,
                  projectId: mr.targetProjectId,
                  mrId: mr.id,
                  messagePreview: `New merge request: ${title.slice(0, 100)}`,
                }).catch(() => { /* non-fatal */ });
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-merge-request-failed", { agentId: agent.id, sourceProjectId, error: msg });
        if (msg.includes("not found") || msg.includes("Only forked") || msg.includes("already exists") || msg.includes("don't belong")) {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: "Failed to create merge request." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/merge-requests — List merge requests (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/merge-requests",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      try {
        const result = await fileManager.listMergeRequests(projectId, status, limit, offset);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          res.status(404).json({ error: msg });
          return;
        }
        logSecurityEvent("error", "list-merge-requests-failed", { projectId, error: msg });
        res.status(500).json({ error: "Failed to list merge requests." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/merge-requests/:mrId — MR detail (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/merge-requests/:mrId",
    async (req: Request, res: Response): Promise<void> => {
      const mrId = req.params.mrId as string;

      try {
        const detail = await fileManager.getMergeRequestDetail(mrId);
        if (!detail) {
          res.status(404).json({ error: "Merge request not found." });
          return;
        }
        res.json(detail);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-merge-request-failed", { mrId, error: msg });
        res.status(500).json({ error: "Failed to get merge request." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/merge-requests/:mrId/merge — Execute merge
  // -------------------------------------------------------
  router.post(
    "/projects/:id/merge-requests/:mrId/merge",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const mrId = req.params.mrId as string;
      const { comment } = req.body;

      try {
        const result = await fileManager.executeMerge(
          mrId, agent.id, agent.address, comment as string | undefined,
        );
        res.json(result);

        // Broadcast merge event
        const projectId = req.params.id as string;
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.merge_request_merged",
          timestamp: new Date().toISOString(),
          data: {
            mrId,
            mergedCommitId: result.commitId,
            filesChanged: result.filesChanged,
            mergedBy: agent.address,
            projectId,
          },
        });

        // Proactive signal
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
                  signalType: "merge_request_merged",
                  senderAddress: agent.address,
                  projectId,
                  mrId,
                  messagePreview: `Merge request merged with ${result.filesChanged} files changed`,
                }).catch(() => { /* non-fatal */ });
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "merge-failed", { agentId: agent.id, mrId, error: msg });
        if (msg.includes("not found") || msg.includes("already") || msg.includes("Only project") || msg.includes("No file")) {
          res.status(400).json({ error: msg });
          return;
        }
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
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const mrId = req.params.mrId as string;
      const { comment } = req.body;

      try {
        const result = await fileManager.closeMergeRequest(
          mrId, agent.id, comment as string | undefined,
        );
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "close-merge-request-failed", { agentId: agent.id, mrId, error: msg });
        if (msg.includes("not found") || msg.includes("already") || msg.includes("Only the MR")) {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: "Failed to close merge request." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/projects/:id/collaboration-mode — Set collaboration mode
  // -------------------------------------------------------
  router.patch(
    "/projects/:id/collaboration-mode",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { mode } = req.body;

      if (!mode || !["standard", "open"].includes(mode)) {
        res.status(400).json({ error: 'mode must be "standard" or "open".' });
        return;
      }

      try {
        await fileManager.setCollaborationMode(projectId, agent.id, mode);

        // Activity event
        const { rows: projRows } = await pool.query(
          `SELECT name FROM projects WHERE project_id = $1`, [projectId],
        );
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'collaboration_mode_changed', $3, $4, $5)`,
          [projectId, projRows[0]?.name ?? projectId, agent.id, agent.address,
           JSON.stringify({ mode })],
        );

        res.json({ projectId, collaborationMode: mode });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("owner")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(400).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/notes — Create a lab note
  // -------------------------------------------------------
  router.post(
    "/projects/:id/notes",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { text, commitRef } = req.body;

      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required." });
        return;
      }

      try {
        const note = await fileManager.createNote(
          projectId, agent.id, agent.address, text, commitRef,
        );
        res.status(201).json(note);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found") || msg.includes("access")) {
          res.status(404).json({ error: msg });
          return;
        }
        res.status(400).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/notes — List lab notes (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/notes",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1", [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      try {
        const result = await fileManager.listNotes(projectId, limit, offset);
        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-notes-failed", { error: message });
        res.status(500).json({ error: "Failed to list notes." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/frontiers — Cross-project frontier feed (public)
  // -------------------------------------------------------
  router.get(
    "/frontiers",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

      try {
        const frontiers = await fileManager.getGlobalFrontiers(limit);
        res.json({ frontiers, total: frontiers.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-frontiers-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve frontiers." });
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-global-activity-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve activity." });
      }
    },
  );

  return router;
}
