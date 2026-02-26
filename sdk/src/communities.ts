/**
 * Community management module for the Nookplot SDK.
 *
 * Handles community creation (metadata → IPFS → on-chain), moderator management,
 * poster approval, and community querying. Communities are Nookplot's organizing unit —
 * like subreddits, but decentralized with on-chain enforcement.
 *
 * @module communities
 */

import { ethers } from "ethers";

import type {
  CreateCommunityInput,
  CommunityDocument,
  CommunityInfo,
} from "./types";
import { PostingPolicy, SDK_VERSION } from "./types";
import { IpfsClient } from "./ipfs";
import { ContractManager } from "./contracts";

/**
 * Manages community creation, metadata, and on-chain operations.
 */
export class CommunityManager {
  constructor(
    private readonly contracts: ContractManager,
    private readonly ipfs: IpfsClient,
    private readonly wallet: ethers.Wallet,
  ) {}

  // ================================================================
  //                     Community Creation
  // ================================================================

  /**
   * Create a new community: build metadata → sign → upload to IPFS → register on-chain.
   *
   * @param input - Community creation parameters.
   * @param chainId - Chain ID for EIP-712 domain (default: 8453).
   * @returns The community document, IPFS CID, and transaction receipt.
   */
  async createCommunity(
    input: CreateCommunityInput,
    chainId: number = 8453,
  ): Promise<{
    document: CommunityDocument;
    cid: string;
    receipt: ethers.TransactionReceipt;
  }> {
    const policy = input.postingPolicy ?? PostingPolicy.Open;

    // Build the community metadata document
    const now = Math.floor(Date.now() / 1000);
    const policyString = policy === PostingPolicy.Open
      ? "open"
      : policy === PostingPolicy.RegisteredOnly
        ? "registered-only"
        : "approved-only";

    // Sign the community data with EIP-712
    // verifyingContract scopes the signature to this specific CommunityRegistry deployment
    const verifyingContract = await this.contracts.communityRegistry!.getAddress();
    const domain = { name: "Nookplot", version: "1", chainId, verifyingContract };
    const types = {
      Community: [
        { name: "slug", type: "string" },
        { name: "name", type: "string" },
        { name: "description", type: "string" },
        { name: "creator", type: "address" },
        { name: "postingPolicy", type: "string" },
        { name: "timestamp", type: "uint256" },
      ],
    };
    const value = {
      slug: input.slug,
      name: input.name,
      description: input.description,
      creator: this.wallet.address,
      postingPolicy: policyString,
      timestamp: now,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);

    const document: CommunityDocument = {
      version: "1.0.0",
      name: input.name,
      slug: input.slug,
      description: input.description,
      creator: this.wallet.address,
      rules: input.rules,
      moderators: [this.wallet.address],
      settings: {
        postingPolicy: policyString,
        contentTypes: input.contentTypes ?? ["text", "markdown"],
        tags: input.tags,
      },
      created: now,
      updated: now,
      signature: {
        signer: this.wallet.address,
        hash,
        value: signature,
      },
      metadata: {
        clientVersion: `@nookplot/sdk@${SDK_VERSION}`,
      },
    };

    // Upload to IPFS
    const uploadResult = await this.ipfs.uploadJson(
      document as unknown as Record<string, unknown>,
      `nookplot-community-${input.slug}`,
    );

    // Register on-chain
    const receipt = await this.contracts.createCommunity(
      input.slug,
      uploadResult.cid,
      policy,
    );

    return { document, cid: uploadResult.cid, receipt };
  }

  // ================================================================
  //                     Community Queries
  // ================================================================

  /**
   * Get on-chain community info.
   */
  async getCommunity(slug: string): Promise<CommunityInfo> {
    return this.contracts.getCommunity(slug);
  }

  /**
   * Fetch the community metadata document from IPFS.
   *
   * @param slug - Community slug. The metadata CID is read from the on-chain record.
   * @returns The parsed community metadata document.
   */
  async getCommunityMetadata(slug: string): Promise<CommunityDocument> {
    const info = await this.contracts.getCommunity(slug);
    const data = await this.ipfs.fetchJson(info.metadataCid);
    return data as unknown as CommunityDocument;
  }

  /**
   * Check if a community exists on-chain.
   */
  async communityExists(slug: string): Promise<boolean> {
    return this.contracts.communityExists(slug);
  }

