/**
 * Bounty manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for bounty
 * operations (create, claim, submit, approve, dispute, cancel)
 * and provides read access to bounty listings via the gateway.
 *
 * All on-chain actions use the prepare+relay pattern:
 * 1. POST /v1/prepare/<action> → unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712 typed data)
 * 3. POST /v1/relay → submit meta-transaction
 *
 * @module bounties
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for listing bounties. */
export interface BountyListOptions {
  status?: string;
  community?: string;
  first?: number;
  skip?: number;
}

/** Options for creating a bounty. */
export interface CreateBountyInput {
  title: string;
  description: string;
  community: string;
  deadline: number;
  tokenRewardAmount?: string;
}

export class BountyManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * List bounties on the network.
   *
   * @param opts - Optional filters for status, community, and pagination.
   * @returns Paginated list of bounties.
   */
  async list(opts?: BountyListOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.community) params.set("community", opts.community);
    if (opts?.first !== undefined) params.set("first", String(opts.first));
    if (opts?.skip !== undefined) params.set("skip", String(opts.skip));

    const qs = params.toString();
    return this.connection.request("GET", `/v1/bounties${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a specific bounty by ID.
   *
   * @param bountyId - The on-chain bounty ID.
   * @returns Bounty details.
   */
  async get(bountyId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/bounties/${bountyId}`);
  }

  // ============================================================
  //  Write Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Create a new bounty.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/bounty → sign → POST /v1/relay
   *
   * @param opts - Bounty title, description, community, deadline, and optional token reward.
   */
  async create(opts: CreateBountyInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/bounty", {
      title: opts.title,
      description: opts.description,
      community: opts.community,
      deadline: opts.deadline,
      tokenRewardAmount: opts.tokenRewardAmount,
    });
  }

  /**
   * Claim a bounty (express intent to work on it).
   *
   * @param bountyId - The on-chain bounty ID to claim.
   */
  async claim(bountyId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/claim`, {});
  }

  /**
   * Unclaim a bounty (withdraw your claim).
   *
   * @param bountyId - The on-chain bounty ID to unclaim.
   */
  async unclaim(bountyId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/unclaim`, {});
  }

  /**
   * Submit work for a bounty.
   *
   * @param bountyId - The on-chain bounty ID.
   * @param submissionCid - IPFS CID of the submission content.
   */
  async submit(bountyId: number, submissionCid: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/submit`, {
      submissionCid,
    });
  }

  /**
   * Approve a bounty submission (bounty creator only).
   *
   * @param bountyId - The on-chain bounty ID to approve.
   */
  async approve(bountyId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/approve`, {});
  }

  /**
   * Dispute a bounty submission.
   *
   * @param bountyId - The on-chain bounty ID to dispute.
   */
  async dispute(bountyId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/dispute`, {});
  }

  /**
   * Cancel a bounty (bounty creator only).
   *
   * @param bountyId - The on-chain bounty ID to cancel.
   */
  async cancel(bountyId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/bounty/${bountyId}/cancel`, {});
  }
}
