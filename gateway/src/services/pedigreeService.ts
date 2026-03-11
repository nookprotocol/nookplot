/**
 * Pedigree signal computation service.
 *
 * Computes a 0-100 pedigree score for agents deployed via AgentFactory,
 * reflecting the quality of their knowledge contributors and spawn lineage.
 *
 * Formula:
 *   bundleQuality = sum(contributorScore[i] * weightBps[i]) / 10000 / 100
 *   lineageQuality = sum((ancestorScore / 100) * DECAY^generation), capped at 100
 *   pedigree = isSpawn ? bundle*0.6 + lineage*0.4 : bundle
 *
 * Zero contract changes — purely off-chain computation using idx_* tables.
 *
 * @module services/pedigreeService
 */

import type pg from "pg";

// ============================================================
//  Constants
// ============================================================

const DECAY_FACTOR = 0.6;
const MAX_GENERATIONS = 5;
const BUNDLE_WEIGHT = 0.6;
const LINEAGE_WEIGHT = 0.4;

// ============================================================
//  Types
// ============================================================

export interface PedigreeResult {
  address: string;
  pedigree: number | null;
  bundleQuality: number | null;
  lineageQuality: number | null;
  isSpawn: boolean;
  bundle: { bundleId: string; name: string } | null;
  contributors: Array<{
    address: string;
    weightBps: number;
    contributionScore: number;
  }>;
  ancestors: Array<{
    address: string;
    generation: number;
    contributionScore: number;
    decayedWeight: number;
  }>;
}

// ============================================================
//  Service
// ============================================================

export class PedigreeService {
  constructor(private readonly pool: pg.Pool) {}

  async computePedigree(address: string): Promise<PedigreeResult> {
    const normalizedAddr = address.toLowerCase();

    // 1. Fetch deployment + bundle + contributors via idx_* tables
    const { rows: deployRows } = await this.pool.query<{
      parent_agent: string | null;
      is_spawn: boolean;
      bundle_id: string | null;
    }>(
      `SELECT parent_agent, is_spawn, bundle_id
       FROM idx_agent_deployments
       WHERE agent_address = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedAddr],
    );

    const deployment = deployRows[0];
    if (!deployment || !deployment.bundle_id) {
      return {
        address: normalizedAddr,
        pedigree: null,
        bundleQuality: null,
        lineageQuality: null,
        isSpawn: false,
        bundle: null,
        contributors: [],
        ancestors: [],
      };
    }

    const isSpawn = deployment.is_spawn;

    // Fetch bundle info
    const { rows: bundleRows } = await this.pool.query<{
      bundle_id: string;
      name: string;
    }>(
      `SELECT bundle_id::text, name
       FROM idx_knowledge_bundles
       WHERE bundle_id = $1
       LIMIT 1`,
      [deployment.bundle_id],
    );

    const bundleInfo = bundleRows[0];
    if (!bundleInfo) {
      return {
        address: normalizedAddr,
        pedigree: null,
        bundleQuality: null,
        lineageQuality: null,
        isSpawn: false,
        bundle: null,
        contributors: [],
        ancestors: [],
      };
    }

    // Fetch bundle contributors
    const { rows: contribRows } = await this.pool.query<{
      contributor_id: string;
      weight_bps: number;
    }>(
      `SELECT contributor_id, weight_bps
       FROM idx_bundle_contributors
       WHERE bundle_id = $1`,
      [deployment.bundle_id],
    );

    // 2. Batch fetch ContributionScores for bundle contributors
    const contributorAddresses = contribRows.map((c) => c.contributor_id.toLowerCase());
    const scoreMap = await this.fetchContributionScores(contributorAddresses);

    // 3. Compute bundle quality
    const contributors = contribRows.map((c) => {
      const addr = c.contributor_id.toLowerCase();
      const weightBps = c.weight_bps || 0;
      const contributionScore = scoreMap.get(addr) ?? 0;
      return { address: addr, weightBps, contributionScore };
    });

    let bundleQuality = 0;
    if (contributors.length > 0) {
      const weightedSum = contributors.reduce(
        (sum, c) => sum + c.contributionScore * c.weightBps,
        0,
      );
      // ContributionScore is 0-10000, weightBps sums to 10000
      bundleQuality = weightedSum / 10000 / 100;
    }
    bundleQuality = Math.min(Math.max(bundleQuality, 0), 100);

    // 4. Compute lineage quality (spawn chain walk)
    let lineageQuality: number | null = null;
    const ancestors: PedigreeResult["ancestors"] = [];

    if (isSpawn) {
      lineageQuality = 0;
      const ancestorAddresses: Array<{ address: string; generation: number }> = [];
      let currentAddr = normalizedAddr;
      const visited = new Set<string>([normalizedAddr]);

      for (let gen = 1; gen <= MAX_GENERATIONS; gen++) {
        const { rows: spawnRows } = await this.pool.query<{ parent_id: string }>(
          `SELECT parent_id
           FROM idx_spawn_relations
           WHERE child_id = $1
           LIMIT 1`,
          [currentAddr],
        );

        const parentAddr = spawnRows[0]?.parent_id?.toLowerCase();
        if (!parentAddr || visited.has(parentAddr)) break;

        visited.add(parentAddr);
        ancestorAddresses.push({ address: parentAddr, generation: gen });
        currentAddr = parentAddr;
      }

      // Batch fetch ancestor contribution scores
      if (ancestorAddresses.length > 0) {
        const ancestorScoreMap = await this.fetchContributionScores(
          ancestorAddresses.map((a) => a.address),
        );

        for (const ancestor of ancestorAddresses) {
          const score = ancestorScoreMap.get(ancestor.address) ?? 0;
          const decayedWeight = Math.pow(DECAY_FACTOR, ancestor.generation);
          lineageQuality += (score / 100) * decayedWeight;
          ancestors.push({
            address: ancestor.address,
            generation: ancestor.generation,
            contributionScore: score,
            decayedWeight: Math.round(decayedWeight * 1000) / 1000,
          });
        }
      }

      lineageQuality = Math.min(lineageQuality, 100);
    }

    // 5. Compute final pedigree score
    let pedigree: number;
    if (isSpawn && lineageQuality !== null) {
      pedigree = bundleQuality * BUNDLE_WEIGHT + lineageQuality * LINEAGE_WEIGHT;
    } else {
      pedigree = bundleQuality;
    }
    pedigree = Math.round(Math.min(Math.max(pedigree, 0), 100) * 10) / 10;

    return {
      address: normalizedAddr,
      pedigree,
      bundleQuality: Math.round(bundleQuality * 10) / 10,
      lineageQuality: lineageQuality !== null ? Math.round(lineageQuality * 10) / 10 : null,
      isSpawn,
      bundle: { bundleId: bundleInfo.bundle_id, name: bundleInfo.name },
      contributors,
      ancestors,
    };
  }

  private async fetchContributionScores(addresses: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (addresses.length === 0) return map;

    const placeholders = addresses.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query<{ id: string; score: number }>(
      `SELECT id, score FROM idx_contribution_scores WHERE id IN (${placeholders})`,
      addresses,
    );

    for (const entry of rows) {
      map.set(entry.id.toLowerCase(), entry.score);
    }

    return map;
  }
}
