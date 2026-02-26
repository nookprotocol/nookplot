/**
 * Cloudflare origin protection middleware.
 *
 * Blocks requests that don't come through Cloudflare by validating
 * a shared secret header set via Cloudflare Transform Rules.
 *
 * Setup:
 * 1. In Cloudflare Dashboard → Rules → Transform Rules → Modify Request Header
 * 2. Add a rule: Set static header "X-Cloudflare-Secret" to your secret value
 * 3. Set CLOUDFLARE_SECRET env var on Railway to the same value
 * 4. Set CLOUDFLARE_ENABLED=true on Railway
 *
 * Bypasses:
 * - /health endpoint (Railway health checks hit the origin directly)
 * - Non-production environments (unless CLOUDFLARE_ENABLED is explicitly set)
 *
 * @module middleware/cloudflare
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { logSecurityEvent } from "./auditLog.js";

const BYPASS_PATHS = [
  "/health",
  "/v1/index-relay",
  "/v1/activity",              // Public project activity feed (used by homepage dashboard)
  "/v1/admin/subgraph-usage",  // Public subgraph budget monitor
  "/v1/stats",                 // Public aggregate network stats
  "/v1/auth/twitter",          // Twitter OAuth initiate (browser GET redirect)
  "/v1/auth/twitter/callback", // Twitter OAuth callback (browser GET redirect)
  "/v1/projects/network",      // Public network projects listing
  "/v1/contributions/leaderboard", // Public leaderboard (read-only)
  "/v1/credits/packs",         // Public credit pack listing (used by PurchasePanel)
  "/v1/agents/me",             // Agent identity resolution (browser, auth via Bearer token)
  "/v1/projects",              // My projects listing (browser, auth via Bearer token)
];

/** Path prefixes that are bypassed (checked with startsWith). GET-only. */
const BYPASS_PREFIXES = [
  "/v1/projects/",             // Public project detail pages (/v1/projects/:id)
  "/v1/channels/by-source/",   // Public channel lookup + messages for project discussions
  "/v1/ingestion/",            // Public paper ingestion data (papers, status)
  "/v1/citations/",            // Public citation queries (most-cited, tree, detail)
  "/v1/credits/balance/",      // Public credit balance lookup (/v1/credits/balance/:address)
  "/v1/agents/me/",            // Agent management (egress, webhooks, MCP, credentials — auth via Bearer)
  "/v1/agents/",               // Agent lookup by address (/v1/agents/:address/projects)
];

export function createCloudflareMiddleware(secret: string) {
  // Pre-compute buffer for timing-safe comparison
  const secretBuffer = Buffer.from(secret);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Always allow health checks and public endpoints
    if (BYPASS_PATHS.includes(req.path)) {
      next();
      return;
    }
    // Public GET-only prefix routes (project detail pages, credit balances, etc.)
    if (req.method === "GET" && BYPASS_PREFIXES.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }
    // Allow requests with a Bearer token to bypass Cloudflare check.
    // These are authenticated API calls from the browser frontend or SDKs.
    // The gateway's own auth middleware validates the token — Cloudflare
    // origin protection is defense-in-depth, not the sole auth layer.
    const authHeader = req.headers["authorization"];
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      next();
      return;
    }

    const provided = req.headers["x-cloudflare-secret"];

    // Use timing-safe comparison to prevent secret leakage via timing attacks
    if (provided && typeof provided === "string") {
      const providedBuffer = Buffer.from(provided);
      if (
        providedBuffer.length === secretBuffer.length &&
        crypto.timingSafeEqual(providedBuffer, secretBuffer)
      ) {
        next();
        return;
      }
    }

    // Log blocked request
    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    logSecurityEvent("warn", "cloudflare-bypass-blocked", {
      clientIp,
      path: req.path.slice(0, 200),
      method: req.method,
      hasCfRay: !!req.headers["cf-ray"],
      hasSecret: !!provided,
    });

    res.status(403).json({ error: "Forbidden" });
  };
}
