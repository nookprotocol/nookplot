/**
 * Webhook manager — handles inbound webhook registration, HMAC verification,
 * replay protection, rate limiting, and event publishing.
 *
 * External services POST to `/v1/webhooks/:address/:source` to trigger
 * agent events. The WebhookManager verifies authenticity, logs the event,
 * and publishes it to the agent's WebSocket stream via RuntimeEventBroadcaster.
 *
 * @module services/webhookManager
 */

import crypto from "crypto";
import type pg from "pg";
import type { RuntimeEventBroadcaster } from "./runtimeEventBroadcaster.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { encryptSecret, decryptSecret } from "../secretManager.js";

// ============================================================
//  Types
// ============================================================

export interface WebhookConfig {
  /** HMAC secret for signature verification. */
  secret?: string;
  /** Header containing the HMAC signature (e.g. "X-Hub-Signature-256"). */
  signatureHeader?: string;
  /** Header containing the timestamp for replay protection. */
  timestampHeader?: string;
  /** Max age in seconds for replay protection (default: 300 = 5 min). */
  maxAgeSeconds?: number;
  /** Map provider event types to Nookplot event types. */
  eventMapping?: Record<string, string>;
}

export interface WebhookRegistration {
  id: string;
  agentId: string;
  source: string;
  config: WebhookConfig;
  active: boolean;
  createdAt: string;
}

export interface WebhookEventEntry {
  id: string;
  agentId: string;
  source: string;
  eventType: string | null;
  status: string;
  payloadSize: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//  Constants
// ============================================================

const MAX_WEBHOOKS_PER_HOUR = 100;
const MAX_PAYLOAD_SIZE = 262_144; // 256 KB
const DEFAULT_MAX_AGE_SECONDS = 300; // 5 minutes

// ============================================================
//  WebhookManager
// ============================================================

export class WebhookManager {
  private readonly pool: pg.Pool;
  private readonly eventBroadcaster: RuntimeEventBroadcaster;
  private readonly secretEncryptionKey?: string;

  constructor(pool: pg.Pool, eventBroadcaster: RuntimeEventBroadcaster, secretEncryptionKey?: string) {
    this.pool = pool;
    this.eventBroadcaster = eventBroadcaster;
    this.secretEncryptionKey = secretEncryptionKey;
  }

  // ---- Registration management ----

  /**
   * Register a webhook source for an agent.
   */
  async register(
    agentId: string,
    source: string,
    config: WebhookConfig,
  ): Promise<WebhookRegistration> {
    // Validate source name
    if (!source.match(/^[a-z0-9_-]{1,100}$/)) {
      throw new Error("Invalid source name. Use lowercase letters, numbers, hyphens, and underscores (max 100 chars).");
    }

    // Encrypt the webhook secret before storage if encryption key is available
    const configToStore: Record<string, unknown> = { ...config };
    if (configToStore.secret && this.secretEncryptionKey) {
      const { encryptedKey, iv, authTag } = encryptSecret(configToStore.secret as string, this.secretEncryptionKey);
      configToStore.encryptedSecret = encryptedKey;
      configToStore.secretIv = iv;
      configToStore.secretAuthTag = authTag;
      delete configToStore.secret; // Don't store plaintext
    }

    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      source: string;
      config: WebhookConfig;
      active: boolean;
      created_at: string;
    }>(
      `INSERT INTO webhook_registrations (agent_id, source, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, source) DO UPDATE
         SET config = $3, active = TRUE
       RETURNING *`,
      [agentId, source, JSON.stringify(configToStore)],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      agentId: row.agent_id,
      source: row.source,
      config: row.config,
      active: row.active,
      createdAt: row.created_at,
    };
  }

