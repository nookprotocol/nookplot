/**
 * Off-chain Sybil detection service.
 *
 * Detects coordinated account creation, attestation farming, vote cartels,
 * and other suspicious patterns. Detection only — does NOT auto-penalize.
 * False positives are worse than false negatives in early stages.
 *
 * 5 detection algorithms:
 * 1. Temporal Registration Clustering — 3+ agents created within 10-min window
 * 2. Attestation Fan-In / Rings — many fresh accounts all attesting same target
 * 3. Voting Alignment — groups with Jaccard similarity >0.8 on vote sets
 * 4. Cross-Dimensional Anomaly — high trust but zero content, etc.
 * 5. Low Reciprocity — receives attestations but never gives
 *
 * Pattern reference: gateway/src/services/cliqueDetector.ts
 *
 * @module services/sybilDetector
 */

import type { Pool } from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "./subgraphGateway.js";

// ============================================================
//  Types
// ============================================================

export type SignalType =
  | "temporal_cluster"
  | "attestation_fan_in"
  | "vote_alignment"
  | "dimension_anomaly"
  | "low_reciprocity";

export interface FraudSignal {
  id: string;
  agentId: string;
  signalType: SignalType;
  severity: number;
  details: Record<string, unknown>;
  resolution: "open" | "resolved" | "dismissed";
  createdAt: string;
}

export interface SybilScore {
  agentId: string;
  address: string;
  suspicionScore: number;
  signalCount: number;
  highestSignal: string | null;
  computedAt: string;
}

export interface ScanResult {
  signalsCreated: number;
  relationshipsCreated: number;
  scoresUpdated: number;
  duration: number;
}

// ============================================================
//  SybilDetector
// ============================================================

export class SybilDetector {
  private readonly pool: Pool;
  private readonly subgraphGateway: SubgraphGateway | undefined;

  constructor(pool: Pool, subgraphGateway?: SubgraphGateway) {
    this.pool = pool;
    this.subgraphGateway = subgraphGateway;
  }

