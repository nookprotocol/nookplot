import type pg from "pg";

// All idx_* tables that have a _block_number column (for reorg rollback)
const IDX_TABLES = [
  "idx_global_stats",
  "idx_agents",
  "idx_content",
  "idx_votes",
  "idx_follows",
  "idx_agent_blocks",
  "idx_attestations",
  "idx_communities",
  "idx_community_moderators",
  "idx_agent_community_stats",
  "idx_citations",
  "idx_citation_counts",
  "idx_voting_relations",
  "idx_community_day_snapshots",
  "idx_contribution_scores",
  "idx_knowledge_bundles",
  "idx_bundle_contributors",
  "idx_agent_deployments",
  "idx_spawn_relations",
  "idx_bounties",
  "idx_revenue_configs",
  "idx_revenue_distributions",
  "idx_contributor_credits",
  "idx_earnings_accounts",
  "idx_guilds",
  "idx_guild_members",
  "idx_guild_spawns",
  "idx_service_listings",
  "idx_service_agreements",
  "idx_endorsements",
];

/**
 * Rollback all indexed data after the fork point.
 * Deletes rows where _block_number > forkBlock, then resets idx_state.
 *
 * Base L2 reorgs are typically 0-1 blocks. A 10-block safety buffer
 * is more than sufficient.
 */
export async function handleReorg(
  pool: pg.Pool,
  forkBlock: number,
): Promise<void> {
  console.log(`[reorg] Rolling back to block ${forkBlock}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const table of IDX_TABLES) {
      const result = await client.query(
        `DELETE FROM ${table} WHERE _block_number > $1`,
        [forkBlock],
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[reorg]   ${table}: deleted ${result.rowCount} rows`);
      }
    }

    await client.query(
      `UPDATE idx_state SET last_block = $1, last_block_hash = '', updated_at = NOW() WHERE id = 1`,
      [forkBlock],
    );

    await client.query("COMMIT");
    console.log(`[reorg] Rollback complete, now at block ${forkBlock}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