  /**
   * Check if a community is active.
   */
  async isCommunityActive(slug: string): Promise<boolean> {
    return this.contracts.isCommunityActive(slug);
  }

  /**
   * Check if an address can post in a community.
   */
  async canPost(slug: string, poster: string): Promise<boolean> {
    return this.contracts.canPostInCommunity(slug, poster);
  }

  // ================================================================
  //                   Moderator Management
  // ================================================================

  /**
   * Add a moderator to a community.
   */
  async addModerator(
    slug: string,
    moderator: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.addCommunityModerator(slug, moderator);
  }

  /**
   * Remove a moderator from a community.
   */
  async removeModerator(
    slug: string,
    moderator: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.removeCommunityModerator(slug, moderator);
  }

  /**
   * Check if an address is a moderator.
   */
  async isModerator(slug: string, address: string): Promise<boolean> {
    return this.contracts.isCommunityModerator(slug, address);
  }

  // ================================================================
  //                     Poster Approval
  // ================================================================

  /**
   * Approve a poster for an approved-only community.
   */
  async approvePoster(
    slug: string,
    poster: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.approvePoster(slug, poster);
  }

  /**
   * Revoke a poster's approval.
   */
  async revokePoster(
    slug: string,
    poster: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.revokePoster(slug, poster);
  }

  // ================================================================
  //                     Policy & Ownership
  // ================================================================

  /**
   * Set the posting policy for a community.
   */
  async setPostingPolicy(
    slug: string,
    policy: PostingPolicy,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.setCommunityPostingPolicy(slug, policy);
  }

  /**
   * Transfer community ownership to a new creator.
   */
  async transferOwnership(
    slug: string,
    newCreator: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.transferCommunityOwnership(slug, newCreator);
  }

  /**
   * Update community metadata: fetch current → merge → re-sign → re-upload → update on-chain.
   *
   * @param slug - Community slug.
   * @param updates - Fields to update.
   * @param chainId - Chain ID for EIP-712 domain.
   * @returns The updated document, new CID, and transaction receipt.
   */
  async updateMetadata(
    slug: string,
    updates: {
      name?: string;
      description?: string;
      rules?: Array<{ title: string; description: string }>;
      tags?: string[];
    },
    chainId: number = 8453,
  ): Promise<{
    document: CommunityDocument;
    cid: string;
    receipt: ethers.TransactionReceipt;
  }> {
    // Fetch current metadata
    const current = await this.getCommunityMetadata(slug);
    const info = await this.contracts.getCommunity(slug);
    const now = Math.floor(Date.now() / 1000);

    // Merge updates
    const updated: CommunityDocument = {
      ...current,
      name: updates.name ?? current.name,
      description: updates.description ?? current.description,
      rules: updates.rules ?? current.rules,
      settings: {
        ...current.settings,
        tags: updates.tags ?? current.settings?.tags,
      },
      updated: now,
      metadata: {
        ...current.metadata,
        previousVersionCid: info.metadataCid,
        clientVersion: `@nookplot/sdk@${SDK_VERSION}`,
      },
    } as CommunityDocument;

    // Re-sign (verifyingContract scopes signature to this deployment)
    const verifyingContract = await this.contracts.communityRegistry!.getAddress();
    const domain = { name: "Nookplot", version: "1", chainId, verifyingContract };
    const types = {
      Community: [
        { name: "slug", type: "string" },
        { name: "name", type: "string" },
        { name: "description", type: "string" },
        { name: "creator", type: "address" },
        { name: "postingPolicy", type: "string" },
        { name: "timestamp", type: "uint256" },
      ],
    };
    const value = {
      slug: updated.slug,
      name: updated.name,
      description: updated.description,
      creator: updated.creator,
      postingPolicy: updated.settings?.postingPolicy ?? "open",
      timestamp: now,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);

    updated.signature = {
      signer: this.wallet.address,
      hash,
      value: signature,
    };

    // Upload to IPFS
    const uploadResult = await this.ipfs.uploadJson(
      updated as unknown as Record<string, unknown>,
      `nookplot-community-${slug}`,
    );

    // Update on-chain
    const receipt = await this.contracts.updateCommunityMetadata(
      slug,
      uploadResult.cid,
    );

    return { document: updated, cid: uploadResult.cid, receipt };
  }
}
