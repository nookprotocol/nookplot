/**
 * ERC-8004 Identity Bridge module for the Nookplot SDK.
 *
 * Manages dual registration: when an agent registers on Nookplot, they can
 * optionally also mint an ERC-8004 Identity NFT on Base. This gives Nookplot
 * agents cross-platform discoverability via the Trustless Agents standard.
 *
 * The two registrations are independent — Nookplot is primary, ERC-8004 is
 * secondary. If ERC-8004 fails, Nookplot registration still succeeds.
 *
 * @module erc8004
 */

import { ethers } from "ethers";

import type {
  ERC8004Config,
  ERC8004AgentMetadata,
  ERC8004MintResult,
  ReputationSyncResult,
  DIDDocument,
} from "./types";

import type { ReputationEngine } from "./reputation";

import { ERC8004_IDENTITY_REGISTRY_ABI, ERC8004_REPUTATION_REGISTRY_ABI } from "./abis";
import { IpfsClient } from "./ipfs";

/**
 * Manages interactions with the ERC-8004 IdentityRegistry contract.
 *
 * Follows the same patterns as ContractManager: takes a provider, signer,
 * and config; wraps contract calls with error handling; returns typed results.
 *
 * @example
 * ```ts
 * const manager = new ERC8004Manager(provider, signer, config, ipfsClient);
 * const result = await manager.mintIdentity(didDocument, didCid);
 * console.log(`ERC-8004 Agent ID: ${result.agentId}`);
 * ```
 */
export class ERC8004Manager {
  /** The ERC-8004 IdentityRegistry contract instance. */
  public readonly identityRegistry: ethers.Contract;

  /** The ERC-8004 ReputationRegistry contract instance (null if not configured). */
  public readonly reputationRegistry: ethers.Contract | null;

  private readonly provider: ethers.JsonRpcProvider;
  private readonly ipfs: IpfsClient;
  private readonly signerAddress: string;

  /**
   * Create a new ERC8004Manager.
   *
   * @param provider - An ethers v6 JsonRpcProvider connected to Base / Base Sepolia.
   * @param signer - An ethers v6 Wallet used to sign transactions.
   * @param config - ERC-8004 configuration with contract addresses.
   * @param ipfsClient - IpfsClient for uploading metadata to IPFS.
   */
  constructor(
    provider: ethers.JsonRpcProvider,
    signer: ethers.Wallet,
    config: ERC8004Config,
    ipfsClient: IpfsClient,
  ) {
    const connectedSigner = signer.connect(provider);

    this.identityRegistry = new ethers.Contract(
      config.identityRegistry,
      ERC8004_IDENTITY_REGISTRY_ABI,
      connectedSigner,
    );

    // Conditionally initialise ReputationRegistry
    if (config.reputationRegistry) {
      this.reputationRegistry = new ethers.Contract(
        config.reputationRegistry,
        ERC8004_REPUTATION_REGISTRY_ABI,
        connectedSigner,
      );
    } else {
      this.reputationRegistry = null;
    }

    this.provider = provider;
    this.ipfs = ipfsClient;
    this.signerAddress = signer.address;
  }

  /**
   * Build ERC-8004 metadata JSON from Nookplot DID data.
   *
   * The metadata links the ERC-8004 identity back to the Nookplot DID
   * document stored on IPFS. This is uploaded to IPFS and used as the
   * agentURI for the ERC-8004 Identity NFT.
   *
   * @param didDocument - The agent's Nookplot DID document.
   * @param didCid - The IPFS CID of the DID document.
   * @param gatewayUrl - The full IPFS gateway URL for the DID document.
   * @returns The formatted ERC-8004 metadata object.
   */
  formatRegistrationMetadata(
    didDocument: DIDDocument,
    didCid: string,
    gatewayUrl: string,
  ): ERC8004AgentMetadata {
    return {
      version: "1.0",
      name: didDocument.agentProfile?.displayName ?? "Nookplot Agent",
      description:
        didDocument.agentProfile?.description ??
        "An AI agent registered on the Nookplot decentralised social network",
      platform: "nookplot",
      nookplotDid: didDocument.id,
      didDocumentCid: didCid,
      didDocumentUrl: gatewayUrl,
      capabilities: didDocument.agentProfile?.capabilities ?? [],
      x402Enabled: false,
      walletAddress: this.signerAddress,
      created: Date.now(),
      updated: Date.now(),
    };
  }

