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

export interface ImportResult {
  agentId: bigint;
  imported: true;
  metadataCid: string | null;
}

interface IpfsUploader {
  uploadJson(data: Record<string, unknown>, name?: string): Promise<{ cid: string }>;
  getGatewayUrl(cid: string): string;
}

export class ERC8004MintService {
  private readonly pool: Pool;
  private readonly ipfs: IpfsUploader;
  private readonly contract: ethers.Contract;
  private readonly provider: ethers.JsonRpcProvider;
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
    this.provider = provider;
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
           erc8004_source = 'minted',
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
   * Check if an address already owns an ERC-8004 identity on-chain and link it
   * in the gateway DB without minting a new one.
   *
   * Flow: check DB → balanceOf → scan Transfer events → optionally read tokenURI → update DB.
   * Returns the import result if an existing identity was found, or null if no on-chain 8004 exists.
   * Idempotent: returns early if agent already has an erc8004_agent_id.
   */
  async importExisting(
    gatewayAgentId: string,
    agentAddress: string,
  ): Promise<ImportResult | null> {
    // 1. Check gateway DB — already has erc8004_agent_id? Return early.
    const { rows: existing } = await this.pool.query<{
      erc8004_agent_id: string | null;
    }>(
      `SELECT erc8004_agent_id::text FROM agents WHERE id = $1`,
      [gatewayAgentId],
    );
    if (existing.length > 0 && existing[0].erc8004_agent_id) {
      return {
        agentId: BigInt(existing[0].erc8004_agent_id),
        imported: true,
        metadataCid: null,
      };
    }

    // 2. Check on-chain balance (read-only, no gas)
    const balance = await this.contract.balanceOf(agentAddress);
    if (BigInt(balance) === 0n) {
      return null; // No existing ERC-8004 identity
    }

    // 3. Scan Transfer events to find the token ID (same approach as SDK's getERC8004Id)
    const filter = this.contract.filters.Transfer(
      ethers.ZeroAddress,
      agentAddress,
    );
    const currentBlock = await this.provider.getBlockNumber();
    const MAX_RANGE = 9_999;
    const MAX_SCAN_CHUNKS = 50;
    let agentId: bigint | null = null;

    for (let i = 0; i < MAX_SCAN_CHUNKS; i++) {
      const to = currentBlock - i * MAX_RANGE;
      if (to < 0) break;
      const from = Math.max(0, to - MAX_RANGE + 1);

      try {
        const chunk = await this.contract.queryFilter(filter, from, to);
        if (chunk.length > 0) {
          const lastEvent = chunk[chunk.length - 1];
          if ("args" in lastEvent && lastEvent.args) {
            agentId = BigInt(lastEvent.args.tokenId);
            break;
          }
        }
      } catch {
        // Skip failed chunks
      }

      if (from === 0) break;
    }

    if (agentId === null) {
      return null; // Balance > 0 but couldn't find mint event — skip import
    }

    // 4. Optionally read existing metadata CID from tokenURI
    let metadataCid: string | null = null;
    try {
      const tokenURI: string = await this.contract.tokenURI(agentId);
      // tokenURI is typically an IPFS gateway URL like https://gateway.pinata.cloud/ipfs/Qm...
      // Extract the CID from the end of the URL
      const cidMatch = tokenURI.match(/\/ipfs\/([a-zA-Z0-9]+)$/);
      if (cidMatch) {
        metadataCid = cidMatch[1];
      }
    } catch {
      // tokenURI read failed — non-fatal, proceed without metadata CID
    }

    // 5. Store in gateway DB
    await this.pool.query(
      `UPDATE agents
       SET erc8004_agent_id = $1,
           erc8004_source = 'imported',
           erc8004_metadata_cid = COALESCE($2, erc8004_metadata_cid),
           updated_at = NOW()
       WHERE id = $3`,
      [agentId.toString(), metadataCid, gatewayAgentId],
    );

    logSecurityEvent("info", "erc8004-import-existing", {
      gatewayAgentId,
      agentAddress,
      erc8004AgentId: agentId.toString(),
      metadataCid,
    });

    return { agentId, imported: true, metadataCid };
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
