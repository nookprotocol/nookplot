/**
 * Team assembly service.
 *
 * Assembles optimal teams for a given task by:
 * 1. Extracting required skills from description or explicit list
 * 2. Using SkillMatchingService to find candidates per skill slot
 * 3. Greedy set-cover deduplication to minimize team size
 * 4. Storing request + result for retrieval
 *
 * @module services/teamAssemblyService
 */

import type { Pool } from "pg";
import type { SkillMatchingService, MatchResult } from "./skillMatchingService.js";

// ---- Types ----

export interface TeamMember {
  address: string;
  displayName: string | null;
  matchScore: number;
  coveredSkills: string[];
  contributionScore: number;
  availability: string | null;
}

export interface TeamResult {
  requestId: string;
  members: TeamMember[];
  coverageScore: number;
  coveredSkills: string[];
  gaps: string[];
  status: string;
}

export class TeamAssemblyService {
  private pool: Pool;
  private matchingService: SkillMatchingService;

  constructor(pool: Pool, matchingService: SkillMatchingService) {
    this.pool = pool;
    this.matchingService = matchingService;
  }

  /**
   * Assemble a team for a given task description.
   */
  async assembleTeam(
    requesterId: string,
    description: string,
    requiredSkills?: string[],
    teamSize = 3,
    filters: Record<string, unknown> = {},
  ): Promise<TeamResult> {
    // 1. Determine skills to match
    let skills: string[];

    if (requiredSkills && requiredSkills.length > 0) {
      skills = requiredSkills.map((s) => s.trim()).filter(Boolean).slice(0, 15);
    } else {
      // Extract skills via keyword matching against existing expertise_tags
      skills = await this.extractSkillsFromDescription(description);
    }

    // 2. Store the request
    const { rows: insertRows } = await this.pool.query<{ id: string }>(
      `INSERT INTO team_assembly_requests
         (requester_id, description, required_skills, team_size, filters, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       RETURNING id`,
      [requesterId, description, JSON.stringify(skills), teamSize, JSON.stringify(filters)],
    );
    const requestId = insertRows[0].id;

    try {
      // 3. Get requester address for exclusion
      const { rows: requesterRows } = await this.pool.query<{ address: string }>(
        `SELECT address FROM agents WHERE id = $1`,
        [requesterId],
      );
      const excludeAddresses = requesterRows.length > 0 ? [requesterRows[0].address] : [];

      // 4. Find candidates for all skills at once
      const { matches: allCandidates } = await this.matchingService.matchAgents(skills, {
        count: 50,
        excludeAddresses,
        minReputation: typeof filters.minReputation === "number" ? filters.minReputation : 0,
        availableOnly: filters.availableOnly === true,
      });

      // 5. Greedy set-cover: pick agents that cover the most uncovered skills
      const members: TeamMember[] = [];
      const coveredSkills = new Set<string>();
      const usedAddresses = new Set<string>();
      const skillsLower = skills.map((s) => s.toLowerCase());

      while (members.length < teamSize && allCandidates.length > 0) {
        let bestCandidate: MatchResult | null = null;
        let bestNewSkills: string[] = [];
        let bestIdx = -1;

        for (let i = 0; i < allCandidates.length; i++) {
          const candidate = allCandidates[i];
          if (usedAddresses.has(candidate.address)) continue;

          // Skills this candidate covers that haven't been covered yet
          const newSkills = candidate.matchedSkills
            .filter((s) => skillsLower.includes(s.tag.toLowerCase()) && !coveredSkills.has(s.tag.toLowerCase()))
            .map((s) => s.tag);

          // Prefer candidates covering more uncovered skills, then by match score
          if (newSkills.length > bestNewSkills.length ||
              (newSkills.length === bestNewSkills.length && candidate.matchScore > (bestCandidate?.matchScore ?? 0))) {
            bestCandidate = candidate;
            bestNewSkills = newSkills;
            bestIdx = i;
          }
        }

        if (!bestCandidate) break;

        // If all skills are covered, pick by score only
        const candidateSkills = bestCandidate.matchedSkills
          .filter((s) => skillsLower.includes(s.tag.toLowerCase()))
          .map((s) => s.tag);

        for (const s of candidateSkills) {
          coveredSkills.add(s.toLowerCase());
        }

        members.push({
          address: bestCandidate.address,
          displayName: bestCandidate.displayName,
          matchScore: bestCandidate.matchScore,
          coveredSkills: candidateSkills,
          contributionScore: bestCandidate.contributionScore,
          availability: bestCandidate.availability,
        });

        usedAddresses.add(bestCandidate.address);
        allCandidates.splice(bestIdx, 1);

        // If all skills covered, fill remaining slots by score
        if ([...coveredSkills].length >= skillsLower.length) {
          // Fill remaining slots with highest-scored unused candidates
          const remaining = allCandidates
            .filter((c) => !usedAddresses.has(c.address))
            .sort((a, b) => b.matchScore - a.matchScore);

          for (const c of remaining) {
            if (members.length >= teamSize) break;
            const cSkills = c.matchedSkills
              .filter((s) => skillsLower.includes(s.tag.toLowerCase()))
              .map((s) => s.tag);
            members.push({
              address: c.address,
              displayName: c.displayName,
              matchScore: c.matchScore,
              coveredSkills: cSkills,
              contributionScore: c.contributionScore,
              availability: c.availability,
            });
            usedAddresses.add(c.address);
          }
          break;
        }
      }

      // 6. Compute gaps
      const gaps = skillsLower.filter((s) => !coveredSkills.has(s));
      const coverageScore = skillsLower.length > 0
        ? Math.round(((skillsLower.length - gaps.length) / skillsLower.length) * 100) / 100
        : 1.0;

      const result: TeamResult = {
        requestId,
        members,
        coverageScore,
        coveredSkills: [...coveredSkills],
        gaps,
        status: "completed",
      };

      // 7. Update request with result
      await this.pool.query(
        `UPDATE team_assembly_requests
         SET status = 'completed', result = $1, completed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(result), requestId],
      );

      return result;
    } catch (error) {
      // Mark request as failed
      await this.pool.query(
        `UPDATE team_assembly_requests SET status = 'failed' WHERE id = $1`,
        [requestId],
      ).catch(() => {});
      throw error;
    }
  }

  /**
   * Extract skills from a description by matching against known expertise_tags.
   */
  private async extractSkillsFromDescription(description: string): Promise<string[]> {
    const words = description.toLowerCase().split(/[\s,;.!?()[\]{}<>]+/).filter((w) => w.length >= 2);

    // Get all known tags
    const { rows: knownTags } = await this.pool.query<{ tag: string }>(
      `SELECT DISTINCT LOWER(tag) AS tag FROM expertise_tags`,
    );

    const tagSet = new Set(knownTags.map((t) => t.tag));
    const matched = new Set<string>();

    // Single word matches
    for (const word of words) {
      if (tagSet.has(word)) {
        matched.add(word);
      }
    }

    // Two-word phrase matches (e.g., "machine learning")
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (tagSet.has(phrase)) {
        matched.add(phrase);
      }
    }

    return [...matched].slice(0, 15);
  }
}
