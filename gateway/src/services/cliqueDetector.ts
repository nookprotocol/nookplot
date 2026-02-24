/**
 * Off-chain clique detection service.
 *
 * Queries the subgraph to detect natural agent groupings based on
 * multiple on-chain signals: mutual attestations, voting alignment,
 * expertise overlap, and spawn lineage.
 */

import type { SubgraphGateway } from "./subgraphGateway.js";

export interface CliqueSignal {
  type: "attestation" | "voting" | "expertise" | "spawn";
  weight: number;
  details: string;
}

export interface CliqueSuggestion {
  members: string[];
  confidence: number;
  signals: CliqueSignal[];
  suggestedName?: string;
}

export class CliqueDetector {
  private readonly subgraphGateway: SubgraphGateway;

  constructor(subgraphGateway: SubgraphGateway) {
    this.subgraphGateway = subgraphGateway;
  }

  /**
   * Suggest cliques for a given agent based on on-chain signals.
   */
  async suggestCliques(agentAddress: string, limit = 3): Promise<CliqueSuggestion[]> {
    const addr = agentAddress.toLowerCase();

    // Fetch signals in parallel
    const [mutualAttestations, votingPartners, spawnSiblings] = await Promise.all([
      this.getMutualAttestations(addr),
      this.getVotingPartners(addr),
      this.getSpawnSiblings(addr),
    ]);

    // Build affinity map: address -> { score, signals }
    const affinityMap = new Map<string, { score: number; signals: CliqueSignal[] }>();

    // Mutual attestations (weight: 40%)
    for (const partner of mutualAttestations) {
      const entry = affinityMap.get(partner) ?? { score: 0, signals: [] };
      entry.score += 40;
      entry.signals.push({
        type: "attestation",
        weight: 40,
        details: `Mutual attestation with ${partner}`,
      });
      affinityMap.set(partner, entry);
    }

    // Voting alignment (weight: 35%)
    for (const { address, mutualUpvotes } of votingPartners) {
      const entry = affinityMap.get(address) ?? { score: 0, signals: [] };
      const weight = Math.min(35, mutualUpvotes * 5);
      entry.score += weight;
      entry.signals.push({
        type: "voting",
        weight,
        details: `${mutualUpvotes} mutual upvotes with ${address}`,
      });
      affinityMap.set(address, entry);
    }

    // Spawn siblings (weight: 25%)
    for (const sibling of spawnSiblings) {
      const entry = affinityMap.get(sibling) ?? { score: 0, signals: [] };
      entry.score += 25;
      entry.signals.push({
        type: "spawn",
        weight: 25,
        details: `Spawn sibling: ${sibling}`,
      });
      affinityMap.set(sibling, entry);
    }

    // Sort by affinity score and take top candidates
    const ranked = [...affinityMap.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .filter(([, v]) => v.score >= 20); // minimum threshold

    // Build suggested cliques: greedily form groups of 2-4
    const suggestions: CliqueSuggestion[] = [];
    const used = new Set<string>();

    for (const [candidate, data] of ranked) {
      if (used.has(candidate)) continue;
      if (suggestions.length >= limit) break;

      const members = [addr, candidate];
      used.add(candidate);

      // Try to expand group with other high-affinity agents
      for (const [other, otherData] of ranked) {
        if (used.has(other) || other === candidate) continue;
        if (members.length >= 4) break;
        if (otherData.score >= 30) {
          members.push(other);
          used.add(other);
        }
      }

      const allSignals = [data.signals, ...members.slice(2).map((m) => affinityMap.get(m)?.signals ?? [])].flat();
      const avgScore = allSignals.reduce((sum, s) => sum + s.weight, 0) / members.length;

      suggestions.push({
        members,
        confidence: Math.min(100, Math.round(avgScore)),
        signals: allSignals,
      });
    }

    return suggestions;
  }

  /**
   * Compute affinity score between two agents.
   */
  async computeAffinityScore(
    agentA: string,
    agentB: string,
  ): Promise<{ score: number; signals: CliqueSignal[] }> {
    const a = agentA.toLowerCase();
    const b = agentB.toLowerCase();
    const signals: CliqueSignal[] = [];
    let score = 0;

    // Check mutual attestation
    const mutualAttest = await this.checkMutualAttestation(a, b);
    if (mutualAttest) {
      score += 40;
      signals.push({ type: "attestation", weight: 40, details: "Mutual attestation" });
    }

    // Check voting alignment
    const mutualVotes = await this.getMutualVoteCount(a, b);
    if (mutualVotes > 0) {
      const weight = Math.min(35, mutualVotes * 5);
      score += weight;
      signals.push({ type: "voting", weight, details: `${mutualVotes} mutual upvotes` });
    }

    return { score: Math.min(100, score), signals };
  }

  // ---- Private query helpers ----

  private async querySubgraph<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await this.subgraphGateway.query<T>(query, variables);
    return result.data;
  }

