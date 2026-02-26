/**
 * Project management module for the Nookplot SDK.
 *
 * Handles creating, updating, and managing collaborative coding projects.
 * Project metadata is stored on IPFS and referenced on-chain via the
 * ProjectRegistry contract. GitHub integration is handled at the gateway
 * layer — this module covers IPFS + on-chain operations.
 */

import { ethers } from "ethers";
import type {
  ProjectDocument,
  CreateProjectInput,
  ProjectInfo,
  VersionSnapshotResult,
} from "./types";
import { SDK_VERSION } from "./types";
import { IpfsClient } from "./ipfs";
import { ContractManager } from "./contracts";

// ============================================================
//                     PROJECT MANAGER
// ============================================================

/**
 * Manages the lifecycle of collaborative coding projects on Nookplot.
 *
 * Projects link to GitHub repos and track collaborators and version
 * snapshots on-chain. Metadata is stored on IPFS.
 *
 * @example
 * ```ts
 * const projects = new ProjectManager(ipfsClient, contractManager);
 * const result = await projects.createProject(wallet, {
 *   projectId: "my-agent-sdk",
 *   name: "My Agent SDK",
 *   description: "A TypeScript SDK for AI agents",
 *   repoUrl: "https://github.com/owner/repo",
 *   languages: ["TypeScript"],
 *   tags: ["sdk", "ai-agent"],
 * });
 * console.log(`Project created: ${result.cid}`);
 * ```
 */
export class ProjectManager {
  private readonly ipfsClient: IpfsClient;
  private readonly contracts: ContractManager;

  constructor(ipfsClient: IpfsClient, contracts: ContractManager) {
    if (!ipfsClient) {
      throw new Error("ProjectManager: ipfsClient is required");
    }
    if (!contracts) {
      throw new Error("ProjectManager: contracts is required");
    }
    this.ipfsClient = ipfsClient;
    this.contracts = contracts;
  }

  // ------------------------------------------------------------------
  //  Create Project
  // ------------------------------------------------------------------

  /**
   * Create a new project: build metadata document, sign it, upload to IPFS,
   * and record on-chain.
   *
   * @param wallet - The ethers.Wallet of the project creator.
   * @param input - Project creation input.
   * @returns The project document, IPFS CID, and transaction receipt.
   */
  async createProject(
    wallet: ethers.Wallet,
    input: CreateProjectInput,
  ): Promise<{
    document: ProjectDocument;
    cid: string;
    receipt: ethers.TransactionReceipt;
  }> {
    const now = Math.floor(Date.now() / 1000);

    // Build the project document
    const doc: ProjectDocument = {
      version: "1.0.0",
      type: "project",
      name: input.name,
      description: input.description,
      creator: wallet.address,
      created: now,
      updated: now,
      signature: { signer: "", hash: "", value: "" }, // placeholder
    };

    if (input.repoUrl) doc.repoUrl = input.repoUrl;
    if (input.defaultBranch) doc.defaultBranch = input.defaultBranch;
    if (input.languages && input.languages.length > 0) doc.languages = input.languages;
    if (input.tags && input.tags.length > 0) doc.tags = input.tags;
    if (input.license) doc.license = input.license;

    doc.metadata = { clientVersion: SDK_VERSION };

    // Sign the project content with EIP-712
    const { hash, signature } = await this._signProject(wallet, doc);
    doc.signature = {
      signer: wallet.address,
      hash,
      value: signature,
    };

    // Upload to IPFS
    const uploadResult = await this.ipfsClient.uploadJson(
      doc as unknown as Record<string, unknown>,
      `nookplot-project-${input.projectId}`,
    );

    // Record on-chain
    const receipt = await this.contracts.createProject(input.projectId, uploadResult.cid);

    return { document: doc, cid: uploadResult.cid, receipt };
  }

  // ------------------------------------------------------------------
  //  Update Project
  // ------------------------------------------------------------------

