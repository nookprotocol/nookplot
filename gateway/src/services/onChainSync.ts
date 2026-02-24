/**
 * On-chain synchronization service for the Agent Gateway.
 *
 * Pushes aggregated contribution scores and expertise tags from the
 * gateway's PostgreSQL database to the ContributionRegistry smart
 * contract on-chain. Breakdown JSON is uploaded to IPFS and referenced
 * by CID in the on-chain record.
 *
 * Batch size is capped at 50 agents per transaction to stay within
 * gas limits.
 *
 * All queries use parameterized SQL to prevent injection.
 *
 * @module services/onChainSync
 */

import type { Pool } from "pg";
import type { IpfsClient } from "@nookplot/sdk";
import type { ethers } from "ethers";

/** Maximum number of agents per batchSetScores transaction. */
const BATCH_SIZE = 50;

/** Shape of the breakdown JSON uploaded to IPFS. */
interface BreakdownDocument {
  version: "1.0";
  agentAddress: string;
  agentId: string;
  overallScore: number;
  components: {
    commits: number;
    exec: number;
    projects: number;
    lines: number;
    collab: number;
  };
  computedAt: string;
}

/** Row shape returned from the contribution_scores query. */
interface ContributionRow {
  id: string;
  agent_id: string;
  address: string;
  overall_score: number;
  commits_score: number;
  exec_score: number;
  projects_score: number;
  lines_score: number;
  collab_score: number;
  computed_at: Date;
}

/** Row shape returned from the expertise_tags query. */
interface ExpertiseRow {
  agent_id: string;
  address: string;
  tag: string;
  confidence: number;
}

/** Result of a full sync cycle. */
export interface SyncCycleResult {
  agentsSynced: number;
  txHashes: string[];
}

/**
 * Synchronizes contribution scores and expertise tags to an on-chain
 * ContributionRegistry contract.
 *
 * The sync cycle:
 * 1. Queries all un-synced (or stale) contribution_scores from the DB
 * 2. Uploads a breakdown JSON document to IPFS for each agent
 * 3. Calls ContributionRegistry.batchSetScores() in batches of 50
 * 4. Calls ContributionRegistry.setExpertiseTags() per agent
 * 5. Updates synced_at and sync_tx_hash in the DB
 */
export class OnChainSync {
  private pool: Pool;
  private ipfs: IpfsClient;
  private registry: ethers.Contract;

  constructor(
    pool: Pool,
    ipfs: IpfsClient,
    registry: ethers.Contract,
  ) {
    this.pool = pool;
    this.ipfs = ipfs;
    this.registry = registry;
  }

  /**
   * Run a full sync cycle: upload breakdowns to IPFS, push scores and
   * tags on-chain, and mark agents as synced in the DB.
   *
   * @returns The number of agents synced and all transaction hashes.
   */
  async runSyncCycle(): Promise<SyncCycleResult> {
    // 1. Get all contribution scores that need syncing
    //    (never synced, or computed_at > synced_at)
    const scoresRes = await this.pool.query<ContributionRow>(
      `SELECT id, agent_id, address, overall_score,
              commits_score, exec_score, projects_score, lines_score, collab_score,
              computed_at
       FROM contribution_scores
       WHERE synced_at IS NULL
          OR computed_at > synced_at
       ORDER BY overall_score DESC`,
    );

    if (scoresRes.rows.length === 0) {
      return { agentsSynced: 0, txHashes: [] };
    }

    const txHashes: string[] = [];
    let agentsSynced = 0;

    // 2. Upload breakdown JSON to IPFS for each agent and collect CIDs
    const agentCids: Map<string, string> = new Map();

    for (const row of scoresRes.rows) {
      const breakdown: BreakdownDocument = {
        version: "1.0",
        agentAddress: row.address,
        agentId: row.agent_id,
        overallScore: row.overall_score,
        components: {
          commits: row.commits_score,
          exec: row.exec_score,
          projects: row.projects_score,
          lines: row.lines_score,
          collab: row.collab_score,
        },
        computedAt: row.computed_at.toISOString(),
      };

      try {
        const uploadResult = await this.ipfs.uploadJson(
          breakdown as unknown as Record<string, unknown>,
          `contribution-${row.address}`,
        );
        agentCids.set(row.agent_id, uploadResult.cid);

        // Update the breakdown_cid in the DB
        await this.pool.query(
          `UPDATE contribution_scores
           SET breakdown_cid = $1
           WHERE agent_id = $2`,
          [uploadResult.cid, row.agent_id],
        );
      } catch (err) {
        // Log but continue — we can still sync the score without the CID
        console.error(
          `IPFS upload failed for agent ${row.address}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 3. Batch set scores on-chain in groups of BATCH_SIZE
    for (let i = 0; i < scoresRes.rows.length; i += BATCH_SIZE) {
      const batch = scoresRes.rows.slice(i, i + BATCH_SIZE);

      const addresses = batch.map((r) => r.address);
      const scores = batch.map((r) => r.overall_score);
      const cids = batch.map((r) => agentCids.get(r.agent_id) ?? "");

      try {
        const tx = await this.registry.batchSetScores(
          addresses,
          scores,
          cids,
        );
        const receipt = await tx.wait();
        const txHash: string = receipt.hash;
        txHashes.push(txHash);

        // Update synced_at and sync_tx_hash for this batch
        for (const row of batch) {
          await this.pool.query(
            `UPDATE contribution_scores
             SET synced_at = NOW(),
                 sync_tx_hash = $1
             WHERE agent_id = $2`,
            [txHash, row.agent_id],
          );
          agentsSynced++;
        }
      } catch (err) {
        console.error(
          `batchSetScores failed for batch starting at index ${i}:`,
          err instanceof Error ? err.message : err,
        );
        // Continue to the next batch rather than aborting entirely
      }
    }

    // 4. Set expertise tags on-chain per agent
    //    Query all expertise tags for the synced agents
    const agentIds = scoresRes.rows.map((r) => r.agent_id);

    const tagsRes = await this.pool.query<ExpertiseRow>(
      `SELECT et.agent_id, a.address, et.tag, et.confidence
       FROM expertise_tags et
       JOIN agents a ON a.id = et.agent_id
       WHERE et.agent_id = ANY($1::uuid[])
       ORDER BY et.agent_id, et.confidence DESC`,
      [agentIds],
    );

    // Group tags by agent
    const tagsByAgent = new Map<string, Array<{ tag: string; confidence: number }>>();
    for (const row of tagsRes.rows) {
      const key = row.address;
      if (!tagsByAgent.has(key)) {
        tagsByAgent.set(key, []);
      }
      tagsByAgent.get(key)!.push({
        tag: row.tag,
        confidence: row.confidence,
      });
    }

    // Submit tags for each agent
    for (const [address, tags] of tagsByAgent.entries()) {
      const tagNames = tags.map((t) => t.tag);
      // Convert confidence (0.0-1.0) to basis points (0-10000) for on-chain storage
      const confidences = tags.map((t) => Math.round(t.confidence * 10000));

      try {
        const tx = await this.registry.setExpertiseTags(
          address,
          tagNames,
          confidences,
        );
        const receipt = await tx.wait();
        txHashes.push(receipt.hash);
      } catch (err) {
        console.error(
          `setExpertiseTags failed for ${address}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { agentsSynced, txHashes };
  }
}
