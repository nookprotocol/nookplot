/**
 * Citation routes — query citation relationships between content.
 *
 * GET    /v1/citations/most-cited        — Most-cited content (public)
 * GET    /v1/citations/pending           — Unresolved pending citations (admin)
 * GET    /v1/citations/:cid             — Citations for a content CID (public)
 * GET    /v1/citations/:cid/tree        — Citation tree, recursive (public)
 *
 * @module routes/citations
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

const router = Router();

// -------------------------------------------------------
//  GET /v1/citations/graph — Full citation graph (public)
// -------------------------------------------------------
router.get(
  "/citations/graph",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pool = req.app.locals.pool as pg.Pool;

      const [nodesResult, edgesResult] = await Promise.all([
        pool.query(
          `SELECT id, arxiv_id, content_cid, title, categories, citation_count, quality_score
           FROM arxiv_content_map ORDER BY id`,
        ),
        pool.query(
          `SELECT source_cid, resolved_cid
           FROM pending_citations WHERE resolved_cid IS NOT NULL`,
        ),
      ]);

      const nodes = nodesResult.rows.map((r) => ({
        id: r.content_cid,
        arxivId: r.arxiv_id,
        title: r.title,
        categories: r.categories ?? [],
        citationCount: r.citation_count ?? 0,
        qualityScore: r.quality_score ?? 0,
      }));

      const edges = edgesResult.rows.map((r) => ({
        source: r.source_cid,
        target: r.resolved_cid,
      }));

      res.json({
        nodes,
        edges,
        meta: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-citation-graph-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve citation graph." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/citations/most-cited — Most-cited content (public)
// -------------------------------------------------------
router.get(
  "/citations/most-cited",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pool = req.app.locals.pool as pg.Pool;

      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const community = typeof req.query.community === "string" ? req.query.community : undefined;

      let query: string;
      const params: (string | number)[] = [];

      if (community) {
        query = `
          SELECT id, arxiv_id, doi, semantic_scholar_id, content_cid, title, authors, categories,
                 published_date, quality_score, citation_count, grokipedia_score, ingested_at
          FROM arxiv_content_map
          WHERE categories @> $1::jsonb AND citation_count > 0
          ORDER BY citation_count DESC
          LIMIT $2
        `;
        params.push(JSON.stringify([community]), limit);
      } else {
        query = `
          SELECT id, arxiv_id, doi, semantic_scholar_id, content_cid, title, authors, categories,
                 published_date, quality_score, citation_count, grokipedia_score, ingested_at
          FROM arxiv_content_map
          WHERE citation_count > 0
          ORDER BY citation_count DESC
          LIMIT $1
        `;
        params.push(limit);
      }

      const { rows } = await pool.query(query, params);
      res.json({ papers: rows, count: rows.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-most-cited-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve most-cited content." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/citations/pending — Unresolved pending citations (admin)
// -------------------------------------------------------
router.get(
  "/citations/pending",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pool = req.app.locals.pool as pg.Pool;

      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const offset = (page - 1) * limit;

      const [countResult, dataResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total FROM pending_citations WHERE resolved_cid IS NULL`,
        ),
        pool.query(
          `SELECT pc.id, pc.source_cid, pc.target_external_id, pc.target_platform, pc.created_at,
                  acm.title AS source_title
           FROM pending_citations pc
           LEFT JOIN arxiv_content_map acm ON acm.content_cid = pc.source_cid
           WHERE pc.resolved_cid IS NULL
           ORDER BY pc.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
      ]);

      const total = countResult.rows[0]?.total ?? 0;

      res.json({
        citations: dataResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-pending-citations-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve pending citations." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/citations/:cid — Citations for a content CID (public)
// -------------------------------------------------------
router.get(
  "/citations/:cid",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pool = req.app.locals.pool as pg.Pool;
      const cid = req.params.cid as string;

      // Outbound: this CID cites other papers (pending_citations where source_cid = cid)
      const { rows: outbound } = await pool.query(
        `SELECT pc.id, pc.target_external_id, pc.target_platform, pc.resolved_cid, pc.resolved_at,
                pc.created_at, acm.title AS resolved_title, acm.arxiv_id AS resolved_arxiv_id
         FROM pending_citations pc
         LEFT JOIN arxiv_content_map acm ON acm.content_cid = pc.resolved_cid
         WHERE pc.source_cid = $1
         ORDER BY pc.created_at DESC`,
        [cid],
      );

      // Inbound: other papers cite this CID (pending_citations where resolved_cid = cid)
      const { rows: inbound } = await pool.query(
        `SELECT pc.id, pc.source_cid, pc.target_external_id, pc.target_platform, pc.created_at,
                acm.title AS source_title, acm.arxiv_id AS source_arxiv_id
         FROM pending_citations pc
         LEFT JOIN arxiv_content_map acm ON acm.content_cid = pc.source_cid
         WHERE pc.resolved_cid = $1
         ORDER BY pc.created_at DESC`,
        [cid],
      );

      res.json({
        cid,
        outbound,
        inbound,
        counts: {
          outbound: outbound.length,
          inbound: inbound.length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-citations-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve citations." });
    }
  },
);

// -------------------------------------------------------
//  GET /v1/citations/:cid/tree — Citation tree, recursive (public)
// -------------------------------------------------------
router.get(
  "/citations/:cid/tree",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pool = req.app.locals.pool as pg.Pool;
      const cid = req.params.cid as string;
      const maxDepth = Math.min(10, Math.max(1, parseInt(String(req.query.depth ?? "3"), 10) || 3));
      const direction = typeof req.query.direction === "string" && ["outbound", "inbound", "both"].includes(req.query.direction)
        ? (req.query.direction as "outbound" | "inbound" | "both")
        : "both";

      interface TreeNode {
        cid: string;
        title: string | null;
        arxivId: string | null;
        depth: number;
        direction: "root" | "outbound" | "inbound";
        children: TreeNode[];
      }

      const visited = new Set<string>();

      async function buildTree(
        currentCid: string,
        depth: number,
        dir: "root" | "outbound" | "inbound",
      ): Promise<TreeNode> {
        // Look up paper metadata for this CID
        const { rows: meta } = await pool.query(
          `SELECT title, arxiv_id FROM arxiv_content_map WHERE content_cid = $1 LIMIT 1`,
          [currentCid],
        );

        const node: TreeNode = {
          cid: currentCid,
          title: meta[0]?.title ?? null,
          arxivId: meta[0]?.arxiv_id ?? null,
          depth,
          direction: dir,
          children: [],
        };

        visited.add(currentCid);

        if (depth >= maxDepth) {
          return node;
        }

        // Outbound children: papers this CID cites (resolved only)
        if (direction === "both" || direction === "outbound") {
          const { rows: outRefs } = await pool.query(
            `SELECT resolved_cid FROM pending_citations
             WHERE source_cid = $1 AND resolved_cid IS NOT NULL`,
            [currentCid],
          );

          for (const ref of outRefs) {
            if (!visited.has(ref.resolved_cid)) {
              const child = await buildTree(ref.resolved_cid, depth + 1, "outbound");
              node.children.push(child);
            }
          }
        }

        // Inbound children: papers that cite this CID (resolved only)
        if (direction === "both" || direction === "inbound") {
          const { rows: inRefs } = await pool.query(
            `SELECT source_cid FROM pending_citations
             WHERE resolved_cid = $1`,
            [currentCid],
          );

          for (const ref of inRefs) {
            if (!visited.has(ref.source_cid)) {
              const child = await buildTree(ref.source_cid, depth + 1, "inbound");
              node.children.push(child);
            }
          }
        }

        return node;
      }

      const tree = await buildTree(cid, 0, "root");
      res.json({ tree });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "get-citation-tree-failed", { error: message });
      res.status(500).json({ error: "Failed to retrieve citation tree." });
    }
  },
);

export default router;
