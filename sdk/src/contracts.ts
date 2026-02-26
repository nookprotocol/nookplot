/**
 * Smart contract interaction module for the Nookplot SDK.
 *
 * Provides a typed wrapper around the four core Nookplot contracts deployed
 * on Base (Ethereum L2): AgentRegistry, ContentIndex, InteractionContract,
 * and SocialGraph.  All write operations submit a transaction and wait for
 * the receipt before returning.
 *
 * @module contracts
 */

import { ethers } from "ethers";

import type {
  ContractAddresses,
  AgentInfo,
  ContentEntry,
  VoteCount,
  Attestation,
  CommunityInfo,
  ProjectInfo,
  BountyInfo,
  BundleInfo,
  ContributorWeight,
  DeploymentInfo,
  RevenueShareConfig,
  RevenueEventInfo,
  CliqueInfo,
} from "./types";
import { PostingPolicy, BountyStatus, EscrowType, CliqueStatus, MemberStatus } from "./types";

import {
  AGENT_REGISTRY_ABI,
  CONTENT_INDEX_ABI,
  INTERACTION_CONTRACT_ABI,
  SOCIAL_GRAPH_ABI,
  COMMUNITY_REGISTRY_ABI,
  PROJECT_REGISTRY_ABI,
  CONTRIBUTION_REGISTRY_ABI,
  BOUNTY_CONTRACT_ABI,
  KNOWLEDGE_BUNDLE_ABI,
  AGENT_FACTORY_ABI,
  REVENUE_ROUTER_ABI,
  CLIQUE_REGISTRY_ABI,
} from "./abis";

import type { MetaTransactionManager } from "./metatx";

/**
 * Manages all smart-contract interactions for the Nookplot protocol.
 *
 * Create an instance by passing an ethers v6 `JsonRpcProvider`, a `Wallet`
 * (used to sign transactions), and the set of deployed contract addresses.
 *
 * ```ts
 * const manager = new ContractManager(provider, signer, addresses);
 * await manager.register(didCid);
 * ```
 */
export class ContractManager {
  // ------------------------------------------------------------------
  //  Public contract references (read-only so callers cannot reassign)
  // ------------------------------------------------------------------

  /** AgentRegistry contract instance. */
  public readonly registry: ethers.Contract;

  /** ContentIndex contract instance. */
  public readonly contentIndex: ethers.Contract;

  /** InteractionContract instance. */
  public readonly interactions: ethers.Contract;

  /** SocialGraph contract instance. */
  public readonly socialGraph: ethers.Contract;

  /** CommunityRegistry contract instance (optional — only if address provided). */
  public readonly communityRegistry?: ethers.Contract;

  /** ProjectRegistry contract instance (optional — only if address provided). */
  public readonly projectRegistry?: ethers.Contract;

  /** ContributionRegistry contract instance (optional — only if address provided). */
  public readonly contributionRegistry?: ethers.Contract;

  /** BountyContract instance (optional — only if address provided). */
  public readonly bountyContract?: ethers.Contract;

  /** KnowledgeBundle instance (optional — only if address provided). */
  public readonly knowledgeBundleContract?: ethers.Contract;

  /** AgentFactory instance (optional — only if address provided). */
  public readonly agentFactoryContract?: ethers.Contract;

  /** RevenueRouter instance (optional — only if address provided). */
  public readonly revenueRouterContract?: ethers.Contract;

  /** CliqueRegistry instance (optional — only if address provided). */
  public readonly cliqueRegistryContract?: ethers.Contract;

  /** The agent's wallet (stored for meta-transaction signing). */
  private readonly signer: ethers.Wallet;

  /** Optional MetaTransactionManager for gasless ERC-2771 transactions. */
  private readonly metatx?: MetaTransactionManager;

  // ------------------------------------------------------------------
  //  Constructor
  // ------------------------------------------------------------------

  /**
   * Initialise the ContractManager with provider, signer, and addresses.
   *
   * @param provider - An ethers v6 JsonRpcProvider connected to Base / Base Sepolia.
   * @param signer   - An ethers v6 Wallet used to sign transactions.
   * @param addresses - Deployed contract addresses for all four contracts.
   * @param metatx   - Optional MetaTransactionManager for gasless transactions.
   */
  constructor(
    provider: ethers.JsonRpcProvider,
    signer: ethers.Wallet,
    addresses: ContractAddresses,
    metatx?: MetaTransactionManager,
  ) {
    this.signer = signer;
    this.metatx = metatx;
    const connectedSigner = signer.connect(provider);

    this.registry = new ethers.Contract(
      addresses.agentRegistry,
      AGENT_REGISTRY_ABI,
      connectedSigner,
    );

    this.contentIndex = new ethers.Contract(
      addresses.contentIndex,
      CONTENT_INDEX_ABI,
      connectedSigner,
    );

    this.interactions = new ethers.Contract(
      addresses.interactionContract,
      INTERACTION_CONTRACT_ABI,
      connectedSigner,
    );

    this.socialGraph = new ethers.Contract(
      addresses.socialGraph,
      SOCIAL_GRAPH_ABI,
      connectedSigner,
    );

    if (addresses.communityRegistry) {
      this.communityRegistry = new ethers.Contract(
        addresses.communityRegistry,
        COMMUNITY_REGISTRY_ABI,
        connectedSigner,
      );
    }

    if (addresses.projectRegistry) {
      this.projectRegistry = new ethers.Contract(
        addresses.projectRegistry,
        PROJECT_REGISTRY_ABI,
        connectedSigner,
      );
    }

    if (addresses.contributionRegistry) {
      this.contributionRegistry = new ethers.Contract(
        addresses.contributionRegistry,
        CONTRIBUTION_REGISTRY_ABI,
        connectedSigner,
      );
    }

    if (addresses.bountyContract) {
      this.bountyContract = new ethers.Contract(
        addresses.bountyContract,
        BOUNTY_CONTRACT_ABI,
        connectedSigner,
      );
    }

    if (addresses.knowledgeBundle) {
      this.knowledgeBundleContract = new ethers.Contract(
        addresses.knowledgeBundle,
        KNOWLEDGE_BUNDLE_ABI,
        connectedSigner,
      );
    }

    if (addresses.agentFactory) {
      this.agentFactoryContract = new ethers.Contract(
        addresses.agentFactory,
        AGENT_FACTORY_ABI,
        connectedSigner,
      );
    }

    if (addresses.revenueRouter) {
      this.revenueRouterContract = new ethers.Contract(
        addresses.revenueRouter,
        REVENUE_ROUTER_ABI,
        connectedSigner,
      );
    }

    if (addresses.cliqueRegistry) {
      this.cliqueRegistryContract = new ethers.Contract(
        addresses.cliqueRegistry,
        CLIQUE_REGISTRY_ABI,
        connectedSigner,
      );
    }
  }

