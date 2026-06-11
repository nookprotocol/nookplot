/**
 * Fee Distribution management module for the Nookplot SDK.
 *
 * Wraps the FeeDistributor and RewardPool contracts with
 * higher-level methods for distributing fees and claiming rewards.
 */

import { ethers } from "ethers";
import type { FeeDistributionConfig, RewardClaimInfo } from "./types";
import { FEE_DISTRIBUTOR_ABI, REWARD_POOL_ABI } from "./abis";

// ============================================================
//                  ROLE CONSTANTS
// ============================================================

/** keccak256("OPERATOR_ROLE") — triggers distributions on FeeDistributor */
export const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

/** keccak256("GUARDIAN_ROLE") — pause-only role on FeeDistributor and RewardPool */
export const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

/** keccak256("ROOT_PUBLISHER_ROLE") — setMerkleRoot on RewardPool */
export const ROOT_PUBLISHER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ROOT_PUBLISHER_ROLE"));

/** DEFAULT_ADMIN_ROLE = bytes32(0) — admin on all contracts */
export const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

/**
 * Manages fee distribution and reward pool interactions.
 *
 * @example
 * ```ts
 * const fees = new FeeDistributionManager(provider, signer, {
 *   feeDistributor: "0x...",
 *   agentRewardPool: "0x...",
 *   citationPool: "0x...",
 * });
 *
 * // Distribute all accumulated fees
 * await fees.distributeAll();
 *
 * // Check claimable rewards
 * const info = await fees.getRewardClaimInfo(agentRewardPoolAddr, myAddress, cumulativeAmount);
 *
 * // Claim from a reward pool
 * await fees.claimReward(agentRewardPoolAddr, cumulativeAmount, merkleProof);
 * ```
 */
export class FeeDistributionManager {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly feeDistributor?: ethers.Contract;
  private readonly agentRewardPool?: ethers.Contract;
  private readonly citationPool?: ethers.Contract;

  constructor(
    provider: ethers.JsonRpcProvider,
    signer: ethers.Wallet,
    addresses: {
      feeDistributor?: string;
      agentRewardPool?: string;
      citationPool?: string;
    },
  ) {
    this.provider = provider;
    this.signer = signer;

    const connected = signer.connect(provider);

    if (addresses.feeDistributor) {
      this.feeDistributor = new ethers.Contract(
        addresses.feeDistributor,
        FEE_DISTRIBUTOR_ABI,
        connected,
      );
    }
    if (addresses.agentRewardPool) {
      this.agentRewardPool = new ethers.Contract(
        addresses.agentRewardPool,
        REWARD_POOL_ABI,
        connected,
      );
    }
    if (addresses.citationPool) {
      this.citationPool = new ethers.Contract(
        addresses.citationPool,
        REWARD_POOL_ABI,
        connected,
      );
    }
  }

  // ============================================================
  //                  FEE DISTRIBUTOR
  // ============================================================

  /**
   * Distribute a specific amount of wETH to configured destinations.
   */
  async distributeWeth(amount: bigint): Promise<ethers.TransactionReceipt> {
    this.requireDistributor();
    const tx = await this.feeDistributor!.distributeWeth(amount);
    return tx.wait();
  }

  /**
   * Distribute a specific amount of NOOK to configured destinations.
   */
  async distributeNook(amount: bigint): Promise<ethers.TransactionReceipt> {
    this.requireDistributor();
    const tx = await this.feeDistributor!.distributeNook(amount);
    return tx.wait();
  }

  /**
   * Distribute all wETH and NOOK held by the FeeDistributor.
   */
  async distributeAll(): Promise<ethers.TransactionReceipt> {
    this.requireDistributor();
    const tx = await this.feeDistributor!.distributeAll();
    return tx.wait();
  }

  /**
   * Get the full configuration of the FeeDistributor.
   */
  async getDistributorConfig(): Promise<FeeDistributionConfig> {
    this.requireDistributor();
    const d = this.feeDistributor!;
    const [
      wethAddress,
      nookAddress,
      rdWallet,
      buybackWallet,
      agentRewardPool,
      citationPool,
      ecosystemWallet,
      rdBps,
      buybackBps,
      agentRewardBps,
      citationBps,
      ecosystemBps,
      totalWethDistributed,
      totalNookDistributed,
    ] = await Promise.all([
      d.weth(),
      d.nook(),
      d.rdWallet(),
      d.buybackWallet(),
      d.agentRewardPool(),
      d.citationPool(),
      d.ecosystemWallet(),
      d.rdBps(),
      d.buybackBps(),
      d.agentRewardBps(),
      d.citationBps(),
      d.ecosystemBps(),
      d.totalWethDistributed(),
      d.totalNookDistributed(),
    ]);

    return {
      wethAddress,
      nookAddress,
      rdWallet,
      buybackWallet,
      agentRewardPool,
      citationPool,
      ecosystemWallet,
      rdBps: Number(rdBps),
      buybackBps: Number(buybackBps),
      agentRewardBps: Number(agentRewardBps),
      citationBps: Number(citationBps),
      ecosystemBps: Number(ecosystemBps),
      totalWethDistributed,
      totalNookDistributed,
    };
  }

