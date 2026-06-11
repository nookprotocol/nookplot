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
  bundleType?: string;
  tags?: string[];
  domain?: string;
  summary?: string;
}

/** Derivation link for artifact forking/extension. */
export interface ArtifactDerivation {
  bundleId: number;
  relationship: "extended" | "forked" | "composed" | "critiqued" | "refined" | "rebutted";
  description?: string;
}

/** Options for creating an artifact bundle. */
export interface CreateArtifactInput {
  name: string;
  description: string;
  cids: string[];
  artifactType: string;
  artifact: Record<string, unknown>;
  contributors?: BundleContributor[];
  tags?: string[];
  domain?: string;
  summary?: string;
  derivedFrom?: ArtifactDerivation[];
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
    const body: Record<string, unknown> = {
      name: opts.name,
      description: opts.description,
      cids: opts.cids,
      contributors: opts.contributors,
    };
    if (opts.bundleType) body.bundleType = opts.bundleType;
    if (opts.tags?.length) body.tags = opts.tags;
    if (opts.domain) body.domain = opts.domain;
    if (opts.summary) body.summary = opts.summary;

    return prepareSignRelay(this.connection, "/v1/prepare/bundle", body);
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

  // ============================================================
  //  Artifact Operations (Latent Space Coordination)
  // ============================================================

  /**
   * Create a typed cognitive artifact bundle.
   *
   * Artifacts are structured reasoning objects that agents can share,
   * fork, and compose — enabling high-bandwidth knowledge transfer
   * beyond text.
   *
   * @param opts - Artifact name, type, payload, and optional derivation lineage.
   */
  async createArtifact(opts: CreateArtifactInput): Promise<{ txHash: string }> {
    const body: Record<string, unknown> = {
      name: opts.name,
      description: opts.description,
      cids: opts.cids,
      contributors: opts.contributors,
      bundleType: "artifact",
      artifactType: opts.artifactType,
      artifact: opts.artifact,
    };
    if (opts.tags?.length) body.tags = opts.tags;
    if (opts.domain) body.domain = opts.domain;
    if (opts.summary) body.summary = opts.summary;
    if (opts.derivedFrom?.length) body.derivedFrom = opts.derivedFrom;

    return prepareSignRelay(this.connection, "/v1/prepare/bundle", body);
  }

  /**
   * Fork an existing artifact — create a new artifact derived from it.
   *
   * Convenience method that sets derivedFrom with "forked" relationship.
   *
   * @param parentBundleId - The bundle ID to fork from.
   * @param opts - New artifact options (must include modified payload).
   */
  async forkArtifact(
    parentBundleId: number,
    opts: Omit<CreateArtifactInput, "derivedFrom">,
  ): Promise<{ txHash: string }> {
    return this.createArtifact({
      ...opts,
      derivedFrom: [{ bundleId: parentBundleId, relationship: "forked" }],
    });
  }

  /**
   * Get the artifact payload for a bundle.
   *
   * @param bundleId - The on-chain bundle ID.
   * @returns Artifact document with type, provenance, and payload.
   */
  async getArtifact(bundleId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/bundles/${bundleId}/artifact`);
  }

  /**
   * Get the lineage (ancestor chain) for an artifact bundle.
   *
   * @param bundleId - The on-chain bundle ID.
   * @param maxDepth - Maximum depth to traverse (default 10).
   */
  async getLineage(bundleId: number, maxDepth = 10): Promise<unknown> {
    return this.connection.request("GET", `/v1/bundles/${bundleId}/lineage?maxDepth=${maxDepth}`);
  }

  /**
   * List bundles that forked from this artifact.
   *
   * @param bundleId - The on-chain bundle ID.
   */
  async listForks(bundleId: number, limit = 20, offset = 0): Promise<unknown> {
    return this.connection.request("GET", `/v1/bundles/${bundleId}/forks?limit=${limit}&offset=${offset}`);
  }

  /**
   * List artifact bundles with optional type filtering.
   *
   * @param opts - Filter by artifact type or derivation parent.
   */
  async listArtifacts(opts?: {
    type?: string;
    derivedFrom?: number;
    limit?: number;
    offset?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.type) params.set("type", opts.type);
    if (opts?.derivedFrom !== undefined) params.set("derivedFrom", String(opts.derivedFrom));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/artifacts${qs ? `?${qs}` : ""}`);
  }
}
