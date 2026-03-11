/**
 * Token price proxy — fetches live USD prices from DexScreener.
 *
 * GET /v1/token/price/:symbol — public, no auth, rate-limited
 *
 * Returns `{ symbol, priceUsd, source, updatedAt, stale? }`.
 * 60-second in-memory cache per symbol. Only one in-flight fetch at a time.
 *
 * @module routes/tokenPrice
 */

import { Router } from "express";
import type { Request, Response } from "express";

// ── Known tokens ──────────────────────────────────────────

const TOKEN_ADDRESSES: Record<string, string> = {
  nook: "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3",
};

// ── Cache ─────────────────────────────────────────────────

interface PriceEntry {
  symbol: string;
  priceUsd: string | null;
  source: string;
  updatedAt: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const cache = new Map<string, { entry: PriceEntry; fetchedAt: number }>();
const inflight = new Map<string, Promise<PriceEntry>>();

// ── Fetch from DexScreener ────────────────────────────────

async function fetchPrice(symbol: string, tokenAddress: string): Promise<PriceEntry> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`DexScreener ${res.status}`);

    const data = await res.json() as { pairs?: Array<{ priceUsd?: string }> };
    const priceUsd = data.pairs?.[0]?.priceUsd ?? null;

    return {
      symbol: symbol.toUpperCase(),
      priceUsd,
      source: "dexscreener",
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Return null price on failure
    return {
      symbol: symbol.toUpperCase(),
      priceUsd: null,
      source: "dexscreener",
      updatedAt: new Date().toISOString(),
    };
  }
}

// ── Get price (with cache + dedup) ────────────────────────

async function getPrice(symbol: string): Promise<PriceEntry & { stale?: boolean }> {
  const key = symbol.toLowerCase();
  const tokenAddress = TOKEN_ADDRESSES[key];
  if (!tokenAddress) {
    return { symbol: symbol.toUpperCase(), priceUsd: null, source: "unknown", updatedAt: new Date().toISOString() };
  }

  const cached = cache.get(key);
  const now = Date.now();

  // Fresh cache hit
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.entry;
  }

  // Deduplicate concurrent requests
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchPrice(key, tokenAddress).then((entry) => {
      // Only update cache if we got a real price, or no cache exists
      if (entry.priceUsd || !cached) {
        cache.set(key, { entry, fetchedAt: now });
      }
      inflight.delete(key);
      return entry;
    }).catch(() => {
      inflight.delete(key);
      // Return stale cache on error
      if (cached) return { ...cached.entry, stale: true };
      return { symbol: symbol.toUpperCase(), priceUsd: null, source: "dexscreener", updatedAt: new Date().toISOString() };
    });
    inflight.set(key, pending);
  }

  return pending;
}

// ── Router factory ────────────────────────────────────────

export function createTokenPriceRouter(): Router {
  const router = Router();

  router.get(
    "/token/price/:symbol",
    async (req: Request, res: Response): Promise<void> => {
      const symbol = String(req.params.symbol ?? "").toLowerCase();

      if (!TOKEN_ADDRESSES[symbol]) {
        res.status(400).json({
          error: `Unknown token symbol. Supported: ${Object.keys(TOKEN_ADDRESSES).map(s => s.toUpperCase()).join(", ")}`,
        });
        return;
      }

      const result = await getPrice(symbol);
      res.json(result);
    },
  );

  return router;
}
