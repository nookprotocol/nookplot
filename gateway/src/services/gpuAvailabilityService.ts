/**
 * GPU Availability Service — real-time GPU provider tracking via heartbeats.
 *
 * Providers push heartbeats every 60s. The staleness checker marks providers
 * as degraded (5 min no heartbeat) or offline (15 min). Buyers query
 * available GPUs with live status.
 *
 * @module services/gpuAvailabilityService
 */

import type pg from "pg";

// ── Row shapes ───────────────────────────────────────────────────

export interface GpuAvailabilityRow {
  provider_address: string;
  listing_id: number | null;
  status: "online" | "degraded" | "offline";
  gpu_model: string | null;
  vram_gb: number | null;
  gpu_temp_c: number | null;
  gpu_utilization: number | null;
  vram_used_gb: number | null;
  current_agreement_id: number | null;
  last_heartbeat: string;
  created_at: string;
  updated_at: string;
}

export interface HeartbeatInput {
  providerAddress: string;
  listingId: number;
  status: "idle" | "busy";
  gpuModel?: string;
  vramGb?: number;
  gpuTempC?: number;
  gpuUtilization?: number;
  vramUsedGb?: number;
  currentAgreementId?: number;
}

export interface GpuSearchFilters {
  gpuModel?: string;
  minVram?: number;
  maxPriceUsdc?: number;
  region?: string;
  status?: "online" | "degraded" | "any";
  attestationMaxAgeDays?: number;
  minChallengePassRate?: number;
  limit?: number;
  offset?: number;
}

/** VRAM tiers for public display (hides exact values). */
function vramTier(vramGb: number | null): string {
  if (!vramGb) return "unknown";
  if (vramGb >= 80) return "80GB+";
  if (vramGb >= 40) return "40GB+";
  if (vramGb >= 24) return "24GB+";
  if (vramGb >= 16) return "16GB+";
  if (vramGb >= 8) return "8GB+";
  return "<8GB";
}

/** Public-safe GPU listing — no exact specs, no telemetry. */
export interface GpuPublicRow {
  listing_id: number | null;
  status: "online" | "degraded" | "offline";
  vram_tier: string;
  last_heartbeat: string;
  current_agreement_id: number | null;
}

/** Redact a full row to a public-safe row. */
export function toPublicRow(row: GpuAvailabilityRow): GpuPublicRow {
  return {
    listing_id: row.listing_id,
    status: row.status,
    vram_tier: vramTier(row.vram_gb),
    last_heartbeat: row.last_heartbeat,
    current_agreement_id: row.current_agreement_id,
  };
}

// ── Service ──────────────────────────────────────────────────────

export class GpuAvailabilityService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Record a heartbeat from a GPU provider. Upserts the availability row.
   */
  async recordHeartbeat(input: HeartbeatInput): Promise<GpuAvailabilityRow> {
    const { rows } = await this.pool.query<GpuAvailabilityRow>(
      `INSERT INTO gpu_availability
         (provider_address, listing_id, status, gpu_model, vram_gb,
          gpu_temp_c, gpu_utilization, vram_used_gb, current_agreement_id,
          last_heartbeat, updated_at)
       VALUES ($1, $2, 'online', $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (provider_address) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         status = 'online',
         gpu_model = COALESCE(EXCLUDED.gpu_model, gpu_availability.gpu_model),
         vram_gb = COALESCE(EXCLUDED.vram_gb, gpu_availability.vram_gb),
         gpu_temp_c = EXCLUDED.gpu_temp_c,
         gpu_utilization = EXCLUDED.gpu_utilization,
         vram_used_gb = EXCLUDED.vram_used_gb,
         current_agreement_id = EXCLUDED.current_agreement_id,
         last_heartbeat = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [
        input.providerAddress,
        input.listingId,
        input.gpuModel ?? null,
        input.vramGb ?? null,
        input.gpuTempC ?? null,
        input.gpuUtilization ?? null,
        input.vramUsedGb ?? null,
        input.currentAgreementId ?? null,
      ],
    );
    return rows[0];
  }

  /**
   * Get availability for a single listing.
   */
  async getAvailability(listingId: number): Promise<GpuAvailabilityRow | null> {
    const { rows } = await this.pool.query<GpuAvailabilityRow>(
      `SELECT * FROM gpu_availability WHERE listing_id = $1`,
      [listingId],
    );
    return rows[0] ?? null;
  }

  /**
   * Search available GPUs with optional filters.
   * Joins with idx_gpu_attestations for attestation age and idx_service_listings for pricing.
   */
  async searchAvailableGpus(filters: GpuSearchFilters): Promise<GpuAvailabilityRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Status filter
    if (filters.status && filters.status !== "any") {
      conditions.push(`ga.status = $${paramIdx++}`);
      params.push(filters.status);
    } else {
      conditions.push(`ga.status != 'offline'`);
    }

    // GPU model filter
    if (filters.gpuModel) {
      conditions.push(`ga.gpu_model ILIKE $${paramIdx++}`);
      params.push(`%${filters.gpuModel}%`);
    }

    // Min VRAM filter
    if (filters.minVram) {
      conditions.push(`ga.vram_gb >= $${paramIdx++}`);
      params.push(filters.minVram);
    }

    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = filters.offset ?? 0;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await this.pool.query<GpuAvailabilityRow>(
      `SELECT ga.*
       FROM gpu_availability ga
       ${whereClause}
       ORDER BY ga.last_heartbeat DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );
    return rows;
  }

  /**
   * Mark providers as degraded if no heartbeat for 5+ minutes.
   * Returns count of affected rows.
   */
  async markDegraded(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE gpu_availability
       SET status = 'degraded', updated_at = NOW()
       WHERE status = 'online'
         AND last_heartbeat < NOW() - INTERVAL '5 minutes'`,
    );
    return rowCount ?? 0;
  }

  /**
   * Mark providers as offline if no heartbeat for 15+ minutes.
   * Returns count of affected rows.
   */
  async markOffline(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE gpu_availability
       SET status = 'offline', updated_at = NOW()
       WHERE status IN ('online', 'degraded')
         AND last_heartbeat < NOW() - INTERVAL '15 minutes'`,
    );
    return rowCount ?? 0;
  }

  /**
   * Run the full staleness check cycle (degraded + offline).
   */
  async runStalenessCheck(): Promise<{ degraded: number; offline: number }> {
    const offline = await this.markOffline();
    const degraded = await this.markDegraded();
    return { degraded, offline };
  }
}
