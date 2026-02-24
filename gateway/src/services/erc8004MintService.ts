/**
 * ERC-8004 Identity minting service for the Agent Gateway.
 *
 * Automatically mints ERC-8004 Identity NFTs for agents after successful
 * on-chain registration. The relayer wallet calls register() on the
 * IdentityRegistry, then transfers the NFT to the agent's address.
 *
 * Non-fatal: if minting fails, Nookplot registration is unaffected.
 *
 * @module services/erc8004MintService
 */

import type { Pool } from "pg";
import { ethers } from "ethers";
import { ERC8004_IDENTITY_REGISTRY_ABI } from "@nookplot/sdk/dist/abis.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export interface ERC8004MintServiceConfig {
  identityRegistryAddress: string;
  autoTransfer: boolean;
}

export interface MintResult {
  agentId: bigint;
  metadataCid: string;
  mintTxHash: string;
  transferTxHash?: string;
}

interface IpfsUploader {
  uploadJson(data: Record<string, unknown>, name?: string): Promise<{ cid: string }>;
  getGatewayUrl(cid: string): string;
}

export class ERC8004MintService {
  private readonly pool: Pool;
  private readonly ipfs: IpfsUploader;
  private readonly contract: ethers.Contract;
  private readonly relayerAddress: string;
  private readonly autoTransfer: boolean;

  constructor(
    pool: Pool,
    ipfs: IpfsUploader,
    relayerWallet: ethers.Wallet,
    provider: ethers.JsonRpcProvider,
    config: ERC8004MintServiceConfig,
  ) {
    this.pool = pool;
    this.ipfs = ipfs;
    this.autoTransfer = config.autoTransfer;
    this.relayerAddress = relayerWallet.address;

    const connectedWallet = relayerWallet.connect(provider);
    this.contract = new ethers.Contract(
      config.identityRegistryAddress,
      ERC8004_IDENTITY_REGISTRY_ABI,
      connectedWallet,
    );
  }

  /**
   * Mint an ERC-8004 Identity NFT and transfer it to the agent.
   *
   * Flow: upload metadata → register(agentURI) → transferFrom → update DB.
   * Idempotent: skips if agent already has an ERC-8004 ID.
   */
  async mintAndTransfer(
    gatewayAgentId: string,
    agentAddress: string,
    didCid: string,
    displayName?: string | null,
    description?: string | null,
    capabilities?: string[] | null,
  ): Promise<MintResult> {
    // Idempotency: skip if already minted
    const { rows: existing } = await this.pool.query<{ erc8004_agent_id: string | null }>(
      `SELECT erc8004_agent_id::text FROM agents WHERE id = $1`,
      [gatewayAgentId],
    );
    if (existing.length > 0 && existing[0].erc8004_agent_id) {
      throw new Error(`Agent already has ERC-8004 ID: ${existing[0].erc8004_agent_id}`);
    }

    // 1. Build and upload metadata to IPFS
    const metadata = this.buildMetadata(agentAddress, didCid, displayName, description, capabilities);
    const { cid: metadataCid } = await this.ipfs.uploadJson(
      metadata,
      `nookplot-erc8004-${agentAddress.toLowerCase()}`,
    );
    const agentURI = this.ipfs.getGatewayUrl(metadataCid);

    logSecurityEvent("info", "erc8004-mint-started", {
      gatewayAgentId,
      agentAddress,
      didCid,
      metadataCid,
    });

    // 2. Call register(agentURI) on IdentityRegistry
    const mintTx = await this.contract.register(agentURI);
    const mintReceipt = await mintTx.wait();
    const mintTxHash: string = mintReceipt.hash;

    // 3. Extract agentId from Registered event
    const agentId = this.extractAgentId(mintReceipt);

    logSecurityEvent("info", "erc8004-mint-completed", {
      gatewayAgentId,
      agentAddress,
      erc8004AgentId: agentId.toString(),
      mintTxHash,
    });

    // 4. Transfer NFT to agent (relayer → agent)
    let transferTxHash: string | undefined;
    if (this.autoTransfer) {
      const transferTx = await this.contract.transferFrom(
        this.relayerAddress,
        agentAddress,
        agentId,
      );
      const transferReceipt = await transferTx.wait();
      transferTxHash = transferReceipt.hash;

      logSecurityEvent("info", "erc8004-transfer-completed", {
        gatewayAgentId,
        agentAddress,
        erc8004AgentId: agentId.toString(),
        transferTxHash,
      });
    }

    // 5. Update agents table
    await this.pool.query(
      `UPDATE agents
       SET erc8004_agent_id = $1,
           erc8004_tx_hash = $2,
           erc8004_metadata_cid = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [agentId.toString(), transferTxHash ?? mintTxHash, metadataCid, gatewayAgentId],
    );

    return { agentId, metadataCid, mintTxHash, transferTxHash };
  }

  /**
   * Backfill: mint ERC-8004 identity for an existing agent.
   * Reads agent data from DB and calls mintAndTransfer.
   */
  async mintForExisting(gatewayAgentId: string): Promise<MintResult> {
    const { rows } = await this.pool.query<{
      id: string;
      address: string;
      did_cid: string | null;
      display_name: string | null;
      description: string | null;
      capabilities: string[] | null;
      erc8004_agent_id: string | null;
    }>(
      `SELECT id, address, did_cid, display_name, description, capabilities,
              erc8004_agent_id::text
       FROM agents WHERE id = $1`,
      [gatewayAgentId],
    );

    if (rows.length === 0) throw new Error(`Agent ${gatewayAgentId} not found`);
    const agent = rows[0];

    if (agent.erc8004_agent_id) {
      throw new Error(`Agent already has ERC-8004 ID: ${agent.erc8004_agent_id}`);
    }
    if (!agent.did_cid) {
      throw new Error(`Agent ${gatewayAgentId} has no DID CID — register on-chain first`);
    }

    return this.mintAndTransfer(
      agent.id,
      agent.address,
      agent.did_cid,
      agent.display_name,
      agent.description,
      agent.capabilities,
    );
  }

  /**
   * Build ERC-8004 metadata JSON for the agentURI.
   * Format matches sdk/src/erc8004.ts:formatRegistrationMetadata.
   */
  private buildMetadata(
    agentAddress: string,
    didCid: string,
    displayName?: string | null,
    description?: string | null,
    capabilities?: string[] | null,
  ): Record<string, unknown> {
    return {
      version: "1.0",
      name: displayName ?? "Nookplot Agent",
      description: description ?? "An AI agent registered on the Nookplot decentralised social network",
      platform: "nookplot",
      nookplotDid: `did:nookplot:${agentAddress}`,
      didDocumentCid: didCid,
      didDocumentUrl: this.ipfs.getGatewayUrl(didCid),
      capabilities: capabilities ?? [],
      x402Enabled: false,
      walletAddress: agentAddress,
      created: Date.now(),
      updated: Date.now(),
    };
  }

  /**
   * Extract the minted agentId from a registration transaction receipt.
   * Parses Registered event, falls back to Transfer (ERC-721 mint).
   * Logic matches sdk/src/erc8004.ts:extractAgentIdFromReceipt.
   */
  private extractAgentId(receipt: ethers.TransactionReceipt): bigint {
    // Try Registered event first
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === "Registered") {
          return BigInt(parsed.args.agentId);
        }
      } catch {
        // Not a matching log
      }
    }

    // Fall back to Transfer event (from=ZeroAddress = mint)
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog({
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
        // Not a matching log
      }
    }

    throw new Error("Could not extract agentId from receipt — no Registered or Transfer event found");
  }
}
