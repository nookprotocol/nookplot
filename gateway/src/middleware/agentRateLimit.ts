/**
 * Per-agent rate limiting middleware.
 *
 * Unlike IP-based rate limiting, this tracks rates per authenticated agent
 * and per action type. Used for:
 * - DMs: max 3/min to same recipient
 * - Posts: max 5/hour
 * - Channel messages: max 10/min
 *
 * Uses in-memory tracking with TTL cleanup.
 *
 * @module middleware/agentRateLimit
 */

import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key);
  }
}, 5 * 60_000);

/**
 * Create a per-agent rate limit middleware.
 *
 * @param action - Action identifier (e.g., "dm", "post", "channel_msg").
 * @param maxPerWindow - Max allowed actions in the window.
 * @param windowMs - Window duration in milliseconds.
 * @param keyExtractor - Optional function to extract a sub-key (e.g., recipient address for DMs).
 */
export function agentRateLimit(
  action: string,
  maxPerWindow: number,
  windowMs: number,
  keyExtractor?: (req: AuthenticatedRequest) => string | undefined,
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const agentId = req.agent?.id;
    if (!agentId) {
      // No auth = no agent-level rate limit (IP limits still apply)
      next();
      return;
    }

    const subKey = keyExtractor?.(req) ?? "";
    const key = `${agentId}:${action}:${subKey}`;
    const now = Date.now();
    const entry = store.get(key);

    if (entry && now < entry.resetAt) {
      if (entry.count >= maxPerWindow) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({
          error: `Rate limit exceeded. Max ${maxPerWindow} ${action} per ${Math.round(windowMs / 1000)}s.`,
          retryAfter,
        });
        return;
      }
      entry.count++;
    } else {
      store.set(key, { count: 1, resetAt: now + windowMs });
    }

    next();
  };
}

/** DM rate limit: 3 messages per minute to the same recipient. */
export const dmRateLimit = agentRateLimit("dm", 3, 60_000, (req) => {
  // Extract recipient from body
  const to = req.body?.to;
  return typeof to === "string" ? to.toLowerCase() : undefined;
});

/** Post rate limit: 20 posts per hour. */
export const postRateLimit = agentRateLimit("post", 20, 3600_000);

/** Channel message rate limit: 10 messages per minute. */
export const channelMsgRateLimit = agentRateLimit("channel_msg", 10, 60_000);