  /**
   * List webhook registrations for an agent.
   */
  async list(agentId: string): Promise<WebhookRegistration[]> {
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      source: string;
      config: WebhookConfig;
      active: boolean;
      created_at: string;
    }>(
      `SELECT * FROM webhook_registrations WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      source: row.source,
      config: row.config,
      active: row.active,
      createdAt: row.created_at,
    }));
  }

  /**
   * Remove a webhook registration.
   */
  async remove(agentId: string, source: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM webhook_registrations WHERE agent_id = $1 AND source = $2`,
      [agentId, source],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get webhook event log for an agent.
   */
  async getEventLog(
    agentId: string,
    page = 0,
    limit = 20,
  ): Promise<WebhookEventEntry[]> {
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      source: string;
      event_type: string | null;
      status: string;
      payload_size: number | null;
      error_message: string | null;
      created_at: string;
    }>(
      `SELECT * FROM webhook_event_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, page * limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      source: row.source,
      eventType: row.event_type,
      status: row.status,
      payloadSize: row.payload_size,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    }));
  }

  // ---- Inbound webhook handling ----

  /**
   * Handle an inbound webhook from an external service.
   *
   * Security pipeline:
   * 1. Look up webhook registration (agent + source)
   * 2. HMAC signature verification (if configured)
   * 3. Timestamp replay protection (if configured)
   * 4. Rate limit check (per agent per source)
   * 5. Payload size check
   * 6. Publish as webhook.received event
   * 7. Log to webhook_event_log
   */
  async handleIncoming(
    agentAddress: string,
    source: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<void> {
    // Resolve agent ID from address
    const agentResult = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
      [agentAddress],
    );
    if (agentResult.rows.length === 0) {
      throw new WebhookError("Agent not found", 404);
    }
    const agentId = agentResult.rows[0].id;

    // 1. Look up registration
    const regResult = await this.pool.query<{
      id: string;
      config: WebhookConfig;
      active: boolean;
    }>(
      `SELECT id, config, active FROM webhook_registrations
       WHERE agent_id = $1 AND source = $2`,
      [agentId, source],
    );

    if (regResult.rows.length === 0) {
      throw new WebhookError(`No webhook registered for source "${source}"`, 404);
    }

    const reg = regResult.rows[0];
    if (!reg.active) {
      throw new WebhookError(`Webhook for source "${source}" is inactive`, 403);
    }

    const config = reg.config;

    // Decrypt webhook secret if it was encrypted at rest
    const resolvedSecret = this.resolveSecret(config as WebhookConfig & { encryptedSecret?: string; secretIv?: string; secretAuthTag?: string });

    // 1b. Idempotency check — deduplicate by webhook ID header
    const idempotencyKey = this.extractIdempotencyKey(headers, agentId, source, body);
    if (idempotencyKey) {
      const { rows: existingRows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM webhook_event_log WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existingRows.length > 0) {
        // Already processed — return silently (200 OK at caller level)
        return;
      }
    }

    // 2. HMAC signature verification
    if (resolvedSecret && config.signatureHeader) {
      const signatureHeaderKey = config.signatureHeader.toLowerCase();
      const providedSignature = headers[signatureHeaderKey];

      if (!providedSignature) {
        await this.logEvent(agentId, source, null, "rejected", body.length, "Missing signature header", idempotencyKey);
        throw new WebhookError("Missing signature header", 401);
      }

      const isValid = this.verifyHmac(body, resolvedSecret, providedSignature);
      if (!isValid) {
        logSecurityEvent("warn", "webhook-signature-invalid", {
          agentId,
          source,
        });
        await this.logEvent(agentId, source, null, "rejected", body.length, "Invalid HMAC signature", idempotencyKey);
        throw new WebhookError("Invalid signature", 401);
      }
    }

    // 3. Replay protection
    if (config.timestampHeader) {
      const timestampHeaderKey = config.timestampHeader.toLowerCase();
      const timestamp = headers[timestampHeaderKey];

      if (!timestamp) {
        await this.logEvent(agentId, source, null, "rejected", body.length, "Missing timestamp header", idempotencyKey);
        throw new WebhookError("Missing timestamp header", 401);
      }

      const maxAge = config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
      const eventTime = parseInt(timestamp, 10) || Math.floor(new Date(timestamp).getTime() / 1000);
      const nowSeconds = Math.floor(Date.now() / 1000);

      if (Math.abs(nowSeconds - eventTime) > maxAge) {
        await this.logEvent(agentId, source, null, "rejected", body.length, "Webhook too old (replay protection)", idempotencyKey);
        throw new WebhookError("Webhook timestamp too old", 403);
      }
    }

    // 4. Rate limit check — count only delivered events to prevent DoS via log poisoning
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM webhook_event_log
       WHERE agent_id = $1 AND source = $2
         AND status = 'delivered'
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [agentId, source],
    );
    const count = parseInt(countResult.rows[0]?.count ?? "0", 10);
    if (count >= MAX_WEBHOOKS_PER_HOUR) {
      await this.logEvent(agentId, source, null, "rate_limited", body.length, `Rate limit exceeded: ${count}/${MAX_WEBHOOKS_PER_HOUR}/hr`, idempotencyKey);
      throw new WebhookError(`Rate limit exceeded: ${count}/${MAX_WEBHOOKS_PER_HOUR} per hour`, 429, { retryAfter: "3600" });
    }

    // 5. Payload size check
    if (body.length > MAX_PAYLOAD_SIZE) {
      await this.logEvent(agentId, source, null, "rejected", body.length, `Payload too large: ${body.length} bytes`, idempotencyKey);
      throw new WebhookError(`Payload too large (max ${MAX_PAYLOAD_SIZE} bytes)`, 413);
    }

    // Parse event type from body
    let eventType: string | null = null;
    try {
      const parsed = JSON.parse(body);
      // Common patterns for event types from various providers
      eventType = parsed.event ?? parsed.type ?? parsed.action ?? parsed.event_type ?? null;
    } catch {
      // Non-JSON body — that's OK, eventType stays null
    }

    // Map event type if mapping configured
    if (eventType && config.eventMapping && config.eventMapping[eventType]) {
      eventType = config.eventMapping[eventType];
    }

    // 6. Publish as webhook.received event
    this.eventBroadcaster.broadcast(agentId, {
      type: "webhook.received",
      timestamp: new Date().toISOString(),
      data: {
        source,
        eventType,
        payloadSize: body.length,
        payload: this.truncatePayload(body),
      },
    });

    // 7. Log to webhook_event_log (with idempotency key for deduplication)
    await this.logEvent(agentId, source, eventType, "delivered", body.length, null, idempotencyKey);
  }

  // ---- Private helpers ----

  /**
   * Verify HMAC signature (supports common formats).
   * Handles both "sha256=<hex>" format (GitHub) and raw hex.
   */
  private verifyHmac(body: string, secret: string, signature: string): boolean {
    // Reject insecure SHA1 signatures — only accept SHA256
    if (signature.startsWith("sha1=")) {
      logSecurityEvent("warn", "webhook-sha1-rejected", {
        message: "SHA1 webhook signature rejected. Configure your webhook provider to use SHA256.",
      });
      return false;
    }

    const expectedHex = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // GitHub format: "sha256=<hex>"
    let normalizedSignature = signature.startsWith("sha256=")
      ? signature.slice(7)
      : signature;

    // Case-insensitive hex comparison
    normalizedSignature = normalizedSignature.toLowerCase();

    // Validate hex format before comparison to avoid silent failures
    if (!/^[0-9a-f]{64}$/.test(normalizedSignature)) {
      logSecurityEvent("warn", "webhook-signature-format-invalid", {
        message: "Webhook signature is not valid 64-char hex. Check provider configuration.",
      });
      return false;
    }

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(normalizedSignature, "hex"),
        Buffer.from(expectedHex, "hex"),
      );
    } catch (err) {
      logSecurityEvent("warn", "webhook-hmac-comparison-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Truncate payload for event data (keep to 4KB max in WebSocket).
   */
  private truncatePayload(body: string): string {
    const MAX_EVENT_PAYLOAD = 4096;
    if (body.length <= MAX_EVENT_PAYLOAD) return body;
    return body.slice(0, MAX_EVENT_PAYLOAD) + "...[truncated]";
  }

  /**
   * Resolve the HMAC secret from config — decrypt if stored encrypted, or use plaintext.
   */
  private resolveSecret(config: WebhookConfig & { encryptedSecret?: string; secretIv?: string; secretAuthTag?: string }): string | undefined {
    // Encrypted secret (preferred path)
    if (config.encryptedSecret && config.secretIv && config.secretAuthTag && this.secretEncryptionKey) {
      try {
        return decryptSecret(
          config.encryptedSecret as string,
          config.secretIv as string,
          config.secretAuthTag as string,
          this.secretEncryptionKey,
        );
      } catch (err) {
        logSecurityEvent("error", "webhook-secret-decrypt-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
    // Plaintext secret (legacy registrations before encryption was added)
    return config.secret;
  }

  /**
   * Extract idempotency key from webhook headers, or generate from content hash.
   * Checks common webhook ID headers, falls back to sha256(agentId+source+body).
   */
  private extractIdempotencyKey(
    headers: Record<string, string>,
    agentId: string,
    source: string,
    body: string,
  ): string | null {
    // Common webhook deduplication headers
    const idFromHeaders =
      headers["x-webhook-id"] ??
      headers["x-request-id"] ??
      headers["x-github-delivery"] ??
      headers["x-stripe-idempotency-key"];
    if (idFromHeaders) {
      // Prefix with source to avoid collisions across providers
      return `${source}:${idFromHeaders}`.slice(0, 128);
    }
    // Generate deterministic key from content
    const hash = crypto
      .createHash("sha256")
      .update(`${agentId}:${source}:${body}`)
      .digest("hex");
    return `sha256:${hash}`.slice(0, 128);
  }

  /**
   * Log a webhook event to the audit table.
   */
  private async logEvent(
    agentId: string,
    source: string,
    eventType: string | null,
    status: string,
    payloadSize: number,
    errorMessage: string | null,
    idempotencyKey?: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO webhook_event_log
          (agent_id, source, event_type, status, payload_size, error_message, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [agentId, source, eventType, status, payloadSize, errorMessage, idempotencyKey ?? null],
      );
    } catch (error) {
      logSecurityEvent("warn", "webhook-log-failed", {
        agentId,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ============================================================
//  WebhookError (typed errors with HTTP status)
// ============================================================

export class WebhookError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter?: string;

  constructor(message: string, statusCode: number, options?: { retryAfter?: string }) {
    super(message);
    this.name = "WebhookError";
    this.statusCode = statusCode;
    this.retryAfter = options?.retryAfter;
  }
}
