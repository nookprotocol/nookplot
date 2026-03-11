/**
 * Marketplace routes — search, listing detail, reviews, provider profiles.
 *
 * On-chain write operations go through the prepare+relay flow.
 * These routes handle off-chain queries and the review system.
 *
 * @module routes/marketplace
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter } from "../middleware/rateLimit.js";
import type { MarketplaceService } from "../services/marketplaceService.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

export function createMarketplaceRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  marketplaceService: MarketplaceService,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  // Rate limit agreement messages: 60 per hour per agent
  const agreementMsgLimiter = createKeyRateLimiter(3_600_000, 60);

  // -------------------------------------------------------
  //  GET /v1/marketplace/search — Search listings (public)
  // -------------------------------------------------------
  router.get(
    "/marketplace/search",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const category = typeof req.query.category === "string" ? req.query.category : undefined;
        const maxPrice = typeof req.query.maxPrice === "string" ? req.query.maxPrice : undefined;
        const activeOnly = req.query.activeOnly !== "false";
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        // GPU-specific filters
        const gpuModel = typeof req.query.gpuModel === "string" ? req.query.gpuModel : undefined;
        const minVram = typeof req.query.minVram === "string" ? parseInt(req.query.minVram, 10) : undefined;
        const maxPriceUsdc = typeof req.query.maxPriceUsdc === "string" ? parseFloat(req.query.maxPriceUsdc) : undefined;
        const attestationMaxAgeDays = typeof req.query.attestationMaxAgeDays === "string" ? parseInt(req.query.attestationMaxAgeDays, 10) : undefined;
        const availabilityStatus = typeof req.query.availabilityStatus === "string" ? req.query.availabilityStatus as "online" | "degraded" | "any" : undefined;
        const minChallengePassRate = typeof req.query.minChallengePassRate === "string" ? parseFloat(req.query.minChallengePassRate) : undefined;

        // API-specific filters
        const apiStatus = typeof req.query.apiStatus === "string" ? req.query.apiStatus as "online" | "degraded" | "any" : undefined;
        const minUptimePercent = typeof req.query.minUptime === "string" ? parseFloat(req.query.minUptime) : undefined;

        const listings = await marketplaceService.searchListings({
          category,
          maxPrice,
          activeOnly,
          limit,
          offset,
          gpuModel,
          minVram: isNaN(minVram as number) ? undefined : minVram,
          maxPriceUsdc: isNaN(maxPriceUsdc as number) ? undefined : maxPriceUsdc,
          attestationMaxAgeDays: isNaN(attestationMaxAgeDays as number) ? undefined : attestationMaxAgeDays,
          availabilityStatus,
          minChallengePassRate: isNaN(minChallengePassRate as number) ? undefined : minChallengePassRate,
          apiStatus,
          minUptimePercent: isNaN(minUptimePercent as number) ? undefined : minUptimePercent,
        });

        res.json({ listings, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-search-failed", { error: message });
        res.status(500).json({ error: "Failed to search listings." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/listings/:id — Listing detail (public)
  // -------------------------------------------------------
  router.get(
    "/marketplace/listings/:id",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const listingId = parseInt(req.params.id as string, 10);
        if (isNaN(listingId)) {
          res.status(400).json({ error: "Listing ID must be a number." });
          return;
        }

        const listing = await marketplaceService.getListingDetail(listingId);
        if (!listing) {
          res.status(404).json({ error: "Listing not found." });
          return;
        }

        res.json(listing);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-listing-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch listing." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/featured — Featured listings (public)
  // -------------------------------------------------------
  router.get(
    "/marketplace/featured",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const limit = parseInt(String(req.query.limit ?? "10"), 10) || 10;
        const listings = await marketplaceService.getFeaturedListings(limit);
        res.json({ listings });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-featured-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch featured listings." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/provider/:address — Provider profile (public)
  // -------------------------------------------------------
  router.get(
    "/marketplace/provider/:address",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = req.params.address as string;

        // Look up agent by address
        const { rows: agents } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [address],
        );

        if (agents.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const agentId = agents[0].id;
        const stats = await marketplaceService.getProviderStats(agentId);
        const listings = await marketplaceService.searchListings({
          activeOnly: false,
          limit: 50,
        });

        // Filter to this provider's listings
        const providerListings = listings.filter(l => l.agent_id === agentId);

        // GPU challenge stats (aggregate only — always public)
        const { rows: challengeStats } = await pool.query(
          `SELECT
            COUNT(*)::int AS total_challenges,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            MAX(completed_at) AS last_challenge_at
           FROM gpu_challenges WHERE LOWER(provider_address) = LOWER($1)`,
          [address],
        );
        const gpuChallengeStats = challengeStats[0] ?? null;

        // GPU attestation — only show existence + age publicly, not full specs
        const { rows: attestationRows } = await pool.query(
          `SELECT active, attested_at FROM idx_gpu_attestations WHERE LOWER(provider_address) = LOWER($1) AND active = TRUE`,
          [address],
        );
        const hasAttestation = attestationRows.length > 0;
        const attestedAt = attestationRows[0]?.attested_at ?? null;

        // Availability — public: status + vram tier only
        const { rows: availRows } = await pool.query<{ status: string; last_heartbeat: string; vram_gb: number | null }>(
          `SELECT status, last_heartbeat, vram_gb FROM gpu_availability WHERE LOWER(provider_address) = LOWER($1)`,
          [address],
        );
        const avail = availRows[0] ?? null;
        const vramTier = !avail?.vram_gb ? null
          : avail.vram_gb >= 80 ? "80GB+" : avail.vram_gb >= 40 ? "40GB+"
          : avail.vram_gb >= 24 ? "24GB+" : avail.vram_gb >= 16 ? "16GB+"
          : avail.vram_gb >= 8 ? "8GB+" : "<8GB";

        // API availability — status + uptime for API marketplace providers
        const { rows: apiAvailRows } = await pool.query<{
          status: string; last_heartbeat: string; uptime_checks: number; uptime_passes: number;
          last_latency_ms: number | null; active_agreements: number;
        }>(
          `SELECT status, last_heartbeat, uptime_checks, uptime_passes, last_latency_ms, active_agreements
           FROM api_availability WHERE LOWER(provider_address) = LOWER($1)`,
          [address],
        );
        const apiAvail = apiAvailRows[0] ?? null;

        res.json({
          address, agentId, stats, listings: providerListings,
          gpu: hasAttestation || avail ? {
            hasAttestation,
            attestedAt,
            challengeStats: gpuChallengeStats,
            availability: avail ? { status: avail.status, vramTier, lastHeartbeat: avail.last_heartbeat } : null,
          } : null,
          api: apiAvail ? {
            status: apiAvail.status,
            lastHeartbeat: apiAvail.last_heartbeat,
            uptimePercent: apiAvail.uptime_checks > 0
              ? Math.round((apiAvail.uptime_passes / apiAvail.uptime_checks) * 100)
              : 0,
            lastLatencyMs: apiAvail.last_latency_ms,
            activeAgreements: apiAvail.active_agreements,
          } : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-provider-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch provider profile." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/agreements — My agreements
  // -------------------------------------------------------
  router.get(
    "/marketplace/agreements",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const role = (typeof req.query.role === "string" && ["buyer", "provider", "both"].includes(req.query.role))
          ? req.query.role as "buyer" | "provider" | "both"
          : "both";
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const agreements = await marketplaceService.getAgreements(
          agent.id,
          role,
          { status, limit, offset },
        );

        res.json({ agreements, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-agreements-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch agreements." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/agreements/:id — Agreement detail
  //  Party callers see full data including delivery_cid.
  //  Non-party callers see delivery_cid as null (privacy).
  // -------------------------------------------------------
  router.get(
    "/marketplace/agreements/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const agreementId = parseInt(req.params.id as string, 10);
        if (isNaN(agreementId)) {
          res.status(400).json({ error: "Agreement ID must be a number." });
          return;
        }

        const agreement = await marketplaceService.getAgreementDetail(agreementId);
        if (!agreement) {
          res.status(404).json({ error: "Agreement not found." });
          return;
        }

        const isParty =
          agent.id === agreement.buyer_agent_id ||
          agent.id === agreement.provider_agent_id;

        // If buyer is viewing a delivered agreement for the first time, mark it
        if (
          isParty &&
          agent.id === agreement.buyer_agent_id &&
          agreement.status === "delivered" &&
          !agreement.buyer_viewed_delivery_at
        ) {
          marketplaceService.markDeliveryViewed(agreementId, agent.id).catch((err) => {
            logSecurityEvent("warn", "marketplace-mark-viewed-failed", { agreementId, error: String(err) });
          });
        }

        // Non-party callers: strip delivery_cid for privacy
        if (!isParty) {
          res.json({
            ...agreement,
            delivery_cid: null,
            has_delivery: agreement.delivery_cid !== null,
          });
          return;
        }

        res.json(agreement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-agreement-detail-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch agreement." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/agreements/:id/messages — Message thread
  //  Party-only: only buyer or provider can read messages.
  // -------------------------------------------------------
  router.get(
    "/marketplace/agreements/:id/messages",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const agreementId = parseInt(req.params.id as string, 10);
        if (isNaN(agreementId)) {
          res.status(400).json({ error: "Agreement ID must be a number." });
          return;
        }

        const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const messages = await marketplaceService.getMessages(agreementId, agent.id, { limit, offset });
        res.json({ messages, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("not found")) {
          res.status(404).json({ error: message });
          return;
        }
        if (message.includes("Not a party")) {
          res.status(403).json({ error: message });
          return;
        }

        logSecurityEvent("error", "marketplace-messages-get-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch messages." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/marketplace/agreements/:id/messages — Send message
  //  Party-only: only buyer or provider can send messages.
  // -------------------------------------------------------
  router.post(
    "/marketplace/agreements/:id/messages",
    authMiddleware,
    agreementMsgLimiter,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { messageType, content, attachmentCid } = req.body;

      if (!content) {
        res.status(400).json({ error: "Missing required field: content" });
        return;
      }

      try {
        const agreementId = parseInt(req.params.id as string, 10);
        if (isNaN(agreementId)) {
          res.status(400).json({ error: "Agreement ID must be a number." });
          return;
        }

        const msg = await marketplaceService.sendMessage({
          agreementId,
          senderAgentId: agent.id,
          messageType: messageType ?? "general",
          content,
          attachmentCid,
        });

        // Emit revision_requested signal to provider when buyer sends revision request
        if (proactiveScheduler && messageType === "revision_request") {
          pool.query<{ buyer_agent_id: string; provider_agent_id: string }>(
            `SELECT buyer_agent_id, provider_agent_id FROM service_agreements WHERE agreement_id = $1`,
            [agreementId],
          ).then(({ rows }) => {
            if (rows.length > 0) {
              const targetId = agent.id === rows[0].buyer_agent_id
                ? rows[0].provider_agent_id
                : rows[0].buyer_agent_id;
              proactiveScheduler.handleReactiveSignal(targetId, {
                signalType: "revision_requested",
                agreementId,
                message: content,
                senderAddress: agent.address,
              }).catch(() => {});
            }
          }).catch(() => { /* fire-and-forget */ });
        }

        res.status(201).json(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("not found")) {
          res.status(404).json({ error: message });
          return;
        }
        if (message.includes("Not a party")) {
          res.status(403).json({ error: message });
          return;
        }
        if (
          message.includes("Only the") ||
          message.includes("can only be") ||
          message.includes("Invalid message type") ||
          message.includes("required") ||
          message.includes("5000 characters")
        ) {
          res.status(400).json({ error: message });
          return;
        }

        logSecurityEvent("error", "marketplace-messages-send-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to send message." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/marketplace/reviews — Submit review
  // -------------------------------------------------------
  router.post(
    "/marketplace/reviews",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId, revieweeAgentId, rating, comment } = req.body;

      if (agreementId === undefined || !rating) {
        res.status(400).json({ error: "Missing required fields: agreementId, rating" });
        return;
      }

      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        res.status(400).json({ error: "Rating must be a number between 1 and 5." });
        return;
      }

      // Auto-resolve revieweeAgentId if not provided — the reviewee is the other party
      let resolvedRevieweeId = revieweeAgentId as string | undefined;
      if (!resolvedRevieweeId) {
        const { rows: agreements } = await pool.query<{ buyer_agent_id: string; provider_agent_id: string }>(
          `SELECT buyer_agent_id, provider_agent_id FROM service_agreements WHERE agreement_id = $1`,
          [parseInt(String(agreementId), 10)],
        );
        if (agreements.length === 0) {
          res.status(404).json({ error: "Agreement not found." });
          return;
        }
        const ag = agreements[0];
        if (agent.id === ag.buyer_agent_id) {
          resolvedRevieweeId = ag.provider_agent_id;
        } else if (agent.id === ag.provider_agent_id) {
          resolvedRevieweeId = ag.buyer_agent_id;
        } else {
          res.status(403).json({ error: "You are not a party to this agreement." });
          return;
        }
      }

      try {
        const review = await marketplaceService.submitReview({
          agreementId: parseInt(String(agreementId), 10),
          reviewerAgentId: agent.id,
          revieweeAgentId: resolvedRevieweeId,
          rating,
          comment,
        });

        // Emit review_received signal to the reviewee agent
        if (proactiveScheduler && resolvedRevieweeId) {
          proactiveScheduler.handleReactiveSignal(resolvedRevieweeId, {
            signalType: "review_received",
            agreementId: parseInt(String(agreementId), 10),
            rating,
            comment: comment ?? "",
            reviewerAddress: agent.address,
          }).catch(() => {});
        }

        res.status(201).json(review);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Check for known error types
        if (message.includes("duplicate key") || message.includes("unique")) {
          res.status(409).json({ error: "You have already reviewed this agreement." });
          return;
        }
        if (message.includes("not found") || message.includes("not a party") || message.includes("settled")) {
          res.status(400).json({ error: message });
          return;
        }

        logSecurityEvent("error", "marketplace-review-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to submit review." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/reviews/:address — Reviews for an agent
  // -------------------------------------------------------
  router.get(
    "/marketplace/reviews/:address",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = req.params.address as string;

        const { rows: agents } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [address],
        );

        if (agents.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const reviews = await marketplaceService.getReviews(agents[0].id, { limit, offset });
        res.json({ reviews, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-reviews-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch reviews." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/marketplace/categories — Categories with counts
  // -------------------------------------------------------
  router.get(
    "/marketplace/categories",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const categories = await marketplaceService.getCategories();
        res.json({ categories });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-categories-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch categories." });
      }
    },
  );

  return router;
}
