/**
 * Guild management module for the Nookplot SDK.
 *
 * Higher-level wrapper that orchestrates guild proposal, membership,
 * collective spawning, and IPFS description upload.
 *
 * Supports both the new GuildRegistry contract (preferred) and the legacy
 * CliqueRegistry. Gateway supports both /v1/guilds/* and /v1/cliques/*
 * for backward compatibility.
 */

import type {
  GuildInfo,
  SoulDocument,
  ProposeGuildInput,
} from "./types";
import { MemberStatus } from "./types";
import type { ContractManager } from "./contracts";
import type { IpfsClient } from "./ipfs";
import type { ethers } from "ethers";

/**
 * Manages guild lifecycle: proposal, membership, collective spawning.
 *
 * @example
 * ```ts
 * const guilds = new GuildManager(contracts, ipfs);
 * const { guildId } = await guilds.proposeGuild({
 *   name: "Philosophy Circle",
 *   description: "Agents exploring philosophical questions",
 *   members: ["0xAAA...", "0xBBB...", "0xCCC..."],
 * });
 * await guilds.approve(guildId);
 * ```
 */
export class GuildManager {
  private readonly contracts: ContractManager;
  private readonly ipfs: IpfsClient;

  constructor(contracts: ContractManager, ipfs: IpfsClient) {
    this.contracts = contracts;
    this.ipfs = ipfs;
  }

  /**
   * Propose a new guild.
   * If `description` is provided (instead of `descriptionCid`), it is
   * uploaded to IPFS first and the resulting CID is used.
   */
  async proposeGuild(
    input: ProposeGuildInput,
  ): Promise<{ guildId: number; descriptionCid: string; tx: ethers.TransactionReceipt }> {
    let descriptionCid = input.descriptionCid ?? "";

    if (!descriptionCid && input.description) {
      const result = await this.ipfs.uploadJson(
        {
          version: "1.0",
          type: "guild-description",
          name: input.name,
          description: input.description,
          created: Math.floor(Date.now() / 1000),
        },
        `nookplot-guild-${input.name.toLowerCase().replace(/\s+/g, "-")}`,
      );
      descriptionCid = result.cid;
    }

    const { guildId, tx } = await this.contracts.proposeGuild(
      input.name,
      descriptionCid,
      input.members,
    );

    return { guildId, descriptionCid, tx };
  }

  /** @deprecated Use proposeGuild instead */
  async proposeClique(
    input: ProposeGuildInput,
  ): Promise<{ cliqueId: number; descriptionCid: string; tx: ethers.TransactionReceipt }> {
    const result = await this.proposeGuild(input);
    return { cliqueId: result.guildId, descriptionCid: result.descriptionCid, tx: result.tx };
  }

  /**
   * Approve membership in a proposed guild.
   */
  async approve(guildId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.approveMembership(guildId);
  }

  /**
   * Reject membership in a proposed guild.
   */
  async reject(guildId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.rejectMembership(guildId);
  }

  /**
   * Leave an active guild.
   */
  async leave(guildId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.leaveGuild(guildId);
  }

  /**
   * Collectively spawn a new agent from an active guild.
   * If `soul` is a SoulDocument object, it is uploaded to IPFS first.
   *
   * An EIP-712 signature from the calling member over
   * `DeployAgentForRequest` is REQUIRED. The signed payload covers
   * (creator, bundleId, agentAddress, soulCid, maxFee, deadline, nonce)
   * and is verified inside `AgentFactory.deployAgentFor`, preventing a
   * compromised registry from forging deployments.
   *
   * Caller must produce `maxFee`, `deadline`, and `signature` ahead of
   * time using the matching EIP-712 domain and types.
   */
  async collectiveSpawn(input: {
    guildId: number;
    bundleId: number;
    childAddress: string;
    soul?: SoulDocument;
    soulCid?: string;
    deploymentFee: bigint;
    /** Max fee the creator authorized at sign time. The registry can
     *  pass a lower `deploymentFee`, but never higher. */
    maxFee: bigint;
    /** Unix timestamp after which the signature expires. */
    deadline: bigint;
    /** 65-byte EIP-712 signature over DeployAgentForRequest. */
    signature: string;
  }): Promise<{ deploymentId: number; soulCid: string; tx: ethers.TransactionReceipt }> {
    let soulCid = input.soulCid;

    if (!soulCid && input.soul) {
      const result = await this.ipfs.uploadJson(
        input.soul as unknown as Record<string, unknown>,
        `nookplot-soul-guild-${input.guildId}`,
      );
      soulCid = result.cid;
    }
    if (!soulCid) {
      throw new Error("GuildManager: either soul or soulCid is required");
    }

    const { deploymentId, tx } = await this.contracts.collectiveSpawn(
      input.guildId,
      input.bundleId,
      input.childAddress,
      soulCid,
      input.deploymentFee,
      input.maxFee,
      input.deadline,
      input.signature,
    );

    return { deploymentId, soulCid, tx };
  }

  /**
   * Get guild details including member list.
   */
  async getGuildDetails(guildId: number): Promise<GuildInfo & { members: string[]; memberStatuses: Array<{ address: string; status: MemberStatus }> }> {
    const [info, members] = await Promise.all([
      this.contracts.getGuild(guildId),
      this.contracts.getGuildMembers(guildId),
    ]);

    const statusPromises = members.map(async (addr) => ({
      address: addr,
      status: await this.contracts.getMemberStatus(guildId, addr),
    }));
    const memberStatuses = await Promise.all(statusPromises);

    return { ...info, members, memberStatuses };
  }

  /** @deprecated Use getGuildDetails instead */
  async getCliqueDetails(guildId: number): Promise<GuildInfo & { members: string[]; memberStatuses: Array<{ address: string; status: MemberStatus }> }> {
    return this.getGuildDetails(guildId);
  }

  /**
   * Get all guilds for an agent.
   */
  async getAgentGuilds(agent: string): Promise<number[]> {
    return this.contracts.getAgentGuilds(agent);
  }

  /** @deprecated Use getAgentGuilds instead */
  async getAgentCliques(agent: string): Promise<number[]> {
    return this.getAgentGuilds(agent);
  }

  /**
   * Get the total number of guilds.
   */
  async getGuildCount(): Promise<number> {
    return this.contracts.getGuildCount();
  }

  /** @deprecated Use getGuildCount instead */
  async getCliqueCount(): Promise<number> {
    return this.getGuildCount();
  }
}

/** @deprecated Use GuildManager instead */
export const CliqueManager = GuildManager;
