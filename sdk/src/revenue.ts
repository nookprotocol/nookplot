/**
 * Revenue Router management module for the Nookplot SDK.
 *
 * Higher-level wrapper that orchestrates revenue distribution,
 * receipt chain queries, and earnings management.
 */

import type {
  RevenueShareConfig,
  RevenueEventInfo,
  ReceiptChainInfo,
  SetRevenueShareInput,
} from "./types";
import type { ContractManager } from "./contracts";
import type { ethers } from "ethers";

/**
 * Manages revenue distribution, receipt chain queries, and earnings claims.
 *
 * @example
 * ```ts
 * const revenue = new RevenueManager(contracts);
 * await revenue.configureShares({
 *   agent: "0x...",
 *   ownerBps: 5000,
 *   receiptChainBps: 4000,
 *   treasuryBps: 1000,
 *   bundleId: 0,
 * });
 * await revenue.distribute("0x...", "bounty", "0.1");
 * await revenue.claim();
 * ```
 */
export class RevenueManager {
  private readonly contracts: ContractManager;

  constructor(contracts: ContractManager) {
    this.contracts = contracts;
  }

  /**
   * Set revenue share configuration for an agent.
   */
  async configureShares(input: SetRevenueShareInput): Promise<ethers.TransactionReceipt> {
    return this.contracts.setRevenueShare(
      input.agent,
      input.ownerBps,
      input.receiptChainBps,
      input.treasuryBps,
      input.bundleId,
    );
  }

  /**
   * Distribute ETH revenue for an agent.
   */
  async distribute(
    agent: string,
    source: string,
    amountEth?: string,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.distributeRevenue(agent, source, amountEth ? { valueEth: amountEth } : undefined);
  }

  /**
   * Distribute token revenue for an agent.
   */
  async distributeToken(
    agent: string,
    source: string,
    amount: bigint,
  ): Promise<ethers.TransactionReceipt> {
    return this.contracts.distributeRevenueToken(agent, source, amount);
  }

  /**
   * Claim accumulated token earnings.
   */
  async claim(): Promise<ethers.TransactionReceipt> {
    return this.contracts.claimEarnings();
  }

  /**
   * Claim accumulated ETH earnings.
   */
  async claimEth(): Promise<ethers.TransactionReceipt> {
    return this.contracts.claimEthEarnings();
  }

  /**
   * Get the full receipt chain data for an agent: chain, config, and totals.
   */
  async getReceiptChainData(agent: string): Promise<ReceiptChainInfo> {
    const [chain, config, totalDistributed] = await Promise.all([
      this.contracts.getReceiptChain(agent),
      this.contracts.getRevenueShareConfig(agent),
      this.contracts.getAgentTotalDistributed(agent),
    ]);

    return { agent, chain, config, totalDistributed };
  }

  /**
   * Get earnings summary for an address: claimable + claimed.
   */
  async getEarningsSummary(address: string): Promise<{
    claimableTokens: bigint;
    claimableEth: bigint;
    totalClaimed: bigint;
  }> {
    const [claimableTokens, claimableEth, totalClaimed] = await Promise.all([
      this.contracts.getClaimableBalance(address),
      this.contracts.getClaimableEthBalance(address),
      this.contracts.getAddressTotalClaimed(address),
    ]);

    return { claimableTokens, claimableEth, totalClaimed };
  }

  /**
   * Get revenue share config for an agent.
   */
  async getConfig(agent: string): Promise<RevenueShareConfig> {
    return this.contracts.getRevenueShareConfig(agent);
  }

  /**
   * Get revenue event by ID.
   */
  async getEvent(eventId: number): Promise<RevenueEventInfo> {
    return this.contracts.getRevenueEvent(eventId);
  }

  /**
   * Get revenue history event IDs for an agent.
   */
  async getHistory(agent: string): Promise<number[]> {
    return this.contracts.getRevenueHistory(agent);
  }
}
