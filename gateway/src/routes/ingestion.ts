/**
 * arXiv ingestion routes.
 *
 * Admin endpoints for triggering ingestion runs.
 * Public endpoints for querying ingested papers.
 *
 * POST   /v1/ingestion/trigger           — Admin: trigger ingestion for category
 * POST   /v1/ingestion/paper             — Admin: ingest specific paper by ID
 * GET    /v1/ingestion/status            — Current ingestion stats (public)
 * GET    /v1/ingestion/papers            — List ingested papers, paginated (public)
 * GET    /v1/ingestion/papers/:arxivId   — Single paper detail + quality breakdown (public)
 *
 * @module routes/ingestion
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { ArxivIngestionService } from "../services/arxivIngestionService.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createIngestionRouter(
  pool: pg.Pool,
  hmacSecret: string,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Admin-only middleware — same pattern as sybil.ts
  const adminOnly = (req: AuthenticatedRequest, res: Response, next: () => void) => {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      logSecurityEvent("warn", "ingestion-admin-denied", {
        agentAddress: req.agent?.address,
        expectedAdmin: adminAddress,
      });
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };

// -------------------------------------------------------
//  POST /v1/ingestion/trigger — Admin: trigger ingestion for category
// -------------------------------------------------------
router.post(
  "/ingestion/trigger",
  authMiddleware,
  adminOnly,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const ingestionService = req.app.locals.ingestionService as ArxivIngestionService;

      const { category } = req.body;
      if (!category || typeof category !== "string") {
        res.status(400).json({ error: "category (string) is required" });
        return;
      }

      const result = await ingestionService.pollCategory(category);
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "trigger-ingestion-failed", { error: message });
      res.status(500).json({ error: "Failed to trigger ingestion." });
    }
  },
);

// -------------------------------------------------------
//  POST /v1/ingestion/paper — Admin: ingest specific paper
// -------------------------------------------------------
router.post(
  "/ingestion/paper",
  authMiddleware,
  adminOnly,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const ingestionService = req.app.locals.ingestionService as ArxivIngestionService;

      const { id } = req.body;
      if (!id || typeof id !== "string") {
        res.status(400).json({ error: "id (string) is required — arXiv ID, DOI, or Semantic Scholar ID" });
        return;
      }

      const ingested = await ingestionService.ingestHistoricalPaper(id);
      res.json({ ok: true, ingested });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "ingest-paper-failed", { error: message });
      res.status(500).json({ error: "Failed to ingest paper." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/ingestion/status — Current ingestion stats (public)
// -------------------------------------------------------
router.get(
  "/ingestion/status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      // pool from factory closure

      const [runsResult, paperCountResult, pendingCountResult] = await Promise.all([
        pool.query(
          `SELECT id, category, papers_found, papers_passed, papers_failed, started_at, completed_at
           FROM ingestion_runs
           ORDER BY started_at DESC
           LIMIT 10`,
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM arxiv_content_map`),
        pool.query(`SELECT COUNT(*)::int AS total FROM pending_citations WHERE resolved_cid IS NULL`),
      ]);

      res.json({
        recentRuns: runsResult.rows,
        totalPapersIngested: paperCountResult.rows[0]?.total ?? 0,
        pendingCitations: pendingCountResult.rows[0]?.total ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-ingestion-status-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve ingestion status." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/ingestion/papers — List ingested papers (public, paginated)
// -------------------------------------------------------
router.get(
  "/ingestion/papers",
  async (req: Request, res: Response): Promise<void> => {
    try {
      // pool from factory closure

      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const offset = (page - 1) * limit;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const minQuality = parseInt(String(req.query.minQuality ?? "0"), 10) || 0;
      const sort = typeof req.query.sort === "string" ? req.query.sort : "newest";

      const conditions: string[] = [];
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (category) {
        conditions.push(`categories @> $${paramIdx}::jsonb`);
        params.push(JSON.stringify([category]));
        paramIdx++;
      }

      if (minQuality > 0) {
        conditions.push(`quality_score >= $${paramIdx}`);
        params.push(minQuality);
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Sort options
      const SORT_MAP: Record<string, string> = {
        "newest": "ingested_at DESC",
        "pub-newest": "published_date DESC NULLS LAST",
        "pub-oldest": "published_date ASC NULLS LAST",
        "most-cited": "citation_count DESC",
        "highest-quality": "quality_score DESC",
      };
      const orderBy = SORT_MAP[sort] ?? SORT_MAP["newest"];

      const countQuery = `SELECT COUNT(*)::int AS total FROM arxiv_content_map ${whereClause}`;
      const dataQuery = `
        SELECT id, arxiv_id, doi, semantic_scholar_id, content_cid, title, authors, categories,
               published_date, quality_score, citation_count, grokipedia_score, ingested_at
        FROM arxiv_content_map
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;

      const dataParams = [...params, limit, offset];

      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, params),
        pool.query(dataQuery, dataParams),
      ]);

      const total = countResult.rows[0]?.total ?? 0;

      res.json({
        papers: dataResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "list-papers-failed", { error: message });
      res.status(500).json({ error: "Failed to list papers." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/ingestion/papers/:arxivId — Single paper detail (public)
// -------------------------------------------------------
router.get(
  "/ingestion/papers/:arxivId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      // pool from factory closure
      const param = req.params.arxivId as string;

      // If param is numeric, look up by DB id; otherwise by arxiv_id
      const isNumeric = /^\d+$/.test(param);
      const { rows } = await pool.query(
        `SELECT id, arxiv_id, doi, semantic_scholar_id, content_cid, title, authors, categories,
                published_date, quality_score, quality_breakdown, citation_count, grokipedia_score, ingested_at
         FROM arxiv_content_map
         WHERE ${isNumeric ? "id = $1" : "arxiv_id = $1"}`,
        [isNumeric ? parseInt(param, 10) : param],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Paper not found" });
        return;
      }

      const paper = rows[0];

      // Also fetch any pending citations originating from this paper
      const { rows: pendingCites } = await pool.query(
        `SELECT target_external_id, target_platform, resolved_cid, resolved_at, created_at
         FROM pending_citations
         WHERE source_cid = $1
         ORDER BY created_at DESC`,
        [paper.content_cid],
      );

      res.json({
        ...paper,
        pendingCitations: pendingCites,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-paper-detail-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve paper." });
    }
  },
);

  return router;
}
