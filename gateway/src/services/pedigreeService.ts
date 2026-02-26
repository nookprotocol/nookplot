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
 * Zero contract changes — purely off-chain computation using subgraph data.
 *
 * @module services/pedigreeService
 */

import type { SubgraphGateway } from "./subgraphGateway.js";

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

// Subgraph response shapes
interface DeploymentQueryResult {
  agentDeployments: Array<{
    parentAgent: string | null;
    isSpawn: boolean;
    bundle: {
      bundleId: string;
      name: string;
      contributors: Array<{
        contributor: { id: string };
        weightBps: string;
      }>;
    } | null;
  }>;
}

interface ContributionScoreQueryResult {
  contributionScores: Array<{
    id: string;
    score: number;
  }>;
}

interface SpawnRelationQueryResult {
  spawnRelations: Array<{
    parent: { id: string };
  }>;
}

// ============================================================
//  Queries
// ============================================================

const DEPLOYMENT_QUERY = `
  query AgentDeployment($addr: String!) {
    agentDeployments(
      where: { agentAddress: $addr }
      first: 1
      orderBy: createdAt
      orderDirection: desc
    ) {
      parentAgent
      isSpawn
      bundle {
        bundleId
        name
        contributors {
          contributor { id }
          weightBps
        }
      }
    }
  }
`;

const CONTRIBUTION_SCORES_QUERY = `
  query ContributionScores($ids: [ID!]!) {
    contributionScores(where: { id_in: $ids }) {
      id
      score
    }
  }
`;

const SPAWN_RELATION_QUERY = `
  query SpawnRelation($child: String!) {
    spawnRelations(where: { child: $child }, first: 1) {
      parent { id }
    }
  }
`;

// ============================================================
//  Service
// ============================================================

export class PedigreeService {
  constructor(private readonly subgraphGateway: SubgraphGateway) {}

  async computePedigree(address: string): Promise<PedigreeResult> {
    const normalizedAddr = address.toLowerCase();

    // 1. Fetch deployment + bundle + contributors
    const deployResult = await this.subgraphGateway.query<DeploymentQueryResult>(
      DEPLOYMENT_QUERY,
      { addr: normalizedAddr },
    );

    const deployment = deployResult.data?.agentDeployments?.[0];
    if (!deployment || !deployment.bundle) {
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

    const isSpawn = deployment.isSpawn;
    const bundle = deployment.bundle;

    // 2. Batch fetch ContributionScores for bundle contributors
    const contributorAddresses = bundle.contributors.map((c) => c.contributor.id.toLowerCase());
    const scoreMap = await this.fetchContributionScores(contributorAddresses);

    // 3. Compute bundle quality
    const contributors = bundle.contributors.map((c) => {
      const addr = c.contributor.id.toLowerCase();
      const weightBps = parseInt(c.weightBps, 10) || 0;
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
        const spawnResult = await this.subgraphGateway.query<SpawnRelationQueryResult>(
          SPAWN_RELATION_QUERY,
          { child: currentAddr },
        );

        const parentAddr = spawnResult.data?.spawnRelations?.[0]?.parent?.id?.toLowerCase();
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
      bundle: { bundleId: bundle.bundleId, name: bundle.name },
      contributors,
      ancestors,
    };
  }

  private async fetchContributionScores(addresses: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (addresses.length === 0) return map;

    const result = await this.subgraphGateway.query<ContributionScoreQueryResult>(
      CONTRIBUTION_SCORES_QUERY,
      { ids: addresses },
    );

    for (const entry of result.data?.contributionScores ?? []) {
      map.set(entry.id.toLowerCase(), entry.score);
    }

    return map;
  }
}
