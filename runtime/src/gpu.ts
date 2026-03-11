/**
 * GPU marketplace manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps GPU-specific operations: attestation (prepare+sign+relay),
 * availability (heartbeats), and buyer challenges. Also provides
 * read access to GPU listings and provider stats.
 *
 * @module gpu
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for searching available GPUs. */
export interface GpuSearchOptions {
  gpuModel?: string;
  minVram?: number;
  status?: "online" | "degraded" | "any";
  limit?: number;
  offset?: number;
}

/** Input for submitting a GPU benchmark attestation. */
export interface GpuAttestInput {
  benchmarkHash: string;
  gpuModel: string;
  vramGb: number;
  computeCapability?: string;
  cudaVersion?: string;
}

/** Input for sending a heartbeat. */
export interface GpuHeartbeatInput {
  listingId: number;
  status?: "idle" | "busy";
  gpuModel?: string;
  vramGb?: number;
  gpuTempC?: number;
  gpuUtilization?: number;
  vramUsedGb?: number;
  currentAgreementId?: number;
}

/** Input for renting a GPU (creating a service agreement). */
export interface GpuRentInput {
  listingId: number;
  terms?: string;
  durationHours?: number;
  tokenAmount?: string;
  tokenAddress?: string;
}

/** Input for batch GPU rental for swarms. */
export interface GpuSwarmRentInput {
  count: number;
  minVram?: number;
  gpuModel?: string;
  terms?: string;
  durationHours?: number;
  tokenAmount?: string;
}

/** Input for creating a buyer challenge. */
export interface GpuChallengeInput {
  listingId: number;
  providerAddress: string;
  challengeInputCid: string;
  expectedMinTflops?: number;
}

/** Input for submitting challenge results (provider). */
export interface GpuChallengeSubmitInput {
  challengeId: string;
  challengeOutputCid: string;
  actualTflops?: number;
  wallTimeMs?: number;
}

export class GpuManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * Search available GPUs with live status.
   */
  async searchAvailable(opts?: GpuSearchOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.gpuModel) params.set("gpuModel", opts.gpuModel);
    if (opts?.minVram !== undefined) params.set("minVram", String(opts.minVram));
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));

    const qs = params.toString();
    return this.connection.request("GET", `/v1/gpu/availability${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get availability for a specific listing.
   */
  async getAvailability(listingId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/gpu/availability/${listingId}`);
  }

  /**
   * Get a challenge by ID.
   */
  async getChallenge(challengeId: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/gpu/challenge/${challengeId}`);
  }

  /**
   * Get a provider's challenge history and stats.
   */
  async getProviderChallenges(address: string, limit = 20, offset = 0): Promise<unknown> {
    return this.connection.request("GET", `/v1/gpu/providers/${address}/challenges?limit=${limit}&offset=${offset}`);
  }

  // ============================================================
  //  Write Operations (off-chain)
  // ============================================================

  /**
   * Send a GPU heartbeat (provider).
   */
  async heartbeat(input: GpuHeartbeatInput): Promise<unknown> {
    return this.connection.request("POST", "/v1/gpu/heartbeat", input);
  }

  /**
   * Create a buyer challenge.
   */
  async createChallenge(input: GpuChallengeInput): Promise<unknown> {
    return this.connection.request("POST", "/v1/gpu/challenge", input);
  }

  /**
   * Submit challenge results (provider).
   */
  async submitChallengeResult(input: GpuChallengeSubmitInput): Promise<unknown> {
    return this.connection.request("POST", `/v1/gpu/challenge/${input.challengeId}/submit`, {
      challengeOutputCid: input.challengeOutputCid,
      actualTflops: input.actualTflops,
      wallTimeMs: input.wallTimeMs,
    });
  }

  // ============================================================
  //  On-Chain Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Submit a GPU benchmark attestation on-chain.
   */
  async submitAttestation(input: GpuAttestInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/gpu/attest", {
      benchmarkHash: input.benchmarkHash,
      gpuModel: input.gpuModel,
      vramGb: input.vramGb,
      computeCapability: input.computeCapability ?? "",
      cudaVersion: input.cudaVersion ?? "",
    });
  }

  /**
   * Update attestation with a new benchmark hash.
   */
  async updateAttestation(benchmarkHash: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/gpu/update-attest", {
      benchmarkHash,
    });
  }

  /**
   * Revoke GPU attestation (voluntarily delist).
   */
  async revokeAttestation(): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/gpu/revoke", {});
  }

  // ============================================================
  //  GPU Rental (convenience wrappers over ServiceMarketplace)
  // ============================================================

  /**
   * Rent a GPU by creating a ServiceMarketplace agreement.
   * This is a convenience wrapper around the marketplace agreement flow
   * specifically for GPU listings.
   */
  async rentGpu(input: GpuRentInput): Promise<{ txHash: string; agreementId?: string }> {
    const deadline = Math.floor(Date.now() / 1000) + (input.durationHours ?? 24) * 3600;
    return prepareSignRelay(this.connection, "/v1/prepare/service/agree", {
      listingId: input.listingId,
      terms: input.terms ?? "GPU rental via Nookplot marketplace",
      deadline: String(deadline),
      tokenAmount: input.tokenAmount ?? "0",
      tokenAddress: input.tokenAddress,
    });
  }

  /**
   * Rent multiple GPUs for a research swarm.
   * Finds available GPUs matching criteria and creates agreements for each.
   */
  async rentSwarmGpus(input: GpuSwarmRentInput): Promise<Array<{ listingId: number; txHash: string; error?: string }>> {
    // Search for available GPUs
    const result = await this.searchAvailable({
      minVram: input.minVram,
      gpuModel: input.gpuModel,
      status: "online",
      limit: input.count,
    }) as { gpus: Array<{ listing_id: number }> };

    const gpus = result.gpus || [];
    if (gpus.length < input.count) {
      throw new Error(
        `Only ${gpus.length} GPUs available matching criteria (need ${input.count}). ` +
        `Try reducing minVram or changing gpuModel.`
      );
    }

    const results: Array<{ listingId: number; txHash: string; error?: string }> = [];
    for (const gpu of gpus.slice(0, input.count)) {
      try {
        const rental = await this.rentGpu({
          listingId: gpu.listing_id,
          terms: input.terms ?? `Swarm GPU rental (${input.count} GPUs)`,
          durationHours: input.durationHours,
          tokenAmount: input.tokenAmount,
        });
        results.push({ listingId: gpu.listing_id, txHash: rental.txHash });
      } catch (err: unknown) {
        results.push({
          listingId: gpu.listing_id,
          txHash: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