  /**
   * Update a project's metadata: upload new doc to IPFS and update on-chain.
   *
   * @param wallet - The ethers.Wallet of the updater (must be creator or Admin).
   * @param projectId - On-chain project ID.
   * @param updates - Partial project fields to update.
   * @param previousCid - CID of the current metadata (for version linking).
   * @returns The updated document, new CID, and transaction receipt.
   */
  async updateProject(
    wallet: ethers.Wallet,
    projectId: string,
    updates: Partial<Pick<ProjectDocument, "name" | "description" | "repoUrl" | "defaultBranch" | "languages" | "tags" | "license">>,
    previousCid?: string,
  ): Promise<{
    document: ProjectDocument;
    cid: string;
    receipt: ethers.TransactionReceipt;
  }> {
    // Fetch current on-chain info to get existing metadata CID
    const info = await this.contracts.getProject(projectId);

    // Fetch existing document from IPFS
    let existingDoc: ProjectDocument;
    try {
      existingDoc = await this.ipfsClient.fetchJson<ProjectDocument>(info.metadataCid);
    } catch {
      throw new Error(
        `Failed to fetch existing project metadata from IPFS (CID: ${info.metadataCid})`,
      );
    }

    // Merge updates
    const now = Math.floor(Date.now() / 1000);
    const doc: ProjectDocument = {
      ...existingDoc,
      ...updates,
      updated: now,
      signature: { signer: "", hash: "", value: "" }, // re-sign
      metadata: {
        clientVersion: SDK_VERSION,
        previousVersionCid: previousCid || info.metadataCid,
      },
    };

    // Re-sign
    const { hash, signature } = await this._signProject(wallet, doc);
    doc.signature = { signer: wallet.address, hash, value: signature };

    // Upload to IPFS
    const uploadResult = await this.ipfsClient.uploadJson(
      doc as unknown as Record<string, unknown>,
      `nookplot-project-${projectId}-update`,
    );

    // Update on-chain
    const receipt = await this.contracts.updateProjectMetadata(projectId, uploadResult.cid);

    return { document: doc, cid: uploadResult.cid, receipt };
  }

  // ------------------------------------------------------------------
  //  Collaborator Management (delegate to contracts)
  // ------------------------------------------------------------------

  /**
   * Add a collaborator to a project.
   */
  async addCollaborator(
    projectId: string,
    collaborator: string,
    role: number,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.addProjectCollaborator(projectId, collaborator, role);
  }

  /**
   * Remove a collaborator from a project.
   */
  async removeCollaborator(
    projectId: string,
    collaborator: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.removeProjectCollaborator(projectId, collaborator);
  }

  // ------------------------------------------------------------------
  //  Version Snapshots
  // ------------------------------------------------------------------

  /**
   * Record a version snapshot for a project on-chain.
   *
   * @param projectId - On-chain project ID.
   * @param commitHash - Git commit hash (40 hex characters).
   * @param metadataCid - Optional IPFS CID of version-specific metadata.
   * @returns Version snapshot result with version number from on-chain.
   */
  async snapshotVersion(
    projectId: string,
    commitHash: string,
    metadataCid: string = "",
  ): Promise<VersionSnapshotResult> {
    const receipt = await this.contracts.snapshotVersion(projectId, commitHash, metadataCid);

    // Read the updated version count from the contract
    const info = await this.contracts.getProject(projectId);

    return {
      projectId,
      versionNumber: info.versionCount,
      commitHash,
      metadataCid,
      receipt,
    };
  }

  // ------------------------------------------------------------------
  //  Deactivation
  // ------------------------------------------------------------------

  /**
   * Deactivate a project (creator only).
   */
  async deactivateProject(projectId: string): Promise<ethers.TransactionReceipt> {
    return this.contracts.deactivateProject(projectId);
  }

  // ------------------------------------------------------------------
  //  Read Operations
  // ------------------------------------------------------------------

  /**
   * Get on-chain project info.
   */
  async getProject(projectId: string): Promise<ProjectInfo> {
    return this.contracts.getProject(projectId);
  }

  /**
   * Check if an address is a collaborator on a project.
   */
  async isCollaborator(projectId: string, address: string): Promise<boolean> {
    return this.contracts.isProjectCollaborator(projectId, address);
  }

  /**
   * Get a collaborator's role on a project.
   *
   * @returns 0=None, 1=Viewer, 2=Contributor, 3=Admin.
   */
  async getCollaboratorRole(projectId: string, address: string): Promise<number> {
    return this.contracts.getProjectCollaboratorRole(projectId, address);
  }

  // ------------------------------------------------------------------
  //  Internal: EIP-712 Signing
  // ------------------------------------------------------------------

  /**
   * Sign project content using EIP-712 typed data.
   */
  private async _signProject(
    wallet: ethers.Wallet,
    doc: ProjectDocument,
  ): Promise<{ hash: string; signature: string }> {
    const domain = {
      name: "Nookplot",
      version: "1",
    };

    const types = {
      Project: [
        { name: "name", type: "string" },
        { name: "description", type: "string" },
        { name: "creator", type: "address" },
        { name: "created", type: "uint256" },
        { name: "updated", type: "uint256" },
      ],
    };

    const value = {
      name: doc.name,
      description: doc.description,
      creator: doc.creator,
      created: doc.created,
      updated: doc.updated,
    };

    const signature = await wallet.signTypedData(domain, types, value);
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);

    return { hash, signature };
  }
}
