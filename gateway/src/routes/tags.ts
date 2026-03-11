/**
 * Public tag browse/search/suggest endpoints.
 *
 * No authentication required — tags are public metadata.
 *
 * GET /v1/tags                   — List/search tags (query params: q, category, limit, offset)
 * GET /v1/tags/trending          — Top tags by usage
 * GET /v1/tags/suggest           — Autocomplete (query param: prefix)
 *
 * @module routes/tags
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { InterestEngine } from "../services/interestEngine.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createTagsRouter(
  interestEngine: InterestEngine,
): Router {
  const router = Router();

  // -------------------------------------------------------
  //  GET /v1/tags/trending — Top tags by usage
  // -------------------------------------------------------
  router.get(
    "/tags/trending",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      try {
        const tags = await interestEngine.trendingTags(limit);
        res.json({ tags });
      } catch (err) {
        logSecurityEvent("error", "tags-trending-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get trending tags" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/tags/suggest — Autocomplete
  // -------------------------------------------------------
  router.get(
    "/tags/suggest",
    async (req: Request, res: Response): Promise<void> => {
      const prefix = req.query.prefix as string;
      if (!prefix || prefix.length < 1) {
        res.status(400).json({ error: "prefix query parameter is required" });
        return;
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      try {
        const suggestions = await interestEngine.suggestTags(prefix, limit);
        res.json({ suggestions });
      } catch (err) {
        logSecurityEvent("error", "tags-suggest-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to suggest tags" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/tags — List/search tags
  // -------------------------------------------------------
  router.get(
    "/tags",
    async (req: Request, res: Response): Promise<void> => {
      const q = req.query.q as string | undefined;
      const category = req.query.category as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      try {
        const result = await interestEngine.listTags({ q, category, limit, offset });
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "tags-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list tags" });
      }
    },
  );

  return router;
}
