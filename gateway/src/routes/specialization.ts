/**
 * Specialization REST routes — niche detection, skill gaps, demand/supply signals, recommendations.
 *
 * POST   /v1/specialization/gaps                     — Record a skill gap
 * GET    /v1/specialization/gaps                     — List open gaps
 * POST   /v1/specialization/gaps/:id/resolve         — Mark gap as resolved
 * POST   /v1/specialization/signals                  — Record demand/supply signal
 * GET    /v1/specialization/signals                  — Get aggregated signals
 * PUT    /v1/specialization/proficiency              — Update agent proficiency
 * GET    /v1/specialization/profile                  — Get agent specialization profile
 * GET    /v1/specialization/profile/:agentId         — Get another agent's profile
 * POST   /v1/specialization/recommendations/generate — Generate recommendations
 * GET    /v1/specialization/recommendations          — Get existing recommendations
 * DELETE /v1/specialization/recommendations/:id      — Dismiss recommendation
 * GET    /v1/specialization/landscape                — Network skill landscape
 *
 * @module routes/specialization
 */

import { Router } from "express";
import type pg from "pg";
import type { SpecializationService } from "../services/specializationService.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";
import type { Request, Response } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuthState {
  user: { id: string; address: string };
  agent: { id: string; address: string; tier?: number };
}

export function createSpecializationRouter(
  pool: pg.Pool,
  hmacSecret: string,
  specializationService: SpecializationService,
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
  router.param("id", validateUuid("specialization ID"));
  router.param("agentId", validateUuid("agent ID"));

  const getAuth = (req: any): AuthState | null => {
    const agent = req.agent;
    return agent?.id ? { user: { id: agent.id, address: agent.address }, agent } : null;
  };

  // -------------------------------------------------------
  //  POST /v1/specialization/gaps — Record a skill gap
  // -------------------------------------------------------
  router.post(
    "/specialization/gaps",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { queryText, queryTags, communityId } = req.body;
        if (!queryText || typeof queryText !== "string") {
          res.status(400).json({ error: "queryText is required" }); return;
        }

        const result = await specializationService.recordGap(queryText, queryTags || [], communityId);
        res.status(201).json({ data: { recorded: true, ...(result.matchingSkills ? { matchingSkills: result.matchingSkills } : {}) } });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/gaps — List open gaps
  // -------------------------------------------------------
  router.get(
    "/specialization/gaps",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const data = await specializationService.listGaps({
          tag: req.query.tag as string | undefined,
          communityId: req.query.communityId as string | undefined,
          minCount: req.query.minCount ? Number(req.query.minCount) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-gaps-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/specialization/gaps/:id/resolve
  // -------------------------------------------------------
  router.post(
    "/specialization/gaps/:id/resolve",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await specializationService.resolveGap(s.agent.id, String(req.params.id));
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/specialization/signals — Record signal
  // -------------------------------------------------------
  router.post(
    "/specialization/signals",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { skillDomain, signalType, intensity, sourceType, sourceId, metadata } = req.body;
        if (!skillDomain || !signalType) {
          res.status(400).json({ error: "skillDomain and signalType are required" }); return;
        }

        await specializationService.recordSignal(skillDomain, signalType, intensity, sourceType, sourceId, metadata);
        res.status(201).json({ data: { recorded: true } });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/signals — Aggregated signals
  // -------------------------------------------------------
  router.get(
    "/specialization/signals",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const data = await specializationService.getSignals({
          skillDomain: req.query.skillDomain as string | undefined,
          signalType: req.query.signalType as string | undefined,
          days: req.query.days ? Number(req.query.days) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-signals-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/specialization/proficiency
  // -------------------------------------------------------
  router.put(
    "/specialization/proficiency",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { skillDomain, proficiency } = req.body;
        if (!skillDomain || proficiency == null) {
          res.status(400).json({ error: "skillDomain and proficiency are required" }); return;
        }

        const data = await specializationService.updateProficiency(s.agent.id, skillDomain, Number(proficiency));
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/profile — Own profile
  // -------------------------------------------------------
  router.get(
    "/specialization/profile",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await specializationService.getProfile(s.agent.id);
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-profile-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/profile/:agentId — Other profile
  // -------------------------------------------------------
  router.get(
    "/specialization/profile/:agentId",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const data = await specializationService.getProfile(String(req.params.agentId));
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-profile-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/specialization/recommendations/generate
  // -------------------------------------------------------
  router.post(
    "/specialization/recommendations/generate",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await specializationService.generateRecommendations(s.agent.id);
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/recommendations
  // -------------------------------------------------------
  router.get(
    "/specialization/recommendations",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await specializationService.getRecommendations(
          s.agent.id, req.query.status as string | undefined,
        );
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-recs-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/specialization/recommendations/:id
  // -------------------------------------------------------
  router.delete(
    "/specialization/recommendations/:id",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        await specializationService.dismissRecommendation(s.agent.id, String(req.params.id));
        res.json({ data: { dismissed: true } });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/specialization/landscape
  // -------------------------------------------------------
  router.get(
    "/specialization/landscape",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const days = req.query.days ? Number(req.query.days) : undefined;
        const data = await specializationService.getSkillLandscape(days);
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "spec-landscape-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  return router;
}

// ── Error Mapping ─────────────────────────────────────────────────────────────

function mapError(res: any, err: any): void {
  const code = err.code as string | undefined;
  switch (code) {
    case "NOT_FOUND":
      res.status(404).json({ error: err.message });
      break;
    case "VALIDATION":
      res.status(400).json({ error: err.message });
      break;
    default:
      logSecurityEvent("warn", "spec-route-error", { error: err.message, code });
      res.status(500).json({ error: "Internal error" });
  }
}
