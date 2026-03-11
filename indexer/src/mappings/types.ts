import type pg from "pg";
import type { ethers, LogDescription } from "ethers";

export interface MappingContext {
  client: pg.PoolClient;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
  logIndex: number;
  /** JSON-RPC provider — available for on-chain view calls during indexing */
  provider?: ethers.JsonRpcProvider;
}

export type MappingHandler = (
  ctx: MappingContext,
  parsed: LogDescription,
) => Promise<void>;

// Helper: ensure agent exists (lazy creation like subgraph's getOrCreateAgent)
export async function ensureAgent(
  client: pg.PoolClient,
  address: string,
  blockNumber: number,
  isActiveDefault = true,
): Promise<void> {
  await client.query(
    `INSERT INTO idx_agents (id, is_active, _block_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [address.toLowerCase(), isActiveDefault, blockNumber],
  );
}

// Helper: ensure community exists (lazy creation like subgraph's getOrCreateCommunity)
export async function ensureCommunity(
  client: pg.PoolClient,
  name: string,
  blockNumber: number,
): Promise<void> {
  const id = name.toLowerCase();
  await client.query(
    `INSERT INTO idx_communities (id, _block_number)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, blockNumber],
  );
}

// Helper: ensure global stats row exists
export async function ensureGlobalStats(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO idx_global_stats DEFAULT VALUES ON CONFLICT DO NOTHING`,
  );
}

// Helper: floor timestamp to start of day (UTC)
export function floorToDay(timestamp: number): number {
  const SECONDS_PER_DAY = 86400;
  return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}
