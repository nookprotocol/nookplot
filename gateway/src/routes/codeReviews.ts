/**
 * AI code review routes — Greptile-powered code review on project commits.
 *
 * POST /v1/projects/:id/commits/:commitId/ai-review
 *   Triggers a Greptile AI review, deducts credits, posts findings as
 *   a review + inline comments using the existing commit review system.
 *
 * @module routes/codeReviews
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { CodeReviewService, CodeReviewError } from "../services/codeReviewService.js";
import type { FileManager } from "../services/fileManager.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";

export function createCodeReviewRouter(
  pool: pg.Pool,
  hmacSecret: string,
  codeReviewService: CodeReviewService | undefined,
  fileManager: FileManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/projects/:id/commits/:commitId/ai-review
  // -------------------------------------------------------
  router.post(
    "/projects/:id/commits/:commitId/ai-review",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      // Feature gate
      if (!codeReviewService) {
        res.status(501).json({ error: "AI code review is not enabled on this gateway." });
        return;
      }

      const agent = req.agent;
      if (!agent) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const projectId = req.params.id as string;
      const commitId = req.params.commitId as string;

      try {
        const result = await codeReviewService.requestReview(
          projectId,
          commitId,
          agent.id,
        );

        res.status(201).json(result);

        // Notify commit author about the AI review (non-blocking)
        try {
          const { rows: commitRows } = await pool.query<{
            author_id: string;
            project_id: string;
          }>(
            `SELECT author_id, project_id FROM file_commits WHERE id = $1`,
            [commitId],
          );

          if (commitRows.length > 0 && eventBroadcaster) {
            eventBroadcaster.broadcast(commitRows[0].author_id, {
              type: "project.review_submitted",
              timestamp: new Date().toISOString(),
              data: {
                projectId: commitRows[0].project_id,
                commitId,
                reviewer: "0x0000000000000000000000000000000000000000",
                reviewerName: "Greptile Reviewer",
                verdict: result.verdict,
                commentCount: result.findingsCount,
                hasSuggestions: result.findings.some((f) => f.suggestion !== null),
                channelSlug: `project-${commitRows[0].project_id}`,
                source: "greptile",
              },
            });
          }
        } catch {
          /* non-fatal — review is already persisted */
        }
      } catch (err) {
        if (err instanceof CodeReviewError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        logSecurityEvent("error", "ai-code-review-failed", {
          projectId,
          commitId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "AI code review failed." });
      }
    },
  );

  return router;
}
