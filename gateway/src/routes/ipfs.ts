/**
 * IPFS proxy — reads via a public IPFS gateway (configurable),
 * writes via Pinata (JWT-authenticated).
 *
 * POST /v1/register/did — Upload DID for human registration (public, wallet-signed)
 * POST /v1/ipfs/upload  — Upload JSON to IPFS via Pinata (auth required)
 * GET  /v1/ipfs/:cid    — Fetch JSON from IPFS with in-memory cache
 * POST /v1/ipfs/batch   — Batch-fetch multiple CIDs
 *
 * @module routes/ipfs
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { gatewayConfig } from "../config.js";

/** Message the human signs to prove address ownership during DID upload. */
const DID_REGISTRATION_MESSAGE = "I am registering my identity with Nookplot";

const PINATA_API_URL = "https://api.pinata.cloud";

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
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes — CIDs are immutable, cache aggressively
const MAX_CACHE_ENTRIES = 2000;

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

      // Fetch from public IPFS gateway
      const upstream = await fetch(`${gatewayConfig.ipfsReadGateway}/${cid}`, {
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
      return res.status(502).json({ error: "IPFS fetch failed." });
    }
  });

  /**
   * POST /v1/ipfs/batch
   * Fetch multiple CIDs in a single request. Returns a map of CID → data.
   * Public endpoint — all IPFS content is public.
   * Max 25 CIDs per request.
   */
  router.post("/ipfs/batch", async (req: Request, res: Response) => {
    try {
      const { cids } = req.body as { cids?: unknown };

      if (!Array.isArray(cids) || cids.length === 0) {
        return res.status(400).json({ error: "cids must be a non-empty array of strings" });
      }
      if (cids.length > 25) {
        return res.status(400).json({ error: "Maximum 25 CIDs per batch request" });
      }

      // Validate and deduplicate
      const validCids: string[] = [];
      const seen = new Set<string>();
      for (const c of cids) {
        if (typeof c !== "string" || !CID_REGEX.test(c) || seen.has(c)) continue;
        seen.add(c);
        validCids.push(c);
      }

      if (validCids.length === 0) {
        return res.status(400).json({ error: "No valid CIDs provided" });
      }

      // Resolve each CID: check cache first, then fetch from Pinata in parallel
      const results: Record<string, unknown> = {};
      const toFetch: string[] = [];

      for (const cid of validCids) {
        const cached = getCached(cid);
        if (cached !== undefined) {
          results[cid] = cached;
        } else {
          toFetch.push(cid);
        }
      }

      // Fetch uncached CIDs in parallel with individual 8s timeouts
      if (toFetch.length > 0) {
        const fetches = toFetch.map(async (cid) => {
          try {
            const upstream = await fetch(`${gatewayConfig.ipfsReadGateway}/${cid}`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(8_000),
            });
            if (upstream.ok) {
              const data = await upstream.json();
              putCached(cid, data);
              return { cid, data };
            }
          } catch {
            // Individual fetch failed — leave as null
          }
          return { cid, data: null };
        });

        const settled = await Promise.all(fetches);
        for (const { cid, data } of settled) {
          if (data !== null) results[cid] = data;
        }
      }

      const cacheHits = validCids.length - toFetch.length;
      res.setHeader("X-Cache-Hits", String(cacheHits));
      res.setHeader("X-Cache-Misses", String(toFetch.length));
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("IPFS batch fetch error:", message);
      return res.status(500).json({ error: "IPFS batch fetch failed." });
    }
  });

  // -------------------------------------------------------
  //  POST /v1/register/did — Upload DID for human registration (PUBLIC)
  //
  //  No API key required. Humans prove wallet ownership via signature.
  //  Gateway builds the DID document server-side and uploads to IPFS.
  //  Returns the CID so the frontend can call the smart contract.
  //
  //  Rate-limited externally by registrationLimiter in server.ts.
  // -------------------------------------------------------
  router.post("/register/did", async (req: Request, res: Response) => {
    const { address, signature, displayName, description } = req.body;

    // Validate address
    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({
        error: "Bad request",
        message: "Missing or invalid 'address'. Must be a valid Ethereum address.",
      });
      return;
    }

    // Validate signature
    if (!signature || typeof signature !== "string") {
      res.status(400).json({
        error: "Bad request",
        message: `Missing 'signature'. Sign the message: "${DID_REGISTRATION_MESSAGE}"`,
      });
      return;
    }

    // Recover address from signature
    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.verifyMessage(DID_REGISTRATION_MESSAGE, signature);
    } catch {
      res.status(400).json({ error: "Bad request", message: "Invalid signature format." });
      return;
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      logSecurityEvent("warn", "did-registration-signature-mismatch", {
        claimed: address,
        recovered: recoveredAddress,
      });
      res.status(403).json({
        error: "Forbidden",
        message: "Signature does not match the provided address.",
      });
      return;
    }

    // Validate optional fields
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 100) {
        res.status(400).json({ error: "Bad request", message: "displayName must be a string (max 100 chars)." });
        return;
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== "string" || description.length > 500) {
        res.status(400).json({ error: "Bad request", message: "description must be a string (max 500 chars)." });
        return;
      }
    }

    try {
      // Build DID document server-side
      const did = `did:nookplot:${address.toLowerCase()}`;
      const now = Date.now();
      const didDoc = {
        version: "1.0",
        id: did,
        controller: did,
        verificationMethod: [
          {
            id: `${did}#key-1`,
            type: "EcdsaSecp256k1VerificationKey2019",
            controller: did,
            publicKeyHex: address.toLowerCase(),
          },
        ],
        agentProfile: {
          ...(displayName ? { displayName } : {}),
          ...(description ? { description } : {}),
        },
        service: [],
        created: now,
        updated: now,
        metadata: { clientVersion: "0.1.0", accountType: "human" },
      };

      // Upload to Pinata
      const jsonStr = JSON.stringify({
        pinataContent: didDoc,
        pinataMetadata: { name: `did-${address.toLowerCase()}` },
      });

      if (jsonStr.length > MAX_UPLOAD_SIZE) {
        res.status(413).json({ error: `Payload exceeds ${MAX_UPLOAD_SIZE} byte limit` });
        return;
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
        console.error("DID registration IPFS upload failed:", response.status, errorText);
        res.status(502).json({ error: "Failed to upload DID to IPFS" });
        return;
      }

      const result = (await response.json()) as { IpfsHash: string; PinSize: number };

      logSecurityEvent("info", "did-registration-upload", {
        address: address.toLowerCase(),
        cid: result.IpfsHash,
      });

      res.status(201).json({ cid: result.IpfsHash, size: result.PinSize });
    } catch (err) {
      console.error("DID registration error:", err);
      res.status(500).json({ error: "Internal server error" });
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
        console.error("IPFS upload upstream error:", response.status, errorText);
        return res.status(502).json({ error: "IPFS upload failed." });
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
