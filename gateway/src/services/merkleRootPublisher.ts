/**
 * Merkle root publisher — bridges off-chain Merkle trees to on-chain RewardPool.
 *
 * After MerkleRewardService computes a weekly Merkle tree and stores it in
 * `merkle_reward_roots`, this service picks up unpublished roots and calls
 * `RewardPool.setMerkleRoot(bytes32)` on-chain.
 *
 * Uses the gateway's existing RPC provider. Requires a dedicated signer with
 * ROOT_PUBLISHER_ROLE on the RewardPool contract(s).
 *
 * Feature-flagged: only starts when `merkleRewardEnabled` is true AND
 * the required env vars are set (REWARD_POOL_NOOK_ADDRESS, ROOT_PUBLISHER_PRIVATE_KEY).
 *
 * @module services/merkleRootPublisher
 */

import { ethers } from "ethers";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// Minimal ABI — only the function we need
const REWARD_POOL_ABI = [
  "function setMerkleRoot(bytes32 newRoot) external",
  "function merkleRoot() view returns (bytes32)",
  "function epoch() view returns (uint256)",
] as const;

export interface MerkleRootPublisherConfig {
  /** NOOK RewardPool contract address on Base */
  nookPoolAddress: string;
  /** wETH RewardPool contract address on Base (empty string = disabled) */
  wethPoolAddress: string;
  /** Private key of the ROOT_PUBLISHER_ROLE signer */
  signerPrivateKey: string;
  /** How often to check for unpublished roots (default: 5 min) */
  pollIntervalMs: number;
  /** Max retries per root before giving up for this tick (default: 3) */
  maxRetries: number;
  /** Delay between retries in ms (default: 10s) */
  retryDelayMs: number;
}

const DEFAULT_CONFIG: MerkleRootPublisherConfig = {
  nookPoolAddress: "",
  wethPoolAddress: "",
  signerPrivateKey: "",
  pollIntervalMs: 300_000, // 5 minutes
  maxRetries: 3,
  retryDelayMs: 10_000,
};

