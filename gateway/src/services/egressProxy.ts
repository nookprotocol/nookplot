/**
 * Secure egress proxy for agent HTTP requests.
 *
 * Mediates all outbound HTTP requests from agents to external services.
 * Security pipeline (follows InferenceProxy pattern):
 * 1. Domain allowlist check
 * 2. Secret scan outbound (block private keys, PII patterns)
 * 3. Rate limit (per-agent, per-domain)
 * 4. Credit check + charge
 * 5. Credential injection (auto-inject stored credentials)
 * 6. Execute with timeout + response size cap
 * 7. Audit log
 * 8. Strip sensitive response headers
 *
 * @module services/egressProxy
 */

import dns from "dns/promises";
import { isIP } from "net";
import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import { decryptSecret } from "../secretManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { isPrivateIp, ALLOWED_PROTOCOLS, BLOCKED_HOSTNAMES } from "../networkGuard.js";

// ============================================================
//  Types
// ============================================================

export interface EgressRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  credentialService?: string;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  creditsCharged: number;
  durationMs: number;
}

// ============================================================
//  Secret scan patterns
// ============================================================

const SECRET_PATTERNS = [
  /0x[0-9a-fA-F]{64}/,                     // Ethereum private key
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, // PEM private keys
  /sk-[a-zA-Z0-9]{32,}/,                    // OpenAI-style API keys
  /ghp_[a-zA-Z0-9]{36}/,                    // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/,                    // GitHub OAuth
  /xox[bpras]-[a-zA-Z0-9-]{10,}/,           // Slack tokens
  /AKIA[A-Z0-9]{16}/,                       // AWS access key
  /\b\d{3}[-. ]?\d{2}[-. ]?\d{4}\b/,        // SSN pattern
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // Credit card pattern
];

const MAX_RESPONSE_SIZE = 1_048_576; // 1MB
const MAX_TIMEOUT_MS = 30_000;
const BASE_CREDIT_COST = 15;
const CREDITS_PER_KB = 1;

// ============================================================
//  EgressProxy
// ============================================================

export class EgressProxy {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly secretEncryptionKey: string;

