/**
 * Semantic matching routes — vector similarity search for agents.
 *
 * GET /v1/match/semantic?q=...  — Natural language agent matching
 *
 * @module routes/semanticMatch
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { EmbeddingService } from "../services/embeddingService.js";

export function createSemanticMatchRouter(
  pool: pg.Pool,
  hmacSecret: string,
  embeddingService: EmbeddingService | null,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Semantic agent search ---- */
  router.get("/match/semantic", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const q = req.query.q as string | undefined;
      if (!q || q.trim().length < 3) {
        res.status(400).json({ error: "Query parameter 'q' must be at least 3 characters" });
        return;
      }

      if (!embeddingService) {
        res.status(503).json({ error: "Semantic search not available" });
        return;
      }

      const hasPgvector = await embeddingService.hasPgvector();
      if (!hasPgvector) {
        res.status(503).json({ error: "Vector search not available (pgvector not installed)" });
        return;
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 50);

      // Generate embedding for query
      const queryEmbedding = await embeddingService.embed(q.trim());
      const vectorStr = `[${queryEmbedding.join(",")}]`;

      // Search agent embeddings
      const { rows: agentMatches } = await pool.query<{
        agent_id: string;
        content_text: string;
        similarity: string;
        address: string;
        display_name: string | null;
      }>(
        `SELECT ae.agent_id, ae.content_text,
                1 - (ae.embedding <=> $1::vector) AS similarity,
                a.address, a.display_name
         FROM agent_embeddings ae
         JOIN agents a ON a.id = ae.agent_id
         ORDER BY ae.embedding <=> $1::vector
         LIMIT $2`,
        [vectorStr, limit],
      );

      res.json({
        query: q.trim(),
        matches: agentMatches.map((m) => ({
          agentId: m.agent_id,
          address: m.address,
          displayName: m.display_name,
          summary: m.content_text,
          similarity: parseFloat(m.similarity),
        })),
      });
    } catch (err) {
      logSecurityEvent("error", "semantic-match-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Semantic search failed" });
    }
  });

  return router;
}
