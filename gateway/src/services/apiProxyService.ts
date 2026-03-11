/**
 * API Proxy Service — proxy configuration, usage metering, and availability
 * tracking for the API marketplace.
 *
 * Providers register their proxy endpoints; buyers route requests through the
 * gateway which meters usage. No API keys are ever stored or shared.
 *
 * @module services/apiProxyService
 */

import type pg from "pg";

// ── Row shapes ───────────────────────────────────────────────────

export interface ApiProxyConfigRow {
  listing_id: number;
  provider_address: string;
  proxy_url: string;
  health_check_path: string;
  rate_limit_rpm: number;
  allowed_methods: string[];
  max_payload_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface ApiUsageLogRow {
  id: string;
  agreement_id: number;
  listing_id: number;
  request_id: string;
  buyer_address: string;
  provider_address: string;
  method: string;
  path: string;
  status_code: number | null;
  latency_ms: number | null;
  request_bytes: number;
  response_bytes: number;
  error: string | null;
  created_at: string;
}

export interface ApiAvailabilityRow {
  provider_address: string;
  listing_id: number | null;
  status: "online" | "degraded" | "offline";
  last_heartbeat: string;
  last_latency_ms: number | null;
  uptime_checks: number;
  uptime_passes: number;
  active_agreements: number;
  created_at: string;
  updated_at: string;
}

export interface RegisterEndpointInput {
  listingId: number;
  providerAddress: string;
  proxyUrl: string;
  healthCheckPath?: string;
  rateLimitRpm?: number;
  allowedMethods?: string[];
  maxPayloadBytes?: number;
}

export interface ApiHeartbeatInput {
  providerAddress: string;
  listingId: number;
  latencyMs?: number;
  activeAgreements?: number;
}

export interface LogUsageInput {
  agreementId: number;
  listingId: number;
  requestId: string;
  buyerAddress: string;
  providerAddress: string;
  method: string;
  path: string;
  statusCode?: number;
  latencyMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  error?: string;
}

export interface ApiSearchFilters {
  status?: "online" | "degraded" | "any";
  capabilities?: string[];
  maxPriceUsdc?: number;
  minUptimePercent?: number;
  limit?: number;
  offset?: number;
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  totalRequestBytes: number;
  totalResponseBytes: number;
  periodStart: string;
  periodEnd: string;
}

// ── Service ──────────────────────────────────────────────────────

export class ApiProxyService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ── Proxy Configuration ──────────────────────────────────────

  /**
   * Register or update a provider's proxy endpoint for a listing.
   */
  async registerEndpoint(input: RegisterEndpointInput): Promise<ApiProxyConfigRow> {
    const { rows } = await this.pool.query<ApiProxyConfigRow>(
      `INSERT INTO api_proxy_config
         (listing_id, provider_address, proxy_url, health_check_path,
          rate_limit_rpm, allowed_methods, max_payload_bytes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (listing_id) DO UPDATE SET
         proxy_url = EXCLUDED.proxy_url,
         health_check_path = EXCLUDED.health_check_path,
         rate_limit_rpm = EXCLUDED.rate_limit_rpm,
         allowed_methods = EXCLUDED.allowed_methods,
         max_payload_bytes = EXCLUDED.max_payload_bytes,
         updated_at = NOW()
       RETURNING *`,
      [
        input.listingId,
        input.providerAddress,
        input.proxyUrl,
        input.healthCheckPath ?? "/health",
        input.rateLimitRpm ?? 60,
        input.allowedMethods ?? ["GET", "POST"],
        input.maxPayloadBytes ?? 1_048_576,
      ],
    );
    return rows[0];
  }

  /**
   * Get proxy config for a listing.
   */
  async getProxyConfig(listingId: number): Promise<ApiProxyConfigRow | null> {
    const { rows } = await this.pool.query<ApiProxyConfigRow>(
      `SELECT * FROM api_proxy_config WHERE listing_id = $1`,
      [listingId],
    );
    return rows[0] ?? null;
  }