  constructor(
    pool: pg.Pool,
    creditManager: CreditManager,
    secretEncryptionKey: string,
  ) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.secretEncryptionKey = secretEncryptionKey;
  }

  /**
   * Execute an outbound HTTP request through the security pipeline.
   */
  async execute(agentId: string, request: EgressRequest): Promise<EgressResponse> {
    const startTime = Date.now();
    let domain: string;
    let pathname: string;
    let pinnedIp: string | null = null;

    try {
      const parsed = new URL(request.url);
      domain = parsed.hostname;
      pathname = parsed.pathname;

      // SSRF protection: only allow http/https protocols
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Protocol "${parsed.protocol}" is not allowed. Use http: or https: only.`);
      }

      // SSRF protection: block known internal/infrastructure hostnames
      if (BLOCKED_HOSTNAMES.has(domain.toLowerCase())) {
        logSecurityEvent("warn", "egress-ssrf-blocked", { agentId, domain });
        throw new Error("Egress blocked: target hostname is an internal/infrastructure address");
      }

      // SSRF protection: block direct IP access and private IPs
      if (isIP(domain)) {
        if (isPrivateIp(domain)) {
          throw new Error("Egress to private/reserved IP addresses is not allowed");
        }
        pinnedIp = domain;
      } else {
        // Resolve hostname and check all resolved IPs.
        // Pin the first valid public IP to prevent TOCTOU DNS rebinding.
        const addresses = await dns.resolve4(domain).catch(() => [] as string[]);
        const addresses6 = await dns.resolve6(domain).catch(() => [] as string[]);
        const allAddresses = [...addresses, ...addresses6];

        if (allAddresses.length === 0) {
          throw new Error(`DNS resolution failed for "${domain}"`);
        }

        for (const addr of allAddresses) {
          if (isPrivateIp(addr)) {
            logSecurityEvent("warn", "egress-ssrf-blocked", {
              agentId,
              domain,
              resolvedIp: addr,
            });
            throw new Error("Egress blocked: domain resolves to a private/reserved IP address");
          }
        }

        // Pin the first resolved IP so fetch() uses it directly,
        // preventing DNS rebinding between check and use.
        pinnedIp = allAddresses[0];
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Egress")) throw error;
      if (error instanceof Error && (error.message.includes("Protocol") || error.message.includes("DNS"))) throw error;
      throw new Error("Invalid URL");
    }

    // 1a. Global denylist check (admin-curated, overrides agent allowlist)
    await this.checkGlobalDenylist(domain);

    // 1b. Domain allowlist check (per-agent)
    await this.checkAllowlist(agentId, domain);

    // 2. Secret scan outbound
    this.scanForSecrets(request);

    // 3. Rate limit check
    await this.checkRateLimit(agentId, domain);

    // 4. Pre-deduct base credits before making the request
    const requestId = `egress-${Date.now()}`;
    try {
      await this.creditManager.deductCredits(agentId, BASE_CREDIT_COST, requestId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "INSUFFICIENT_CREDITS" || msg === "ACCOUNT_NOT_FOUND" || msg === "DAILY_SPEND_LIMIT") {
        throw new Error("Insufficient credits for egress request");
      }
      throw error;
    }

    // 5. Credential injection
    const headers = { ...request.headers };
    if (request.credentialService) {
      const credential = await this.getCredential(agentId, request.credentialService);
      if (credential) {
        // Sanitize credential: reject non-printable ASCII (null bytes, CRLF, control chars)
        const sanitized = credential.slice(0, 4096);
        if (!/^[\x20-\x7E]+$/.test(sanitized)) {
          logSecurityEvent("warn", "egress-credential-invalid-chars", { agentId, service: request.credentialService });
          throw new Error("Stored credential contains invalid characters");
        }
        headers["Authorization"] = `Bearer ${sanitized}`;
      }
    }

    // 6. Execute with timeout + size cap
    const timeout = Math.min(request.timeout ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      // Build fetch URL using the pinned IP to prevent DNS rebinding (TOCTOU).
      // Replace hostname with pinned IP and set Host header to original domain.
      let fetchUrl = request.url;
      if (pinnedIp && !isIP(domain)) {
        const parsed = new URL(request.url);
        parsed.hostname = pinnedIp;
        fetchUrl = parsed.toString();
        headers["Host"] = domain;
      }

      response = await fetch(fetchUrl, {
        method: request.method,
        headers,
        body: request.method !== "GET" ? request.body : undefined,
        signal: controller.signal,
        redirect: "manual",
      });

      // If the target responds with a redirect, reject it rather than following
      // to a potentially internal/private IP that bypasses our SSRF checks.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "(none)";
        logSecurityEvent("warn", "egress-redirect-blocked", {
          agentId,
          domain,
          status: response.status,
          location: location.slice(0, 200),
        });
        throw new Error(`Egress request returned a redirect (${response.status}). Redirects are not followed for security.`);
      }
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Refund pre-deducted credits on fetch failure
      try {
        await this.creditManager.addCredits(agentId, BASE_CREDIT_COST, "egress_refund", requestId);
      } catch {
        logSecurityEvent("warn", "egress-refund-failed", { agentId, requestId });
      }

      await this.logRequest(agentId, domain, request.method, pathname, null,
        request.body?.length ?? 0, 0, 0, durationMs, errorMsg);

      throw new Error(`Egress request failed: ${errorMsg}`);
    } finally {
      clearTimeout(timer);
    }

    // Read response with size cap
    const responseBody = await this.readResponseBody(response);
    const durationMs = Date.now() - startTime;

    // Calculate additional credits for response size (base already deducted)
    const responseSizeKb = Math.ceil(responseBody.length / 1024);
    const additionalCredits = responseSizeKb * CREDITS_PER_KB;
    const creditsCharged = BASE_CREDIT_COST + additionalCredits;

    // Charge additional credits for response size
    if (additionalCredits > 0) {
      try {
        await this.creditManager.deductCredits(agentId, additionalCredits, `${requestId}-response`);
      } catch {
        logSecurityEvent("warn", "egress-response-credit-charge-failed", {
          agentId,
          additionalCredits,
        });
      }
    }

    // 7. Audit log
    await this.logRequest(
      agentId, domain, request.method, pathname,
      response.status, request.body?.length ?? 0,
      responseBody.length, creditsCharged, durationMs, null,
    );

    // 8. Strip sensitive response headers
    const safeHeaders: Record<string, string> = {};
    const sensitiveHeaders = new Set(["set-cookie", "server", "x-powered-by"]);
    response.headers.forEach((value, key) => {
      if (!sensitiveHeaders.has(key.toLowerCase())) {
        safeHeaders[key] = value;
      }
    });

    return {
      status: response.status,
      headers: safeHeaders,
      body: responseBody,
      creditsCharged,
      durationMs,
    };
  }

  // ---- Private helpers ----

  /**
   * Check if domain is on the admin-curated global denylist.
   * Checked BEFORE the per-agent allowlist — a denied domain cannot
   * be overridden by an agent adding it to their allowlist.
   */
  private async checkGlobalDenylist(domain: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM egress_global_denylist WHERE domain = $1 LIMIT 1`,
      [domain.toLowerCase()],
    );
    if (result.rows.length > 0) {
      throw new Error(`Domain "${domain}" is denied by platform policy.`);
    }
  }

  /**
   * Check if agent has the domain on their allowlist.
   */
  private async checkAllowlist(agentId: string, domain: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT domain, max_requests_per_hour
       FROM agent_egress_allowlist
       WHERE agent_id = $1 AND domain = $2`,
      [agentId, domain],
    );
    if (result.rows.length === 0) {
      throw new Error(`Domain "${domain}" is not on your egress allowlist. Add it first via PUT /v1/agents/me/egress.`);
    }
  }

  /**
   * Scan request for sensitive data patterns.
   */
  private scanForSecrets(request: EgressRequest): void {
    const toScan = [
      request.url,
      request.body ?? "",
      ...Object.values(request.headers ?? {}),
    ].join("\n");

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(toScan)) {
        throw new Error("Egress request blocked: contains sensitive data pattern");
      }
    }
  }

  /**
   * Check per-agent per-domain rate limit.
   */
  private async checkRateLimit(agentId: string, domain: string): Promise<void> {
    // Atomic rate limit check: count existing requests and verify under limit in one query
    const result = await this.pool.query<{ current_count: string; max_allowed: string }>(
      `SELECT
         (SELECT COUNT(*) FROM egress_request_log
          WHERE agent_id = $1 AND domain = $2
            AND created_at > NOW() - INTERVAL '1 hour')::text AS current_count,
         COALESCE(
           (SELECT max_requests_per_hour FROM agent_egress_allowlist
            WHERE agent_id = $1 AND domain = $2),
           60
         )::text AS max_allowed`,
      [agentId, domain],
    );
    const count = parseInt(result.rows[0]?.current_count ?? "0", 10);
    const maxPerHour = parseInt(result.rows[0]?.max_allowed ?? "60", 10);

    if (count >= maxPerHour) {
      throw new Error(`Rate limit exceeded: ${count}/${maxPerHour} requests/hour for ${domain}`);
    }
  }

  /**
   * Decrypt and retrieve a stored credential for a service.
   */
  private async getCredential(agentId: string, service: string): Promise<string | null> {
    const result = await this.pool.query<{
      encrypted_key: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT encrypted_key, iv, auth_tag FROM agent_credentials
       WHERE agent_id = $1 AND service = $2`,
      [agentId, service],
    );
    if (result.rows.length === 0) return null;

    try {
      return decryptSecret(
        result.rows[0].encrypted_key,
        result.rows[0].iv,
        result.rows[0].auth_tag,
        this.secretEncryptionKey,
      );
    } catch {
      logSecurityEvent("warn", "egress-credential-decrypt-failed", {
        agentId,
        service,
      });
      return null;
    }
  }

  /**
   * Read response body with size cap.
   */
  private async readResponseBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.byteLength;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          chunks.push(value.slice(0, MAX_RESPONSE_SIZE - (totalSize - value.byteLength)));
          break;
        }
        chunks.push(value);
      }
    } catch {
      // Stream read error — return what we have
    }

    const combined = new Uint8Array(Math.min(totalSize, MAX_RESPONSE_SIZE));
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  /**
   * Log egress request to audit table.
   */
  private async logRequest(
    agentId: string,
    domain: string,
    method: string,
    path: string,
    statusCode: number | null,
    requestSize: number,
    responseSize: number,
    creditsCharged: number,
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO egress_request_log
          (agent_id, domain, method, path, status_code, request_size, response_size, credits_charged, duration_ms, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [agentId, domain, method, path, statusCode, requestSize, responseSize, creditsCharged, durationMs, errorMessage],
      );
    } catch (error) {
      logSecurityEvent("warn", "egress-log-failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