  /**
   * Get the FeeDistributor's current wETH balance.
   */
  async getWethBalance(): Promise<bigint> {
    this.requireDistributor();
    return this.feeDistributor!.wethBalance();
  }

  /**
   * Get the FeeDistributor's current NOOK balance.
   */
  async getNookBalance(): Promise<bigint> {
    this.requireDistributor();
    return this.feeDistributor!.nookBalance();
  }

  // ============================================================
  //                  REWARD POOLS
  // ============================================================

  /**
   * Claim rewards from the agent reward pool (wETH).
   */
  async claimAgentReward(
    cumulativeAmount: bigint,
    proof: string[],
  ): Promise<ethers.TransactionReceipt> {
    this.requireAgentPool();
    const tx = await this.agentRewardPool!.claim(cumulativeAmount, proof);
    return tx.wait();
  }

  /**
   * Claim rewards from the citation pool (NOOK).
   */
  async claimCitationReward(
    cumulativeAmount: bigint,
    proof: string[],
  ): Promise<ethers.TransactionReceipt> {
    this.requireCitationPool();
    const tx = await this.citationPool!.claim(cumulativeAmount, proof);
    return tx.wait();
  }

  /**
   * Get claim info for the agent reward pool.
   */
  async getAgentRewardInfo(
    account: string,
    cumulativeEntitlement: bigint,
  ): Promise<RewardClaimInfo> {
    this.requireAgentPool();
    return this.getPoolInfo(this.agentRewardPool!, account, cumulativeEntitlement);
  }

  /**
   * Get claim info for the citation pool.
   */
  async getCitationRewardInfo(
    account: string,
    cumulativeEntitlement: bigint,
  ): Promise<RewardClaimInfo> {
    this.requireCitationPool();
    return this.getPoolInfo(this.citationPool!, account, cumulativeEntitlement);
  }

  // ============================================================
  //                  ROLE MANAGEMENT
  // ============================================================

  /**
   * Check if an account has a specific role on the FeeDistributor.
   * @param role Role hash (use exported constants like OPERATOR_ROLE)
   * @param account Account address to check
   */
  async hasDistributorRole(role: string, account: string): Promise<boolean> {
    this.requireDistributor();
    return this.feeDistributor!.hasRole(role, account);
  }

  /**
   * Grant a role on the FeeDistributor. Caller must have DEFAULT_ADMIN_ROLE.
   * @param role Role hash (use exported constants like OPERATOR_ROLE)
   * @param account Account address to grant the role to
   */
  async grantDistributorRole(role: string, account: string): Promise<ethers.TransactionReceipt> {
    this.requireDistributor();
    const tx = await this.feeDistributor!.grantRole(role, account);
    return tx.wait();
  }

  /**
   * Check if an account has a specific role on a reward pool.
   * @param pool "agent" or "citation"
   * @param role Role hash
   * @param account Account address
   */
  async hasPoolRole(pool: "agent" | "citation", role: string, account: string): Promise<boolean> {
    const contract = pool === "agent" ? this.agentRewardPool : this.citationPool;
    if (!contract) {
      throw new Error(`FeeDistributionManager: ${pool}Pool address not configured`);
    }
    return contract.hasRole(role, account);
  }

  /**
   * Grant a role on a reward pool. Caller must have DEFAULT_ADMIN_ROLE.
   * @param pool "agent" or "citation"
   * @param role Role hash
   * @param account Account address
   */
  async grantPoolRole(pool: "agent" | "citation", role: string, account: string): Promise<ethers.TransactionReceipt> {
    const contract = pool === "agent" ? this.agentRewardPool : this.citationPool;
    if (!contract) {
      throw new Error(`FeeDistributionManager: ${pool}Pool address not configured`);
    }
    const tx = await contract.grantRole(role, account);
    return tx.wait();
  }

  // ============================================================
  //                  PRIVATE HELPERS
  // ============================================================

  private async getPoolInfo(
    pool: ethers.Contract,
    account: string,
    cumulativeEntitlement: bigint,
  ): Promise<RewardClaimInfo> {
    const [alreadyClaimed, claimableAmount, poolBalance, claimable, epoch, merkleRoot] =
      await Promise.all([
        pool.cumulativeClaimed(account),
        pool.getClaimableAmount(account, cumulativeEntitlement),
        pool.poolBalance(),
        pool.claimable(),
        pool.epoch(),
        pool.merkleRoot(),
      ]);

    return {
      account,
      cumulativeEntitlement,
      alreadyClaimed,
      claimableAmount,
      poolBalance,
      claimable,
      epoch: Number(epoch),
      merkleRoot,
    };
  }

  private requireDistributor(): void {
    if (!this.feeDistributor) {
      throw new Error(
        "FeeDistributionManager: feeDistributor address not configured",
      );
    }
  }

  private requireAgentPool(): void {
    if (!this.agentRewardPool) {
      throw new Error(
        "FeeDistributionManager: agentRewardPool address not configured",
      );
    }
  }

  private requireCitationPool(): void {
    if (!this.citationPool) {
      throw new Error(
        "FeeDistributionManager: citationPool address not configured",
      );
    }
  }
}
