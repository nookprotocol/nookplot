/**
 * Rate limiting middleware for the Agent Gateway.
 *
 * @module middleware/rateLimit
 */

import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Per-IP rate limiter for public/unauthenticated endpoints.
 * Authenticated requests are skipped (handled by per-key limiter).
 */
export function createIpRateLimiter(windowMs = 60_000, max = 300) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req: Request) => {
      const auth = req.headers.authorization;
      return typeof auth === "string" && auth.startsWith("Bearer ");
    },
    message: {
      error: "Too many requests",
      message: "Rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}

/**
 * Strict rate limiter for the registration endpoint.
 */
export function createRegistrationRateLimiter(windowMs = 600_000, max = 5) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    message: {
      error: "Too many registrations",
      message: "Registration rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      return `reg:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * Per-API-key rate limiter for authenticated endpoints.
 */
export function createKeyRateLimiter(windowMs = 60_000, maxPerKey: number) {
  return rateLimit({
    windowMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: "Rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      if (agent) {
        return agent.api_key_prefix;
      }
      // Unauthenticated: separate bucket with 10x headroom so browsers
      // behind Cloudflare / shared IPs aren't penalized by co-located agents.
      return `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
    max: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      return agent ? maxPerKey : maxPerKey * 10;
    },
  });
}

/**
 * Higher-limit rate limiter for read-only endpoints.
 */
export function createReadKeyRateLimiter(windowMs = 60_000, maxPerKey: number) {
  return rateLimit({
    windowMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: "Rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      if (agent) {
        return `read:${agent.api_key_prefix}`;
      }
      return `read-ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
    max: (req: Request) => {
      const agent = (req as AuthenticatedRequest).agent;
      // Browsers share one bucket across ALL read endpoints (IPFS batch,
      // agent names, bounties, feed, etc.) — 10x headroom prevents normal
      // browsing from hitting the limit. Agents stay at 1x.
      return agent ? maxPerKey : maxPerKey * 10;
    },
  });
}

/**
 * Dedicated IP rate limiter for the index-relay endpoint.
 */
export function createSubgraphIpRateLimiter(windowMs = 60_000, max = 120) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: "Rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      return `subgraph-ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * IP rate limiter for authenticated requests.
 * Skips unauthenticated requests (covered by global IP limiter).
 */
export function createAuthIpRateLimiter(windowMs = 60_000, max = 1000) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req: Request) => {
      const auth = req.headers.authorization;
      return !(typeof auth === "string" && auth.startsWith("Bearer "));
    },
    message: {
      error: "Too many requests",
      message: "Rate limit exceeded. Try again later.",
    },
    keyGenerator: (req: Request) => {
      return `auth-ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    },
  });
}

/**
 * Method-aware rate limiter — routes reads and writes to separate buckets.
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
