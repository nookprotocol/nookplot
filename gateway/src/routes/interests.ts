/**
 * Interest subscription + GitHub repo watch CRUD routes.
 *
 * Authenticated endpoints for managing structured interest subscriptions
 * that trigger real-time notifications when matching entities appear.
 *
 * POST   /v1/interests                          — Create interest subscription
 * GET    /v1/interests                          — List agent's subscriptions
 * GET    /v1/interests/:id                      — Get one subscription
 * PUT    /v1/interests/:id                      — Update subscription
 * DELETE /v1/interests/:id                      — Delete subscription
 * POST   /v1/interests/:id/test                 — Dry-run: show current matches + estimated cost
 * GET    /v1/interests/notifications             — Notification history (paginated)
 * GET    /v1/interests/notifications/stats       — Today's count, credits spent, free remaining
 * POST   /v1/interests/repo-watches              — Add repo watch
 * GET    /v1/interests/repo-watches              — List agent's watches
 * DELETE /v1/interests/repo-watches/:id          — Remove watch
 * POST   /v1/interests/repo-watches/:id/check    — Manual poll
 *
 * @module routes/interests
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { InterestEngine } from "../services/interestEngine.js";
import { ValidationError, LimitError } from "../services/interestEngine.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createInterestsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  interestEngine: InterestEngine,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/interests/notifications/stats — must be before :id
  // -------------------------------------------------------
  router.get(
    "/interests/notifications/stats",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const stats = await interestEngine.getNotificationStats(agent.id);
        res.json(stats);
      } catch (err) {
        logSecurityEvent("error", "interest-notif-stats-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to get notification stats" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/interests/notifications — Notification history
  // -------------------------------------------------------
  router.get(
    "/interests/notifications",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      try {
        const result = await interestEngine.getNotificationHistory(agent.id, limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "interest-notif-list-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to list notifications" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/interests/repo-watches — Add repo watch
  // -------------------------------------------------------
  router.post(
    "/interests/repo-watches",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { owner, repo } = req.body;

      if (!owner || typeof owner !== "string") {
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!repo || typeof repo !== "string") {
        res.status(400).json({ error: "repo is required" });
        return;
      }

      try {
        const watch = await interestEngine.addRepoWatch(agent.id, owner, repo);
        res.status(201).json(watch);
      } catch (err) {
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof LimitError) {
          res.status(409).json({ error: err.message });
          return;
        }
        // Check for unique constraint violation
        if ((err as { code?: string }).code === "23505") {
          res.status(409).json({ error: "Already watching this repo" });
          return;
        }
        logSecurityEvent("error", "repo-watch-add-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to add repo watch" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/interests/repo-watches — List agent's watches
  // -------------------------------------------------------
  router.get(
    "/interests/repo-watches",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const watches = await interestEngine.listRepoWatches(agent.id);
        res.json({ watches });
      } catch (err) {
        logSecurityEvent("error", "repo-watch-list-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to list repo watches" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/interests/repo-watches/:id — Remove watch
  // -------------------------------------------------------
  router.delete(
    "/interests/repo-watches/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const deleted = await interestEngine.removeRepoWatch(agent.id, req.params.id as string);
        if (!deleted) {
          res.status(404).json({ error: "Repo watch not found" });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        logSecurityEvent("error", "repo-watch-delete-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to remove repo watch" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/interests/repo-watches/:id/check — Manual poll
  // -------------------------------------------------------
  router.post(
    "/interests/repo-watches/:id/check",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const result = await interestEngine.manualPollRepoWatch(agent.id, req.params.id as string);
        if (!result) {
          res.status(404).json({ error: "Repo watch not found" });
          return;
        }
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "repo-watch-check-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to check repo" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/interests — Create interest subscription
  // -------------------------------------------------------
  router.post(
    "/interests",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const sub = await interestEngine.createSubscription(agent.id, req.body);
        res.status(201).json(sub);
      } catch (err) {
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof LimitError) {
          res.status(409).json({ error: err.message });
          return;
        }
        logSecurityEvent("error", "interest-create-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to create subscription" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/interests — List agent's subscriptions
  // -------------------------------------------------------
  router.get(
    "/interests",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const subscriptions = await interestEngine.listSubscriptions(agent.id);
        res.json({ subscriptions });
      } catch (err) {
        logSecurityEvent("error", "interest-list-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to list subscriptions" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/interests/:id — Get one subscription
  // -------------------------------------------------------
  router.get(
    "/interests/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const sub = await interestEngine.getSubscription(agent.id, req.params.id as string);
        if (!sub) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }
        res.json(sub);
      } catch (err) {
        logSecurityEvent("error", "interest-get-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to get subscription" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/interests/:id — Update subscription
  // -------------------------------------------------------
  router.put(
    "/interests/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const sub = await interestEngine.updateSubscription(agent.id, req.params.id as string, req.body);
        if (!sub) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }
        res.json(sub);
      } catch (err) {
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        logSecurityEvent("error", "interest-update-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to update subscription" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/interests/:id — Delete subscription
  // -------------------------------------------------------
  router.delete(
    "/interests/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const deleted = await interestEngine.deleteSubscription(agent.id, req.params.id as string);
        if (!deleted) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        logSecurityEvent("error", "interest-delete-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to delete subscription" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/interests/:id/test — Dry-run
  // -------------------------------------------------------
  router.post(
    "/interests/:id/test",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const result = await interestEngine.testSubscription(agent.id, req.params.id as string);
        if (!result) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "interest-test-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to test subscription" });
      }
    },
  );

  return router;
}
