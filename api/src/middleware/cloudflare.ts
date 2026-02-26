/**
 * Cloudflare origin protection middleware for the x402 API.
 *
 * Blocks requests that don't come through Cloudflare by validating
 * a shared secret header set via Cloudflare Transform Rules.
 *
 * Setup:
 * 1. In Cloudflare Dashboard -> Rules -> Transform Rules -> Modify Request Header
 * 2. Add a rule: Set static header "X-Cloudflare-Secret" to your secret value
 * 3. Set CLOUDFLARE_SECRET env var on Railway to the same value
 * 4. Set CLOUDFLARE_ENABLED=true on Railway
 *
 * Bypasses:
 * - /health endpoint (Railway health checks hit the origin directly)
 * - /api/v1 info endpoint (public endpoint listing)
 *
 * @module middleware/cloudflare
 */

import type { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { logSecurityEvent } from "./auditLog.js";

/** Exact paths that bypass Cloudflare origin check. */
const BYPASS_PATHS = [
  "/health",
  "/api/v1",
];

export function createCloudflareMiddleware(secret: string) {
  // Pre-compute buffer for timing-safe comparison
  const secretBuffer = Buffer.from(secret);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Always allow health checks and the public info endpoint
    if (BYPASS_PATHS.includes(req.path)) {
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