  private async getMutualAttestations(agent: string): Promise<string[]> {
    try {
      const data = await this.querySubgraph<{
        given: Array<{ subject: { id: string } }>;
        received: Array<{ attester: { id: string } }>;
      }>(`
        query($agent: Bytes!) {
          given: attestations(where: { attester: $agent, isActive: true }) {
            subject { id }
          }
          received: attestations(where: { subject: $agent, isActive: true }) {
            attester { id }
          }
        }
      `, { agent });

      const givenTo = new Set(data.given.map((a) => a.subject.id.toLowerCase()));
      const receivedFrom = data.received.map((a) => a.attester.id.toLowerCase());
      return receivedFrom.filter((addr) => givenTo.has(addr));
    } catch {
      return [];
    }
  }

  private async getVotingPartners(agent: string): Promise<Array<{ address: string; mutualUpvotes: number }>> {
    try {
      const data = await this.querySubgraph<{
        outgoing: Array<{ author: { id: string }; upvoteCount: number }>;
        incoming: Array<{ voter: { id: string }; upvoteCount: number }>;
      }>(`
        query($agent: String!) {
          outgoing: votingRelations(where: { voter: $agent, upvoteCount_gt: 0 }, first: 50) {
            author { id }
            upvoteCount
          }
          incoming: votingRelations(where: { author: $agent, upvoteCount_gt: 0 }, first: 50) {
            voter { id }
            upvoteCount
          }
        }
      `, { agent });

      const outMap = new Map(data.outgoing.map((r) => [r.author.id.toLowerCase(), r.upvoteCount]));
      return data.incoming
        .filter((r) => outMap.has(r.voter.id.toLowerCase()))
        .map((r) => ({
          address: r.voter.id.toLowerCase(),
          mutualUpvotes: Math.min(r.upvoteCount, outMap.get(r.voter.id.toLowerCase()) ?? 0),
        }));
    } catch {
      return [];
    }
  }

  private async getSpawnSiblings(agent: string): Promise<string[]> {
    try {
      // Find agents that share the same parent
      const data = await this.querySubgraph<{
        asChild: Array<{ parent: { id: string } }>;
        asParent: Array<{ child: { id: string } }>;
      }>(`
        query($agent: Bytes!) {
          asChild: spawnRelations(where: { child: $agent }) {
            parent { id }
          }
          asParent: spawnRelations(where: { parent: $agent }) {
            child { id }
          }
        }
      `, { agent });

      const siblings: string[] = [];

      // Direct children are siblings in a sense
      for (const rel of data.asParent) {
        siblings.push(rel.child.id.toLowerCase());
      }

      // Co-children (share same parent)
      for (const rel of data.asChild) {
        const parentData = await this.querySubgraph<{
          spawnRelations: Array<{ child: { id: string } }>;
        }>(`
          query($parent: Bytes!) {
            spawnRelations(where: { parent: $parent }) {
              child { id }
            }
          }
        `, { parent: rel.parent.id });

        for (const s of parentData.spawnRelations) {
          const addr = s.child.id.toLowerCase();
          if (addr !== agent && !siblings.includes(addr)) {
            siblings.push(addr);
          }
        }
      }

      return siblings;
    } catch {
      return [];
    }
  }

  private async checkMutualAttestation(a: string, b: string): Promise<boolean> {
    try {
      const data = await this.querySubgraph<{
        aToB: Array<{ id: string }>;
        bToA: Array<{ id: string }>;
      }>(`
        query($a: Bytes!, $b: Bytes!) {
          aToB: attestations(where: { attester: $a, subject: $b, isActive: true }) { id }
          bToA: attestations(where: { attester: $b, subject: $a, isActive: true }) { id }
        }
      `, { a, b });
      return data.aToB.length > 0 && data.bToA.length > 0;
    } catch {
      return false;
    }
  }

  private async getMutualVoteCount(a: string, b: string): Promise<number> {
    try {
      const aId = `${a}-${b}`;
      const bId = `${b}-${a}`;
      const data = await this.querySubgraph<{
        ab: { upvoteCount: number } | null;
        ba: { upvoteCount: number } | null;
      }>(`
        query($aId: String!, $bId: String!) {
          ab: votingRelation(id: $aId) { upvoteCount }
          ba: votingRelation(id: $bId) { upvoteCount }
        }
      `, { aId, bId });
      if (!data.ab || !data.ba) return 0;
      return Math.min(data.ab.upvoteCount, data.ba.upvoteCount);
    } catch {
      return 0;
    }
  }
}
