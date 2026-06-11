/**
 * Knowledge Bundle management module for the Nookplot SDK.
 *
 * Higher-level module that wraps ContractManager bundle methods with
 * input validation, IPFS description upload, and typed return values.
 */

import type {
  CreateBundleInput,
  BundleInfo,
  ContributorWeight,
} from "./types";
import type { ContractManager } from "./contracts";
import type { IpfsClient } from "./ipfs";
import type { ethers } from "ethers";

/**
 * Manages the lifecycle of knowledge bundles on the Nookplot network.
 *
 * Provides methods for creating bundles, managing content CIDs,
 * and updating contributor weights.
 *
 * @example
 * ```ts
 * const bundles = new BundleManager(contracts, ipfs);
 * const { bundleId, tx } = await bundles.createBundle({
 *   name: "AI Philosophy Collection",
 *   contentCids: ["QmCid1...", "QmCid2..."],
 *   contributors: [
 *     { contributor: "0x...", weightBps: 6000 },
 *     { contributor: "0x...", weightBps: 4000 },
 *   ],
 * });
 * ```
 */
export class BundleManager {
  private readonly contracts: ContractManager;
  private readonly ipfs: IpfsClient;

  constructor(contracts: ContractManager, ipfs: IpfsClient) {
    this.contracts = contracts;
    this.ipfs = ipfs;
  }

  /**
   * Create a knowledge bundle.
   *
   * If `descriptionCid` is not provided but a `description` text is given
   * in the input, it will be uploaded to IPFS first.
   *
   * @param input Bundle creation input
   * @returns The bundle ID and transaction receipt
   */
  async createBundle(
    input: CreateBundleInput & { description?: string },
  ): Promise<{ bundleId: number; tx: ethers.TransactionReceipt }> {
    // Validate
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("BundleManager: name is required");
    }
    if (!input.contentCids || input.contentCids.length === 0) {
      throw new Error("BundleManager: at least one content CID is required");
    }
    if (input.contentCids.length > 50) {
      throw new Error("BundleManager: maximum 50 CIDs per createBundle call");
    }
    this.validateWeights(input.contributors);

    // Upload description to IPFS if provided as text
    let descCid = input.descriptionCid ?? "";
    if (!descCid && input.description) {
      const result = await this.ipfs.uploadJson({
        version: "1.0",
        type: "bundle-description",
        text: input.description,
      } as unknown as Record<string, unknown>);
      descCid = result.cid;
    }

    return this.contracts.createBundle(
      input.name,
      descCid,
      input.contentCids,
      input.contributors,
    );
  }

  /**
   * Get a bundle by ID.
   */
  async getBundle(bundleId: number): Promise<BundleInfo> {
    return this.contracts.getBundle(bundleId);
  }

  /**
   * Get total bundle count.
   */
  async getBundleCount(): Promise<number> {
    return this.contracts.getBundleCount();
  }

  /**
   * Add content to a bundle.
   */
  async addContent(bundleId: number, cids: string[]): Promise<ethers.TransactionReceipt> {
    if (!cids || cids.length === 0) {
      throw new Error("BundleManager: at least one CID is required");
    }
    if (cids.length > 50) {
      throw new Error("BundleManager: maximum 50 CIDs per addContent call");
    }
    return this.contracts.addBundleContent(bundleId, cids);
  }

  /**
   * Remove content from a bundle.
   */
  async removeContent(bundleId: number, cids: string[]): Promise<ethers.TransactionReceipt> {
    if (!cids || cids.length === 0) {
      throw new Error("BundleManager: at least one CID is required");
    }
    return this.contracts.removeBundleContent(bundleId, cids);
  }

  /**
   * Update contributor weights.
   */
  async setContributorWeights(
    bundleId: number,
    contributors: ContributorWeight[],
  ): Promise<ethers.TransactionReceipt> {
    this.validateWeights(contributors);
    return this.contracts.setBundleContributorWeights(bundleId, contributors);
  }

  /**
   * Deactivate a bundle.
   */
  async deactivateBundle(bundleId: number): Promise<ethers.TransactionReceipt> {
    return this.contracts.deactivateBundle(bundleId);
  }

  /**
   * Validate contributor weights sum to 10000.
   */
  private validateWeights(contributors: ContributorWeight[]): void {
    if (!contributors || contributors.length === 0) {
      throw new Error("BundleManager: at least one contributor is required");
    }
    const total = contributors.reduce((sum, c) => sum + c.weightBps, 0);
    if (total !== 10000) {
      throw new Error(
        `BundleManager: contributor weights must sum to 10000 (got ${total})`,
      );
    }
  }
}
