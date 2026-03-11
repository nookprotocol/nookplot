/**
 * Skill-based agent matching service.
 *
 * Finds agents whose expertise tags match requested skills, ranked by
 * a composite score of skill match, contribution score, availability,
 * collaboration history, and recency.
 *
 * @module services/skillMatchingService
 */

import type { Pool } from "pg";
import type { CollaborationTracker } from "./collaborationTracker.js";

// ---- Types ----

export interface MatchOptions {
  count?: number;
  availableOnly?: boolean;
  minReputation?: number;
  excludeAddresses?: string[];
}

export interface MatchedSkill {
  tag: string;
  confidence: number;
  verificationLevel: string;
}

export interface MatchResult {
  address: string;
  displayName: string | null;
  matchScore: number;
  matchedSkills: MatchedSkill[];
  contributionScore: number;
  availability: string | null;
  collabSuccessRate: number;
  lastActive: string | null;
}

/** Verification level → confidence multiplier for scoring. */
const VERIFICATION_MULTIPLIER: Record<string, number> = {
  self_reported: 0.5,
  inferred: 0.7,
  activity_verified: 1.0,
  externally_verified: 1.0,
};

export class SkillMatchingService {
  private pool: Pool;
  private collabTracker: CollaborationTracker;

  constructor(pool: Pool, collabTracker: CollaborationTracker) {
    this.pool = pool;
    this.collabTracker = collabTracker;
  }

  /**
   * Find agents matching the requested skills, ranked by composite score.
   */
  async matchAgents(
    skills: string[],
    options: MatchOptions = {},
  ): Promise<{ matches: MatchResult[]; total: number }> {
    const count = Math.min(Math.max(options.count ?? 10, 1), 50);
    const normalizedSkills = skills.map((s) => s.toLowerCase().trim()).filter(Boolean);

    if (normalizedSkills.length === 0) {
      return { matches: [], total: 0 };
    }

    // Find agents with matching expertise tags
    const excludeClause = options.excludeAddresses && options.excludeAddresses.length > 0
      ? `AND LOWER(a.address) <> ALL($2::text[])`
      : "";
    const params: unknown[] = [normalizedSkills];
    if (options.excludeAddresses && options.excludeAddresses.length > 0) {
      params.push(options.excludeAddresses.map((a) => a.toLowerCase()));
    }

    const { rows: candidates } = await this.pool.query<{
      agent_id: string;
      address: string;
      display_name: string | null;
      tag: string;
      confidence: number;
      verification_level: string;
      overall_score: number | null;
      last_heartbeat: string | null;
      availability: string | null;
    }>(
      `SELECT a.id AS agent_id, a.address, a.display_name,
              et.tag, et.confidence, et.verification_level,
              cs.overall_score,
              rs.last_heartbeat,
              rs.metadata->>'availability' AS availability
       FROM expertise_tags et
       JOIN agents a ON a.id = et.agent_id
       LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
       LEFT JOIN runtime_sessions rs ON rs.agent_id = a.id AND rs.disconnected_at IS NULL
       WHERE LOWER(et.tag) = ANY($1::text[])
         AND a.status = 'active'
         ${excludeClause}
       ORDER BY et.confidence DESC`,
      params,
    );

    // Group by agent
    const agentMap = new Map<string, {
      agentId: string;
      address: string;
      displayName: string | null;
      matchedSkills: MatchedSkill[];
      overallScore: number;
      lastHeartbeat: string | null;
      availability: string | null;
    }>();

    for (const row of candidates) {
      const existing = agentMap.get(row.address);
      const skill: MatchedSkill = {
        tag: row.tag,
        confidence: row.confidence,
        verificationLevel: row.verification_level,
      };

      if (existing) {
        existing.matchedSkills.push(skill);
      } else {
        agentMap.set(row.address, {
          agentId: row.agent_id,
          address: row.address,
          displayName: row.display_name,
          matchedSkills: [skill],
          overallScore: row.overall_score ?? 0,
          lastHeartbeat: row.last_heartbeat,
          availability: row.availability,
        });
      }
    }

    // Filter
    let agentEntries = [...agentMap.values()];

    if (options.availableOnly) {
      agentEntries = agentEntries.filter((a) => a.availability === "accepting_work");
    }

    if (options.minReputation !== undefined && options.minReputation > 0) {
      agentEntries = agentEntries.filter((a) => a.overallScore >= options.minReputation!);
    }

    const total = agentEntries.length;

    // Compute max contribution score for normalization
    const maxContribution = Math.max(1, ...agentEntries.map((a) => a.overallScore));

    // Score each agent
    const scored: Array<{ entry: typeof agentEntries[0]; score: number; collabRate: number }> = [];

    for (const entry of agentEntries) {
      // Skill match score: sum of (confidence * verification multiplier) per matched tag
      const skillMatchScore = entry.matchedSkills.reduce((sum, s) => {
        const mult = VERIFICATION_MULTIPLIER[s.verificationLevel] ?? 0.5;
        return sum + s.confidence * mult;
      }, 0);

      // Contribution weight: normalized 0-1
      const contributionWeight = entry.overallScore / maxContribution;

      // Availability bonus
      let availabilityBonus = 1.0;
      if (entry.availability === "accepting_work") availabilityBonus = 1.2;
      else if (entry.availability === "busy") availabilityBonus = 0.5;

      // Collaboration success rate
      const collabRate = await this.collabTracker.getCollabSuccessRate(entry.agentId);

      // Recency factor: decay based on last heartbeat
      let recencyFactor = 0.5;
      if (entry.lastHeartbeat) {
        const daysSince = (Date.now() - new Date(entry.lastHeartbeat).getTime()) / (1000 * 60 * 60 * 24);
        recencyFactor = Math.exp(-0.05 * daysSince);
      }

      // Composite score
      const score = skillMatchScore
        * (0.3 + 0.7 * contributionWeight) // contribution weight has 0.3 floor
        * availabilityBonus
        * collabRate
        * recencyFactor;

      scored.push({ entry, score, collabRate });
    }

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, count);

    const matches: MatchResult[] = topResults.map((s) => ({
      address: s.entry.address,
      displayName: s.entry.displayName,
      matchScore: Math.round(s.score * 100) / 100,
      matchedSkills: s.entry.matchedSkills,
      contributionScore: s.entry.overallScore,
      availability: s.entry.availability,
      collabSuccessRate: Math.round(s.collabRate * 100) / 100,
      lastActive: s.entry.lastHeartbeat ?? null,
    }));

    return { matches, total };
  }
}
