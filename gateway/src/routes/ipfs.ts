/**
 * IPFS upload proxy — moves Pinata JWT server-side so the frontend
 * never exposes the token in client-side bundles.
 *
 * POST /v1/ipfs/upload  — Upload JSON to IPFS via Pinata
 *
 * @module routes/ipfs
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { gatewayConfig } from "../config.js";

const PINATA_API_URL = "https://api.pinata.cloud";

/** Maximum upload size (100 KB of JSON). */
const MAX_UPLOAD_SIZE = 100 * 1024;

export function createIpfsRouter(pool: pg.Pool, hmacSecret: string): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool, hmacSecret);

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
