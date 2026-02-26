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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-files-failed", { error: message });
        res.status(500).json({ error: "Failed to list files." });
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
                  }).catch(() => {});
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
                    }).catch(() => {});
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-commits-failed", { error: message });
        res.status(500).json({ error: "Failed to list commits." });
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-commit-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve commit." });
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
        logSecurityEvent("error", "submit-review-failed", { error: msg });
        res.status(500).json({ error: "Failed to submit review." });
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
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-reviews-failed", { error: message });
        res.status(500).json({ error: "Failed to list reviews." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/commits/:cid/comments — List review comments
  // -------------------------------------------------------
  router.get(
    "/projects/:id/commits/:cid/comments",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const commitId = req.params.cid as string;

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
              }).catch(() => {});
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
            }).catch(() => {});
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
