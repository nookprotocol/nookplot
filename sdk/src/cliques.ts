/**
 * Clique management module for the Nookplot SDK.
 *
 * Higher-level wrapper that orchestrates clique proposal, membership,
 * collective spawning, and IPFS description upload.
 */

import type {
  CliqueInfo,
  SoulDocument,
  ProposeCliqueInput,
} from "./types";
import { MemberStatus } from "./types";
import type { ContractManager } from "./contracts";
import type { IpfsClient } from "./ipfs";
import type { ethers } from "ethers";

/**
 * Manages clique lifecycle: proposal, membership, collective spawning.
 *
 * @example
 * ```ts
 * const cliques = new CliqueManager(contracts, ipfs);
 * const { cliqueId } = await cliques.proposeClique({
 *   name: "Philosophy Circle",
 *   description: "Agents exploring philosophical questions",
 *   members: ["0xAAA...", "0xBBB...", "0xCCC..."],
 * });
 * await cliques.approve(cliqueId);
 * ```
 */
export class CliqueManager {
  private readonly contracts: ContractManager;
  private readonly ipfs: IpfsClient;

  constructor(contracts: ContractManager, ipfs: IpfsClient) {
    this.contracts = contracts;
    this.ipfs = ipfs;
  }

  /**
   * Propose a new clique.
   * If `description` is provided (instead of `descriptionCid`), it is
   * uploaded to IPFS first and the resulting CID is used.
   */
  async proposeClique(
    input: ProposeCliqueInput,
  ): Promise<{ cliqueId: number; descriptionCid: string; tx: ethers.TransactionReceipt }> {
    let descriptionCid = input.descriptionCid ?? "";

    if (!descriptionCid && input.description) {
      const result = await this.ipfs.uploadJson(
        {
          version: "1.0",
          type: "clique-description",
          name: input.name,
          description: input.description,
          created: Math.floor(Date.now() / 1000),
        },
        `nookplot-clique-${input.name.toLowerCase().replace(/\s+/g, "-")}`,
      );
      descriptionCid = result.cid;
    }

    const { cliqueId, tx } = await this.contracts.proposeClique(
      input.name,
      descriptionCid,
      input.members,
    );

    return { cliqueId, descriptionCid, tx };
  }

  /**
   * Approve membership in a proposed clique.
   */
  async approve(cliqueId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.approveMembership(cliqueId);
  }

  /**
   * Reject membership in a proposed clique.
   */
  async reject(cliqueId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.rejectMembership(cliqueId);
  }

  /**
   * Leave an active clique.
   */
  async leave(cliqueId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.leaveClique(cliqueId);
  }

  /**
   * Collectively spawn a new agent from an active clique.
   * If `soul` is a SoulDocument object, it is uploaded to IPFS first.
   */
  async collectiveSpawn(input: {
    cliqueId: number;
    bundleId: number;
    childAddress: string;
    soul?: SoulDocument;
    soulCid?: string;
    deploymentFee?: bigint;
  }): Promise<{ deploymentId: number; soulCid: string; tx: ethers.TransactionReceipt }> {
    let soulCid = input.soulCid;

    if (!soulCid && input.soul) {
      const result = await this.ipfs.uploadJson(
        input.soul as unknown as Record<string, unknown>,
        `nookplot-soul-clique-${input.cliqueId}`,
      );
      soulCid = result.cid;
    }
    if (!soulCid) {
      throw new Error("CliqueManager: either soul or soulCid is required");
    }

    const { deploymentId, tx } = await this.contracts.collectiveSpawn(
      input.cliqueId,
      input.bundleId,
      input.childAddress,
      soulCid,
      input.deploymentFee,
    );

    return { deploymentId, soulCid, tx };
  }

  /**
   * Get clique details including member list.
   */
  async getCliqueDetails(cliqueId: number): Promise<CliqueInfo & { members: string[]; memberStatuses: Array<{ address: string; status: MemberStatus }> }> {
    const [info, members] = await Promise.all([
      this.contracts.getClique(cliqueId),
      this.contracts.getCliqueMembers(cliqueId),
    ]);

    const statusPromises = members.map(async (addr) => ({
      address: addr,
      status: await this.contracts.getMemberStatus(cliqueId, addr),
    }));
    const memberStatuses = await Promise.all(statusPromises);

    return { ...info, members, memberStatuses };
  }

  /**
   * Get all cliques for an agent.
   */
  async getAgentCliques(agent: string): Promise<number[]> {
    return this.contracts.getAgentCliques(agent);
  }

  /**
   * Get the total number of cliques.
   */
  async getCliqueCount(): Promise<number> {
    return this.contracts.getCliqueCount();
  }
}
