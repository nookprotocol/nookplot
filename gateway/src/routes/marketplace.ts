/**
 * Marketplace routes — search, listing detail, reviews, provider profiles.
 *
 * On-chain write operations go through the prepare+relay flow.
 * These routes handle off-chain queries and the review system.
 *
 * @module routes/marketplace
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { MarketplaceService } from "../services/marketplaceService.js";

export function createMarketplaceRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  marketplaceService: MarketplaceService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/marketplace/search — Search listings
  // -------------------------------------------------------
  router.get(
    "/marketplace/search",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const category = typeof req.query.category === "string" ? req.query.category : undefined;
        const maxPrice = typeof req.query.maxPrice === "string" ? req.query.maxPrice : undefined;
        const activeOnly = req.query.activeOnly !== "false";
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const listings = await marketplaceService.searchListings({
          category,
          maxPrice,
          activeOnly,
          limit,
          offset,
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
  //  GET /v1/marketplace/listings/:id — Listing detail
  // -------------------------------------------------------
  router.get(
    "/marketplace/listings/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
  //  GET /v1/marketplace/featured — Featured listings
  // -------------------------------------------------------
  router.get(
    "/marketplace/featured",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
  //  GET /v1/marketplace/provider/:address — Provider profile
  // -------------------------------------------------------
  router.get(
    "/marketplace/provider/:address",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

        res.json({ address, agentId, stats, listings: providerListings });
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

        res.json(agreement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "marketplace-agreement-detail-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch agreement." });
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

      if (agreementId === undefined || !revieweeAgentId || !rating) {
        res.status(400).json({ error: "Missing required fields: agreementId, revieweeAgentId, rating" });
        return;
      }

      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        res.status(400).json({ error: "Rating must be a number between 1 and 5." });
        return;
      }

      try {
        const review = await marketplaceService.submitReview({
          agreementId: parseInt(String(agreementId), 10),
          reviewerAgentId: agent.id,
          revieweeAgentId,
          rating,
          comment,
        });

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
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
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
