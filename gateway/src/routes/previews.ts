/**
 * Preview deployment management routes.
 *
 * CRUD endpoints for managing Docker-hosted preview deployments.
 * All endpoints require authentication.
 *
 * @module routes/previews
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { PreviewDeploymentService } from "../services/previewDeploymentService.js";
import type { CreditManager } from "../services/creditManager.js";
import { handleRouteError } from "../utils/safeError.js";

export function createPreviewsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  previewService: PreviewDeploymentService,
  creditManager: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/preview-deployments/detect — Auto-detect runtime
  // -------------------------------------------------------
  router.post(
    "/preview-deployments/detect",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { files } = req.body;
      if (!files || typeof files !== "object") {
        res.status(400).json({ error: "Missing required field: files (object)" });
        return;
      }

      const detected = previewService.detectRuntime(files);
      res.json(detected);
    },
  );

  // -------------------------------------------------------
  //  GET /v1/preview-deployments — List own deployments
  // -------------------------------------------------------
  router.get(
    "/preview-deployments",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const deployments = await previewService.listByAgent(agent.id);
      res.json({ deployments });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/preview-deployments/:id — Get deployment status
  // -------------------------------------------------------
  router.get(
    "/preview-deployments/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const dep = await previewService.getDeployment(req.params.id as string);
      if (!dep) { res.status(404).json({ error: "Deployment not found" }); return; }
      if (dep.agent_id !== agent.id) { res.status(403).json({ error: "Not authorized" }); return; }

      res.json(dep);
    },
  );

  // -------------------------------------------------------
  //  POST /v1/preview-deployments/:id/stop — Stop deployment
  // -------------------------------------------------------
  router.post(
    "/preview-deployments/:id/stop",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        await previewService.stop(req.params.id as string, agent.id);
        res.json({ status: "stopped" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Not authorized") { res.status(403).json({ error: "Not authorized" }); return; }
        if (msg === "Deployment not found") { res.status(404).json({ error: "Deployment not found" }); return; }
        logSecurityEvent("error", "preview-stop-failed", { deploymentId: req.params.id as string, error: msg });
        res.status(500).json({ error: "Failed to stop deployment." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/preview-deployments/:id/resume — Resume paused deployment
  // -------------------------------------------------------
  router.post(
    "/preview-deployments/:id/resume",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        await previewService.resume(req.params.id as string, agent.id);
        res.json({ status: "running" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Not authorized") { res.status(403).json({ error: "Not authorized" }); return; }
        if (msg === "Deployment not found") { res.status(404).json({ error: "Deployment not found" }); return; }
        if (msg === "INSUFFICIENT_CREDITS") { res.status(402).json({ error: "Insufficient credits to resume" }); return; }
        logSecurityEvent("error", "preview-resume-failed", { deploymentId: req.params.id as string, error: msg });
        res.status(500).json({ error: "Failed to resume deployment." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/preview-deployments/:id — Delete deployment
  // -------------------------------------------------------
  router.delete(
    "/preview-deployments/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        await previewService.delete(req.params.id as string, agent.id);
        res.json({ status: "deleted" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Not authorized") { res.status(403).json({ error: "Not authorized" }); return; }
        if (msg === "Deployment not found") { res.status(404).json({ error: "Deployment not found" }); return; }
        logSecurityEvent("error", "preview-delete-failed", { deploymentId: req.params.id as string, error: msg });
        res.status(500).json({ error: "Failed to delete deployment." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/preview-deployments/:id/logs — Tail container logs
  // -------------------------------------------------------
  router.get(
    "/preview-deployments/:id/logs",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const tail = parseInt(req.query.tail as string) || 100;
        const logs = await previewService.getLogs(req.params.id as string, agent.id, Math.min(tail, 500));
        res.json({ logs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Not authorized") { res.status(403).json({ error: "Not authorized" }); return; }
        if (msg === "Deployment not found") { res.status(404).json({ error: "Deployment not found" }); return; }
        handleRouteError(res, err, "preview-logs-failed", "Failed to fetch deployment logs.");
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:projectId/deployments — List deployments for project (public)
  // -------------------------------------------------------
  router.get(
    "/projects/:projectId/deployments",
    async (req: Request, res: Response): Promise<void> => {
      const projectId = req.params.projectId as string;

      const { rows: projCheck } = await pool.query(
        "SELECT 1 FROM projects WHERE project_id = $1",
        [projectId],
      );
      if (projCheck.length === 0) {
        res.status(404).json({ error: "Project not found." });
        return;
      }

      const deployments = await previewService.listByProject(projectId);
      res.json({ deployments });
    },
  );

  return router;
}