export class MerkleRootPublisher {
  private readonly pool: pg.Pool;
  private readonly config: MerkleRootPublisherConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    pool: pg.Pool,
    provider: ethers.JsonRpcProvider,
    config: Partial<MerkleRootPublisherConfig>,
  ) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.signer = new ethers.Wallet(this.config.signerPrivateKey, this.provider);
  }

  // ----------------------------------------------------------
  //  Lifecycle
  // ----------------------------------------------------------

  start(): void {
    if (this.timer) return;

    const signerAddr = this.signer.address;
    const pools: string[] = [];
    if (this.config.nookPoolAddress) pools.push(`NOOK:${this.config.nookPoolAddress}`);
    if (this.config.wethPoolAddress) pools.push(`wETH:${this.config.wethPoolAddress}`);

    logSecurityEvent("info", "merkle-root-publisher-started", {
      signer: signerAddr,
      pools,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    // Initial tick
    this.tick().catch((err) => {
      logSecurityEvent("warn", "merkle-root-publisher-initial-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("warn", "merkle-root-publisher-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ----------------------------------------------------------
  //  Tick — find unpublished roots and publish them
  // ----------------------------------------------------------

  async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Find roots that were computed but not yet published on-chain
      const { rows } = await this.pool.query<{
        id: string;
        pool_type: string;
        epoch_number: number;
        merkle_root: string;
      }>(
        `SELECT id, pool_type, epoch_number, merkle_root
         FROM merkle_reward_roots
         WHERE published_at IS NULL AND tx_hash IS NULL
         ORDER BY epoch_number ASC
         LIMIT 10`,
      );

      for (const row of rows) {
        const poolAddress = this.getPoolAddress(row.pool_type);
        if (!poolAddress) {
          // Pool not configured — skip silently (e.g. wETH disabled)
          continue;
        }

        await this.publishRoot(row.id, row.pool_type, row.epoch_number, row.merkle_root, poolAddress);
      }
    } catch (err) {
      logSecurityEvent("warn", "merkle-root-publisher-tick-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // ----------------------------------------------------------
  //  Publish a single root on-chain
  // ----------------------------------------------------------

  private async publishRoot(
    rootId: string,
    poolType: string,
    epochNumber: number,
    merkleRoot: string,
    poolAddress: string,
  ): Promise<void> {
    const contract = new ethers.Contract(poolAddress, REWARD_POOL_ABI, this.signer);

    // Safety: verify the root isn't already on-chain and epoch ordering is correct
    try {
      const currentRoot: string = await contract.merkleRoot();
      const onChainEpoch = Number(await contract.epoch());

      if (currentRoot === merkleRoot) {
        // Already published (maybe by manual TX) — just update DB
        await this.markPublished(rootId, "already-on-chain");
        logSecurityEvent("info", "merkle-root-already-on-chain", {
          poolType, epochNumber, merkleRoot,
        });
        return;
      }

      // Prevent overwriting a newer root with an older one.
      // On-chain epoch increments with each setMerkleRoot call, so if the
      // on-chain epoch is already >= our epoch number, this root is stale.
      if (onChainEpoch >= epochNumber) {
        await this.markPublished(rootId, "skipped-stale");
        logSecurityEvent("warn", "merkle-root-skipped-stale", {
          poolType, epochNumber, onChainEpoch, merkleRoot,
          message: "On-chain epoch is already >= this epoch — skipping to avoid regression",
        });
        return;
      }
    } catch (err) {
      logSecurityEvent("warn", "merkle-root-publisher-read-failed", {
        poolType, epochNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — attempt to publish anyway
    }

    // Publish with retries
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        logSecurityEvent("info", "merkle-root-publishing", {
          poolType, epochNumber, merkleRoot, attempt,
          pool: poolAddress,
          signer: this.signer.address,
        });

        const tx = await contract.setMerkleRoot(merkleRoot);
        const receipt = await tx.wait();

        if (!receipt || receipt.status !== 1) {
          throw new Error(`TX reverted: ${tx.hash}`);
        }

        // Success — update DB
        await this.markPublished(rootId, tx.hash);

        logSecurityEvent("info", "merkle-root-published", {
          poolType,
          epochNumber,
          merkleRoot,
          txHash: tx.hash,
          gasUsed: receipt.gasUsed?.toString(),
        });

        return; // done
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("warn", "merkle-root-publish-attempt-failed", {
          poolType, epochNumber, attempt,
          maxRetries: this.config.maxRetries,
          error: errMsg,
        });

        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, this.config.retryDelayMs));
        }
      }
    }

    // All retries exhausted — log critical and move on (next tick will retry)
    logSecurityEvent("error", "merkle-root-publish-failed", {
      poolType, epochNumber, merkleRoot,
      message: `Failed after ${this.config.maxRetries} attempts — will retry next tick`,
    });
  }

  // ----------------------------------------------------------
  //  DB helpers
  // ----------------------------------------------------------

  private async markPublished(rootId: string, txHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE merkle_reward_roots
       SET published_at = NOW(), tx_hash = $2
       WHERE id = $1`,
      [rootId, txHash],
    );
  }

  private getPoolAddress(poolType: string): string | null {
    if (poolType === "nook" && this.config.nookPoolAddress) {
      return this.config.nookPoolAddress;
    }
    if (poolType === "weth" && this.config.wethPoolAddress) {
      return this.config.wethPoolAddress;
    }
    return null;
  }

  // ----------------------------------------------------------
  //  Public status (for health checks / admin routes)
  // ----------------------------------------------------------

  async getStatus(): Promise<{
    signer: string;
    nookPool: string;
    wethPool: string;
    unpublishedCount: number;
    lastPublished: { poolType: string; epochNumber: number; txHash: string; publishedAt: string } | null;
  }> {
    const { rows: unpubRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM merkle_reward_roots WHERE published_at IS NULL AND tx_hash IS NULL`,
    );

    const { rows: lastRows } = await this.pool.query<{
      pool_type: string;
      epoch_number: number;
      tx_hash: string;
      published_at: string;
    }>(
      `SELECT pool_type, epoch_number, tx_hash, published_at
       FROM merkle_reward_roots
       WHERE published_at IS NOT NULL
       ORDER BY published_at DESC
       LIMIT 1`,
    );

    return {
      signer: this.signer.address,
      nookPool: this.config.nookPoolAddress || "(disabled)",
      wethPool: this.config.wethPoolAddress || "(disabled)",
      unpublishedCount: Number(unpubRows[0].count),
      lastPublished: lastRows.length > 0
        ? {
            poolType: lastRows[0].pool_type,
            epochNumber: lastRows[0].epoch_number,
            txHash: lastRows[0].tx_hash,
            publishedAt: lastRows[0].published_at,
          }
        : null,
    };
  }
}
