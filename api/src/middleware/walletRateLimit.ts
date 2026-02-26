/**
 * Per-wallet rate limiting for the Nookplot x402 API.
 *
 * Limits how many paid requests a single wallet can make per time window.
 * Only CONFIRMED settlements (from the onAfterSettle hook) count toward
 * the limit — prevents forgery-based DoS where an attacker sends requests
 * with a copied payment header to exhaust someone else's rate limit.
 *
 * Flow:
 * 1. onAfterSettle hook records confirmed payer in SettlementStore
 * 2. Middleware decodes the payment-signature header to identify the payer
 * 3. Checks the payer's confirmed settlement count in the current window
 * 4. If over limit, returns 429 BEFORE x402 processes (no charge)
 *
 * In-memory store — sufficient for single-process deployment.
 * Swap for Redis if horizontal scaling is needed.
 *
 * @module middleware/walletRateLimit
 */

import type { Request, Response, NextFunction } from "express";
import { logSecurityEvent } from "./auditLog.js";

// ============================================================
//  Settlement Store — shared between onAfterSettle and middleware
// ============================================================

/**
 * In-memory store of confirmed settlement timestamps per wallet.
 * Populated by the onAfterSettle hook, read by the rate limiter.
 */
export class SettlementStore {
  /** Map of checksummed wallet address -> array of settlement timestamps. */
  private settlements = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly windowMs: number;
  /** Max unique wallets tracked to prevent unbounded memory growth. */
  private static readonly MAX_ENTRIES = 10_000;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    // Clean expired entries every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Don't prevent Node from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Record a confirmed settlement for a payer wallet.
   * Called from the onAfterSettle hook only.
   */
  record(payer: string): void {
    const key = payer.toLowerCase();
    // Skip new wallets if at capacity (existing wallets still tracked)
    if (!this.settlements.has(key) && this.settlements.size >= SettlementStore.MAX_ENTRIES) {
      return;
    }
    const timestamps = this.settlements.get(key) ?? [];
    timestamps.push(Date.now());
    this.settlements.set(key, timestamps);
  }

  /**
   * Count confirmed settlements for a payer in the current window.
   */
  count(payer: string): number {
    const key = payer.toLowerCase();
    const timestamps = this.settlements.get(key);
    if (!timestamps) return 0;

    const cutoff = Date.now() - this.windowMs;
    return timestamps.filter((t) => t > cutoff).length;
  }

  /**
   * Remove expired entries from all wallets.
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.settlements) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.settlements.delete(key);
      } else {
        this.settlements.set(key, active);
      }
    }
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ============================================================
//  Payer extraction from payment header
// ============================================================

/**
 * Try to extract the payer address from the x402 payment-signature header.
 * Returns null if the header is missing, malformed, or doesn't contain
 * a recognizable payer field.
 *
 * Uses dynamic import for @x402/core/http to match the ESM import
 * pattern used elsewhere in the server.
 */
let decodePaymentHeader: ((header: string) => Record<string, unknown>) | null = null;

async function initDecoder(): Promise<void> {
  if (decodePaymentHeader) return;
  try {
    const { decodePaymentSignatureHeader } = await import("@x402/core/http");
    decodePaymentHeader = decodePaymentSignatureHeader as (header: string) => Record<string, unknown>;
  } catch {
    // x402 not available — middleware will skip payer extraction
  }
}

/**
 * Extract payer address from a decoded payment payload.
 * Supports both EIP-3009 and Permit2 payload formats.
 */
function extractPayerFromPayload(decoded: Record<string, unknown>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (decoded as any).payload;
  if (!payload || typeof payload !== "object") return null;

  // EIP-3009: payload.authorization.from
  if (payload.authorization?.from && typeof payload.authorization.from === "string") {
    return payload.authorization.from;
  }

  // Permit2: payload.permit2Authorization.from
  if (payload.permit2Authorization?.from && typeof payload.permit2Authorization.from === "string") {
    return payload.permit2Authorization.from;
  }

  return null;
}

function getPayerFromRequest(req: Request): string | null {
  const header =
    req.headers["payment-signature"] as string | undefined ??
    req.headers["x-payment"] as string | undefined;

  if (!header || !decodePaymentHeader) return null;

  try {
    const decoded = decodePaymentHeader(header);
    return extractPayerFromPayload(decoded);
  } catch {
    // Malformed header — not our problem, x402 will reject it
    return null;
  }
}

// ============================================================
//  Middleware factory
// ============================================================

/**
 * Create a per-wallet rate limiting middleware.
 *
 * Must be applied BEFORE the x402 payment middleware so that
 * over-limit requests are rejected without charging the payer.
 *
 * @param store - Shared SettlementStore (also fed by onAfterSettle)
 * @param maxPerWindow - Max confirmed settlements per window (default: env or 300)
 * @param windowMs - Window duration in ms (default: 60000 = 1 minute)
 */
export function createWalletRateLimiter(
  store: SettlementStore,
  maxPerWindow?: number,
  windowMs = 60_000,
): (req: Request, res: Response, next: NextFunction) => void {
  const limit = maxPerWindow ?? parseInt(process.env.RATE_LIMIT_PER_WALLET ?? "300", 10);

  // Initialize the decoder asynchronously — it'll be ready before
  // any real traffic arrives (server startup takes longer than this)
  initDecoder().catch(() => {
    // Swallow — middleware degrades gracefully without decoder
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const payer = getPayerFromRequest(req);

    if (!payer) {
      // No payer identifiable — let x402 handle it
      // (could be a non-paywalled route, missing header, or first-time payer)
      next();
      return;
    }

    // Store payer on res.locals for downstream audit logging
    res.locals.x402Payer = payer;

    const count = store.count(payer);
    if (count >= limit) {
      logSecurityEvent("warn", "wallet-rate-limit-exceeded", {
        payer,
        count,
        limit,
        windowMs,
      });

      res.status(429).json({
        error: "Too many requests",
        message: `Wallet rate limit exceeded. Maximum ${limit} paid requests per ${Math.ceil(windowMs / 1000)} seconds.`,
        retryAfter: Math.ceil(windowMs / 1000),
      });
      return;
    }

    next();
  };
}
