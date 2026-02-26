/**
 * Watches the CreditPurchase contract for CreditsPurchased events.
 *
 * Polls the chain every N seconds, credits agent accounts, and sets
 * has_purchased = true to unlock tier 2 relay caps. Deduplicates via
 * tx_hash UNIQUE constraint. Tracks lastProcessedBlock in watcher_state
 * table for restart resilience.
 *
 * @module services/purchaseWatcher
 */

import { ethers } from "ethers";
import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// Minimal ABI for the CreditsPurchased event
const CREDIT_PURCHASE_ABI = [
  "event CreditsPurchased(address indexed buyer, uint256 indexed packId, uint256 creditAmount, uint256 pricePaid, bool isNook, uint256 timestamp)",
  "function getPackCount() view returns (uint256)",
];

const STATE_KEY = "credit_purchase_last_block";

export interface PurchaseWatcherConfig {
  contractAddress: string;
  rpcUrl: string;
  pollIntervalMs: number;
}

export class PurchaseWatcher {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly config: PurchaseWatcherConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly contract: ethers.Contract;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(pool: pg.Pool, creditManager: CreditManager, config: PurchaseWatcherConfig) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.contract = new ethers.Contract(config.contractAddress, CREDIT_PURCHASE_ABI, this.provider);
  }

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        logSecurityEvent("error", "purchase-watcher-poll-error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollIntervalMs);

    logSecurityEvent("info", "purchase-watcher-started", {
      contract: this.config.contractAddress,
      pollMs: this.config.pollIntervalMs,
    });
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Poll for new CreditsPurchased events since last processed block.
   */
  private async poll(): Promise<void> {
    if (this.processing) return; // Skip if previous poll is still running
    this.processing = true;

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const lastBlock = await this.getLastProcessedBlock();

      // First run: start from current block (don't process historical)
      if (lastBlock === 0) {
        await this.setLastProcessedBlock(currentBlock);
        return;
      }

      // Nothing new
      if (currentBlock <= lastBlock) return;

      // Base Sepolia limits eth_getLogs to 10k blocks
      const fromBlock = lastBlock + 1;
      const toBlock = Math.min(currentBlock, fromBlock + 9999);

      const filter = this.contract.filters.CreditsPurchased();
      const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

      for (const event of events) {
        const log = event as ethers.EventLog;
        await this.processEvent(log);
      }

      await this.setLastProcessedBlock(toBlock);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single CreditsPurchased event.
   */
  private async processEvent(event: ethers.EventLog): Promise<void> {
    const buyer = event.args[0] as string;
    const packId = Number(event.args[1]);
    const creditAmount = Number(event.args[2]);
    const pricePaid = (event.args[3] as bigint).toString();
    const isNook = event.args[4] as boolean;
    const txHash = event.transactionHash;
    const blockNumber = event.blockNumber;

    // Look up agent by address
    const { rows: agentRows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE LOWER(address) = LOWER($1) AND status = 'active'`,
      [buyer],
    );

    const agentId = agentRows[0]?.id ?? null;

    // Insert purchase record (deduplicates via tx_hash UNIQUE)
    try {
      await this.pool.query(
        `INSERT INTO credit_purchases (agent_id, buyer_address, tx_hash, pack_id, credit_amount, price_paid, payment_token, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [agentId, buyer.toLowerCase(), txHash, packId, creditAmount, pricePaid, isNook ? "nook" : "usdc", blockNumber],
      );
    } catch (err) {
      // Duplicate — already processed
      return;
    }

    // Credit the agent account
    if (agentId) {
      try {
        await this.creditManager.addCredits(agentId, creditAmount, "purchase", txHash);

        // Set has_purchased = true to unlock tier 2 relay cap
        await this.pool.query(
          `UPDATE credit_accounts SET has_purchased = TRUE WHERE agent_id = $1`,
          [agentId],
        );

        logSecurityEvent("info", "purchase-credited", {
          agentId,
          buyer,
          packId,
          creditAmount,
          pricePaid,
          isNook,
          txHash,
        });
      } catch (err) {
        logSecurityEvent("error", "purchase-credit-failed", {
          agentId,
          buyer,
          txHash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logSecurityEvent("warn", "purchase-no-agent", {
        buyer,
        txHash,
        packId,
        creditAmount,
        message: "Purchase recorded but no agent found for buyer address. Credits will be applied when agent registers.",
      });
    }
  }

  // -------------------------------------------------------
  //  State persistence
  // -------------------------------------------------------

  private async getLastProcessedBlock(): Promise<number> {
    const { rows } = await this.pool.query<{ value: string }>(
      `SELECT value FROM watcher_state WHERE key = $1`,
      [STATE_KEY],
    );
    return rows[0] ? Number(rows[0].value) : 0;
  }

  private async setLastProcessedBlock(block: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO watcher_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [STATE_KEY, block.toString()],
    );
  }
}
