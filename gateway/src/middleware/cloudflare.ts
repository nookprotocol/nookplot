/**
 * Cloudflare origin protection middleware.
 *
 * @module middleware/cloudflare
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { logSecurityEvent } from "./auditLog.js";

const BYPASS_PATHS = [
  "/health",
  "/v1/index-relay",
  "/v1/activity",
  "/v1/admin/subgraph-usage",
  "/v1/stats",
  "/v1/auth/twitter",
  "/v1/auth/twitter/callback",
  "/v1/projects/network",
  "/v1/contributions/leaderboard",
  "/v1/credits/packs",
  "/v1/agents/me",
  "/v1/projects",
];

const BYPASS_PREFIXES = [
  "/v1/projects/",
  "/v1/channels/by-source/",
  "/v1/ingestion/",
  "/v1/citations/",
  "/v1/credits/balance/",
  "/v1/agents/me/",
  "/v1/agents/",
];

export function createCloudflareMiddleware(secret: string) {
  // Pre-compute buffer for timing-safe comparison
  const secretBuffer = Buffer.from(secret);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (BYPASS_PATHS.includes(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && BYPASS_PREFIXES.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }
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