  /**
   * Run all detection algorithms and update scores.
   */
  async runScan(): Promise<ScanResult> {
    const start = Date.now();
    let signalsCreated = 0;
    let relationshipsCreated = 0;

    try {
      signalsCreated += await this.detectTemporalClusters();
      signalsCreated += await this.detectDimensionAnomalies();
      signalsCreated += await this.detectLowReciprocity();

      if (this.subgraphGateway) {
        signalsCreated += await this.detectAttestationFanIn();
        signalsCreated += await this.detectVoteAlignment();
      }

      const scoresUpdated = await this.recomputeScores();
      const duration = Date.now() - start;

      logSecurityEvent("info", "sybil-scan-complete", {
        signalsCreated,
        relationshipsCreated,
        scoresUpdated,
        durationMs: duration,
      });

      return { signalsCreated, relationshipsCreated, scoresUpdated, duration };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "sybil-scan-failed", { error: msg });
      return { signalsCreated, relationshipsCreated, scoresUpdated: 0, duration: Date.now() - start };
    }
  }

  // -------------------------------------------------------
  //  Algorithm 1: Temporal Registration Clustering
  // -------------------------------------------------------

  /**
   * Detect groups of 3+ agents registered within a 10-minute window.
   * Uses gateway's agents table (created_at).
   */
  private async detectTemporalClusters(): Promise<number> {
    const WINDOW_MINUTES = 10;
    const MIN_CLUSTER_SIZE = 3;
    let created = 0;

    try {
      // Find agents registered in the last 30 days, grouped by 10-min windows
      const { rows } = await this.pool.query<{
        window_start: string;
        agent_ids: string[];
        addresses: string[];
        count: string;
      }>(
        `WITH windowed AS (
           SELECT id, address, created_at,
                  date_trunc('hour', created_at) +
                    (EXTRACT(MINUTE FROM created_at)::int / $1) * ($1 || ' minutes')::interval
                    AS window_start
           FROM agents
           WHERE created_at > NOW() - INTERVAL '30 days'
             AND status = 'active'
         )
         SELECT window_start::text,
                array_agg(id::text) AS agent_ids,
                array_agg(address) AS addresses,
                COUNT(*)::text AS count
         FROM windowed
         GROUP BY window_start
         HAVING COUNT(*) >= $2
         ORDER BY window_start DESC`,
        [WINDOW_MINUTES, MIN_CLUSTER_SIZE],
      );

      for (const row of rows) {
        const clusterSize = parseInt(row.count, 10);
        const severity = Math.min(100, Math.round((clusterSize / 10) * 100));

        for (const agentId of row.agent_ids) {
          created += await this.upsertSignal(agentId, "temporal_cluster", severity, {
            windowStart: row.window_start,
            clusterSize,
            peerAddresses: row.addresses,
          });
        }

        // Create pairwise relationships
        for (let i = 0; i < row.agent_ids.length; i++) {
          for (let j = i + 1; j < row.agent_ids.length; j++) {
            await this.upsertRelationship(
              row.agent_ids[i],
              row.agent_ids[j],
              "temporal_cohort",
              Math.min(1, clusterSize / 10),
              { windowStart: row.window_start },
            );
          }
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "sybil-temporal-cluster-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return created;
  }

  // -------------------------------------------------------
  //  Algorithm 2: Attestation Fan-In / Rings
  // -------------------------------------------------------

  /**
   * Detect many fresh/low-tenure accounts all attesting the same target.
   * Also detects closed attestation loops among low-tenure agents.
   */
  private async detectAttestationFanIn(): Promise<number> {
    if (!this.subgraphGateway) return 0;
    let created = 0;

    try {
      // Find agents with many attestations from low-tenure accounts
      const data = await this.querySubgraph<{
        agents: Array<{
          id: string;
          attestationCount: number;
          registeredAt: string;
        }>;
      }>(`{
        agents(
          where: { attestationCount_gt: 3 }
          first: 100
          orderBy: attestationCount
          orderDirection: desc
        ) {
          id
          attestationCount
          registeredAt
        }
      }`);

      const now = Math.floor(Date.now() / 1000);

      for (const agent of data.agents) {
        // Fetch who attested this agent
        const attData = await this.querySubgraph<{
          attestations: Array<{
            attester: string;
            timestamp: string;
          }>;
        }>(`
          query($subject: Bytes!) {
            attestations(where: { subject: $subject, isActive: true }, first: 100) {
              attester
              timestamp
            }
          }
        `, { subject: agent.id });

        // Check how many attesters are "fresh" (registered < 7 days ago)
        let freshAttesterCount = 0;
        const freshAttesters: string[] = [];

        for (const att of attData.attestations) {
          // Look up the attester's registration in the agents table
          const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
            `SELECT id, created_at FROM agents WHERE LOWER(address) = LOWER($1)`,
            [att.attester],
          );
          if (rows.length > 0) {
            const attesterAge = (now - rows[0].created_at.getTime() / 1000) / 86400;
            if (attesterAge < 7) {
              freshAttesterCount++;
              freshAttesters.push(att.attester);
            }
          }
        }

        if (freshAttesterCount >= 3) {
          const severity = Math.min(100, Math.round((freshAttesterCount / agent.attestationCount) * 100));

          // Signal on the target (recipient of suspicious attestations)
          const { rows: targetRows } = await this.pool.query<{ id: string }>(
            `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
            [agent.id],
          );
          if (targetRows.length > 0) {
            created += await this.upsertSignal(targetRows[0].id, "attestation_fan_in", severity, {
              freshAttesterCount,
              totalAttestations: agent.attestationCount,
              freshAttesters,
            });
          }
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "sybil-attestation-fan-in-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return created;
  }

  // -------------------------------------------------------
  //  Algorithm 3: Voting Alignment
  // -------------------------------------------------------

  /**
   * Detect groups of agents with Jaccard similarity > 0.8 on their vote sets.
   */
  private async detectVoteAlignment(): Promise<number> {
    if (!this.subgraphGateway) return 0;
    let created = 0;

    try {
      // Fetch all voting relations (voter -> author with upvotes)
      const data = await this.querySubgraph<{
        votingRelations: Array<{
          voter: string;
          author: string;
          upvoteCount: number;
        }>;
      }>(`{
        votingRelations(
          where: { upvoteCount_gt: 0 }
          first: 1000
          orderBy: upvoteCount
          orderDirection: desc
        ) {
          voter
          author
          upvoteCount
        }
      }`);

      // Build vote sets: voter -> Set<author they upvoted>
      const voteSets = new Map<string, Set<string>>();
      for (const vr of data.votingRelations) {
        const voter = vr.voter.toLowerCase();
        if (!voteSets.has(voter)) voteSets.set(voter, new Set());
        voteSets.get(voter)!.add(vr.author.toLowerCase());
      }

      // Only check voters with at least 3 votes
      const voters = [...voteSets.entries()].filter(([, set]) => set.size >= 3);

      // Pairwise Jaccard similarity
      for (let i = 0; i < voters.length; i++) {
        for (let j = i + 1; j < voters.length; j++) {
          const [voterA, setA] = voters[i];
          const [voterB, setB] = voters[j];

          const intersection = [...setA].filter((x) => setB.has(x)).length;
          const union = new Set([...setA, ...setB]).size;
          const jaccard = union > 0 ? intersection / union : 0;

          if (jaccard > 0.8) {
            const severity = Math.round(jaccard * 100);

            // Look up both agent IDs
            const { rows: rowsA } = await this.pool.query<{ id: string }>(
              `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
              [voterA],
            );
            const { rows: rowsB } = await this.pool.query<{ id: string }>(
              `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
              [voterB],
            );

            if (rowsA.length > 0 && rowsB.length > 0) {
              created += await this.upsertSignal(rowsA[0].id, "vote_alignment", severity, {
                peerAddress: voterB,
                jaccard,
                sharedVotes: intersection,
              });
              created += await this.upsertSignal(rowsB[0].id, "vote_alignment", severity, {
                peerAddress: voterA,
                jaccard,
                sharedVotes: intersection,
              });

              await this.upsertRelationship(
                rowsA[0].id,
                rowsB[0].id,
                "vote_bloc",
                jaccard,
                { sharedVotes: intersection, totalUnion: union },
              );
            }
          }
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "sybil-vote-alignment-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return created;
  }

  // -------------------------------------------------------
  //  Algorithm 4: Cross-Dimensional Anomaly
  // -------------------------------------------------------

  /**
   * Detect agents with anomalous dimension profiles:
   * - High attestation count but zero posts (trust without substance)
   * - High influence (followers) but zero posts
   */
  private async detectDimensionAnomalies(): Promise<number> {
    let created = 0;

    try {
      // Agents with attestations received (from others' signals) but zero posts
      // We check the contribution_scores table for post activity
      const { rows } = await this.pool.query<{
        id: string;
        address: string;
        created_at: Date;
      }>(
        `SELECT a.id, a.address, a.created_at
         FROM agents a
         WHERE a.status = 'active'
           AND a.did_cid IS NOT NULL
           AND a.created_at < NOW() - INTERVAL '7 days'
           AND NOT EXISTS (
             SELECT 1 FROM contribution_scores cs
             WHERE cs.agent_id = a.id AND cs.overall_score > 0
           )`,
      );

      const now = Date.now();
      for (const row of rows) {
        const ageInDays = (now - row.created_at.getTime()) / 86400000;
        if (ageInDays < 14) continue; // give new agents time

        const severity = Math.min(60, Math.round(ageInDays / 30 * 30)); // severity grows with age

        created += await this.upsertSignal(row.id, "dimension_anomaly", severity, {
          anomalyType: "registered_no_activity",
          ageInDays: Math.round(ageInDays),
          address: row.address,
        });
      }
    } catch (err) {
      logSecurityEvent("warn", "sybil-dimension-anomaly-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return created;
  }

  // -------------------------------------------------------
  //  Algorithm 5: Low Reciprocity
  // -------------------------------------------------------

  /**
   * Detect agents that receive attestations but never give them,
   * or vote prolifically but never post.
   */
  private async detectLowReciprocity(): Promise<number> {
    if (!this.subgraphGateway) return 0;
    let created = 0;

    try {
      // Find agents that have received attestations but given none
      const data = await this.querySubgraph<{
        agents: Array<{
          id: string;
          attestationCount: number;
        }>;
      }>(`{
        agents(
          where: { attestationCount_gt: 2 }
          first: 200
        ) {
          id
          attestationCount
        }
      }`);

      for (const agent of data.agents) {
        // Check if this agent has given any attestations
        const givenData = await this.querySubgraph<{
          attestations: Array<{ id: string }>;
        }>(`
          query($attester: Bytes!) {
            attestations(where: { attester: $attester, isActive: true }, first: 1) {
              id
            }
          }
        `, { attester: agent.id });

        if (givenData.attestations.length === 0 && agent.attestationCount >= 3) {
          // Has received 3+ attestations but given none — suspicious
          const { rows } = await this.pool.query<{ id: string }>(
            `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
            [agent.id],
          );

          if (rows.length > 0) {
            const severity = Math.min(50, agent.attestationCount * 10);
            created += await this.upsertSignal(rows[0].id, "low_reciprocity", severity, {
              attestationsReceived: agent.attestationCount,
              attestationsGiven: 0,
              reciprocityType: "attestation_asymmetry",
            });
          }
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "sybil-low-reciprocity-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return created;
  }

  // -------------------------------------------------------
  //  Score Recomputation
  // -------------------------------------------------------

  /**
   * Recompute composite suspicion scores from all open fraud signals.
   */
  private async recomputeScores(): Promise<number> {
    try {
      // Get all agents with open signals
      const { rows } = await this.pool.query<{
        agent_id: string;
        signal_count: string;
        max_severity: string;
        avg_severity: string;
        highest_type: string;
      }>(
        `SELECT agent_id,
                COUNT(*)::text AS signal_count,
                MAX(severity)::text AS max_severity,
                AVG(severity)::text AS avg_severity,
                (SELECT signal_type FROM fraud_signals fs2
                 WHERE fs2.agent_id = fs.agent_id AND fs2.resolution = 'open'
                 ORDER BY severity DESC LIMIT 1) AS highest_type
         FROM fraud_signals fs
         WHERE resolution = 'open'
         GROUP BY agent_id`,
      );

      let updated = 0;
      for (const row of rows) {
        const signalCount = parseInt(row.signal_count, 10);
        const maxSeverity = parseInt(row.max_severity, 10);
        const avgSeverity = parseFloat(row.avg_severity);

        // Composite score: weighted combination of max severity, average, and count
        // More signals and higher severity = higher suspicion
        const score = Math.min(1.0,
          (maxSeverity / 100) * 0.5 +
          (avgSeverity / 100) * 0.3 +
          Math.min(signalCount / 10, 1) * 0.2,
        );

        await this.pool.query(
          `INSERT INTO sybil_scores (agent_id, suspicion_score, signal_count, highest_signal, computed_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (agent_id) DO UPDATE SET
             suspicion_score = EXCLUDED.suspicion_score,
             signal_count = EXCLUDED.signal_count,
             highest_signal = EXCLUDED.highest_signal,
             computed_at = NOW()`,
          [row.agent_id, score, signalCount, row.highest_type],
        );
        updated++;
      }

      // Clear scores for agents with no open signals
      await this.pool.query(
        `DELETE FROM sybil_scores
         WHERE agent_id NOT IN (
           SELECT DISTINCT agent_id FROM fraud_signals WHERE resolution = 'open'
         )`,
      );

      return updated;
    } catch (err) {
      logSecurityEvent("warn", "sybil-score-recompute-error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // -------------------------------------------------------
  //  Query helpers
  // -------------------------------------------------------

  /** Upsert a fraud signal. Returns 1 if created, 0 if updated. */
  private async upsertSignal(
    agentId: string,
    signalType: SignalType,
    severity: number,
    details: Record<string, unknown>,
  ): Promise<number> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO fraud_signals (agent_id, signal_type, severity, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [agentId, signalType, severity, JSON.stringify(details)],
    );
    return rowCount ?? 0;
  }

  /** Upsert a pairwise relationship. */
  private async upsertRelationship(
    agentA: string,
    agentB: string,
    relationship: string,
    strength: number,
    details: Record<string, unknown>,
  ): Promise<void> {
    // Ensure a < b for the CHECK constraint
    const [a, b] = agentA < agentB ? [agentA, agentB] : [agentB, agentA];
    await this.pool.query(
      `INSERT INTO agent_relationships (agent_a, agent_b, relationship, strength, details)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_a, agent_b, relationship)
       DO UPDATE SET strength = EXCLUDED.strength, details = EXCLUDED.details`,
      [a, b, relationship, strength, JSON.stringify(details)],
    );
  }

  /** Query the subgraph via the centralized gateway. */
  private async querySubgraph<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await this.subgraphGateway!.query<T>(query, variables);
    return result.data;
  }

  // -------------------------------------------------------
  //  Public read methods (for API routes)
  // -------------------------------------------------------

  /** Get paginated sybil scores. */
  async getScores(limit = 50, offset = 0): Promise<{ scores: SybilScore[]; total: number }> {
    const [{ rows }, { rows: countRows }] = await Promise.all([
      this.pool.query<{
        agent_id: string;
        address: string;
        suspicion_score: number;
        signal_count: number;
        highest_signal: string | null;
        computed_at: Date;
      }>(
        `SELECT ss.agent_id, a.address, ss.suspicion_score, ss.signal_count,
                ss.highest_signal, ss.computed_at
         FROM sybil_scores ss
         JOIN agents a ON a.id = ss.agent_id
         ORDER BY ss.suspicion_score DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM sybil_scores`),
    ]);

    return {
      scores: rows.map((r) => ({
        agentId: r.agent_id,
        address: r.address,
        suspicionScore: r.suspicion_score,
        signalCount: r.signal_count,
        highestSignal: r.highest_signal,
        computedAt: r.computed_at.toISOString(),
      })),
      total: parseInt(countRows[0]?.count ?? "0", 10),
    };
  }

  /** Get sybil score for a specific agent address. */
  async getScoreByAddress(address: string): Promise<SybilScore | null> {
    const { rows } = await this.pool.query<{
      agent_id: string;
      address: string;
      suspicion_score: number;
      signal_count: number;
      highest_signal: string | null;
      computed_at: Date;
    }>(
      `SELECT ss.agent_id, a.address, ss.suspicion_score, ss.signal_count,
              ss.highest_signal, ss.computed_at
       FROM sybil_scores ss
       JOIN agents a ON a.id = ss.agent_id
       WHERE LOWER(a.address) = LOWER($1)`,
      [address],
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      agentId: r.agent_id,
      address: r.address,
      suspicionScore: r.suspicion_score,
      signalCount: r.signal_count,
      highestSignal: r.highest_signal,
      computedAt: r.computed_at.toISOString(),
    };
  }

  /** Get fraud signals for an agent address. */
  async getSignalsByAddress(address: string): Promise<FraudSignal[]> {
    const { rows } = await this.pool.query<{
      id: string;
      agent_id: string;
      signal_type: SignalType;
      severity: number;
      details: Record<string, unknown>;
      resolution: "open" | "resolved" | "dismissed";
      created_at: Date;
    }>(
      `SELECT fs.id, fs.agent_id, fs.signal_type, fs.severity, fs.details,
              fs.resolution, fs.created_at
       FROM fraud_signals fs
       JOIN agents a ON a.id = fs.agent_id
       WHERE LOWER(a.address) = LOWER($1)
       ORDER BY fs.severity DESC, fs.created_at DESC`,
      [address],
    );

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      signalType: r.signal_type,
      severity: r.severity,
      details: r.details,
      resolution: r.resolution,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** Resolve a fraud signal. */
  async resolveSignal(signalId: string, resolution: "resolved" | "dismissed", resolvedBy: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE fraud_signals
       SET resolution = $1, resolved_by = $2, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND resolution = 'open'`,
      [resolution, resolvedBy, signalId],
    );
    return (rowCount ?? 0) > 0;
  }
}
