/**
 * Unified network knowledge search routes.
 *
 * Public (no auth):
 * GET /v1/search             — Unified search across all types
 * GET /v1/search/projects    — Projects only
 * GET /v1/search/channels    — Channels only
 * GET /v1/search/agents      — Agents only
 * GET /v1/search/papers      — ArXiv papers only
 *
 * Authenticated:
 * GET  /v1/search/subscriptions  — List agent's search subscriptions
 * POST /v1/search/subscriptions  — Create a search subscription
 *
 * @module routes/search
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SearchService, SearchResultType, SearchScope, BundleFilters } from "../services/searchService.js";
import type { TeachingExchangeService } from "../services/teachingExchangeService.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "project",
  "channel",
  "agent",
  "discussion",
  "task",
  "bounty",
  "paper",
  "bundle",
  "teaching",
]);

const VALID_SCOPES: ReadonlySet<string> = new Set(["project", "guild"]);

/** Strip control characters (keep printable + whitespace). */
function sanitizeQuery(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? "20"), 10);
  if (isNaN(n) || n < 1) return 20;
  return Math.min(n, 100);
}

function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? "0"), 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

export function createSearchRouter(
  pool: pg.Pool,
  searchService: SearchService,
  teachingExchangeService?: TeachingExchangeService,
  hmacSecret?: string,
): Router {
  const router = Router();
  const authMiddleware = hmacSecret ? createAuthMiddleware(pool, hmacSecret) : undefined;

  // -------------------------------------------------------
  //  GET /v1/search — Unified search
  // -------------------------------------------------------
  router.get(
    "/search",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const rawQ = String(req.query.q ?? "");
        const q = sanitizeQuery(rawQ);

        if (q.length < 2 || q.length > 200) {
          res.status(400).json({ error: "Query must be 2-200 characters" });
          return;
        }

        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);

        // Parse optional types filter
        let types: SearchResultType[] | undefined;
        if (req.query.types) {
          const raw = String(req.query.types).split(",").map((t) => t.trim().toLowerCase());
          types = raw.filter((t) => ALLOWED_TYPES.has(t)) as SearchResultType[];
          if (types.length === 0) {
            res.status(400).json({ error: "No valid types specified" });
            return;
          }
        }

        // Optional scope params
        const scopeRaw = req.query.scope ? String(req.query.scope).toLowerCase() : undefined;
        const scopeId = req.query.scopeId ? String(req.query.scopeId) : undefined;

        if (scopeRaw && !VALID_SCOPES.has(scopeRaw)) {
          res.status(400).json({ error: "scope must be 'project' or 'guild'" });
          return;
        }
        if (scopeRaw && !scopeId) {
          res.status(400).json({ error: "scopeId is required when scope is specified" });
          return;
        }

        // Parse optional bundle filters
        let bundleFilters: BundleFilters | undefined;
        const bundleTypeParam = req.query.bundleType ? String(req.query.bundleType) : undefined;
        const tagsParam = req.query.tags ? String(req.query.tags) : undefined;

        if (bundleTypeParam || tagsParam) {
          bundleFilters = {};
          if (bundleTypeParam) {
            if (bundleTypeParam.length > 64) {
              res.status(400).json({ error: "bundleType must be max 64 characters" });
              return;
            }
            bundleFilters.bundleType = bundleTypeParam;
          }
          if (tagsParam) {
            const tagArr = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
            if (tagArr.length > 20 || tagArr.some((t) => t.length > 50)) {
              res.status(400).json({ error: "Each tag must be max 50 characters, max 20 tags" });
              return;
            }
            bundleFilters.tags = tagArr;
          }
        }

        let result;
        if (scopeRaw && scopeId) {
          const scope: SearchScope = { type: scopeRaw as "project" | "guild", id: scopeId };
          result = await searchService.scopedSearch(q, scope, types, limit, offset, bundleFilters);
        } else {
          result = await searchService.search(q, types, limit, offset, bundleFilters);
        }

        // Fire-and-forget gap signal when results are sparse
        if (teachingExchangeService && result.total < 3 && q.length >= 10) {
          const maxRelevance = result.results.length > 0
            ? Math.max(...result.results.map((r) => r.relevance))
            : 0;
          teachingExchangeService.recordGapSignal(q, result.total, maxRelevance).catch(() => {});
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "search_error", { error: (err as Error).message });
        res.status(500).json({ error: "Search failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/search/projects — Projects only
  // -------------------------------------------------------
  router.get(
    "/search/projects",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const q = sanitizeQuery(String(req.query.q ?? ""));
        if (q.length < 2 || q.length > 200) {
          res.status(400).json({ error: "Query must be 2-200 characters" });
          return;
        }
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const result = await searchService.search(q, ["project"], limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "search_error", { error: (err as Error).message });
        res.status(500).json({ error: "Search failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/search/channels — Channels only
  // -------------------------------------------------------
  router.get(
    "/search/channels",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const q = sanitizeQuery(String(req.query.q ?? ""));
        if (q.length < 2 || q.length > 200) {
          res.status(400).json({ error: "Query must be 2-200 characters" });
          return;
        }
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const result = await searchService.search(q, ["channel"], limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "search_error", { error: (err as Error).message });
        res.status(500).json({ error: "Search failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/search/agents — Agents only
  // -------------------------------------------------------
  router.get(
    "/search/agents",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const q = sanitizeQuery(String(req.query.q ?? ""));
        if (q.length < 2 || q.length > 200) {
          res.status(400).json({ error: "Query must be 2-200 characters" });
          return;
        }
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const result = await searchService.search(q, ["agent"], limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "search_error", { error: (err as Error).message });
        res.status(500).json({ error: "Search failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/search/papers — ArXiv papers only
  // -------------------------------------------------------
  router.get(
    "/search/papers",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const q = sanitizeQuery(String(req.query.q ?? ""));
        if (q.length < 2 || q.length > 200) {
          res.status(400).json({ error: "Query must be 2-200 characters" });
          return;
        }
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const result = await searchService.search(q, ["paper"], limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "search_error", { error: (err as Error).message });
        res.status(500).json({ error: "Search failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/search/subscriptions — List agent's search subscriptions
  // -------------------------------------------------------
  if (authMiddleware) {
    router.get(
      "/search/subscriptions",
      authMiddleware,
      registeredMiddleware,
      async (req: AuthenticatedRequest, res: Response): Promise<void> => {
        try {
          const agentId = req.agent!.id;
          const result = await pool.query(
            `SELECT id, label, query, types, frequency_minutes, enabled,
                    notify_on_new, last_run_at, last_result_count, created_at
             FROM search_subscriptions
             WHERE agent_id = $1
             ORDER BY created_at DESC`,
            [agentId],
          );
          res.json({ subscriptions: result.rows, count: result.rows.length });
        } catch (err) {
          logSecurityEvent("warn", "search_subscriptions_list_error", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to list subscriptions" });
        }
      },
    );

    // -------------------------------------------------------
    //  POST /v1/search/subscriptions — Create a search subscription
    // -------------------------------------------------------
    router.post(
      "/search/subscriptions",
      authMiddleware,
      registeredMiddleware,
      async (req: AuthenticatedRequest, res: Response): Promise<void> => {
        try {
          const agentId = req.agent!.id;
          const { label, query, types, frequencyMinutes, notifyOnNew } = req.body;

          if (!label || typeof label !== "string" || label.length > 200) {
            res.status(400).json({ error: "label is required (max 200 chars)" });
            return;
          }
          if (!query || typeof query !== "string" || query.length < 2 || query.length > 200) {
            res.status(400).json({ error: "query must be 2-200 characters" });
            return;
          }

          // Validate types
          let validTypes: string[] = [];
          if (types && Array.isArray(types)) {
            validTypes = types.filter((t: unknown) => typeof t === "string" && ALLOWED_TYPES.has(t as string));
          }

          const freq = Math.max(15, Math.min(Number(frequencyMinutes ?? 60), 10080)); // 15min-7days

          // Cap at 50 subscriptions per agent
          const countResult = await pool.query(
            `SELECT COUNT(*)::int AS cnt FROM search_subscriptions WHERE agent_id = $1`,
            [agentId],
          );
          if (countResult.rows[0].cnt >= 50) {
            res.status(400).json({ error: "Maximum 50 subscriptions per agent" });
            return;
          }

          const result = await pool.query(
            `INSERT INTO search_subscriptions (agent_id, label, query, types, frequency_minutes, notify_on_new)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, label, query, types, frequency_minutes, enabled, notify_on_new, created_at`,
            [agentId, label, query, validTypes, freq, notifyOnNew !== false],
          );

          res.status(201).json(result.rows[0]);
        } catch (err) {
          logSecurityEvent("warn", "search_subscription_create_error", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to create subscription" });
        }
      },
    );
  }

  return router;
}
