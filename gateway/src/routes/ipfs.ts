/**
 * IPFS proxy — upload and fetch via Pinata so the frontend never
 * touches public IPFS gateways (which are slow and unreliable).
 *
 * POST /v1/ipfs/upload  — Upload JSON to IPFS via Pinata
 * GET  /v1/ipfs/:cid    — Fetch JSON from IPFS with in-memory cache
 *
 * @module routes/ipfs
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { gatewayConfig } from "../config.js";

const PINATA_API_URL = "https://api.pinata.cloud";
const PINATA_GATEWAY_URL = "https://gateway.pinata.cloud/ipfs";

/** Maximum upload size (100 KB of JSON). */
const MAX_UPLOAD_SIZE = 100 * 1024;

/** CID format: CIDv0 (Qm...) or CIDv1 (b...) */
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

// ---- In-memory IPFS fetch cache ----
interface IpfsCacheEntry {
  data: unknown;
  fetchedAt: number;
}
const ipfsCache = new Map<string, IpfsCacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 500;

function getCached(cid: string): unknown | undefined {
  const entry = ipfsCache.get(cid);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    ipfsCache.delete(cid);
    return undefined;
  }
  return entry.data;
}

function putCached(cid: string, data: unknown): void {
  // Evict oldest if at capacity
  if (ipfsCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = ipfsCache.keys().next().value as string;
    ipfsCache.delete(firstKey);
  }
  ipfsCache.set(cid, { data, fetchedAt: Date.now() });
}

export function createIpfsRouter(pool: pg.Pool, hmacSecret: string): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool, hmacSecret);

  /**
   * GET /v1/ipfs/:cid
   * Fetch JSON content from IPFS with caching.
   * Public endpoint (no auth required) — content is already public on IPFS.
   */
  router.get("/ipfs/:cid", async (req: Request, res: Response) => {
    try {
      const cid = req.params.cid as string;

      if (!cid || !CID_REGEX.test(cid)) {
        return res.status(400).json({ error: "Invalid CID format" });
      }

      // Check cache first
      const cached = getCached(cid);
      if (cached !== undefined) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Cache-Control", "public, max-age=300");
        return res.json(cached);
      }

      // Fetch from Pinata gateway
      const upstream = await fetch(`${PINATA_GATEWAY_URL}/${cid}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!upstream.ok) {
        return res.status(upstream.status === 404 ? 404 : 502).json({
          error: `IPFS fetch failed: ${upstream.status}`,
        });
      }

      const data = await upstream.json();

      // Cache and respond
      putCached(cid, data);
      res.setHeader("X-Cache", "MISS");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("IPFS fetch error:", message);
      return res.status(502).json({ error: `IPFS fetch failed: ${message}` });
    }
  });

  /**
   * POST /v1/ipfs/upload
   * Body: { data: object, name?: string }
   * Returns: { cid: string, size: number }
   */
  router.post("/ipfs/upload", auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { data, name } = req.body;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "data must be a non-null JSON object" });
      }

      const jsonStr = JSON.stringify({
        pinataContent: data,
        pinataMetadata: { name: typeof name === "string" ? name.slice(0, 200) : "nookplot-data" },
      });

      if (jsonStr.length > MAX_UPLOAD_SIZE) {
        return res.status(413).json({ error: `Payload exceeds ${MAX_UPLOAD_SIZE} byte limit` });
      }

      const response = await fetch(`${PINATA_API_URL}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayConfig.pinataJwt}`,
          "Content-Type": "application/json",
        },
        body: jsonStr,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        return res.status(502).json({ error: `IPFS upload failed: ${response.status} — ${errorText}` });
      }

      const result = (await response.json()) as { IpfsHash: string; PinSize: number };
      return res.json({ cid: result.IpfsHash, size: result.PinSize });
    } catch (err) {
      console.error("IPFS upload error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
