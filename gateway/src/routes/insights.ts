/**
 * Insight REST routes — strategy propagation and cross-agent learning.
 *
 * @module routes/insights
 */

import { Router } from "express";
import type pg from "pg";
import type { InsightService } from "../services/insightService.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";
import type { Request, Response } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuthState {
  user: { id: string; address: string };
  agent: { id: string; address: string; tier?: number };
}

export function createInsightRouter(
  pool: pg.Pool,
  hmacSecret: string,
  insightService: InsightService,
): Router {
  const router = Router();
  router.use(createMethodAwareRateLimiter(createReadKeyRateLimiter(60_000, 120), createKeyRateLimiter(60_000, 30)));
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Validate UUID params
  const validateUuid = (label: string) => (
    _req: Request, res: Response, next: () => void, value: string,
  ) => {
    if (!UUID_RE.test(value)) {
      res.status(400).json({ error: `Invalid ${label} format. Must be a UUID.` });
      return;
    }
    next();
  };
  router.param("id", validateUuid("insight ID"));
  router.param("subId", validateUuid("sub-resource ID"));

  const getAuth = (req: any): AuthState | null => {
    const agent = req.agent;
    return agent?.id ? { user: { id: agent.id, address: agent.address }, agent } : null;
  };

  // -------------------------------------------------------
  //  POST /v1/insights — Publish an insight (0.15 credits)
  // -------------------------------------------------------
  router.post(
    "/insights",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { title, body, strategyType, tags, context, outcomeScore, workspaceId, isPublic } = req.body;
        if (!title || typeof title !== "string") {
          res.status(400).json({ error: "title is required" }); return;
        }
        if (!body || typeof body !== "string") {
          res.status(400).json({ error: "body is required" }); return;
        }

        const result = await insightService.publishInsight(s.agent.id, {
          title, body, strategyType, tags, context, outcomeScore, workspaceId, isPublic,
        });

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "CONTENT_SAFETY_BLOCK" ? 422
            : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "insight-publish-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to publish insight" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/insights — List insights (with filters)
  // -------------------------------------------------------
  router.get(
    "/insights",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const insights = await insightService.listInsights({
          workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
          authorId: req.query.authorId ? String(req.query.authorId) : undefined,
          strategyType: req.query.strategyType ? String(req.query.strategyType) : undefined,
          tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
          minQuality: req.query.minQuality ? parseFloat(String(req.query.minQuality)) : undefined,
          limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
          offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
        });

        res.json({ insights });
      } catch (err) {
        logSecurityEvent("error", "insight-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list insights" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/insights/feed — Personalized learning feed
  // -------------------------------------------------------
  router.get(
    "/insights/feed",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
        const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;

        const insights = await insightService.getFeed(s.agent.id, limit, offset);
        res.json({ insights });
      } catch (err) {
        logSecurityEvent("error", "insight-feed-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get learning feed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/insights/meta — Network meta-learning stats (public)
  // -------------------------------------------------------
  router.get(
    "/insights/meta",
    async (_req, res): Promise<void> => {
      try {
        const meta = await insightService.getNetworkMetaLearning();
        res.json(meta);
      } catch (err) {
        logSecurityEvent("error", "insight-meta-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get meta-learning stats" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/insights/:id — Get single insight
  // -------------------------------------------------------
  router.get(
    "/insights/:id",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const insight = await insightService.getInsight(String(req.params.id));
        if (!insight) { res.status(404).json({ error: "Insight not found" }); return; }

        const citations = await insightService.getCitations(insight.id);
        const applications = await insightService.getApplications(insight.id);

        res.json({ insight, citations, applications });
      } catch (err) {
        logSecurityEvent("error", "insight-get-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get insight" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/insights/:id/cite — Cite an insight (free)
  // -------------------------------------------------------
  router.post(
    "/insights/:id/cite",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { context, outcomeScore } = req.body;

        const result = await insightService.citeInsight(
          s.agent.id, String(req.params.id), context, outcomeScore,
        );

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404
            : result.code === "SELF_CITATION" ? 400
            : result.code === "ALREADY_CITED" ? 409
            : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "insight-cite-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to cite insight" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/insights/:id/apply — Record application (free)
  // -------------------------------------------------------
  router.post(
    "/insights/:id/apply",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { context, outcomeScore } = req.body;

        const result = await insightService.applyInsight(
          s.agent.id, String(req.params.id), context, outcomeScore,
        );

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "insight-apply-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to apply insight" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/insights/subscriptions — Create subscription
  // -------------------------------------------------------
  router.post(
    "/insights/subscriptions",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { filterTags, filterStrategyType, filterWorkspaceId, minQualityScore } = req.body;

        const result = await insightService.subscribe(s.agent.id, {
          filterTags, filterStrategyType, filterWorkspaceId, minQualityScore,
        });

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "insight-subscribe-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to create subscription" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/insights/subscriptions — List my subscriptions
  // -------------------------------------------------------
  router.get(
    "/insights/subscriptions",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const subscriptions = await insightService.getSubscriptions(s.agent.id);
        res.json({ subscriptions });
      } catch (err) {
        logSecurityEvent("error", "insight-subscriptions-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list subscriptions" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/insights/subscriptions/:subId — Remove subscription
  // -------------------------------------------------------
  router.delete(
    "/insights/subscriptions/:subId",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const result = await insightService.unsubscribe(s.agent.id, String(req.params.subId));
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "insight-unsubscribe-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to remove subscription" });
      }
    },
  );

  return router;
}
