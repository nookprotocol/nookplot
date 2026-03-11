/**
 * GPU marketplace routes — heartbeats, availability, and buyer challenges.
 *
 * Provider endpoints require authentication; buyer challenge endpoints
 * require authentication for creation. All read endpoints are public.
 *
 * @module routes/gpu
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter } from "../middleware/rateLimit.js";
import type { GpuAvailabilityService } from "../services/gpuAvailabilityService.js";
import { toPublicRow } from "../services/gpuAvailabilityService.js";
import type { GpuChallengeService } from "../services/gpuChallengeService.js";

export function createGpuRouter(
  pool: pg.Pool,
  hmacSecret: string,
  gpuAvailabilityService: GpuAvailabilityService,
  gpuChallengeService: GpuChallengeService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  // Heartbeat can be frequent (every 60s), allow 120/hour per agent
  const heartbeatLimiter = createKeyRateLimiter(3_600_000, 120);
  // Challenge creation limited to 10/hour per agent
  const challengeLimiter = createKeyRateLimiter(3_600_000, 10);

  // ============================================================
  //  HEARTBEAT (Provider → Gateway)
  // ============================================================

  /**
   * POST /v1/gpu/heartbeat — Provider sends GPU heartbeat
   *
   * Body: { listingId, status, gpuModel?, vramGb?, gpuTempC?,
   *         gpuUtilization?, vramUsedGb?, currentAgreementId? }
   */
  router.post(
    "/gpu/heartbeat",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    heartbeatLimiter,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const { listingId, status, gpuModel, vramGb, gpuTempC, gpuUtilization, vramUsedGb, currentAgreementId } = req.body;

        if (!listingId || typeof listingId !== "number") {
          res.status(400).json({ error: "listingId (number) is required." });
          return;
        }

        // Verify listing exists and is owned by this agent
        const { rows: listingRows } = await pool.query<{ provider_address: string }>(
          `SELECT LOWER(sl.provider_address) AS provider_address
           FROM service_listings sl
           WHERE sl.listing_id = $1`,
          [listingId],
        );
        if (listingRows.length === 0) {
          res.status(404).json({ error: "Listing not found." });
          return;
        }
        if (listingRows[0].provider_address !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "You do not own this listing." });
          return;
        }

        const result = await gpuAvailabilityService.recordHeartbeat({
          providerAddress: agent.address,
          listingId,
          status: status ?? "idle",
          gpuModel,
          vramGb,
          gpuTempC,
          gpuUtilization,
          vramUsedGb,
          currentAgreementId,
        });

        res.json({ ok: true, availability: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-heartbeat-failed", { error: message, agent: agent.address });
        res.status(500).json({ error: "Failed to record heartbeat." });
      }
    },
  );

  // ============================================================
  //  AVAILABILITY (Tiered disclosure)
  //
  //  Public:        vram_tier, status, listing_id, last_heartbeat
  //  Authenticated: + gpu_model, vram_gb, provider_address
  //  Agreement:     + telemetry (temp, utilization, vram_used)
  // ============================================================

  /**
   * Try to extract authenticated agent from request without failing.
   * Returns null if not authenticated — used for optional auth.
   */
  async function tryAuth(req: Request): Promise<{ address: string } | null> {
    try {
      // Attempt to parse the session cookie / API key without middleware
      const apiKey = req.headers["x-api-key"] as string | undefined;
      const cookie = req.headers.cookie;
      if (!apiKey && !cookie) return null;
      // Look up agent by API key
      if (apiKey) {
        const { rows } = await pool.query<{ address: string }>(
          `SELECT a.address FROM agents a JOIN api_keys k ON k.agent_id = a.id WHERE k.key_hash = encode(sha256($1::bytea), 'hex') AND k.revoked = FALSE`,
          [Buffer.from(apiKey)],
        );
        return rows[0] ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if caller has an active agreement with a provider.
   */
  async function hasAgreementWith(callerAddress: string, providerAddress: string): Promise<boolean> {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM service_agreements sa
       JOIN agents buyer ON buyer.id = sa.buyer_agent_id
       JOIN agents provider ON provider.id = sa.provider_agent_id
       WHERE LOWER(buyer.address) = LOWER($1)
         AND LOWER(provider.address) = LOWER($2)
         AND sa.status IN ('agreed', 'delivered')`,
      [callerAddress, providerAddress],
    );
    return parseInt(rows[0]?.c ?? "0", 10) > 0;
  }

  /**
   * GET /v1/gpu/availability — List available GPUs with live status
   *
   * Public: redacted (vram tier, status only)
   * Authenticated: full specs (model, vram, provider address)
   */
  router.get(
    "/gpu/availability",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const gpuModel = typeof req.query.gpuModel === "string" ? req.query.gpuModel : undefined;
        const minVram = typeof req.query.minVram === "string" ? parseInt(req.query.minVram, 10) : undefined;
        const status = typeof req.query.status === "string" ? req.query.status as "online" | "degraded" | "any" : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const gpus = await gpuAvailabilityService.searchAvailableGpus({
          gpuModel,
          minVram: isNaN(minVram!) ? undefined : minVram,
          status,
          limit,
          offset,
        });

        const caller = await tryAuth(req);

        if (caller) {
          // Authenticated: return specs but strip telemetry
          const authedGpus = gpus.map((g) => ({
            provider_address: g.provider_address,
            listing_id: g.listing_id,
            status: g.status,
            gpu_model: g.gpu_model,
            vram_gb: g.vram_gb,
            last_heartbeat: g.last_heartbeat,
            current_agreement_id: g.current_agreement_id,
            // telemetry intentionally omitted
          }));
          res.json({ gpus: authedGpus, limit, offset });
        } else {
          // Public: redacted
          res.json({ gpus: gpus.map(toPublicRow), limit, offset });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-availability-search-failed", { error: message });
        res.status(500).json({ error: "Failed to search GPU availability." });
      }
    },
  );

  /**
   * GET /v1/gpu/availability/:listingId — Single listing availability
   *
   * Public: redacted. Auth: specs. Agreement party: full telemetry.
   */
  router.get(
    "/gpu/availability/:listingId",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const listingId = parseInt(req.params.listingId as string, 10);
        if (isNaN(listingId)) {
          res.status(400).json({ error: "Listing ID must be a number." });
          return;
        }

        const availability = await gpuAvailabilityService.getAvailability(listingId);
        if (!availability) {
          res.status(404).json({ error: "No availability data for this listing." });
          return;
        }

        const caller = await tryAuth(req);

        if (caller && availability.provider_address) {
          const isParty = await hasAgreementWith(caller.address, availability.provider_address);
          if (isParty) {
            // Agreement party: full data including telemetry
            res.json({ availability });
            return;
          }
          // Authenticated: specs without telemetry
          res.json({
            availability: {
              provider_address: availability.provider_address,
              listing_id: availability.listing_id,
              status: availability.status,
              gpu_model: availability.gpu_model,
              vram_gb: availability.vram_gb,
              last_heartbeat: availability.last_heartbeat,
              current_agreement_id: availability.current_agreement_id,
            },
          });
        } else {
          // Public: redacted
          res.json({ availability: toPublicRow(availability) });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-availability-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to get availability." });
      }
    },
  );

  // ============================================================
  //  BUYER CHALLENGES
  // ============================================================

  /**
   * POST /v1/gpu/challenge — Initiate a buyer challenge
   *
   * Body: { listingId, providerAddress, challengeInputCid, expectedMinTflops? }
   */
  router.post(
    "/gpu/challenge",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    challengeLimiter,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const { listingId, providerAddress, challengeInputCid, expectedMinTflops } = req.body;

        if (!listingId || !providerAddress || !challengeInputCid) {
          res.status(400).json({ error: "listingId, providerAddress, and challengeInputCid are required." });
          return;
        }

        // Verify the listing exists and the provider actually owns it
        const { rows: listingCheck } = await pool.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM service_listings sl
           WHERE sl.listing_id = $1 AND LOWER(sl.provider_address) = LOWER($2)`,
          [listingId, providerAddress],
        );
        if (parseInt(listingCheck[0]?.c ?? "0", 10) === 0) {
          res.status(404).json({ error: "Listing not found or provider address does not match." });
          return;
        }

        const challenge = await gpuChallengeService.createChallenge({
          challengerAddress: agent.address,
          providerAddress,
          listingId,
          challengeInputCid,
          expectedMinTflops,
        });

        res.status(201).json({ challenge });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-challenge-create-failed", { error: message, agent: agent?.address });
        res.status(500).json({ error: "Failed to create challenge." });
      }
    },
  );

  /**
   * POST /v1/gpu/challenge/:id/submit — Provider submits challenge result
   *
   * Body: { challengeOutputCid, actualTflops?, wallTimeMs? }
   */
  router.post(
    "/gpu/challenge/:id/submit",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const { challengeOutputCid, actualTflops, wallTimeMs } = req.body;

        if (!challengeOutputCid) {
          res.status(400).json({ error: "challengeOutputCid is required." });
          return;
        }

        const challenge = await gpuChallengeService.submitChallengeResult({
          challengeId: req.params.id as string,
          providerAddress: agent.address,
          challengeOutputCid,
          actualTflops,
          wallTimeMs,
        });

        res.json({ challenge });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("not found") || message.includes("not your")) {
          res.status(404).json({ error: message });
          return;
        }
        if (message.includes("expired") || message.includes("cannot submit")) {
          res.status(409).json({ error: message });
          return;
        }

        logSecurityEvent("error", "gpu-challenge-submit-failed", { error: message, agent: agent.address });
        res.status(500).json({ error: "Failed to submit challenge result." });
      }
    },
  );

  /**
   * GET /v1/gpu/challenge/:id — Get challenge detail
   *
   * Auth required. Only challenger or provider can see full details.
   */
  router.get(
    "/gpu/challenge/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Authentication required to view challenge details." }); return; }

      try {
        const challenge = await gpuChallengeService.getChallenge(req.params.id as string);
        if (!challenge) {
          res.status(404).json({ error: "Challenge not found." });
          return;
        }

        // Only the challenger or provider can see full details
        const isParty = agent.address.toLowerCase() === challenge.challenger_address.toLowerCase() ||
          agent.address.toLowerCase() === challenge.provider_address.toLowerCase();
        if (!isParty) {
          // Redacted view: status + pass/fail only
          res.json({
            challenge: {
              challenge_id: challenge.challenge_id,
              listing_id: challenge.listing_id,
              status: challenge.status,
              created_at: challenge.created_at,
              completed_at: challenge.completed_at,
            },
          });
          return;
        }

        res.json({ challenge });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-challenge-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to get challenge." });
      }
    },
  );

  /**
   * GET /v1/gpu/providers/:address/challenges — Provider challenge stats
   *
   * Public: aggregate stats only (total, pass rate, last date).
   * Authenticated: + redacted challenge list (status, dates — no CIDs/TFLOPS).
   */
  router.get(
    "/gpu/providers/:address/challenges",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = req.params.address as string;
        const limit = parseInt(String(req.query.limit ?? "20"), 10) || 20;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const stats = await gpuChallengeService.getProviderChallengeStats(address);
        const caller = await tryAuth(req);

        if (!caller) {
          // Public: aggregate stats only — no individual challenge records
          res.json({ stats, limit, offset });
          return;
        }

        // Authenticated: include redacted challenge list
        const challenges = await gpuChallengeService.getProviderChallenges(address, limit, offset);
        const redactedChallenges = challenges.map((c) => ({
          challenge_id: c.challenge_id,
          listing_id: c.listing_id,
          status: c.status,
          created_at: c.created_at,
          completed_at: c.completed_at,
          // Omit: challenger_address, CIDs, TFLOPS, wall_time
        }));

        res.json({ challenges: redactedChallenges, stats, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "gpu-provider-challenges-failed", { error: message });
        res.status(500).json({ error: "Failed to get provider challenges." });
      }
    },
  );

  // ============================================================
  //  PROVIDER RESEARCH REPUTATION
  // ============================================================

  /**
   * GET /v1/gpu/providers/:address/research-stats
   *
   * Public — shows how many research experiments ran on this provider's GPU.
   */
  router.get(
    "/gpu/providers/:address/research-stats",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { address } = req.params;

        // Count agent-memory entries tagged "autoresearch" that reference this provider's listings
        // Since memories don't directly reference listing IDs, we query bundles that have gpu_listing metadata
        const { rows } = await pool.query(
          `SELECT
             COUNT(DISTINCT am.id) FILTER (WHERE am.tags @> ARRAY['autoresearch']) AS total_experiments,
             COUNT(DISTINCT am.id) FILTER (WHERE am.tags @> ARRAY['autoresearch', 'improvement']) AS improvements,
             COUNT(DISTINCT kb.bundle_id) AS bundles_produced
           FROM gpu_availability ga
           LEFT JOIN agent_memory am ON LOWER(am.agent_address) = LOWER(ga.provider_address)
             AND am.tags @> ARRAY['autoresearch']
           LEFT JOIN idx_knowledge_bundles kb ON LOWER(kb.creator_address) = LOWER(ga.provider_address)
           WHERE LOWER(ga.provider_address) = LOWER($1)`,
          [address],
        );

        const stats = rows[0] || { total_experiments: "0", improvements: "0", bundles_produced: "0" };

        res.json({
          ok: true,
          researchStats: {
            totalExperiments: parseInt(stats.total_experiments, 10),
            improvements: parseInt(stats.improvements, 10),
            bundlesProduced: parseInt(stats.bundles_produced, 10),
            successRate: parseInt(stats.total_experiments, 10) > 0
              ? Math.round((parseInt(stats.improvements, 10) / parseInt(stats.total_experiments, 10)) * 100)
              : 0,
          },
        });
      } catch (err) {
        console.error("GPU research stats error:", err);
        res.status(500).json({ error: "Failed to fetch research stats" });
      }
    },
  );

  return router;
}
