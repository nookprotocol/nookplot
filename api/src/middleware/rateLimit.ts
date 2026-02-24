/**
 * Rate limiting middleware for the Nookplot x402 API.
 *
 * Multiple layers of rate limiting:
 * - Per IP: prevents pre-payment resource exhaustion (even 402 responses cost compute)
 * - Per endpoint: separate limits for expensive graph traversals vs simple lookups
 *
 * @module middleware/rateLimit
 */

import rateLimit from "express-rate-limit";

/**
 * General per-IP rate limiter.
 * Applies to ALL requests including 402 responses.
 * Default: 60 requests/minute per IP.
 */
export function createIpRateLimiter(windowMs = 60_000, max?: number) {
  const limit = max ?? parseInt(process.env.RATE_LIMIT_PER_IP ?? "60", 10);

  return rateLimit({
    windowMs,
    max: limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: `Rate limit exceeded. Maximum ${limit} requests per minute per IP.`,
      retryAfter: Math.ceil(windowMs / 1000),
    },
    keyGenerator: (req) => {
      // Use X-Forwarded-For if behind a reverse proxy, otherwise remote IP
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
      }
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}

/**
 * Stricter rate limiter for expensive graph traversal endpoints.
 * Trust paths, bridge agents, and PageRank are compute-intensive.
 * Default: 20 requests/minute per IP.
 */
export function createExpensiveEndpointLimiter(windowMs = 60_000, max = 20) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests",
      message: `Rate limit exceeded for this endpoint. Maximum ${max} requests per minute.`,
      retryAfter: Math.ceil(windowMs / 1000),
    },
    keyGenerator: (req) => {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
      }
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}
