/**
 * Knowledge Query routes — semantic + keyword search with credit-gated
 * access and revenue attribution to content creators.
 *
 * POST /v1/knowledge/query    — Semantic search (auth + registered, credit-gated)
 * GET  /v1/knowledge/history  — Query history (auth + registered)
 * GET  /v1/knowledge/earnings — Attribution earnings (auth + registered)
 * GET  /v1/knowledge/topics   — Inferred topic map (auth + registered)
 * GET  /v1/knowledge/stats    — Public stats (no auth)
 *
 * @module routes/knowledgeQuery
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { KnowledgeQueryService } from "../services/knowledgeQueryService.js";
import type { EmbeddingService } from "../services/embeddingService.js";
import type { CreditManager } from "../services/creditManager.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";

export function createKnowledgeQueryRouter(
  pool: pg.Pool,
  hmacSecret: string,
  knowledgeQueryService: KnowledgeQueryService,
  embeddingService: EmbeddingService | null,
  creditManager: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/knowledge/query — Semantic + FTS search
  // -------------------------------------------------------
  router.post(
    "/knowledge/query",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { query, types, limit, minQuality } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required and must be a string" });
        return;
      }

      try {
        const result = await knowledgeQueryService.query(agent.id, {
          query,
          types: Array.isArray(types) ? types : undefined,
          limit: typeof limit === "number" ? limit : undefined,
          minQuality: typeof minQuality === "number" ? minQuality : undefined,
        });

        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits for knowledge query." });
          return;
        }
        if (msg === "RATE_LIMIT_EXCEEDED") {
          res.status(429).json({ error: "Knowledge query rate limit exceeded. Try again later." });
          return;
        }
        if (msg === "ACCOUNT_TOO_NEW") {
          res.status(403).json({ error: "Account must be at least 1 day old to query." });
          return;
        }
        if (msg.startsWith("VALIDATION:")) {
          res.status(400).json({ error: msg.replace("VALIDATION: ", "") });
          return;
        }

        console.error("[knowledge-query] Query failed:", msg);
        res.status(500).json({ error: "Knowledge query failed." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/knowledge/history — Query history
  // -------------------------------------------------------
  router.get(
    "/knowledge/history",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      try {
        const result = await knowledgeQueryService.getQueryHistory(agent.id, limit, offset);
        res.json(result);
      } catch (err) {
        console.error("[knowledge-query] History fetch failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Failed to fetch query history." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/knowledge/earnings — Attribution earnings
  // -------------------------------------------------------
  router.get(
    "/knowledge/earnings",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const days = Math.min(parseInt(String(req.query.days ?? "30"), 10), 365);

      try {
        const result = await knowledgeQueryService.getEarnings(agent.id, days);
        res.json(result);
      } catch (err) {
        console.error("[knowledge-query] Earnings fetch failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Failed to fetch earnings." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/knowledge/topics — Inferred topic map
  // -------------------------------------------------------
  router.get(
    "/knowledge/topics",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const topics = await knowledgeQueryService.getTopicMap(agent.id);
        res.json({ topics });
      } catch (err) {
        console.error("[knowledge-query] Topics fetch failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Failed to fetch topic map." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/knowledge/stats — Public stats (no auth)
  // -------------------------------------------------------
  router.get(
    "/knowledge/stats",
    async (_req, res: Response): Promise<void> => {
      try {
        const stats = await knowledgeQueryService.getStats(embeddingService);
        res.json(stats);
      } catch (err) {
        console.error("[knowledge-query] Stats fetch failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Failed to fetch stats." });
      }
    },
  );

  return router;
}