  /**
   * Delete proxy config (when provider deactivates listing).
   */
  async deleteProxyConfig(listingId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM api_proxy_config WHERE listing_id = $1`,
      [listingId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── Heartbeat / Availability ─────────────────────────────────

  /**
   * Record a heartbeat from an API provider.
   */
  async recordHeartbeat(input: ApiHeartbeatInput): Promise<ApiAvailabilityRow> {
    const { rows } = await this.pool.query<ApiAvailabilityRow>(
      `INSERT INTO api_availability
         (provider_address, listing_id, status, last_heartbeat,
          last_latency_ms, active_agreements, updated_at)
       VALUES ($1, $2, 'online', NOW(), $3, $4, NOW())
       ON CONFLICT (provider_address) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         status = 'online',
         last_heartbeat = NOW(),
         last_latency_ms = COALESCE(EXCLUDED.last_latency_ms, api_availability.last_latency_ms),
         active_agreements = COALESCE(EXCLUDED.active_agreements, api_availability.active_agreements),
         uptime_checks = api_availability.uptime_checks + 1,
         uptime_passes = api_availability.uptime_passes + 1,
         updated_at = NOW()
       RETURNING *`,
      [
        input.providerAddress,
        input.listingId,
        input.latencyMs ?? null,
        input.activeAgreements ?? 0,
      ],
    );
    return rows[0];
  }

  /**
   * Get availability for a single listing.
   */
  async getAvailability(listingId: number): Promise<ApiAvailabilityRow | null> {
    const { rows } = await this.pool.query<ApiAvailabilityRow>(
      `SELECT * FROM api_availability WHERE listing_id = $1`,
      [listingId],
    );
    return rows[0] ?? null;
  }

  /**
   * Search available API providers.
   */
  async searchAvailable(filters: ApiSearchFilters): Promise<ApiAvailabilityRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.status && filters.status !== "any") {
      conditions.push(`aa.status = $${paramIdx++}`);
      params.push(filters.status);
    } else {
      conditions.push(`aa.status != 'offline'`);
    }

    if (filters.minUptimePercent) {
      conditions.push(
        `CASE WHEN aa.uptime_checks > 0 THEN (aa.uptime_passes::float / aa.uptime_checks * 100) ELSE 0 END >= $${paramIdx++}`,
      );
      params.push(filters.minUptimePercent);
    }

    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = filters.offset ?? 0;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await this.pool.query<ApiAvailabilityRow>(
      `SELECT aa.*
       FROM api_availability aa
       ${whereClause}
       ORDER BY aa.last_heartbeat DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );
    return rows;
  }

  /**
   * Mark providers as degraded if no heartbeat for 5+ minutes.
   */
  async markDegraded(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_availability
       SET status = 'degraded', updated_at = NOW()
       WHERE status = 'online'
         AND last_heartbeat < NOW() - INTERVAL '5 minutes'`,
    );
    return rowCount ?? 0;
  }

  /**
   * Mark providers as offline if no heartbeat for 15+ minutes.
   */
  async markOffline(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_availability
       SET status = 'offline', updated_at = NOW()
       WHERE status IN ('online', 'degraded')
         AND last_heartbeat < NOW() - INTERVAL '15 minutes'`,
    );
    return rowCount ?? 0;
  }

  /**
   * Run the full staleness check cycle.
   */
  async runStalenessCheck(): Promise<{ degraded: number; offline: number }> {
    const offline = await this.markOffline();
    const degraded = await this.markDegraded();
    return { degraded, offline };
  }

  // ── Usage Logging ────────────────────────────────────────────

  /**
   * Log a single proxied API request for metering.
   */
  async logUsage(input: LogUsageInput): Promise<ApiUsageLogRow> {
    const { rows } = await this.pool.query<ApiUsageLogRow>(
      `INSERT INTO api_usage_logs
         (agreement_id, listing_id, request_id, buyer_address, provider_address,
          method, path, status_code, latency_ms, request_bytes, response_bytes, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.agreementId,
        input.listingId,
        input.requestId,
        input.buyerAddress,
        input.providerAddress,
        input.method,
        input.path,
        input.statusCode ?? null,
        input.latencyMs ?? null,
        input.requestBytes ?? 0,
        input.responseBytes ?? 0,
        input.error ?? null,
      ],
    );
    return rows[0];
  }

  /**
   * Get usage summary for an agreement within a time range.
   */
  async getUsageSummary(
    agreementId: number,
    periodStart?: Date,
    periodEnd?: Date,
  ): Promise<UsageSummary> {
    const start = periodStart ?? new Date(0);
    const end = periodEnd ?? new Date();

    const { rows } = await this.pool.query<{
      total: string;
      successful: string;
      failed: string;
      avg_latency: string;
      total_req_bytes: string;
      total_res_bytes: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400)::text AS successful,
         COUNT(*) FILTER (WHERE status_code >= 400 OR error IS NOT NULL)::text AS failed,
         COALESCE(AVG(latency_ms), 0)::text AS avg_latency,
         COALESCE(SUM(request_bytes), 0)::text AS total_req_bytes,
         COALESCE(SUM(response_bytes), 0)::text AS total_res_bytes
       FROM api_usage_logs
       WHERE agreement_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [agreementId, start, end],
    );

    const r = rows[0];
    return {
      totalRequests: parseInt(r.total, 10),
      successfulRequests: parseInt(r.successful, 10),
      failedRequests: parseInt(r.failed, 10),
      avgLatencyMs: Math.round(parseFloat(r.avg_latency)),
      totalRequestBytes: parseInt(r.total_req_bytes, 10),
      totalResponseBytes: parseInt(r.total_res_bytes, 10),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    };
  }

  /**
   * Get recent usage logs for an agreement.
   */
  async getUsageLogs(
    agreementId: number,
    limit = 50,
    offset = 0,
  ): Promise<ApiUsageLogRow[]> {
    const { rows } = await this.pool.query<ApiUsageLogRow>(
      `SELECT * FROM api_usage_logs
       WHERE agreement_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agreementId, Math.min(limit, 200), offset],
    );
    return rows;
  }
}
