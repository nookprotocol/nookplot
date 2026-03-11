import { ethers } from "ethers";
import { pool } from "./db/pool.js";
import { config } from "./config.js";
import { decodeLogs, getContractAddresses, getAllTopic0s } from "./decoder.js";
import { getHandler } from "./mappings/index.js";
import { handleReorg } from "./reorgHandler.js";
import { ensureGlobalStats } from "./mappings/types.js";

let running = true;

export function stopCrawler() {
  running = false;
}

export async function startCrawler() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);

  // Get starting point
  const { rows } = await pool.query("SELECT last_block, last_block_hash FROM idx_state WHERE id = 1");
  let lastBlock = Number(rows[0]?.last_block) || 0;
  let lastBlockHash = rows[0]?.last_block_hash ?? "";

  if (lastBlock === 0 || lastBlock < config.startBlock) {
    lastBlock = config.startBlock - 1;
    console.log(`[crawler] Starting from block ${config.startBlock}`);
  } else {
    console.log(`[crawler] Resuming from block ${lastBlock + 1}`);
  }

  const addresses = getContractAddresses();
  const topics = getAllTopic0s();

  console.log(`[crawler] Watching ${addresses.length} contracts, ${topics.length} event signatures`);

  // Ensure global stats row exists
  const initClient = await pool.connect();
  try {
    await ensureGlobalStats(initClient);
  } finally {
    initClient.release();
  }

  let consecutiveErrors = 0;

  while (running) {
    try {
      const chainHead = await provider.getBlockNumber();
      const fromBlock = lastBlock + 1;

      if (fromBlock > chainHead) {
        // Up to date, wait for new blocks
        await sleep(config.pollIntervalMs);
        consecutiveErrors = 0;
        continue;
      }

      // Determine batch size: larger during backfill, smaller for live tracking
      const behind = chainHead - lastBlock;
      const batchSize = behind > 1000 ? config.backfillBatchSize : config.batchSize;
      const toBlock = Math.min(fromBlock + batchSize - 1, chainHead);

      // Check for reorgs: verify parent hash continuity
      if (lastBlockHash) {
        const fromBlockData = await provider.getBlock(fromBlock);
        if (fromBlockData && fromBlockData.parentHash !== lastBlockHash) {
          console.warn(`[crawler] Reorg detected at block ${fromBlock}! Parent hash mismatch`);
          // Find fork point: walk back up to 10 blocks
          let forkBlock = lastBlock;
          for (let i = 0; i < 10 && forkBlock > config.startBlock; i++) {
            const block = await provider.getBlock(forkBlock);
            if (!block) break;

            const { rows: stateRows } = await pool.query(
              "SELECT last_block_hash FROM idx_state WHERE id = 1",
            );
            // Simple approach: roll back to fromBlock - 10
            forkBlock--;
          }
          forkBlock = Math.max(forkBlock - 10, config.startBlock - 1);
          await handleReorg(pool, forkBlock);
          lastBlock = forkBlock;
          lastBlockHash = "";
          continue;
        }
      }

      // Fetch logs for this batch
      const logs = await provider.send("eth_getLogs", [{
        fromBlock: ethers.toQuantity(fromBlock),
        toBlock: ethers.toQuantity(toBlock),
        address: addresses,
        topics: [topics],
      }]);

      // Parse raw RPC response
      const parsedLogs = (logs as Array<{
        address: string;
        topics: string[];
        data: string;
        blockNumber: string;
        transactionHash: string;
        logIndex: string;
      }>).map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: parseInt(l.blockNumber, 16),
        transactionHash: l.transactionHash,
        logIndex: parseInt(l.logIndex, 16),
      }));

      // Decode all logs
      const decoded = decodeLogs(parsedLogs);

      // Sort by block number, then log index for deterministic ordering
      decoded.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

      // Prefetch all block data BEFORE opening the transaction
      // This avoids RPC calls inside the DB transaction which cause lag
      const uniqueBlocks = new Set<number>();
      for (const log of decoded) {
        uniqueBlocks.add(log.blockNumber);
      }
      // Also need the end block hash
      uniqueBlocks.add(toBlock);

      // Fetch all block timestamps in parallel (cache handles dedup)
      await Promise.all(
        [...uniqueBlocks].map((bn) => getBlockTimestamp(provider, bn)),
      );

      // End block hash is already cached from the prefetch above
      const endBlockHash = blockHashCache.get(toBlock) ?? "";

      // Process in a single transaction — no RPC calls inside
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const log of decoded) {
          const handler = getHandler(log.contractName, log.eventName);
          if (!handler) {
            console.warn(`[crawler] No handler for ${log.contractName}.${log.eventName}`);
            continue;
          }

          const blockTs = blockTimestampCache.get(log.blockNumber) ?? 0;

          await handler(
            {
              client,
              blockNumber: log.blockNumber,
              timestamp: blockTs,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              provider,
            },
            log.parsed,
          );
        }

        // Update state
        await client.query(
          `UPDATE idx_state SET last_block = $1, last_block_hash = $2, updated_at = NOW() WHERE id = 1`,
          [toBlock, endBlockHash],
        );

        await client.query("COMMIT");

        lastBlock = toBlock;
        lastBlockHash = endBlockHash;
        consecutiveErrors = 0;

        if (decoded.length > 0) {
          console.log(
            `[crawler] Blocks ${fromBlock}-${toBlock}: ${decoded.length} events (${behind} behind)`,
          );
        } else if (behind > 100) {
          // Log progress even with no events during backfill
          console.log(`[crawler] Blocks ${fromBlock}-${toBlock}: 0 events (${behind} behind)`);
        }
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      consecutiveErrors++;
      const delay = Math.min(1000 * Math.pow(2, consecutiveErrors), 30_000);
      console.error(`[crawler] Error (attempt ${consecutiveErrors}):`, (err as Error).message);
      await sleep(delay);
    }
  }

  console.log("[crawler] Stopped");
}

// Block data caches (cleared periodically)
const blockTimestampCache = new Map<number, number>();
const blockHashCache = new Map<number, string>();
let cacheCleanCounter = 0;

async function getBlockTimestamp(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): Promise<number> {
  const cached = blockTimestampCache.get(blockNumber);
  if (cached !== undefined) return cached;

  const block = await provider.getBlock(blockNumber);
  const ts = block?.timestamp ?? 0;
  blockTimestampCache.set(blockNumber, ts);
  if (block?.hash) blockHashCache.set(blockNumber, block.hash);

  // Periodically clean old entries (keep cache under 10k entries)
  cacheCleanCounter++;
  if (cacheCleanCounter > 1000) {
    cacheCleanCounter = 0;
    if (blockTimestampCache.size > 10_000) {
      const entries = [...blockTimestampCache.entries()].sort((a, b) => a[0] - b[0]);
      const toRemove = entries.slice(0, entries.length - 5000);
      for (const [key] of toRemove) {
        blockTimestampCache.delete(key);
        blockHashCache.delete(key);
      }
    }
  }

  return ts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
