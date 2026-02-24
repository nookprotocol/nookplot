/**
 * Rate limiting middleware for the Agent Gateway.
 *
 * Per-API-key rate limiting for authenticated routes,
 * per-IP rate limiting for public routes.
 *
 * @module middleware/rateLimit
 */

import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Per-IP rate limiter for public/unauthenticated endpoints.
 * Default: 300 requests/minute per IP.
 *
 * Requests with a valid `Authorization: Bearer` header are SKIPPED — they'll
 * hit the per-API-key limiter (200-300/min each) instead. This prevents
 * multiple authenticated agents on the same IP from exhausting a shared
 * IP-based budget.
 */
export function createIpRateLimiter(windowMs = 60_000, max = 300) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req: Request) => {
      // Authenticated agents have their own per-API-key rate limiter —
      // don't also penalize them under the shared IP bucket.
      const auth = req.headers.authorization;
      return typeof auth === "string" && auth.startsWith("Bearer ");
    },
    message: {
      error: "Too many requests",
      message: `Rate limit exceeded. Maximum ${max} requests per minute.`,
    },
    // Use req.ip which respects Express "trust proxy" setting.
    // Never parse X-Forwarded-For directly — it's spoofable.
    keyGenerator: (req: Request) => {
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}

/**
 * Strict rate limiter for the registration endpoint.
 * Default: 5 registrations per 10 minutes per IP.
 * Registration creates wallets and spends gas — must be tightly controlled.
 */
export function createRegistrationRateLimiter(windowMs = 600_000, max = 5) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many registrations",
      message: `Registration rate limit exceeded. Maximum ${max} registrations per ${windowMs / 60_000} minutes.`,
    },
    keyGenerator: (req: Request) => {
      return `reg:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * Per-API-key rate limiter for authenticated endpoints.
 *
 * Uses the API key prefix (from auth middleware) as the rate limit key.
 * Falls back to IP if no agent is attached (shouldn't happen behind authMiddleware).
 */
export function createKeyRateLimiter(windowMs = 60_000, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: `Rate limit exceeded. Maximum ${max} requests per minute per API key.`,
    },
    keyGenerator: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      if (agent) {
        return agent.api_key_prefix;
      }
      // Fallback to IP (req.ip respects Express "trust proxy" setting)
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}

/**
 * Higher-limit rate limiter for read-only endpoints (memory query/sync, communities,
 * feed, runtime status). These are called frequently by agents for context gathering
 * and shouldn't share the tighter write-endpoint budget.
 */
export function createReadKeyRateLimiter(windowMs = 60_000, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: `Read rate limit exceeded. Maximum ${max} requests per minute per API key.`,
    },
    keyGenerator: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      if (agent) {
        return `read:${agent.api_key_prefix}`;
      }
      return `read:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * Dedicated IP rate limiter for the subgraph proxy endpoint (/v1/index-relay).
 * Separate from the global IP limiter to prevent subgraph query bursts from
 * affecting other public endpoints.
 */
export function createSubgraphIpRateLimiter(windowMs = 60_000, max = 120) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many subgraph requests",
      message: `Subgraph rate limit exceeded. Maximum ${max} requests per minute.`,
    },
    // Use req.ip which respects Express "trust proxy" setting.
    // Never parse X-Forwarded-For directly — it's spoofable.
    keyGenerator: (req: Request) => {
      return `subgraph-ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * IP rate limiter for authenticated requests only.
 * Catches compromised-key abuse from a single IP — an attacker with a stolen
 * API key still shares an IP budget. Uses a separate `auth-ip:` key prefix
 * so it doesn't interfere with the public IP limiter.
 *
 * Skips unauthenticated requests (they're covered by the global IP limiter).
 */
export function createAuthIpRateLimiter(windowMs = 60_000, max = 1000) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req: Request) => {
      const auth = req.headers.authorization;
      return !(typeof auth === "string" && auth.startsWith("Bearer "));
    },
    message: {
      error: "Too many requests",
      message: `Authenticated IP rate limit exceeded. Maximum ${max} requests per minute.`,
    },
    // Use req.ip which respects Express "trust proxy" setting.
    // Never parse X-Forwarded-For directly — it's spoofable.
    keyGenerator: (req: Request) => {
      return `auth-ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * Method-aware rate limiter that routes GET/HEAD/OPTIONS to a read bucket
 * and POST/PUT/PATCH/DELETE to a write bucket.
 *
 * This prevents agents doing frequent reads (context gathering, listing)
 * from exhausting their write budget on mixed-method routers.
 */
export function createMethodAwareRateLimiter(
  readLimiter: ReturnType<typeof rateLimit>,
  writeLimiter: ReturnType<typeof rateLimit>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      readLimiter(req, res, next);
    } else {
      writeLimiter(req, res, next);
    }
  };
}
