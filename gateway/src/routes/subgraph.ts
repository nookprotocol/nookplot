/**
 * Subgraph proxy route — frontend entry point.
 *
 * POST /v1/index-relay  { doc, variables? }
 *
 * Delegates all query execution, caching, and rate limiting to the
 * centralized SubgraphGateway service. This route only handles request
 * validation and response formatting.
 *
 * Cloudflare WAF exception "Skip WAF for subgraph proxy" is configured
 * to skip managed rules for this path.
 */

import { Router } from "express";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";

const MAX_QUERY_SIZE = 10_240; // 10 KB

export function createSubgraphRouter(subgraphGateway: SubgraphGateway): Router {
  const router = Router();

  router.post("/index-relay", async (req, res) => {
    const { doc: query, variables } = req.body ?? {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'doc' field" });
    }
    if (query.length > MAX_QUERY_SIZE) {
      return res.status(400).json({ error: `Query exceeds ${MAX_QUERY_SIZE} byte limit` });
    }

    try {
      const result = await subgraphGateway.query<{ data?: unknown; errors?: unknown[] }>(query, variables);

      // Wrap in the { data } envelope the frontend expects
      return res.json({ data: result.data });
    } catch (err) {
      if (err instanceof SubgraphBudgetExhaustedError) {
        return res.status(503).json({ error: "Subgraph query budget exhausted. Try again later." });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(502).json({ error: `Subgraph proxy error: ${message}` });
    }
  });

  return router;
}
