/**
 * Off-chain guild detection service.
 *
 * Queries idx_* tables to detect natural agent groupings based on
 * multiple on-chain signals: mutual attestations, voting alignment,
 * expertise overlap, and spawn lineage.
 */

import type pg from "pg";

export interface GuildSignal {
  type: "attestation" | "voting" | "expertise" | "spawn";
  weight: number;
  details: string;
}

export interface GuildSuggestion {
  members: string[];
  confidence: number;
  signals: GuildSignal[];
  suggestedName?: string;
}

/** @deprecated Use GuildSignal */
export type CliqueSignal = GuildSignal;
/** @deprecated Use GuildSuggestion */
export type CliqueSuggestion = GuildSuggestion;

export class GuildDetector {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Suggest guilds for a given agent based on on-chain signals.
   */
  async suggestGuilds(agentAddress: string, limit = 3): Promise<GuildSuggestion[]> {
    const addr = agentAddress.toLowerCase();

    // Fetch signals in parallel
    const [mutualAttestations, votingPartners, spawnSiblings] = await Promise.all([
      this.getMutualAttestations(addr),
      this.getVotingPartners(addr),
      this.getSpawnSiblings(addr),
    ]);

    // Build affinity map: address -> { score, signals }
    const affinityMap = new Map<string, { score: number; signals: GuildSignal[] }>();

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

    // Build suggested guilds: greedily form groups of 2-4
    const suggestions: GuildSuggestion[] = [];
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

  /** @deprecated Use suggestGuilds */
  async suggestCliques(agentAddress: string, limit = 3): Promise<GuildSuggestion[]> {
    return this.suggestGuilds(agentAddress, limit);
  }

  /**
   * Compute affinity score between two agents.
   */
  async computeAffinityScore(
    agentA: string,
    agentB: string,
  ): Promise<{ score: number; signals: GuildSignal[] }> {
    const a = agentA.toLowerCase();
    const b = agentB.toLowerCase();
    const signals: GuildSignal[] = [];
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

  private async getMutualAttestations(agent: string): Promise<string[]> {
    try {
      // Find agents where both directions of attestation exist
      const { rows: givenRows } = await this.pool.query<{ subject_id: string }>(
        `SELECT subject_id FROM idx_attestations
         WHERE attester_id = $1 AND is_active = true`,
        [agent],
      );
      const { rows: receivedRows } = await this.pool.query<{ attester_id: string }>(
        `SELECT attester_id FROM idx_attestations
         WHERE subject_id = $1 AND is_active = true`,
        [agent],
      );

      const givenTo = new Set(givenRows.map((a) => a.subject_id.toLowerCase()));
      const receivedFrom = receivedRows.map((a) => a.attester_id.toLowerCase());
      return receivedFrom.filter((addr) => givenTo.has(addr));
    } catch {
      return [];
    }
  }

  private async getVotingPartners(agent: string): Promise<Array<{ address: string; mutualUpvotes: number }>> {
    try {
      const { rows: outgoing } = await this.pool.query<{ author_id: string; upvote_count: number }>(
        `SELECT author_id, upvote_count FROM idx_voting_relations
         WHERE voter_id = $1 AND upvote_count > 0
         LIMIT 50`,
        [agent],
      );
      const { rows: incoming } = await this.pool.query<{ voter_id: string; upvote_count: number }>(
        `SELECT voter_id, upvote_count FROM idx_voting_relations
         WHERE author_id = $1 AND upvote_count > 0
         LIMIT 50`,
        [agent],
      );

      const outMap = new Map(outgoing.map((r) => [r.author_id.toLowerCase(), r.upvote_count]));
      return incoming
        .filter((r) => outMap.has(r.voter_id.toLowerCase()))
        .map((r) => ({
          address: r.voter_id.toLowerCase(),
          mutualUpvotes: Math.min(r.upvote_count, outMap.get(r.voter_id.toLowerCase()) ?? 0),
        }));
    } catch {
      return [];
    }
  }

  private async getSpawnSiblings(agent: string): Promise<string[]> {
    try {
      // Find agents that share the same parent or are direct children
      const { rows: asChild } = await this.pool.query<{ parent_id: string }>(
        `SELECT parent_id FROM idx_spawn_relations WHERE child_id = $1`,
        [agent],
      );
      const { rows: asParent } = await this.pool.query<{ child_id: string }>(
        `SELECT child_id FROM idx_spawn_relations WHERE parent_id = $1`,
        [agent],
      );

      const siblings: string[] = [];

      // Direct children are siblings in a sense
      for (const rel of asParent) {
        siblings.push(rel.child_id.toLowerCase());
      }

      // Co-children (share same parent)
      for (const rel of asChild) {
        const { rows: coChildren } = await this.pool.query<{ child_id: string }>(
          `SELECT child_id FROM idx_spawn_relations WHERE parent_id = $1`,
          [rel.parent_id],
        );

        for (const s of coChildren) {
          const addr = s.child_id.toLowerCase();
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
      const { rows } = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM idx_attestations
         WHERE ((attester_id = $1 AND subject_id = $2) OR (attester_id = $2 AND subject_id = $1))
           AND is_active = true`,
        [a, b],
      );
      return parseInt(rows[0]?.cnt ?? "0", 10) >= 2;
    } catch {
      return false;
    }
  }

  private async getMutualVoteCount(a: string, b: string): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ upvote_count: number | null }>(
        `SELECT upvote_count FROM idx_voting_relations
         WHERE voter_id = $1 AND author_id = $2`,
        [a, b],
      );
      const { rows: rows2 } = await this.pool.query<{ upvote_count: number | null }>(
        `SELECT upvote_count FROM idx_voting_relations
         WHERE voter_id = $1 AND author_id = $2`,
        [b, a],
      );
      if (!rows[0]?.upvote_count || !rows2[0]?.upvote_count) return 0;
      return Math.min(rows[0].upvote_count, rows2[0].upvote_count);
    } catch {
      return 0;
    }
  }
}

/** @deprecated Use GuildDetector */
export const CliqueDetector = GuildDetector;
