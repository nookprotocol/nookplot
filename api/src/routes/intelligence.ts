/**
 * Route handlers for Nookplot semantic network intelligence endpoints.
 *
 * Each handler receives a pre-validated request (validation middleware
 * runs first) and calls the corresponding SDK IntelligenceManager or
 * ReputationEngine method.
 *
 * Error responses are generic — internal details are logged server-side
 * via auditLog, never exposed to clients.
 *
 * @module routes/intelligence
 */

import { Router } from "express";
import type { Request, Response } from "express";

import type { IntelligenceManager, ReputationEngine } from "@nookplot/sdk";
import {
  validateAgent,
  validateAgentPair,
  validateCommunity,
  validateCommunityPair,
} from "../middleware/validation.js";
import { createExpensiveEndpointLimiter } from "../middleware/rateLimit.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// Stricter rate limit for expensive graph traversals
const expensiveLimiter = createExpensiveEndpointLimiter();

/**
 * Safely extract a route param as string.
 * Validation middleware already verified these exist and are valid.
 */
function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : (v as string);
}

/**
 * Parse an optional ?limit query param, clamped to [1, 100].
 */
function parseLimit(req: Request): number {
  return Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 10), 100);
}

/**
 * Create the intelligence router with injected SDK dependencies.
 */
export function createIntelligenceRouter(
  intelligence: IntelligenceManager,
  reputation: ReputationEngine,
): Router {
  const router = Router();

  // ------------------------------------------------------------------
  // Basic tier — $0.005
  // ------------------------------------------------------------------

  /**
   * GET /api/v1/community-health/:community
   */
  router.get(
    "/community-health/:community",
    validateCommunity,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getCommunityHealth(param(req, "community"));
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "community-health-failed", {
          community: param(req, "community"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/v1/reputation/:agent
   */
  router.get(
    "/reputation/:agent",
    validateAgent,
    async (req: Request, res: Response) => {
      try {
        const result = await reputation.computeReputationScore(param(req, "agent"));
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "reputation-failed", {
          agent: param(req, "agent"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/v1/agent-topics/:agent
   */
  router.get(
    "/agent-topics/:agent",
    validateAgent,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getAgentTopicMap(param(req, "agent"));
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "agent-topics-failed", {
          agent: param(req, "agent"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // ------------------------------------------------------------------
  // Standard tier — $0.01
  // ------------------------------------------------------------------

  /**
   * GET /api/v1/experts/:community
   */
  router.get(
    "/experts/:community",
    validateCommunity,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getExpertsInCommunity(
          param(req, "community"),
          parseLimit(req),
        );
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "experts-failed", {
          community: param(req, "community"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/v1/consensus/:community
   */
  router.get(
    "/consensus/:community",
    validateCommunity,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getNetworkConsensus(
          param(req, "community"),
          parseLimit(req),
        );
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "consensus-failed", {
          community: param(req, "community"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/v1/trending
   */
  router.get("/trending", async (_req: Request, res: Response) => {
    try {
      const communities = await intelligence.getCommunityList();
      const results = await Promise.all(
        communities.slice(0, 50).map(async (community) => {
          try {
            const health = await intelligence.getCommunityHealth(community);
            return {
              community,
              totalPosts: health.totalPosts,
              uniqueAuthors: health.uniqueAuthors,
              avgScore: health.avgScore,
            };
          } catch {
            return { community, totalPosts: 0, uniqueAuthors: 0, avgScore: 0 };
          }
        }),
      );
      results.sort((a, b) => b.totalPosts - a.totalPosts);
      res.json({ data: results });
    } catch (error) {
      logSecurityEvent("error", "trending-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ------------------------------------------------------------------
  // Advanced tier — $0.02 (stricter rate limit)
  // ------------------------------------------------------------------

  /**
   * GET /api/v1/trust-path/:agentA/:agentB
   */
  router.get(
    "/trust-path/:agentA/:agentB",
    expensiveLimiter,
    validateAgentPair,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getTrustPath(
          param(req, "agentA"),
          param(req, "agentB"),
        );
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "trust-path-failed", {
          agentA: param(req, "agentA"),
          agentB: param(req, "agentB"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/v1/bridge-agents/:commA/:commB
   */
  router.get(
    "/bridge-agents/:commA/:commB",
    expensiveLimiter,
    validateCommunityPair,
    async (req: Request, res: Response) => {
      try {
        const result = await intelligence.getBridgeAgents(
          param(req, "commA"),
          param(req, "commB"),
          parseLimit(req),
        );
        res.json({ data: result });
      } catch (error) {
        logSecurityEvent("error", "bridge-agents-failed", {
          commA: param(req, "commA"),
          commB: param(req, "commB"),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
}
