/**
 * Swarm REST routes — task decomposition, parallel execution, result aggregation.
 *
 * POST   /v1/swarms                        — Create swarm with subtasks
 * GET    /v1/swarms                        — List swarms
 * GET    /v1/swarms/subtasks               — Get available subtasks (open, with optional skill filter)
 * GET    /v1/swarms/:id                    — Get swarm detail + subtasks
 * POST   /v1/swarms/:id/cancel             — Cancel swarm
 * POST   /v1/swarms/:id/aggregate          — Complete swarm with summary
 * GET    /v1/swarms/:id/results            — Get swarm results
 * POST   /v1/swarms/subtasks/:stId/claim   — Claim subtask
 * POST   /v1/swarms/subtasks/:stId/submit  — Submit subtask result
 * POST   /v1/swarms/subtasks/:stId/accept  — Accept submitted result
 * POST   /v1/swarms/subtasks/:stId/reject  — Reject submitted result
 *
 * @module routes/swarms
 */

import { Router } from "express";
import type pg from "pg";
import type { SwarmService } from "../services/swarmService.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";
import type { Request, Response } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuthState {
  user: { id: string; address: string };
  agent: { id: string; address: string; tier?: number };
}

export function createSwarmRouter(
  pool: pg.Pool,
  hmacSecret: string,
  swarmService: SwarmService,
): Router {
  const router = Router();
  router.use(createMethodAwareRateLimiter(createReadKeyRateLimiter(60_000, 120), createKeyRateLimiter(60_000, 30)));
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  const getAuth = (req: any): AuthState | null => {
    const agent = req.agent;
    return agent?.id ? { user: { id: agent.id, address: agent.address }, agent } : null;
  };

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
  router.param("id", validateUuid("swarm ID"));
  router.param("stId", validateUuid("subtask ID"));

  // -------------------------------------------------------
  //  POST /v1/swarms — Create swarm
  // -------------------------------------------------------
  router.post(
    "/swarms",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { title, description, workspaceId, subtasks } = req.body;
        if (!title || typeof title !== "string") {
          res.status(400).json({ error: "title is required" }); return;
        }
        if (!Array.isArray(subtasks) || subtasks.length === 0) {
          res.status(400).json({ error: "subtasks array is required" }); return;
        }

        const data = await swarmService.createSwarm(s.agent.id, { title, description, workspaceId, subtasks });
        res.status(201).json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/swarms — List swarms
  // -------------------------------------------------------
  router.get(
    "/swarms",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await swarmService.listSwarms({
          workspaceId: req.query.workspaceId as string | undefined,
          creatorId: req.query.mine === "true" ? s.agent.id : undefined,
          status: req.query.status as string | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "swarm-list-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/swarms/subtasks — Available subtasks
  // -------------------------------------------------------
  router.get(
    "/swarms/subtasks",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const skillTags = req.query.skills ? String(req.query.skills).split(",") : undefined;
        const data = await swarmService.getAvailableSubtasks({
          swarmId: req.query.swarmId as string | undefined,
          skillTags,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "swarm-subtasks-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/swarms/:id — Swarm detail
  // -------------------------------------------------------
  router.get(
    "/swarms/:id",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const data = await swarmService.getSwarm(String(req.params.id));
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/:id/cancel
  // -------------------------------------------------------
  router.post(
    "/swarms/:id/cancel",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        await swarmService.cancelSwarm(s.agent.id, String(req.params.id));
        res.json({ data: { cancelled: true } });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/:id/aggregate
  // -------------------------------------------------------
  router.post(
    "/swarms/:id/aggregate",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { summary } = req.body;
        const data = await swarmService.aggregateResults(s.agent.id, String(req.params.id), summary || {});
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/swarms/:id/results
  // -------------------------------------------------------
  router.get(
    "/swarms/:id/results",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const data = await swarmService.getResults(String(req.params.id));
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "swarm-results-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/subtasks/:stId/claim
  // -------------------------------------------------------
  router.post(
    "/swarms/subtasks/:stId/claim",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await swarmService.claimSubtask(s.agent.id, String(req.params.stId));
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/subtasks/:stId/submit
  // -------------------------------------------------------
  router.post(
    "/swarms/subtasks/:stId/submit",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { content, resultType } = req.body;
        if (!content) {
          res.status(400).json({ error: "content is required" }); return;
        }

        const data = await swarmService.submitResult(s.agent.id, String(req.params.stId), content, resultType);
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/subtasks/:stId/accept
  // -------------------------------------------------------
  router.post(
    "/swarms/subtasks/:stId/accept",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await swarmService.acceptResult(s.agent.id, String(req.params.stId));
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/swarms/subtasks/:stId/reject
  // -------------------------------------------------------
  router.post(
    "/swarms/subtasks/:stId/reject",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { feedback } = req.body;
        if (!feedback || typeof feedback !== "string") {
          res.status(400).json({ error: "feedback is required" }); return;
        }

        const data = await swarmService.rejectResult(s.agent.id, String(req.params.stId), feedback);
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  return router;
}

// ── Error Mapping ─────────────────────────────────────────────────────────────

function mapError(res: any, err: any): void {
  const code = err.code as string | undefined;
  switch (code) {
    case "INSUFFICIENT_CREDITS":
      res.status(402).json({ error: err.message });
      break;
    case "FORBIDDEN":
      res.status(403).json({ error: err.message });
      break;
    case "NOT_FOUND":
      res.status(404).json({ error: err.message });
      break;
    case "CONFLICT":
    case "SUBTASK_NOT_OPEN":
      res.status(409).json({ error: err.message });
      break;
    case "DEPS_INCOMPLETE":
    case "INVALID_STATUS":
    case "VALIDATION":
      res.status(400).json({ error: err.message });
      break;
    default:
      logSecurityEvent("warn", "swarm-route-error", { error: err.message, code });
      res.status(500).json({ error: "Internal error" });
  }
}
