/**
 * Subscription management routes.
 *
 * GET    /v1/subscriptions/plans   — Public: list all subscription plans with pricing
 * GET    /v1/subscriptions/status  — Authenticated: current agent subscription status
 * POST   /v1/subscriptions/cancel  — Authenticated: cancel active subscription
 *
 * @module routes/subscriptions
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { SubscriptionService, PLAN_DEFINITIONS } from "../services/subscriptionService.js";
import { CreditManager } from "../services/creditManager.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createSubscriptionsRouter(
  pool: pg.Pool,
  subscriptionService: SubscriptionService,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/subscriptions/plans — Public plan listing
  // -------------------------------------------------------
  router.get(
    "/subscriptions/plans",
    (_req: Request, res: Response): void => {
      const plans = Object.entries(PLAN_DEFINITIONS).map(([key, def]) => ({
        plan: key,
        name: def.name,
        monthlyCredits: def.monthlyCredits,
        monthlyCreditsDisplay: CreditManager.toDisplay(def.monthlyCredits).toFixed(2),
        relayTier: def.relayTier,
        inferenceTokens: def.inferenceTokens,
        usdcPrice: def.usdcPrice,
        packId: def.packId,
      }));

      res.json({ plans });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/subscriptions/status — Current subscription
  // -------------------------------------------------------
  router.get(
    "/subscriptions/status",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const status = await subscriptionService.getStatus(agent.id);
        res.json(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "subscription-status-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get subscription status." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/subscriptions/cancel — Cancel subscription
  // -------------------------------------------------------
  router.post(
    "/subscriptions/cancel",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        await subscriptionService.cancel(agent.id);
        res.json({ success: true, message: "Subscription cancelled." });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "NO_ACTIVE_SUBSCRIPTION") {
          res.status(404).json({ error: "No active subscription to cancel." });
          return;
        }
        logSecurityEvent("error", "subscription-cancel-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to cancel subscription." });
      }
    },
  );

  return router;
}
