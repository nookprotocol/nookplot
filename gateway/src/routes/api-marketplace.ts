/**
 * API marketplace routes — endpoint registration, heartbeats, availability,
 * and the proxy engine for non-custodial API access sales.
 *
 * Flow:
 *   1. Provider creates listing (category: "api") via /v1/prepare/service/list
 *   2. Provider registers proxy endpoint via POST /v1/api/register-endpoint
 *   3. Provider sends heartbeats via POST /v1/api/heartbeat
 *   4. Buyer creates agreement via /v1/prepare/service/agree
 *   5. Buyer routes requests via POST /v1/api-proxy/:agreementId
 *   6. Gateway meters usage, forwards to provider, returns response
 *
 * @module routes/api-marketplace
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import { randomUUID } from "node:crypto";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter } from "../middleware/rateLimit.js";
import type { ApiProxyService, ApiAvailabilityRow } from "../services/apiProxyService.js";

/** Validate proxy path to prevent traversal and SSRF. */
function isValidProxyPath(path: string): boolean {
  if (/^https?:\/\//i.test(path) || path.startsWith("//")) return false;
  let decoded = path;
  try { decoded = decodeURIComponent(decodeURIComponent(path)); } catch {
    try { decoded = decodeURIComponent(path); } catch { /* use raw */ }
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0") || path.includes("%00")) return false;
  if (path.length > 2048) return false;
  return true;
}

/** Public-safe API availability — no proxy URL, no config details. */
export interface ApiPublicRow {
  listing_id: number | null;
  status: "online" | "degraded" | "offline";
  last_heartbeat: string;
  uptime_percent: number;
  active_agreements: number;
}

/** Redact an availability row for public display. */
export function toApiPublicRow(row: ApiAvailabilityRow): ApiPublicRow {
  const uptimePercent = row.uptime_checks > 0
    ? Math.round((row.uptime_passes / row.uptime_checks) * 100)
    : 0;
  return {
    listing_id: row.listing_id,
    status: row.status,
    last_heartbeat: row.last_heartbeat,
    uptime_percent: uptimePercent,
    active_agreements: row.active_agreements,
  };
}

export function createApiMarketplaceRouter(
  pool: pg.Pool,
  hmacSecret: string,
  apiProxyService: ApiProxyService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  // Heartbeat can be frequent (every 60s), allow 120/hour per agent
  const heartbeatLimiter = createKeyRateLimiter(3_600_000, 120);

  // ============================================================
  //  ENDPOINT REGISTRATION (Provider → Gateway)
  // ============================================================

  /**
   * POST /v1/api/register-endpoint — Provider registers their proxy URL
   *
   * Body: { listingId, proxyUrl, healthCheckPath?, rateLimitRpm?,
   *         allowedMethods?, maxPayloadBytes? }
   */
  router.post(
    "/api/register-endpoint",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const { listingId, proxyUrl, healthCheckPath, rateLimitRpm, allowedMethods, maxPayloadBytes } = req.body;

        if (!listingId || typeof listingId !== "number") {
          res.status(400).json({ error: "listingId (number) is required." });
          return;
        }
        if (!proxyUrl || typeof proxyUrl !== "string") {
          res.status(400).json({ error: "proxyUrl (string) is required." });
          return;
        }

        // Validate URL format
        try {
          new URL(proxyUrl);
        } catch {
          res.status(400).json({ error: "proxyUrl must be a valid URL." });
          return;
        }

        // Verify listing exists and is owned by this agent
        const { rows: listingRows } = await pool.query<{ provider_address: string; category: string }>(
          `SELECT LOWER(sl.provider_address) AS provider_address, sl.category
           FROM service_listings sl
           WHERE sl.listing_id = $1`,
          [listingId],
        );
        if (listingRows.length === 0) {
          res.status(404).json({ error: "Listing not found." });
          return;
        }
        if (listingRows[0].provider_address !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "You do not own this listing." });
          return;
        }
        if (listingRows[0].category !== "api") {
          res.status(400).json({ error: "Listing category must be 'api' for endpoint registration." });
          return;
        }

        // Validate allowedMethods if provided
        const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
        if (allowedMethods) {
          if (!Array.isArray(allowedMethods) || allowedMethods.some((m: string) => !validMethods.includes(m))) {
            res.status(400).json({ error: `allowedMethods must be an array of: ${validMethods.join(", ")}` });
            return;
          }
        }

        const config = await apiProxyService.registerEndpoint({
          listingId,
          providerAddress: agent.address,
          proxyUrl,
          healthCheckPath,
          rateLimitRpm,
          allowedMethods,
          maxPayloadBytes,
        });

        logSecurityEvent("info", "api-endpoint-registered", {
          agent: agent.address,
          listingId,
          proxyUrl: proxyUrl.replace(/\/\/[^@]*@/, "//***@"), // redact embedded creds
        });

        res.json({ ok: true, config });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-register-endpoint-failed", { error: message, agent: agent?.address });
        res.status(500).json({ error: "Failed to register endpoint." });
      }
    },
  );

  // ============================================================
  //  HEARTBEAT (Provider → Gateway)
  // ============================================================

  /**
   * POST /v1/api/heartbeat — Provider sends API heartbeat
   *
   * Body: { listingId, latencyMs?, activeAgreements? }
   */
  router.post(
    "/api/heartbeat",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    heartbeatLimiter,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const { listingId, latencyMs, activeAgreements } = req.body;

        if (!listingId || typeof listingId !== "number") {
          res.status(400).json({ error: "listingId (number) is required." });
          return;
        }

        // Verify listing exists and is owned by this agent
        const { rows: listingRows } = await pool.query<{ provider_address: string }>(
          `SELECT LOWER(sl.provider_address) AS provider_address
           FROM service_listings sl
           WHERE sl.listing_id = $1`,
          [listingId],
        );
        if (listingRows.length === 0) {
          res.status(404).json({ error: "Listing not found." });
          return;
        }
        if (listingRows[0].provider_address !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "You do not own this listing." });
          return;
        }

        const result = await apiProxyService.recordHeartbeat({
          providerAddress: agent.address,
          listingId,
          latencyMs,
          activeAgreements,
        });

        res.json({ ok: true, availability: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-heartbeat-failed", { error: message, agent: agent?.address });
        res.status(500).json({ error: "Failed to record heartbeat." });
      }
    },
  );

  // ============================================================
  //  AVAILABILITY (Tiered disclosure — mirrors GPU pattern)
  //
  //  Public:        listing_id, status, uptime_percent, last_heartbeat
  //  Authenticated: + provider_address, latency, active_agreements
  // ============================================================

  /**
   * Try to extract authenticated agent from request without failing.
   */
  async function tryAuth(req: Request): Promise<{ address: string } | null> {
    try {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey) return null;
      const { rows } = await pool.query<{ address: string }>(
        `SELECT a.address FROM agents a JOIN api_keys k ON k.agent_id = a.id WHERE k.key_hash = encode(sha256($1::bytea), 'hex') AND k.revoked = FALSE`,
        [Buffer.from(apiKey)],
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * GET /v1/api/availability — List available API providers
   *
   * Public: redacted (status, uptime only)
   * Authenticated: full details (provider address, latency, agreements)
   */
  router.get(
    "/api/availability",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const status = typeof req.query.status === "string"
          ? req.query.status as "online" | "degraded" | "any"
          : undefined;
        const minUptimePercent = typeof req.query.minUptime === "string"
          ? parseFloat(req.query.minUptime)
          : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const apis = await apiProxyService.searchAvailable({
          status,
          minUptimePercent: isNaN(minUptimePercent!) ? undefined : minUptimePercent,
          limit,
          offset,
        });

        const caller = await tryAuth(req);

        if (caller) {
          // Authenticated: return details but strip proxy URL (never exposed)
          const authedApis = apis.map((a) => ({
            provider_address: a.provider_address,
            listing_id: a.listing_id,
            status: a.status,
            last_heartbeat: a.last_heartbeat,
            last_latency_ms: a.last_latency_ms,
            uptime_percent: a.uptime_checks > 0
              ? Math.round((a.uptime_passes / a.uptime_checks) * 100)
              : 0,
            active_agreements: a.active_agreements,
          }));
          res.json({ apis: authedApis, limit, offset });
        } else {
          // Public: redacted
          res.json({ apis: apis.map(toApiPublicRow), limit, offset });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-availability-search-failed", { error: message });
        res.status(500).json({ error: "Failed to search API availability." });
      }
    },
  );

  /**
   * GET /v1/api/availability/:listingId — Single API listing availability
   */
  router.get(
    "/api/availability/:listingId",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const listingId = parseInt(req.params.listingId as string, 10);
        if (isNaN(listingId)) {
          res.status(400).json({ error: "Listing ID must be a number." });
          return;
        }

        const availability = await apiProxyService.getAvailability(listingId);
        if (!availability) {
          res.status(404).json({ error: "No availability data for this listing." });
          return;
        }

        const caller = await tryAuth(req);

        if (caller) {
          // Authenticated: details without proxy URL
          res.json({
            availability: {
              provider_address: availability.provider_address,
              listing_id: availability.listing_id,
              status: availability.status,
              last_heartbeat: availability.last_heartbeat,
              last_latency_ms: availability.last_latency_ms,
              uptime_percent: availability.uptime_checks > 0
                ? Math.round((availability.uptime_passes / availability.uptime_checks) * 100)
                : 0,
              active_agreements: availability.active_agreements,
            },
          });
        } else {
          res.json({ availability: toApiPublicRow(availability) });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-availability-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to get availability." });
      }
    },
  );

  // ============================================================
  //  USAGE STATS (Party-only)
  // ============================================================

  /**
   * GET /v1/api/usage/:agreementId — Usage summary for an agreement
   *
   * Auth required. Only buyer or provider can view.
   */
  router.get(
    "/api/usage/:agreementId",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const agreementId = parseInt(req.params.agreementId as string, 10);
        if (isNaN(agreementId)) {
          res.status(400).json({ error: "Agreement ID must be a number." });
          return;
        }

        // Verify caller is a party to this agreement
        const { rows: agreementRows } = await pool.query<{
          buyer_address: string;
          provider_address: string;
          listing_id: number;
        }>(
          `SELECT LOWER(b.address) AS buyer_address, LOWER(p.address) AS provider_address, sa.listing_id
           FROM service_agreements sa
           JOIN agents b ON b.id = sa.buyer_agent_id
           JOIN agents p ON p.id = sa.provider_agent_id
           WHERE sa.agreement_id = $1`,
          [agreementId],
        );
        if (agreementRows.length === 0) {
          res.status(404).json({ error: "Agreement not found." });
          return;
        }
        const agr = agreementRows[0];
        const callerAddr = agent.address.toLowerCase();
        if (callerAddr !== agr.buyer_address && callerAddr !== agr.provider_address) {
          res.status(403).json({ error: "Only agreement parties can view usage." });
          return;
        }

        const summary = await apiProxyService.getUsageSummary(agreementId);

        // Also return recent logs
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
        const logs = await apiProxyService.getUsageLogs(agreementId, limit, offset);

        res.json({ summary, logs, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-usage-failed", { error: message, agent: agent?.address });
        res.status(500).json({ error: "Failed to get usage." });
      }
    },
  );

  // ============================================================
  //  PROXY ENGINE (Buyer → Gateway → Provider)
  //
  //  Non-custodial: buyer signs each request with EIP-712.
  //  Gateway validates signature, checks agreement, meters usage,
  //  and forwards to the provider's registered proxy URL.
  //  Provider holds the real API key — it never reaches the gateway.
  // ============================================================

  /** EIP-712 domain for API proxy request signatures. */
  const API_PROXY_DOMAIN = {
    name: "NookplotApiProxy",
    version: "1",
    chainId: 8453, // Base Mainnet
  };

  /** EIP-712 types for ApiRequest. */
  const API_REQUEST_TYPES = {
    ApiRequest: [
      { name: "agreementId", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "requestHash", type: "bytes32" },
    ],
  };

  /** Maximum allowed age of a signed proxy request (5 minutes). */
  const MAX_PROXY_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

  /** Maximum proxy response timeout (30 seconds). */
  const PROXY_TIMEOUT_MS = 30_000;

  /** In-memory rate limiter for proxy requests per agreement. */
  const proxyRateBuckets = new Map<number, { count: number; windowStart: number }>();

  function checkProxyRateLimit(agreementId: number, maxRpm: number): boolean {
    const now = Date.now();
    const bucket = proxyRateBuckets.get(agreementId);

    if (!bucket || now - bucket.windowStart >= 60_000) {
      // New window
      proxyRateBuckets.set(agreementId, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= maxRpm) {
      return false;
    }

    bucket.count++;
    return true;
  }

  /**
   * ALL /v1/api-proxy/:agreementId/* — Proxy engine catch-all
   *
   * Headers:
   *   X-Nookplot-Signature: EIP-712 signature of { agreementId, timestamp, requestHash }
   *   X-Nookplot-Timestamp: Unix timestamp (seconds) when signature was created
   *
   * The gateway:
   *   1. Validates the EIP-712 signature against the buyer's address
   *   2. Verifies the agreement is active and not expired
   *   3. Checks per-agreement rate limits
   *   4. Forwards the request to the provider's registered proxy URL
   *   5. Logs usage for metering
   *   6. Returns the provider's response to the buyer
   */
  router.all(
    "/api-proxy/:agreementId/*",
    async (req: Request, res: Response): Promise<void> => {
      const startMs = Date.now();
      const requestId = randomUUID();
      const agreementId = parseInt(req.params.agreementId as string, 10);

      if (isNaN(agreementId)) {
        res.status(400).json({ error: "Agreement ID must be a number." });
        return;
      }

      // ── Extract signature headers ───────────────────────────
      const signature = req.headers["x-nookplot-signature"] as string | undefined;
      const timestampStr = req.headers["x-nookplot-timestamp"] as string | undefined;

      if (!signature || !timestampStr) {
        res.status(401).json({
          error: "Missing required headers: X-Nookplot-Signature and X-Nookplot-Timestamp",
        });
        return;
      }

      const timestamp = parseInt(timestampStr, 10);
      if (isNaN(timestamp)) {
        res.status(400).json({ error: "X-Nookplot-Timestamp must be a unix timestamp (seconds)." });
        return;
      }

      // ── Validate timestamp freshness ────────────────────────
      const nowMs = Date.now();
      const msgMs = timestamp * 1000;
      if (Math.abs(nowMs - msgMs) > MAX_PROXY_TIMESTAMP_DRIFT_MS) {
        res.status(401).json({ error: "Request signature has expired or timestamp is too far in the future." });
        return;
      }

      // ── Validate + build request hash ─────────────────────────
      const proxyPath = req.params[0] || "";

      // Block path traversal, SSRF via absolute URLs, and injection
      if (!isValidProxyPath(proxyPath)) {
        logSecurityEvent("warn", "api-proxy-path-blocked", {
          agreementId,
          path: proxyPath.slice(0, 200),
        });
        res.status(400).json({ error: "Invalid proxy path." });
        return;
      }

      // Hash = keccak256(method + path + body)
      const bodyStr = req.body ? JSON.stringify(req.body) : "";
      const requestHash = ethers.keccak256(
        ethers.toUtf8Bytes(`${req.method}:${proxyPath}:${bodyStr}`),
      );

      // ── Verify EIP-712 signature ────────────────────────────
      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyTypedData(
          API_PROXY_DOMAIN,
          API_REQUEST_TYPES,
          {
            agreementId: BigInt(agreementId),
            timestamp: BigInt(timestamp),
            requestHash,
          },
          signature,
        );
      } catch (err) {
        logSecurityEvent("warn", "api-proxy-sig-invalid", {
          agreementId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(401).json({ error: "Invalid EIP-712 signature." });
        return;
      }

      // ── Look up agreement + validate ────────────────────────
      try {
        const { rows: agrRows } = await pool.query<{
          buyer_address: string;
          provider_address: string;
          listing_id: number;
          status: string;
          deadline: string | null;
        }>(
          `SELECT LOWER(b.address) AS buyer_address, LOWER(p.address) AS provider_address,
                  sa.listing_id, sa.status, sa.deadline
           FROM service_agreements sa
           JOIN agents b ON b.id = sa.buyer_agent_id
           JOIN agents p ON p.id = sa.provider_agent_id
           WHERE sa.agreement_id = $1`,
          [agreementId],
        );

        if (agrRows.length === 0) {
          res.status(404).json({ error: "Agreement not found." });
          return;
        }

        const agr = agrRows[0];

        // Verify signer is the buyer on this agreement
        if (recoveredAddress.toLowerCase() !== agr.buyer_address) {
          logSecurityEvent("warn", "api-proxy-buyer-mismatch", {
            agreementId,
            recovered: recoveredAddress,
            expected: agr.buyer_address,
          });
          res.status(403).json({ error: "Signature does not match agreement buyer." });
          return;
        }

        // Verify agreement is active
        if (!["agreed", "delivered"].includes(agr.status)) {
          res.status(403).json({ error: `Agreement is not active (status: ${agr.status}).` });
          return;
        }

        // Check deadline
        if (agr.deadline && new Date(agr.deadline).getTime() < nowMs) {
          res.status(403).json({ error: "Agreement has expired." });
          return;
        }

        // ── Get proxy config ────────────────────────────────────
        const proxyConfig = await apiProxyService.getProxyConfig(agr.listing_id);
        if (!proxyConfig) {
          res.status(502).json({ error: "Provider has not registered a proxy endpoint for this listing." });
          return;
        }

        // ── Check method allowed ────────────────────────────────
        if (!proxyConfig.allowed_methods.includes(req.method)) {
          res.status(405).json({
            error: `Method ${req.method} not allowed. Allowed: ${proxyConfig.allowed_methods.join(", ")}`,
          });
          return;
        }

        // ── Check payload size ──────────────────────────────────
        const requestBytes = Buffer.byteLength(bodyStr, "utf8");
        if (requestBytes > proxyConfig.max_payload_bytes) {
          res.status(413).json({
            error: `Request payload too large (${requestBytes} bytes). Max: ${proxyConfig.max_payload_bytes} bytes.`,
          });
          return;
        }

        // ── Rate limit check ────────────────────────────────────
        if (!checkProxyRateLimit(agreementId, proxyConfig.rate_limit_rpm)) {
          res.status(429).json({
            error: `Rate limit exceeded (${proxyConfig.rate_limit_rpm} requests/minute).`,
          });
          // Log the rate-limited request
          await apiProxyService.logUsage({
            agreementId,
            listingId: agr.listing_id,
            requestId,
            buyerAddress: agr.buyer_address,
            providerAddress: agr.provider_address,
            method: req.method,
            path: proxyPath,
            statusCode: 429,
            latencyMs: Date.now() - startMs,
            requestBytes,
            error: "Rate limit exceeded",
          });
          return;
        }

        // ── Forward to provider ─────────────────────────────────
        const targetUrl = new URL(proxyPath, proxyConfig.proxy_url.endsWith("/")
          ? proxyConfig.proxy_url
          : proxyConfig.proxy_url + "/",
        );

        // Copy query params
        for (const [key, val] of Object.entries(req.query)) {
          if (typeof val === "string") {
            targetUrl.searchParams.set(key, val);
          }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

        let providerResponse: globalThis.Response;
        try {
          providerResponse = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: {
              "Content-Type": req.headers["content-type"] || "application/json",
              "X-Nookplot-Agreement-Id": String(agreementId),
              "X-Nookplot-Buyer-Address": recoveredAddress,
              "X-Nookplot-Request-Id": requestId,
              "X-Nookplot-Timestamp": timestampStr,
            },
            body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyStr || undefined,
            signal: controller.signal,
          });
        } catch (fetchErr) {
          clearTimeout(timeout);
          const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          const isTimeout = errMsg.includes("abort");

          await apiProxyService.logUsage({
            agreementId,
            listingId: agr.listing_id,
            requestId,
            buyerAddress: agr.buyer_address,
            providerAddress: agr.provider_address,
            method: req.method,
            path: proxyPath,
            latencyMs: Date.now() - startMs,
            requestBytes,
            error: isTimeout ? "Provider timeout" : `Provider unreachable: ${errMsg}`,
          });

          res.status(502).json({
            error: isTimeout
              ? "Provider did not respond in time."
              : "Provider is unreachable.",
          });
          return;
        }
        clearTimeout(timeout);

        // ── Stream response back to buyer ───────────────────────
        const responseBytes: number[] = [];
        const statusCode = providerResponse.status;

        // Copy response headers (selective)
        const safeHeaders = ["content-type", "x-request-id", "x-ratelimit-remaining"];
        for (const h of safeHeaders) {
          const val = providerResponse.headers.get(h);
          if (val) res.setHeader(h, val);
        }

        // Add proxy metadata headers
        res.setHeader("X-Nookplot-Request-Id", requestId);
        res.setHeader("X-Nookplot-Proxied", "true");

        // Buffer the response and send
        let responseBody: Buffer;
        try {
          const arrayBuffer = await providerResponse.arrayBuffer();
          responseBody = Buffer.from(arrayBuffer);
        } catch {
          responseBody = Buffer.alloc(0);
        }

        const latencyMs = Date.now() - startMs;

        // ── Log usage ─────────────────────────────────────────
        // Fire-and-forget — don't block response
        apiProxyService.logUsage({
          agreementId,
          listingId: agr.listing_id,
          requestId,
          buyerAddress: agr.buyer_address,
          providerAddress: agr.provider_address,
          method: req.method,
          path: proxyPath,
          statusCode,
          latencyMs,
          requestBytes,
          responseBytes: responseBody.length,
        }).catch((err) => {
          console.error("[api-proxy] Usage logging failed:", err);
        });

        res.status(statusCode).send(responseBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-proxy-failed", { error: message, agreementId });
        res.status(500).json({ error: "Proxy request failed." });
      }
    },
  );

  return router;
}