  // ================================================================
  //                     Global Counters & Mappings
  // ================================================================

  /**
   * Get the total number of registered agents.
   */
  async totalAgents(): Promise<number> {
    try {
      const count = await this.registry.totalAgents();
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total agents: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the total number of content entries (posts + comments).
   */
  async totalContent(): Promise<number> {
    try {
      const count = await this.contentIndex.totalContent();
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the post count for a specific author.
   *
   * @param address - The Ethereum address of the author.
   */
  async authorPostCount(address: string): Promise<number> {
    try {
      const count = await this.contentIndex.authorPostCount(address);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get author post count for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the post count for a specific community.
   *
   * @param community - The community name.
   */
  async communityPostCount(community: string): Promise<number> {
    try {
      const count = await this.contentIndex.communityPostCount(community);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get community post count for "${community}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the total number of votes cast across all content.
   */
  async totalVotes(): Promise<number> {
    try {
      const count = await this.interactions.totalVotes();
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total votes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the number of attestations received by an agent.
   *
   * @param address - The Ethereum address of the agent.
   */
  async attestationCount(address: string): Promise<number> {
    try {
      const count = await this.socialGraph.attestationCount(address);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get attestation count for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the number of attestations given by an agent.
   *
   * @param address - The Ethereum address of the agent.
   */
  async attestationsGivenCount(address: string): Promise<number> {
    try {
      const count = await this.socialGraph.attestationsGivenCount(address);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get attestations given count for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                     Internal Helpers
  // ================================================================

  /**
   * Send a write transaction, routing through the meta-transaction forwarder
   * when configured, or submitting directly when not.
   *
   * @param contract - The target contract instance.
   * @param method   - The contract method name to call.
   * @param args     - Arguments to pass to the method.
   * @returns The mined transaction receipt.
   */
  private async _send(
    contract: ethers.Contract,
    method: string,
    args: unknown[],
  ): Promise<ethers.TransactionReceipt> {
    if (this.metatx) {
      const data = contract.interface.encodeFunctionData(method, args);
      const target = await contract.getAddress();
      return this.metatx.execute(target, data, this.signer);
    }
    const tx = await contract[method](...args);
    const receipt = await tx.wait();
    return receipt!;
  }

  // ================================================================
  //                     AgentRegistry Methods
  // ================================================================

  /**
   * Register the caller as an agent in the AgentRegistry.
   *
   * @param didCid - The IPFS CID of the agent's DID document.
   * @param agentType - Optional account type: 1 = Human, 2 = Agent.
   *   When omitted, calls `register(string)` which defaults to type 0 (Unspecified).
   *   When provided, calls `register(string,uint8)` which stores the type on-chain.
   * @returns The mined transaction receipt.
   * @throws If the caller is already registered or the CID is empty.
   */
  async register(didCid: string, agentType?: number): Promise<ethers.TransactionReceipt> {
    try {
      if (agentType != null) {
        return await this._send(this.registry, "register(string,uint8)", [didCid, agentType]);
      }
      return await this._send(this.registry, "register(string)", [didCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to register agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the account type of a registered agent.
   *
   * @param address - The Ethereum address of the agent.
   * @returns 0 = Unspecified (legacy), 1 = Human, 2 = Agent.
   */
  async getAgentType(address: string): Promise<number> {
    try {
      const result = await this.registry.getAgentType(address);
      return Number(result);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get agent type for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Update the DID document CID for the calling agent.
   *
   * @param newDidCid - The new IPFS CID pointing to the updated DID document.
   * @returns The mined transaction receipt.
   * @throws If the caller is not registered or the CID is empty.
   */
  async updateDid(newDidCid: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.registry, "updateDid", [newDidCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to update DID: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieve on-chain agent information from the AgentRegistry.
   *
   * @param address - The Ethereum address of the agent to look up.
   * @returns The agent's on-chain info, with bigint timestamps converted to numbers.
   * @throws If the agent is not registered or the call fails.
   */
  async getAgent(address: string): Promise<AgentInfo> {
    try {
      const result = await this.registry.getAgent(address);
      return {
        didCid: result.didCid,
        registeredAt: Number(result.registeredAt),
        updatedAt: Number(result.updatedAt),
        isVerified: result.isVerified,
        isActive: result.isActive,
        stakedAmount: BigInt(result.stakedAmount),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get agent info for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether an address has been registered in the AgentRegistry.
   *
   * @param address - The Ethereum address to check.
   * @returns `true` if the address has a registered agent record.
   */
  async isRegistered(address: string): Promise<boolean> {
    try {
      return await this.registry.isRegistered(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check registration for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether an address is a registered *and* active agent.
   *
   * @param address - The Ethereum address to check.
   * @returns `true` if the agent exists and is currently active.
   */
  async isActiveAgent(address: string): Promise<boolean> {
    try {
      return await this.registry.isActiveAgent(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check active status for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      ContentIndex Methods
  // ================================================================

  /**
   * Record a new post on-chain in the ContentIndex.
   *
   * The actual post content should already be uploaded to IPFS; this method
   * records the CID and its metadata on-chain.
   *
   * @param cid       - The IPFS CID of the post document.
   * @param community - The community name the post belongs to.
   * @returns The mined transaction receipt.
   * @throws If the CID already exists, the caller is not registered, etc.
   */
  async publishPost(
    cid: string,
    community: string,
  ): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.contentIndex, "publishPost", [cid, community]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to publish post: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Record a new comment on-chain in the ContentIndex.
   *
   * @param cid       - The IPFS CID of the comment document.
   * @param community - The community name the comment belongs to.
   * @param parentCid - The IPFS CID of the parent post or comment.
   * @returns The mined transaction receipt.
   * @throws If the CID already exists, the parent is missing, etc.
   */
  async publishComment(
    cid: string,
    community: string,
    parentCid: string,
  ): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.contentIndex, "publishComment", [cid, community, parentCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to publish comment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieve on-chain metadata for a piece of content.
   *
   * @param cid - The IPFS CID of the content to look up.
   * @returns The content entry with its on-chain metadata.
   * @throws If the content does not exist.
   */
  async getContent(cid: string): Promise<ContentEntry> {
    try {
      const result = await this.contentIndex.getContent(cid);
      return {
        author: result.author,
        community: result.community,
        contentType: Number(result.contentType),
        parentCid: result.parentCid,
        timestamp: Number(result.timestamp),
        isActive: result.isActive,
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get content for CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether content with the given CID has been recorded on-chain.
   *
   * @param cid - The IPFS CID to check.
   * @returns `true` if a content entry exists for this CID.
   */
  async contentExists(cid: string): Promise<boolean> {
    try {
      return await this.contentIndex.contentExists(cid);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check content existence for CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                   InteractionContract Methods
  // ================================================================

  /**
   * Upvote a piece of content.
   *
   * @param cid - The IPFS CID of the content to upvote.
   * @returns The mined transaction receipt.
   * @throws If already voted, content not found, voting on own content, etc.
   */
  async upvote(cid: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.interactions, "upvote", [cid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to upvote CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Downvote a piece of content.
   *
   * @param cid - The IPFS CID of the content to downvote.
   * @returns The mined transaction receipt.
   * @throws If already voted, content not found, voting on own content, etc.
   */
  async downvote(cid: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.interactions, "downvote", [cid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to downvote CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Remove a previously cast vote from a piece of content.
   *
   * @param cid - The IPFS CID of the content to remove the vote from.
   * @returns The mined transaction receipt.
   * @throws If the caller has not voted on this content.
   */
  async removeVote(cid: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.interactions, "removeVote", [cid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to remove vote for CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieve the upvote and downvote counts for a piece of content.
   *
   * @param cid - The IPFS CID of the content.
   * @returns An object with `upvotes` and `downvotes` as numbers.
   */
  async getVotes(cid: string): Promise<VoteCount> {
    try {
      const result = await this.interactions.getVotes(cid);
      return {
        upvotes: Number(result.upvotes),
        downvotes: Number(result.downvotes),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get votes for CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the net score (upvotes minus downvotes) for a piece of content.
   *
   * @param cid - The IPFS CID of the content.
   * @returns The net score as a signed number.
   */
  async getScore(cid: string): Promise<number> {
    try {
      const result = await this.interactions.getScore(cid);
      return Number(result);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get score for CID ${cid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether a specific voter has voted on a piece of content.
   *
   * @param cid   - The IPFS CID of the content.
   * @param voter - The Ethereum address of the voter.
   * @returns `true` if the voter has an active vote on this content.
   */
  async hasVoted(cid: string, voter: string): Promise<boolean> {
    try {
      return await this.interactions.hasVoted(cid, voter);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check vote status for CID ${cid}, voter ${voter}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      SocialGraph Methods
  // ================================================================

  /**
   * Follow another agent.
   *
   * @param target - The Ethereum address of the agent to follow.
   * @returns The mined transaction receipt.
   * @throws If already following, target not registered, following self, etc.
   */
  async follow(target: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "follow", [target]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to follow ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Unfollow a previously followed agent.
   *
   * @param target - The Ethereum address of the agent to unfollow.
   * @returns The mined transaction receipt.
   * @throws If not currently following the target.
   */
  async unfollow(target: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "unfollow", [target]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to unfollow ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Block another agent, preventing social interaction.
   *
   * @param target - The Ethereum address of the agent to block.
   * @returns The mined transaction receipt.
   * @throws If already blocked, blocking self, etc.
   */
  async blockAgent(target: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "blockAgent", [target]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to block ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Unblock a previously blocked agent.
   *
   * @param target - The Ethereum address of the agent to unblock.
   * @returns The mined transaction receipt.
   * @throws If the target is not currently blocked.
   */
  async unblockAgent(target: string): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "unblockAgent", [target]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to unblock ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a trust attestation for another agent.
   *
   * Attestations are a core component of the web-of-trust model. They
   * allow agents to vouch for each other's legitimacy and can require
   * staking when the token economy is active.
   *
   * @param subject - The Ethereum address of the agent to attest.
   * @param reason  - A human/agent-readable reason for the attestation.
   * @returns The mined transaction receipt.
   * @throws If already attested, attesting self, insufficient stake, etc.
   */
  async attest(
    subject: string,
    reason: string,
  ): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "attest", [subject, reason]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to attest ${subject}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Revoke a previously created attestation.
   *
   * @param subject - The Ethereum address of the agent whose attestation to revoke.
   * @returns The mined transaction receipt.
   * @throws If no attestation exists for this subject.
   */
  async revokeAttestation(
    subject: string,
  ): Promise<ethers.TransactionReceipt> {
    try {
      return await this._send(this.socialGraph, "revokeAttestation", [subject]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to revoke attestation for ${subject}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether one agent is following another.
   *
   * @param follower - The address of the potential follower.
   * @param target   - The address of the potentially followed agent.
   * @returns `true` if `follower` is currently following `target`.
   */
  async isFollowing(follower: string, target: string): Promise<boolean> {
    try {
      return await this.socialGraph.isFollowing(follower, target);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check follow status (${follower} -> ${target}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether one agent has blocked another.
   *
   * @param blocker - The address of the potential blocker.
   * @param target  - The address of the potentially blocked agent.
   * @returns `true` if `blocker` has blocked `target`.
   */
  async isBlocked(blocker: string, target: string): Promise<boolean> {
    try {
      return await this.socialGraph.isBlocked(blocker, target);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check block status (${blocker} -> ${target}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieve an attestation record between two agents.
   *
   * @param attester - The address of the agent who created the attestation.
   * @param subject  - The address of the agent who was attested.
   * @returns The attestation details including reason, stake, and timestamp.
   * @throws If no attestation exists between these two agents.
   */
  async getAttestation(
    attester: string,
    subject: string,
  ): Promise<Attestation> {
    try {
      const result = await this.socialGraph.getAttestation(attester, subject);
      return {
        attester: result.attester,
        subject: result.subject,
        reason: result.reason,
        stakedAmount: BigInt(result.stakedAmount),
        timestamp: Number(result.timestamp),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get attestation (${attester} -> ${subject}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the number of followers for an agent.
   *
   * @param address - The Ethereum address of the agent.
   * @returns The total number of followers.
   */
  async followerCount(address: string): Promise<number> {
    try {
      const count = await this.socialGraph.followerCount(address);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get follower count for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the number of agents that a given agent is following.
   *
   * @param address - The Ethereum address of the agent.
   * @returns The total number of agents being followed.
   */
  async followingCount(address: string): Promise<number> {
    try {
      const count = await this.socialGraph.followingCount(address);
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get following count for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                   CommunityRegistry Methods
  // ================================================================

  /**
   * Ensure the CommunityRegistry contract is configured.
   * @throws If communityRegistry is not set.
   */
  private requireCommunityRegistry(): ethers.Contract {
    if (!this.communityRegistry) {
      throw new Error(
        "CommunityRegistry not configured. Provide contracts.communityRegistry in the SDK config.",
      );
    }
    return this.communityRegistry;
  }

  /**
   * Create a new community on-chain.
   *
   * @param slug - URL-safe community identifier.
   * @param metadataCid - IPFS CID of the community metadata document.
   * @param postingPolicy - 0=open, 1=registered-only, 2=approved-only.
   * @returns The mined transaction receipt.
   */
  async createCommunity(
    slug: string,
    metadataCid: string,
    postingPolicy: number,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "createCommunity", [slug, metadataCid, postingPolicy]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to create community "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get on-chain community info.
   *
   * @param slug - Community slug to look up.
   * @returns The community info with typed fields.
   */
  async getCommunity(slug: string): Promise<CommunityInfo> {
    const cr = this.requireCommunityRegistry();
    try {
      const result = await cr.getCommunity(slug);
      return {
        creator: result.creator,
        metadataCid: result.metadataCid,
        postingPolicy: Number(result.postingPolicy) as PostingPolicy,
        isActive: result.isActive,
        createdAt: Number(result.createdAt),
        updatedAt: Number(result.updatedAt),
        moderatorCount: Number(result.moderatorCount),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get community "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a community exists on-chain.
   */
  async communityExists(slug: string): Promise<boolean> {
    const cr = this.requireCommunityRegistry();
    try {
      return await cr.communityExists(slug);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check community existence for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a community is active.
   */
  async isCommunityActive(slug: string): Promise<boolean> {
    const cr = this.requireCommunityRegistry();
    try {
      return await cr.isCommunityActive(slug);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check community active status for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Update community metadata CID on-chain.
   */
  async updateCommunityMetadata(
    slug: string,
    newMetadataCid: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "updateMetadata", [slug, newMetadataCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to update metadata for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Add a moderator to a community.
   */
  async addCommunityModerator(
    slug: string,
    moderator: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "addModerator", [slug, moderator]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to add moderator to "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Remove a moderator from a community.
   */
  async removeCommunityModerator(
    slug: string,
    moderator: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "removeModerator", [slug, moderator]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to remove moderator from "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Approve a poster for an approved-only community.
   */
  async approvePoster(
    slug: string,
    poster: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "approvePoster", [slug, poster]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to approve poster for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Revoke a poster's approval.
   */
  async revokePoster(
    slug: string,
    poster: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "revokePoster", [slug, poster]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to revoke poster for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Set the posting policy for a community.
   */
  async setCommunityPostingPolicy(
    slug: string,
    policy: number,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "setPostingPolicy", [slug, policy]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to set posting policy for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if an address is a moderator of a community.
   */
  async isCommunityModerator(slug: string, address: string): Promise<boolean> {
    const cr = this.requireCommunityRegistry();
    try {
      return await cr.isModerator(slug, address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check moderator status for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if an address can post in a community.
   */
  async canPostInCommunity(slug: string, poster: string): Promise<boolean> {
    const cr = this.requireCommunityRegistry();
    try {
      return await cr.canPost(slug, poster);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check posting permission for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Transfer community ownership.
   */
  async transferCommunityOwnership(
    slug: string,
    newCreator: string,
  ): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCommunityRegistry();
    try {
      return await this._send(cr, "transferCommunityOwnership", [slug, newCreator]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to transfer ownership for "${slug}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the total number of registered communities.
   */
  async totalCommunities(): Promise<number> {
    const cr = this.requireCommunityRegistry();
    try {
      const count = await cr.totalCommunities();
      return Number(count);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total communities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                     ProjectRegistry Methods
  // ================================================================

  /**
   * Ensure the ProjectRegistry contract is configured.
   * @throws If projectRegistry is not set.
   */
  private requireProjectRegistry(): ethers.Contract {
    if (!this.projectRegistry) {
      throw new Error(
        "ProjectRegistry not configured. Provide contracts.projectRegistry in the SDK config.",
      );
    }
    return this.projectRegistry;
  }

  /**
   * Create a new project on-chain.
   *
   * @param projectId - URL-safe project identifier.
   * @param metadataCid - IPFS CID of the project metadata document.
   * @returns The mined transaction receipt.
   */
  async createProject(
    projectId: string,
    metadataCid: string,
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "createProject", [projectId, metadataCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to create project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Update project metadata CID on-chain.
   */
  async updateProjectMetadata(
    projectId: string,
    newMetadataCid: string,
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "updateProject", [projectId, newMetadataCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to update project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Add a collaborator to a project.
   *
   * @param projectId - Project ID.
   * @param collaborator - Collaborator's Ethereum address.
   * @param role - Role: 1=Viewer, 2=Contributor, 3=Admin.
   */
  async addProjectCollaborator(
    projectId: string,
    collaborator: string,
    role: number,
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "addCollaborator", [projectId, collaborator, role]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to add collaborator to "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Remove a collaborator from a project.
   */
  async removeProjectCollaborator(
    projectId: string,
    collaborator: string,
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "removeCollaborator", [projectId, collaborator]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to remove collaborator from "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Record a version snapshot for a project.
   *
   * @param projectId - Project ID.
   * @param commitHash - Git commit hash (40 hex characters).
   * @param metadataCid - Optional IPFS CID of version-specific metadata.
   */
  async snapshotVersion(
    projectId: string,
    commitHash: string,
    metadataCid: string = "",
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "snapshotVersion", [projectId, commitHash, metadataCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to snapshot version for "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deactivate a project.
   */
  async deactivateProject(
    projectId: string,
  ): Promise<ethers.TransactionReceipt> {
    const pr = this.requireProjectRegistry();
    try {
      return await this._send(pr, "deactivateProject", [projectId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to deactivate project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get on-chain project info.
   */
  async getProject(projectId: string): Promise<ProjectInfo> {
    const pr = this.requireProjectRegistry();
    try {
      const result = await pr.getProject(projectId);
      return {
        creator: result.creator,
        metadataCid: result.metadataCid,
        collaboratorCount: Number(result.collaboratorCount),
        versionCount: Number(result.versionCount),
        isActive: result.isActive,
        createdAt: Number(result.createdAt),
        updatedAt: Number(result.updatedAt),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a project exists on-chain.
   */
  async projectExists(projectId: string): Promise<boolean> {
    const pr = this.requireProjectRegistry();
    try {
      return await pr.projectExists(projectId);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check project existence for "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a project is active.
   */
  async isProjectActive(projectId: string): Promise<boolean> {
    const pr = this.requireProjectRegistry();
    try {
      return await pr.isProjectActive(projectId);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check project active status for "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if an address is a collaborator on a project.
   */
  async isProjectCollaborator(projectId: string, address: string): Promise<boolean> {
    const pr = this.requireProjectRegistry();
    try {
      return await pr.isCollaborator(projectId, address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check collaborator status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the collaborator role for an address on a project.
   *
   * @returns 0=None, 1=Viewer, 2=Contributor, 3=Admin.
   */
  async getProjectCollaboratorRole(projectId: string, address: string): Promise<number> {
    const pr = this.requireProjectRegistry();
    try {
      return Number(await pr.getCollaboratorRole(projectId, address));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get collaborator role: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the total number of registered projects.
   */
  async totalProjects(): Promise<number> {
    const pr = this.requireProjectRegistry();
    try {
      return Number(await pr.totalProjects());
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total projects: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                  ContributionRegistry
  // ================================================================

  private requireContributionRegistry(): ethers.Contract {
    if (!this.contributionRegistry) {
      throw new Error(
        "ContributionRegistry not configured. Provide contracts.contributionRegistry in the SDK config.",
      );
    }
    return this.contributionRegistry;
  }

  /** Get an agent's contribution score (0-10000). */
  async getContributionScore(address: string): Promise<number> {
    const cr = this.requireContributionRegistry();
    try {
      return Number(await cr.getContributionScore(address));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get contribution score: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get an agent's expertise tags (comma-separated string). */
  async getExpertiseTags(address: string): Promise<string> {
    const cr = this.requireContributionRegistry();
    try {
      return await cr.getExpertiseTags(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get expertise tags: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get the IPFS CID of an agent's contribution breakdown. */
  async getBreakdownCid(address: string): Promise<string> {
    const cr = this.requireContributionRegistry();
    try {
      return await cr.getBreakdownCid(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get breakdown CID: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      BountyContract
  // ================================================================

  private requireBountyContract(): ethers.Contract {
    if (!this.bountyContract) {
      throw new Error(
        "BountyContract not configured. Provide contracts.bountyContract in the SDK config.",
      );
    }
    return this.bountyContract;
  }

  /**
   * Create a bounty on-chain.
   * @param cid IPFS CID of the bounty metadata document
   * @param community Community the bounty belongs to
   * @param deadline Unix timestamp after which bounty can be expired
   * @param options Optional USDC token reward amount (6 decimals)
   */
  async createBounty(
    cid: string,
    community: string,
    deadline: number,
    options?: { tokenRewardAmount?: bigint },
  ): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      const tokenAmount = options?.tokenRewardAmount ?? 0n;
      return await this._send(bc, "createBounty", [cid, community, deadline, tokenAmount]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to create bounty: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Claim a bounty to work on it. */
  async claimBounty(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "claimBounty", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to claim bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Unclaim a bounty (release back to open). */
  async unclaimBounty(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "unclaimBounty", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to unclaim bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Submit work for a claimed bounty. */
  async submitWork(bountyId: number, submissionCid: string): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "submitWork", [bountyId, submissionCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to submit work for bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Approve submitted work (creator only). Releases escrow. */
  async approveWork(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "approveWork", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to approve work for bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Dispute submitted work (creator only). */
  async disputeWork(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "disputeWork", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to dispute work for bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Cancel an open bounty (creator only). Refunds escrow. */
  async cancelBounty(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "cancelBounty", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to cancel bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Expire a bounty past its deadline. Anyone can call. */
  async expireBounty(bountyId: number): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "expireBounty", [bountyId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to expire bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Resolve a disputed bounty. Owner-only. */
  async resolveDispute(bountyId: number, releaseToWorker: boolean): Promise<ethers.TransactionReceipt> {
    const bc = this.requireBountyContract();
    try {
      return await this._send(bc, "resolveDispute", [bountyId, releaseToWorker]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to resolve dispute for bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get full bounty info from chain. */
  async getBounty(bountyId: number): Promise<BountyInfo> {
    const bc = this.requireBountyContract();
    try {
      const result = await bc.getBounty(bountyId);
      return {
        creator: result.creator,
        metadataCid: result.metadataCid,
        community: result.community,
        rewardAmount: result.rewardAmount,
        escrowType: Number(result.escrowType) as EscrowType,
        status: Number(result.status) as BountyStatus,
        claimer: result.claimer,
        submissionCid: result.submissionCid,
        deadline: result.deadline,
        createdAt: result.createdAt,
        claimedAt: result.claimedAt,
        submittedAt: result.submittedAt,
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get bounty ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get the current status of a bounty. */
  async getBountyStatus(bountyId: number): Promise<BountyStatus> {
    const bc = this.requireBountyContract();
    try {
      return Number(await bc.getBountyStatus(bountyId)) as BountyStatus;
    } catch (error: unknown) {
      throw new Error(
        `Failed to get bounty status ${bountyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get total number of bounties created. */
  async totalBounties(): Promise<number> {
    const bc = this.requireBountyContract();
    try {
      return Number(await bc.totalBounties());
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total bounties: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      KnowledgeBundle
  // ================================================================

  private requireKnowledgeBundleContract(): ethers.Contract {
    if (!this.knowledgeBundleContract) {
      throw new Error(
        "KnowledgeBundle not configured. Provide contracts.knowledgeBundle in the SDK config.",
      );
    }
    return this.knowledgeBundleContract;
  }

  /**
   * Create a knowledge bundle on-chain.
   * @param name Human-readable bundle name
   * @param descriptionCid IPFS CID for description (can be empty string)
   * @param cids Array of ContentIndex CIDs
   * @param contributors Array of contributor weight assignments
   * @returns Object with bundleId and transaction receipt
   */
  async createBundle(
    name: string,
    descriptionCid: string,
    cids: string[],
    contributors: ContributorWeight[],
  ): Promise<{ bundleId: number; tx: ethers.TransactionReceipt }> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      const contribs = contributors.map((c) => ({
        contributor: c.contributor,
        weightBps: c.weightBps,
      }));
      const receipt = await this._send(kb, "createBundle", [name, descriptionCid, cids, contribs]);

      // Extract bundleId from events
      let bundleId = 0;
      const iface = kb.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "BundleCreated") {
            bundleId = Number(parsed.args.bundleId);
            break;
          }
        } catch {
          // Skip logs from other contracts
        }
      }

      return { bundleId, tx: receipt };
    } catch (error: unknown) {
      throw new Error(
        `Failed to create bundle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Add content CIDs to an existing bundle. */
  async addBundleContent(bundleId: number, cids: string[]): Promise<ethers.TransactionReceipt> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      return await this._send(kb, "addContent", [bundleId, cids]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to add content to bundle ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Remove content CIDs from a bundle. */
  async removeBundleContent(bundleId: number, cids: string[]): Promise<ethers.TransactionReceipt> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      return await this._send(kb, "removeContent", [bundleId, cids]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to remove content from bundle ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Update contributor weights for a bundle. */
  async setBundleContributorWeights(
    bundleId: number,
    contributors: ContributorWeight[],
  ): Promise<ethers.TransactionReceipt> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      const contribs = contributors.map((c) => ({
        contributor: c.contributor,
        weightBps: c.weightBps,
      }));
      return await this._send(kb, "setContributorWeights", [bundleId, contribs]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to set contributor weights for bundle ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Deactivate a bundle (creator or owner). */
  async deactivateBundle(bundleId: number): Promise<ethers.TransactionReceipt> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      return await this._send(kb, "deactivateBundle", [bundleId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to deactivate bundle ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get full bundle info from chain. */
  async getBundle(bundleId: number): Promise<BundleInfo> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      const result = await kb.getBundle(bundleId);
      return {
        id: bundleId,
        creator: result.creator,
        name: result.name,
        descriptionCid: result.descriptionCid,
        contentCids: [...result.contentCids],
        contributors: result.contributors.map((c: any) => ({
          contributor: c.contributor,
          weightBps: Number(c.weightBps),
        })),
        createdAt: Number(result.createdAt),
        isActive: result.isActive,
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get bundle ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get total number of bundles created. */
  async getBundleCount(): Promise<number> {
    const kb = this.requireKnowledgeBundleContract();
    try {
      return Number(await kb.getBundleCount());
    } catch (error: unknown) {
      throw new Error(
        `Failed to get bundle count: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      AgentFactory
  // ================================================================

  private requireAgentFactoryContract(): ethers.Contract {
    if (!this.agentFactoryContract) {
      throw new Error(
        "AgentFactory not configured. Provide contracts.agentFactory in the SDK config.",
      );
    }
    return this.agentFactoryContract;
  }

  /** Deploy an agent via AgentFactory. */
  async deployAgent(
    bundleId: number,
    agentAddress: string,
    soulCid: string,
    deploymentFee: bigint = 0n,
  ): Promise<{ deploymentId: number; tx: ethers.TransactionReceipt }> {
    const af = this.requireAgentFactoryContract();
    try {
      const receipt = await this._send(af, "deployAgent", [bundleId, agentAddress, soulCid, deploymentFee]);
      let deploymentId = 0;
      const iface = af.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "AgentDeployed") {
            deploymentId = Number(parsed.args.deploymentId);
            break;
          }
        } catch { /* skip */ }
      }
      return { deploymentId, tx: receipt };
    } catch (error: unknown) {
      throw new Error(
        `Failed to deploy agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Spawn a child agent via AgentFactory. */
  async spawnAgent(
    bundleId: number,
    childAddress: string,
    soulCid: string,
    deploymentFee: bigint = 0n,
  ): Promise<{ deploymentId: number; tx: ethers.TransactionReceipt }> {
    const af = this.requireAgentFactoryContract();
    try {
      const receipt = await this._send(af, "spawnAgent", [bundleId, childAddress, soulCid, deploymentFee]);
      let deploymentId = 0;
      const iface = af.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "AgentSpawned") {
            deploymentId = Number(parsed.args.deploymentId);
            break;
          }
        } catch { /* skip */ }
      }
      return { deploymentId, tx: receipt };
    } catch (error: unknown) {
      throw new Error(
        `Failed to spawn agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Update the soul CID for a deployed agent. */
  async updateSoul(deploymentId: number, newSoulCid: string): Promise<ethers.TransactionReceipt> {
    const af = this.requireAgentFactoryContract();
    try {
      return await this._send(af, "updateSoul", [deploymentId, newSoulCid]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to update soul: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get deployment info from chain. */
  async getDeployment(deploymentId: number): Promise<DeploymentInfo> {
    const af = this.requireAgentFactoryContract();
    try {
      const r = await af.getDeployment(deploymentId);
      return {
        id: deploymentId,
        creator: r.creator,
        agentAddress: r.agentAddress,
        bundleId: Number(r.bundleId),
        soulCid: r.soulCid,
        deploymentFee: r.deploymentFee,
        contributorPayout: r.contributorPayout,
        treasuryPayout: r.treasuryPayout,
        creditPayout: r.creditPayout,
        curatorPayout: r.curatorPayout,
        parentAgent: r.parentAgent,
        createdAt: Number(r.createdAt),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get deployment ${deploymentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get deployment IDs by creator. */
  async getDeploymentsByCreator(creator: string): Promise<number[]> {
    const af = this.requireAgentFactoryContract();
    try {
      const ids = await af.getDeploymentsByCreator(creator);
      return ids.map((id: bigint) => Number(id));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get deployments by creator: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get deployment IDs by bundle. */
  async getDeploymentsByBundle(bundleId: number): Promise<number[]> {
    const af = this.requireAgentFactoryContract();
    try {
      const ids = await af.getDeploymentsByBundle(bundleId);
      return ids.map((id: bigint) => Number(id));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get deployments by bundle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get children spawned by a parent agent. */
  async getSpawnChildren(parent: string): Promise<string[]> {
    const af = this.requireAgentFactoryContract();
    try {
      return [...(await af.getSpawnChildren(parent))];
    } catch (error: unknown) {
      throw new Error(
        `Failed to get spawn children: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get the parent of a spawned agent. */
  async getSpawnParent(child: string): Promise<string> {
    const af = this.requireAgentFactoryContract();
    try {
      return await af.getSpawnParent(child);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get spawn parent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get total deployment count. */
  async getDeploymentCount(): Promise<number> {
    const af = this.requireAgentFactoryContract();
    try {
      return Number(await af.getDeploymentCount());
    } catch (error: unknown) {
      throw new Error(
        `Failed to get deployment count: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get soul CID for a deployed agent. */
  async getSoulCid(agentAddress: string): Promise<string> {
    const af = this.requireAgentFactoryContract();
    try {
      return await af.getSoulCid(agentAddress);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get soul CID: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      RevenueRouter
  // ================================================================

  private requireRevenueRouterContract(): ethers.Contract {
    if (!this.revenueRouterContract) {
      throw new Error(
        "RevenueRouter not configured. Provide contracts.revenueRouter in the SDK config.",
      );
    }
    return this.revenueRouterContract;
  }

  /** Set revenue share config for an agent. */
  async setRevenueShare(
    agent: string,
    ownerBps: number,
    receiptChainBps: number,
    treasuryBps: number,
    bundleId: number,
  ): Promise<ethers.TransactionReceipt> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await this._send(rr, "setShareConfig", [agent, ownerBps, receiptChainBps, treasuryBps, bundleId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to set revenue share: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Distribute revenue for an agent (ETH mode — sends msg.value). */
  async distributeRevenue(
    agent: string,
    source: string,
    options?: { valueEth?: string },
  ): Promise<ethers.TransactionReceipt> {
    const rr = this.requireRevenueRouterContract();
    try {
      if (options?.valueEth) {
        const value = ethers.parseEther(options.valueEth);
        const tx = await rr.distributeRevenue(agent, source, { value });
        const receipt = await tx.wait();
        return receipt;
      }
      return await this._send(rr, "distributeRevenue", [agent, source]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to distribute revenue: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Distribute revenue for an agent (token mode). */
  async distributeRevenueToken(
    agent: string,
    source: string,
    amount: bigint,
  ): Promise<ethers.TransactionReceipt> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await this._send(rr, "distributeRevenueToken", [agent, source, amount]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to distribute revenue token: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Claim accumulated token earnings. */
  async claimEarnings(): Promise<ethers.TransactionReceipt> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await this._send(rr, "claim", []);
    } catch (error: unknown) {
      throw new Error(
        `Failed to claim earnings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Claim accumulated ETH earnings. */
  async claimEthEarnings(): Promise<ethers.TransactionReceipt> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await this._send(rr, "claimEth", []);
    } catch (error: unknown) {
      throw new Error(
        `Failed to claim ETH earnings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get claimable token balance. */
  async getClaimableBalance(address: string): Promise<bigint> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await rr.getClaimableBalance(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get claimable balance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get claimable ETH balance. */
  async getClaimableEthBalance(address: string): Promise<bigint> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await rr.getClaimableEthBalance(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get claimable ETH balance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get revenue share config for an agent. */
  async getRevenueShareConfig(agent: string): Promise<RevenueShareConfig> {
    const rr = this.requireRevenueRouterContract();
    try {
      const r = await rr.getShareConfig(agent);
      return {
        ownerBps: Number(r.ownerBps),
        receiptChainBps: Number(r.receiptChainBps),
        treasuryBps: Number(r.treasuryBps),
        bundleId: Number(r.bundleId),
        isSet: r.isSet,
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get revenue share config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get revenue event IDs for an agent. */
  async getRevenueHistory(agent: string): Promise<number[]> {
    const rr = this.requireRevenueRouterContract();
    try {
      const ids = await rr.getRevenueHistory(agent);
      return ids.map((id: bigint) => Number(id));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get revenue history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get a specific revenue event. */
  async getRevenueEvent(eventId: number): Promise<RevenueEventInfo> {
    const rr = this.requireRevenueRouterContract();
    try {
      const r = await rr.getRevenueEvent(eventId);
      return {
        id: eventId,
        agent: r.agent,
        source: r.source,
        amount: r.amount,
        isEth: r.isEth,
        ownerAmount: r.ownerAmount,
        receiptChainAmount: r.receiptChainAmount,
        treasuryAmount: r.treasuryAmount,
        timestamp: Number(r.timestamp),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get revenue event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get the receipt chain (spawn tree parents) for an agent. */
  async getReceiptChain(agent: string): Promise<string[]> {
    const rr = this.requireRevenueRouterContract();
    try {
      return [...(await rr.getReceiptChain(agent))];
    } catch (error: unknown) {
      throw new Error(
        `Failed to get receipt chain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get total revenue distributed for an agent. */
  async getAgentTotalDistributed(agent: string): Promise<bigint> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await rr.getAgentTotalDistributed(agent);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get agent total distributed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get total claimed by an address. */
  async getAddressTotalClaimed(address: string): Promise<bigint> {
    const rr = this.requireRevenueRouterContract();
    try {
      return await rr.getAddressTotalClaimed(address);
    } catch (error: unknown) {
      throw new Error(
        `Failed to get total claimed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                      CliqueRegistry
  // ================================================================

  private requireCliqueRegistryContract(): ethers.Contract {
    if (!this.cliqueRegistryContract) {
      throw new Error(
        "CliqueRegistry not configured. Provide contracts.cliqueRegistry in the SDK config.",
      );
    }
    return this.cliqueRegistryContract;
  }

  /** Propose a new clique with a set of member addresses. */
  async proposeClique(
    name: string,
    descriptionCid: string,
    members: string[],
  ): Promise<{ cliqueId: number; tx: ethers.TransactionReceipt }> {
    const cr = this.requireCliqueRegistryContract();
    try {
      const tx = await cr.proposeClique(name, descriptionCid, members);
      const receipt = await tx.wait();
      // Extract cliqueId from CliqueProposed event
      const iface = cr.interface;
      let cliqueId = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "CliqueProposed") {
            cliqueId = Number(parsed.args.cliqueId);
            break;
          }
        } catch {
          // Skip logs from other contracts
        }
      }
      return { cliqueId, tx: receipt };
    } catch (error: unknown) {
      throw new Error(
        `Failed to propose clique: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Approve membership in a proposed clique. */
  async approveMembership(cliqueId: number): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return await this._send(cr, "approveMembership", [cliqueId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to approve membership: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Reject membership in a proposed clique. */
  async rejectMembership(cliqueId: number): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return await this._send(cr, "rejectMembership", [cliqueId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to reject membership: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Leave an active clique. */
  async leaveClique(cliqueId: number): Promise<ethers.TransactionReceipt> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return await this._send(cr, "leaveClique", [cliqueId]);
    } catch (error: unknown) {
      throw new Error(
        `Failed to leave clique: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Trigger a collective spawn from an active clique. */
  async collectiveSpawn(
    cliqueId: number,
    bundleId: number,
    childAddress: string,
    soulCid: string,
    deploymentFee?: bigint,
  ): Promise<{ deploymentId: number; tx: ethers.TransactionReceipt }> {
    const cr = this.requireCliqueRegistryContract();
    try {
      const tx = await cr.collectiveSpawn(cliqueId, bundleId, childAddress, soulCid, deploymentFee ?? 0n);
      const receipt = await tx.wait();
      // Extract deploymentId from CollectiveSpawn event
      const iface = cr.interface;
      let deploymentId = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "CollectiveSpawn") {
            deploymentId = Number(parsed.args.deploymentId);
            break;
          }
        } catch {
          // Skip logs from other contracts
        }
      }
      return { deploymentId, tx: receipt };
    } catch (error: unknown) {
      throw new Error(
        `Failed to collective spawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get clique info by ID. */
  async getClique(cliqueId: number): Promise<CliqueInfo> {
    const cr = this.requireCliqueRegistryContract();
    try {
      const r = await cr.getClique(cliqueId);
      return {
        id: cliqueId,
        name: r.name,
        descriptionCid: r.descriptionCid,
        proposer: r.proposer,
        memberCount: Number(r.memberCount),
        approvedCount: Number(r.approvedCount),
        status: Number(r.status) as CliqueStatus,
        createdAt: Number(r.createdAt),
        activatedAt: Number(r.activatedAt),
      };
    } catch (error: unknown) {
      throw new Error(
        `Failed to get clique: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get all member addresses for a clique. */
  async getCliqueMembers(cliqueId: number): Promise<string[]> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return [...(await cr.getMembers(cliqueId))];
    } catch (error: unknown) {
      throw new Error(
        `Failed to get clique members: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get a member's status in a clique. */
  async getMemberStatus(cliqueId: number, member: string): Promise<MemberStatus> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return Number(await cr.getMemberStatus(cliqueId, member)) as MemberStatus;
    } catch (error: unknown) {
      throw new Error(
        `Failed to get member status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get all clique IDs an agent belongs to. */
  async getAgentCliques(agent: string): Promise<number[]> {
    const cr = this.requireCliqueRegistryContract();
    try {
      const ids = await cr.getAgentCliques(agent);
      return ids.map((id: bigint) => Number(id));
    } catch (error: unknown) {
      throw new Error(
        `Failed to get agent cliques: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Check if an agent is a member of a clique. */
  async isCliqueMember(cliqueId: number, agent: string): Promise<boolean> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return await cr.isCliqueMember(cliqueId, agent);
    } catch (error: unknown) {
      throw new Error(
        `Failed to check clique membership: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Get the total number of cliques. */
  async getCliqueCount(): Promise<number> {
    const cr = this.requireCliqueRegistryContract();
    try {
      return Number(await cr.getCliqueCount());
    } catch (error: unknown) {
      throw new Error(
        `Failed to get clique count: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