  /**
   * Mint an ERC-8004 Identity NFT for this agent.
   *
   * Uploads the agent metadata to IPFS and calls `register(agentURI)` on
   * the IdentityRegistry. Extracts the minted agentId from the Registered
   * event in the transaction receipt.
   *
   * @param didDocument - The agent's Nookplot DID document.
   * @param didCid - The IPFS CID of the DID document.
   * @returns The minted agentId, metadata CID, and transaction receipt.
   * @throws If the agent is already registered in ERC-8004 or the transaction fails.
   */
  async mintIdentity(
    didDocument: DIDDocument,
    didCid: string,
  ): Promise<ERC8004MintResult> {
    // 1. Build and upload metadata to IPFS
    const gatewayUrl = this.ipfs.getGatewayUrl(didCid);
    const metadata = this.formatRegistrationMetadata(
      didDocument,
      didCid,
      gatewayUrl,
    );

    const metadataUpload = await this.ipfs.uploadJson(
      metadata as unknown as Record<string, unknown>,
      `nookplot-erc8004-${this.signerAddress.toLowerCase()}`,
    );

    // 2. Call register(agentURI) on IdentityRegistry
    const agentURI = this.ipfs.getGatewayUrl(metadataUpload.cid);

    try {
      const tx = await this.identityRegistry.register(agentURI);
      const receipt = await tx.wait();

      // 3. Extract agentId from Registered event
      const agentId = this.extractAgentIdFromReceipt(receipt);

      return {
        agentId,
        metadataCid: metadataUpload.cid,
        receipt,
      };
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.mintIdentity: failed to mint identity NFT — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Update the agentURI for an existing ERC-8004 Identity NFT.
   *
   * Uploads new metadata to IPFS and calls `setAgentURI(agentId, newURI)`
   * on the IdentityRegistry.
   *
   * @param agentId - The ERC-8004 agent ID (token ID) to update.
   * @param didDocument - The updated Nookplot DID document.
   * @param didCid - The IPFS CID of the updated DID document.
   * @returns The transaction receipt.
   */
  async updateIdentity(
    agentId: bigint,
    didDocument: DIDDocument,
    didCid: string,
  ): Promise<ethers.TransactionReceipt> {
    const gatewayUrl = this.ipfs.getGatewayUrl(didCid);
    const metadata = this.formatRegistrationMetadata(
      didDocument,
      didCid,
      gatewayUrl,
    );

    const metadataUpload = await this.ipfs.uploadJson(
      metadata as unknown as Record<string, unknown>,
      `nookplot-erc8004-${this.signerAddress.toLowerCase()}`,
    );

    const newURI = this.ipfs.getGatewayUrl(metadataUpload.cid);

    try {
      const tx = await this.identityRegistry.setAgentURI(agentId, newURI);
      const receipt = await tx.wait();
      return receipt;
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.updateIdentity: failed to update identity NFT — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the ERC-8004 agent ID for an address, or null if not registered.
   *
   * Checks `balanceOf` first, then queries Transfer events from the zero
   * address (mints) to find the token ID.
   *
   * @param address - The Ethereum address to look up.
   * @returns The agentId (token ID) or null if the address has no ERC-8004 identity.
   */
  async getERC8004Id(address: string): Promise<bigint | null> {
    try {
      const balance = await this.identityRegistry.balanceOf(address);
      if (BigInt(balance) === 0n) {
        return null;
      }

      // Query Transfer events where from=ZeroAddress and to=address (mints).
      // Scan backwards from the current block in 10k-block chunks to respect
      // Base Sepolia's eth_getLogs range limit. We stop as soon as we find
      // the most recent mint event — no need to scan the full chain.
      const filter = this.identityRegistry.filters.Transfer(
        ethers.ZeroAddress,
        address,
      );

      const currentBlock = await this.provider.getBlockNumber();
      const MAX_RANGE = 9_999;
      const MAX_SCAN_CHUNKS = 50; // Cap at ~500k blocks back

      for (let i = 0; i < MAX_SCAN_CHUNKS; i++) {
        const to = currentBlock - i * MAX_RANGE;
        if (to < 0) break;
        const from = Math.max(0, to - MAX_RANGE + 1);

        try {
          const chunk = await this.identityRegistry.queryFilter(filter, from, to);
          if (chunk.length > 0) {
            // Return the most recent mint's tokenId from this chunk
            const lastEvent = chunk[chunk.length - 1];
            if ("args" in lastEvent && lastEvent.args) {
              return BigInt(lastEvent.args.tokenId);
            }
          }
        } catch {
          // Skip failed chunks
        }

        if (from === 0) break; // Reached genesis
      }

      return null;
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.getERC8004Id: failed to look up agent ID for ${address} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether an address has an ERC-8004 Identity NFT.
   *
   * @param address - The Ethereum address to check.
   * @returns `true` if the address owns at least one ERC-8004 identity token.
   */
  async hasERC8004Identity(address: string): Promise<boolean> {
    try {
      const balance = await this.identityRegistry.balanceOf(address);
      return BigInt(balance) > 0n;
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.hasERC8004Identity: failed to check identity for ${address} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the tokenURI for an ERC-8004 agent.
   *
   * @param agentId - The ERC-8004 agent ID (token ID).
   * @returns The agentURI string (typically an IPFS gateway URL).
   */
  async getTokenURI(agentId: bigint): Promise<string> {
    try {
      return await this.identityRegistry.tokenURI(agentId);
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.getTokenURI: failed to get tokenURI for agent ${agentId} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                     REPUTATION SYNC (Phase 4)
  // ================================================================

  /**
   * Sync a Nookplot reputation score to the ERC-8004 ReputationRegistry.
   *
   * Uses the protocol submitter model: this SDK's signer submits the
   * reputation feedback on behalf of the target agent. ERC-8004 requires
   * `msg.sender != agent owner`, so the signer MUST be a different wallet
   * from the target agent.
   *
   * @param agentAddress - The agent whose reputation to sync.
   * @param reputationEngine - ReputationEngine instance to compute the score.
   * @param community - Optional community name. Defaults to "overall".
   * @returns Full details of the sync transaction.
   * @throws If ReputationRegistry is not configured, signer is the agent, or agent has no ERC-8004 identity.
   */
  async syncReputation(
    agentAddress: string,
    reputationEngine: ReputationEngine,
    community?: string,
  ): Promise<ReputationSyncResult> {
    // 1. Validate ReputationRegistry is configured
    if (!this.reputationRegistry) {
      throw new Error(
        "ERC8004Manager.syncReputation: ReputationRegistry is not configured. " +
        "Provide erc8004.reputationRegistry in the SDK config.",
      );
    }

    // 2. Validate submitter != agent owner (ERC-8004 requirement)
    if (this.signerAddress.toLowerCase() === agentAddress.toLowerCase()) {
      throw new Error(
        "ERC8004Manager.syncReputation: submitter cannot be the same wallet as the agent. " +
        "ERC-8004 requires msg.sender != agent owner. Use a different wallet (protocol submitter model).",
      );
    }

    // 3. Look up ERC-8004 agentId
    const agentId = await this.getERC8004Id(agentAddress);
    if (agentId === null) {
      throw new Error(
        `ERC8004Manager.syncReputation: agent ${agentAddress} has no ERC-8004 identity. ` +
        "Register in ERC-8004 first via mintIdentity().",
      );
    }

    // 4. Compute Nookplot reputation score
    const score = await reputationEngine.computeReputationScore(agentAddress);

    // 5. Format feedback for ERC-8004
    // ERC-8004 giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)
    //   value: int128, valueDecimals: uint8 (0-18)
    //   We use valueDecimals=2, so 75.5 → 7550 as int128
    const tag1 = "nookplot-reputation";
    const tag2 = community ?? "overall";
    const erc8004Value = BigInt(Math.round(score.overall * 100)); // 75.5 → 7550
    const valueDecimals = 2; // 2 decimal places
    const feedbackURI = `nookplot://reputation/${agentAddress}`;
    const endpoint = ""; // optional, empty
    const feedbackHash = ethers.ZeroHash; // optional, bytes32(0)

    // 6. Submit to ReputationRegistry
    try {
      const tx = await this.reputationRegistry.giveFeedback(
        agentId,
        erc8004Value,
        valueDecimals,
        tag1,
        tag2,
        endpoint,
        feedbackURI,
        feedbackHash,
      );
      const receipt = await tx.wait();

      return {
        agentAddress,
        agentId,
        nookplotScore: score.overall,
        erc8004Value,
        tag1,
        tag2,
        feedbackURI,
        receipt,
      };
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.syncReputation: failed to submit feedback — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Read the reputation summary for an agent from the ERC-8004 ReputationRegistry.
   *
   * Queries all feedback matching the given tag filters. Pass empty strings
   * to get unfiltered results. Pass specific client addresses to filter by
   * submitter, or an empty array for all clients.
   *
   * @param agentId - The ERC-8004 agent ID (token ID).
   * @param clientAddresses - Filter by feedback submitters (empty array = all).
   * @param tag1 - Filter by tag1 (empty string = all).
   * @param tag2 - Filter by tag2 (empty string = all).
   * @returns The feedback count, summary value, and value decimals.
   * @throws If ReputationRegistry is not configured.
   */
  async getReputationSummary(
    agentId: bigint,
    clientAddresses: string[] = [],
    tag1: string = "",
    tag2: string = "",
  ): Promise<{ count: bigint; summaryValue: bigint; summaryValueDecimals: number }> {
    if (!this.reputationRegistry) {
      throw new Error(
        "ERC8004Manager.getReputationSummary: ReputationRegistry is not configured. " +
        "Provide erc8004.reputationRegistry in the SDK config.",
      );
    }

    try {
      const [count, summaryValue, summaryValueDecimals] =
        await this.reputationRegistry.getSummary(agentId, clientAddresses, tag1, tag2);
      return {
        count: BigInt(count),
        summaryValue: BigInt(summaryValue),
        summaryValueDecimals: Number(summaryValueDecimals),
      };
    } catch (error: unknown) {
      throw new Error(
        `ERC8004Manager.getReputationSummary: failed to get summary for agent ${agentId} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ================================================================
  //                     Private Helpers
  // ================================================================

  /**
   * Extract the minted agentId from a registration transaction receipt.
   *
   * Parses the Registered event emitted by the IdentityRegistry.
   * Falls back to Transfer event if Registered is not found.
   *
   * @param receipt - The transaction receipt from the register() call.
   * @returns The minted agentId as a bigint.
   * @throws If no Registered or Transfer event is found in the receipt.
   */
  private extractAgentIdFromReceipt(
    receipt: ethers.TransactionReceipt,
  ): bigint {
    // Try to parse Registered event first
    for (const log of receipt.logs) {
      try {
        const parsed = this.identityRegistry.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === "Registered") {
          return BigInt(parsed.args.agentId);
        }
      } catch {
        // Not a matching log, continue
      }
    }

    // Fall back to Transfer event (ERC-721 mint: from=ZeroAddress)
    for (const log of receipt.logs) {
      try {
        const parsed = this.identityRegistry.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (
          parsed &&
          parsed.name === "Transfer" &&
          parsed.args.from === ethers.ZeroAddress
        ) {
          return BigInt(parsed.args.tokenId);
        }
      } catch {
        // Not a matching log, continue
      }
    }

    throw new Error(
      "ERC8004Manager: could not extract agentId from transaction receipt — no Registered or Transfer event found",
    );
  }
}
