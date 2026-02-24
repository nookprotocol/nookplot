/**
 * Gas management for the Agent Gateway.
 *
 * A hot wallet (funded by the operator) transfers micro-ETH to agent
 * wallets before transactions. This enables gasless agent onboarding —
 * agents never need to acquire ETH themselves.
 *
 * Future: Replace with Coinbase Paymaster or ERC-2771 meta-transactions.
 *
 * @module gasManager
 */

import { ethers } from "ethers";
import type pg from "pg";
import { logSecurityEvent } from "./middleware/auditLog.js";

export interface GasManagerConfig {
  /** Daily gas spending limit per agent in ETH. */
  dailyLimitEth: number;
  /** Minimum hot wallet balance in ETH before refusing to fund. */
  minReserveEth: number;
  /** Amount of ETH to send per funding round. */
  fundingAmountEth: number;
  /** When true, agents don't need gas — meta-transactions handle everything. */
  metatxEnabled?: boolean;
}

export class GasManager {
  private readonly funderWallet: ethers.Wallet;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly pool: pg.Pool;
  private readonly config: GasManagerConfig;

  constructor(
    funderPrivateKey: string,
    provider: ethers.JsonRpcProvider,
    pool: pg.Pool,
    config: GasManagerConfig,
  ) {
    this.funderWallet = new ethers.Wallet(funderPrivateKey, provider);
    this.provider = provider;
    this.pool = pool;
    this.config = config;
  }

  /** Get the hot wallet's current balance. */
  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.funderWallet.address);
  }

  /** Get the hot wallet address. */
  get address(): string {
    return this.funderWallet.address;
  }

  /**
   * Ensure an agent wallet has enough gas for a transaction.
   *
   * Checks the agent's wallet balance. If it's too low, transfers a small
   * batch of ETH from the hot wallet. Enforces daily spending limits.
   *
   * @param agentAddress - The agent's Ethereum address.
   * @param agentId - The agent's database UUID (for gas ledger tracking).
   * @returns True if the agent has enough gas, false if funding failed.
   */
  async ensureGas(agentAddress: string, agentId: string): Promise<boolean> {
    // In meta-transaction mode, agents don't need ETH — the forwarder pays gas
    if (this.config.metatxEnabled) {
      logSecurityEvent("debug", "gas-skipped-metatx", {
        agentId,
        agentAddress,
        reason: "Meta-transaction mode active — forwarder pays gas",
      });
      return true;
    }

    const agentBalance = await this.provider.getBalance(agentAddress);
    const minRequired = ethers.parseEther("0.0001"); // ~1-2 transactions

    if (agentBalance >= minRequired) {
      return true; // Already has enough
    }

    // Check daily spending limit
    const dailySpent = await this.getDailySpending(agentId);
    const dailyLimitWei = ethers.parseEther(this.config.dailyLimitEth.toString());

    if (dailySpent >= dailyLimitWei) {
      logSecurityEvent("warn", "gas-daily-limit-reached", {
        agentId,
        agentAddress,
        dailySpentWei: dailySpent.toString(),
        dailyLimitWei: dailyLimitWei.toString(),
      });
      return false;
    }

    // Check hot wallet reserve
    const hotBalance = await this.getBalance();
    const minReserve = ethers.parseEther(this.config.minReserveEth.toString());

    if (hotBalance < minReserve) {
      logSecurityEvent("error", "gas-hot-wallet-low", {
        hotBalance: ethers.formatEther(hotBalance),
        minReserve: ethers.formatEther(minReserve),
        funderAddress: this.funderWallet.address,
      });
      return false;
    }

    // Fund the agent
    const fundingAmount = ethers.parseEther(this.config.fundingAmountEth.toString());

    try {
      const tx = await this.funderWallet.sendTransaction({
        to: agentAddress,
        value: fundingAmount,
      });
      const receipt = await tx.wait();

      if (receipt) {
        // Record in gas ledger
        await this.recordGasTransfer(
          agentId,
          receipt.hash,
          Number(receipt.gasUsed),
          receipt.gasPrice?.toString() ?? "0",
          fundingAmount.toString(),
          "fund",
        );

        logSecurityEvent("info", "gas-funded", {
          agentId,
          agentAddress,
          amount: ethers.formatEther(fundingAmount),
          txHash: receipt.hash,
        });
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "gas-funding-failed", {
        agentId,
        agentAddress,
        error: message,
      });
      return false;
    }
  }

  /**
   * Record a gas expenditure in the gas ledger.
   */
  async recordGasTransfer(
    agentId: string,
    txHash: string,
    gasUsed: number,
    gasPriceWei: string,
    ethCostWei: string,
    operation: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO gas_ledger (agent_id, tx_hash, gas_used, gas_price_wei, eth_cost_wei, operation)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, txHash, gasUsed, gasPriceWei, ethCostWei, operation],
    );
  }

  /**
   * Get total gas spending for an agent in the last 24 hours.
   */
  private async getDailySpending(agentId: string): Promise<bigint> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(eth_cost_wei::numeric), 0)::text AS total
       FROM gas_ledger
       WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    );
    return BigInt(rows[0]?.total ?? "0");
  }
}
