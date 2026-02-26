/**
 * Bundle manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for knowledge
 * bundle operations (create, add/remove content, set contributors,
 * deactivate) and provides read access via the gateway.
 *
 * All on-chain actions use the prepare+relay pattern:
 * 1. POST /v1/prepare/<action> → unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712 typed data)
 * 3. POST /v1/relay → submit meta-transaction
 *
 * @module bundles
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for listing bundles. */
export interface BundleListOptions {
  first?: number;
  skip?: number;
}

/** A contributor with a revenue weight (basis points). */
export interface BundleContributor {
  address: string;
  weightBps: number;
}

/** Options for creating a bundle. */
export interface CreateBundleInput {
  name: string;
  description: string;
  cids: string[];
  contributors?: BundleContributor[];
}

export class BundleManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * List knowledge bundles on the network.
   *
   * @param opts - Optional pagination parameters.
   * @returns Paginated list of bundles.
   */
  async list(opts?: BundleListOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.first !== undefined) params.set("first", String(opts.first));
    if (opts?.skip !== undefined) params.set("skip", String(opts.skip));

    const qs = params.toString();
    return this.connection.request("GET", `/v1/bundles${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a specific bundle by ID.
   *
   * @param bundleId - The on-chain bundle ID.
   * @returns Bundle details including content CIDs and contributors.
   */
  async get(bundleId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/bundles/${bundleId}`);
  }

  // ============================================================
  //  Write Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Create a new knowledge bundle.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/bundle → sign → POST /v1/relay
   *
   * @param opts - Bundle name, description, content CIDs, and optional contributors.
   */
  async create(opts: CreateBundleInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/bundle", {
      name: opts.name,
      description: opts.description,
      cids: opts.cids,
      contributors: opts.contributors,
    });
  }

  /**
   * Add content CIDs to an existing bundle.
   *
   * @param bundleId - The on-chain bundle ID.
   * @param cids - Array of IPFS CIDs to add to the bundle.
   */
  async addContent(bundleId: number, cids: string[]): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bundle/${bundleId}/content`, {
      cids,
    });
  }

  /**
   * Remove content CIDs from a bundle.
   *
   * @param bundleId - The on-chain bundle ID.
   * @param cids - Array of IPFS CIDs to remove from the bundle.
   */
  async removeContent(bundleId: number, cids: string[]): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bundle/${bundleId}/content/remove`, {
      cids,
    });
  }

  /**
   * Set the contributor list and revenue weights for a bundle.
   *
   * @param bundleId - The on-chain bundle ID.
   * @param contributors - Array of contributor addresses with weight in basis points.
   */
  async setContributors(bundleId: number, contributors: BundleContributor[]): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bundle/${bundleId}/contributors`, {
      contributors,
    });
  }

  /**
   * Deactivate a bundle (creator only).
   *
   * @param bundleId - The on-chain bundle ID to deactivate.
   */
  async deactivate(bundleId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bundle/${bundleId}/deactivate`, {});
  }
}
