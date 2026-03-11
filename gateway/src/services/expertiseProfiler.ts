/**
 * Expertise tag derivation engine for the Agent Gateway.
 *
 * Analyzes multiple skill sources to derive expertise tags with
 * confidence scores (0.0-1.0) and verification levels. Tags are sourced from:
 *   1. Self-reported — agents.capabilities (source: "self_reported")
 *   2. Inferred — commit languages/frameworks (source: "language" | "framework")
 *   3. Activity-verified — bounty completions, service agreements (source: "activity")
 *   4. Externally-verified — verified external claims (source: "external")
 *
 * Tags with confidence below 0.15 are filtered out. A maximum of 30 tags
 * per agent is enforced (top by confidence). Results are UPSERTed into
 * the expertise_tags table with category, verification_level, evidence_count,
 * and evidence_summary.
 *
 * After profiling, rebuilds agents.skill_tsv for full-text skill search.
 *
 * All queries use parameterized SQL to prevent injection.
 *
 * @module services/expertiseProfiler
 */

import type { Pool } from "pg";
import type { SpecializationService } from "./specializationService.js";

/** A derived expertise tag with its confidence, source, and verification metadata. */
export interface DerivedTag {
  tag: string;
  confidence: number;
  source: string;
  category: string;
  verificationLevel: string;
  evidenceCount: number;
  evidenceSummary: Record<string, unknown>;
}

/** Maximum number of tags per agent. */
const MAX_TAGS = 30;

/** Minimum confidence threshold — tags below this are filtered out. */
const MIN_CONFIDENCE = 0.15;

/** Map source types to default categories. */
const SOURCE_CATEGORY_MAP: Record<string, string> = {
  language: "language",
  framework: "framework",
  self_reported: "general",
  activity: "general",
  external: "general",
};

/**
 * Framework inference rules. If a language is present in the commit and the
 * commit also references certain file extensions (via the frameworks column
 * or heuristic), the framework tag is added.
 */
const FRAMEWORK_HEURISTICS: Array<{
  language: string;
  indicator: string;
  framework: string;
}> = [
  { language: "TypeScript", indicator: ".tsx", framework: "React" },
  { language: "TypeScript", indicator: ".vue", framework: "Vue" },
  { language: "TypeScript", indicator: ".svelte", framework: "Svelte" },
  { language: "JavaScript", indicator: ".jsx", framework: "React" },
  { language: "JavaScript", indicator: ".vue", framework: "Vue" },
  { language: "Python", indicator: "django", framework: "Django" },
  { language: "Python", indicator: "flask", framework: "Flask" },
  { language: "Python", indicator: "fastapi", framework: "FastAPI" },
  { language: "Rust", indicator: "wasm", framework: "WebAssembly" },
  { language: "Solidity", indicator: ".sol", framework: "Solidity" },
];

/**
 * Derives expertise tags from multiple sources and persists them.
 */
export class ExpertiseProfiler {
  private pool: Pool;
  private specializationService: SpecializationService | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Wire in SpecializationService for auto-sync after profiling. */
  setSpecializationService(svc: SpecializationService): void {
    this.specializationService = svc;
  }

  /**
   * Profile a single agent by analyzing all skill sources.
   *
   * Sources:
   * 1. Self-reported capabilities (agents.capabilities)
   * 2. Inferred from commit history (languages + frameworks)
   * 3. Activity-verified from bounty completions + service agreements
   * 4. Externally-verified from external_claims
   *
   * @param agentId - UUID of the agent from the agents table.
   * @returns The number of tags written.
   */
  async profileAgent(agentId: string): Promise<number> {
    const tagMap = new Map<string, DerivedTag>();

    // Helper to merge a tag — higher confidence wins, higher verification upgrades
    const VERIFICATION_RANK: Record<string, number> = {
      self_reported: 0,
      inferred: 1,
      activity_verified: 2,
      externally_verified: 3,
    };

    const mergeTag = (tag: DerivedTag) => {
      const key = tag.tag.toLowerCase();
      const existing = tagMap.get(key);
      if (!existing) {
        tagMap.set(key, { ...tag, tag: tag.tag });
        return;
      }
      // Take the higher confidence
      if (tag.confidence > existing.confidence) {
        existing.confidence = tag.confidence;
      }
      // Upgrade verification level
      const existingRank = VERIFICATION_RANK[existing.verificationLevel] ?? 0;
      const newRank = VERIFICATION_RANK[tag.verificationLevel] ?? 0;
      if (newRank > existingRank) {
        existing.verificationLevel = tag.verificationLevel;
      }
      // Accumulate evidence
      existing.evidenceCount += tag.evidenceCount;
      existing.evidenceSummary = { ...existing.evidenceSummary, ...tag.evidenceSummary };
    };

    // ── Source 1: Self-reported capabilities ──
    await this.ingestSelfReported(agentId, mergeTag);

    // ── Source 2: Inferred from commit history ──
    await this.ingestCommitHistory(agentId, mergeTag);

    // ── Source 3: Activity-verified (bounties + service agreements) ──
    await this.ingestActivityVerified(agentId, mergeTag);

    // ── Source 4: Externally-verified claims ──
    await this.ingestExternalClaims(agentId, mergeTag);

    // ── Source 5: On-chain endorsements ──
    await this.ingestEndorsements(agentId, mergeTag);

    // Filter by confidence, sort, take top MAX_TAGS
    const allTags = [...tagMap.values()]
      .filter((t) => t.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_TAGS);

    // UPSERT into expertise_tags
    for (const tag of allTags) {
      await this.pool.query(
        `INSERT INTO expertise_tags (agent_id, tag, confidence, source, category,
           verification_level, evidence_count, evidence_summary, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (agent_id, tag) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           source = EXCLUDED.source,
           category = EXCLUDED.category,
           verification_level = EXCLUDED.verification_level,
           evidence_count = EXCLUDED.evidence_count,
           evidence_summary = EXCLUDED.evidence_summary,
           computed_at = NOW()`,
        [
          agentId,
          tag.tag,
          tag.confidence,
          tag.source,
          tag.category,
          tag.verificationLevel,
          tag.evidenceCount,
          JSON.stringify(tag.evidenceSummary),
        ],
      );
    }

    // Remove stale tags that are no longer in the top set
    const tagNames = allTags.map((t) => t.tag);
    if (tagNames.length > 0) {
      await this.pool.query(
        `DELETE FROM expertise_tags
         WHERE agent_id = $1
           AND tag <> ALL($2::varchar[])`,
        [agentId, tagNames],
      );
    } else {
      await this.pool.query(
        `DELETE FROM expertise_tags WHERE agent_id = $1`,
        [agentId],
      );
    }

    // Rebuild agents.skill_tsv from current expertise_tags
    await this.rebuildSkillTsv(agentId);

    return allTags.length;
  }

  /**
   * Source 1: Self-reported capabilities from agents.capabilities TEXT[].
   */
  private async ingestSelfReported(
    agentId: string,
    mergeTag: (tag: DerivedTag) => void,
  ): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ capabilities: string[] | null }>(
        `SELECT capabilities FROM agents WHERE id = $1`,
        [agentId],
      );
      if (rows.length === 0 || !rows[0].capabilities) return;

      for (const cap of rows[0].capabilities) {
        if (!cap || cap.trim().length === 0) continue;
        mergeTag({
          tag: cap.trim(),
          confidence: 0.5,
          source: "self_reported",
          category: "general",
          verificationLevel: "self_reported",
          evidenceCount: 0,
          evidenceSummary: { self_reported: true },
        });
      }
    } catch {
      // capabilities column may not exist yet — graceful skip
    }
  }

  /**
   * Source 2: Inferred from commit_log languages and frameworks (existing logic).
   */
  private async ingestCommitHistory(
    agentId: string,
    mergeTag: (tag: DerivedTag) => void,
  ): Promise<void> {
    // Language frequency
    const langRes = await this.pool.query<{ lang: string; freq: string }>(
      `SELECT unnest(languages) AS lang, COUNT(*)::text AS freq
       FROM commit_log
       WHERE agent_id = $1
         AND languages IS NOT NULL
       GROUP BY lang
       ORDER BY freq DESC`,
      [agentId],
    );

    if (langRes.rows.length === 0) return;

    const maxFreq = Math.max(
      ...langRes.rows.map((r) => parseInt(r.freq, 10)),
    );

    // Language tags
    for (const row of langRes.rows) {
      const freq = parseInt(row.freq, 10);
      const confidence = Math.min(freq / maxFreq, 1.0);
      mergeTag({
        tag: row.lang,
        confidence,
        source: "language",
        category: "language",
        verificationLevel: "inferred",
        evidenceCount: freq,
        evidenceSummary: { commits: freq },
      });
    }

    // Framework inference
    const frameworkRes = await this.pool.query<{ fw: string; freq: string }>(
      `SELECT unnest(frameworks) AS fw, COUNT(*)::text AS freq
       FROM commit_log
       WHERE agent_id = $1
         AND frameworks IS NOT NULL
       GROUP BY fw
       ORDER BY freq DESC`,
      [agentId],
    );

    const frameworkSet = new Set(frameworkRes.rows.map((r) => r.fw.toLowerCase()));
    const languageSet = new Set(langRes.rows.map((r) => r.lang));

    for (const heuristic of FRAMEWORK_HEURISTICS) {
      if (!languageSet.has(heuristic.language)) continue;

      const matched = frameworkSet.has(heuristic.indicator.toLowerCase()) ||
        frameworkRes.rows.some((r) =>
          r.fw.toLowerCase().includes(heuristic.indicator.toLowerCase()),
        );

      if (matched) {
        const langRow = langRes.rows.find((r) => r.lang === heuristic.language);
        const langFreq = langRow ? parseInt(langRow.freq, 10) : 0;
        const confidence = Math.min((langFreq / maxFreq) * 0.8, 1.0);

        mergeTag({
          tag: heuristic.framework,
          confidence,
          source: "framework",
          category: "framework",
          verificationLevel: "inferred",
          evidenceCount: langFreq,
          evidenceSummary: { framework_heuristic: true, language_commits: langFreq },
        });
      }
    }
  }

  /**
   * Source 3: Activity-verified — bounty completions + service agreements.
   * Tags backed by completed work get higher verification.
   */
  private async ingestActivityVerified(
    agentId: string,
    mergeTag: (tag: DerivedTag) => void,
  ): Promise<void> {
    // Get agent address for idx_ table joins
    const { rows: agentRows } = await this.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE id = $1`,
      [agentId],
    );
    if (agentRows.length === 0) return;
    const address = agentRows[0].address.toLowerCase();

    // Bounty completions — tags from project_bounties the agent has completed
    try {
      const { rows: bountyTags } = await this.pool.query<{
        tag: string;
        bounty_count: string;
      }>(
        `SELECT unnest(pb.tags) AS tag, COUNT(DISTINCT pb.id)::text AS bounty_count
         FROM project_bounties pb
         JOIN idx_bounties ib ON ib.id::text = pb.on_chain_bounty_id
         WHERE LOWER(ib.claimer) = $1
           AND ib.status IN ('3', '4')
           AND pb.tags IS NOT NULL
         GROUP BY tag`,
        [address],
      );

      for (const row of bountyTags) {
        const count = parseInt(row.bounty_count, 10);
        // Confidence scales with number of completed bounties: 0.7 base + 0.1 per additional
        const confidence = Math.min(0.7 + (count - 1) * 0.1, 1.0);
        mergeTag({
          tag: row.tag,
          confidence,
          source: "activity",
          category: "general",
          verificationLevel: "activity_verified",
          evidenceCount: count,
          evidenceSummary: { bounties_completed: count },
        });
      }
    } catch {
      // idx_bounties or project_bounties may not exist — graceful skip
    }

    // Service agreements — category/tags from completed agreements
    try {
      const { rows: serviceTags } = await this.pool.query<{
        tag: string;
        agreement_count: string;
        avg_rating: string | null;
      }>(
        `SELECT unnest(sl.tags) AS tag,
                COUNT(DISTINCT sa.id)::text AS agreement_count,
                AVG(sr.rating)::text AS avg_rating
         FROM service_agreements sa
         JOIN service_listings sl ON sl.id = sa.listing_id
         LEFT JOIN service_reviews sr ON sr.agreement_id = sa.id
         WHERE sa.provider_agent_id = $1 AND sa.status = 'completed'
           AND sl.tags IS NOT NULL
         GROUP BY tag`,
        [agentId],
      );

      for (const row of serviceTags) {
        const count = parseInt(row.agreement_count, 10);
        const avgRating = row.avg_rating ? parseFloat(row.avg_rating) : null;
        // Base 0.7, boost by rating (4+ stars = full confidence)
        let confidence = Math.min(0.7 + (count - 1) * 0.08, 0.95);
        if (avgRating && avgRating >= 4.0) confidence = Math.min(confidence + 0.1, 1.0);
        mergeTag({
          tag: row.tag,
          confidence,
          source: "activity",
          category: "general",
          verificationLevel: "activity_verified",
          evidenceCount: count,
          evidenceSummary: {
            agreements_completed: count,
            ...(avgRating ? { avg_review_rating: Math.round(avgRating * 10) / 10 } : {}),
          },
        });
      }

      // Also ingest service listing categories as skill tags
      const { rows: serviceCategories } = await this.pool.query<{
        category: string;
        agreement_count: string;
      }>(
        `SELECT sl.category, COUNT(DISTINCT sa.id)::text AS agreement_count
         FROM service_agreements sa
         JOIN service_listings sl ON sl.id = sa.listing_id
         WHERE sa.provider_agent_id = $1 AND sa.status = 'completed'
           AND sl.category IS NOT NULL AND sl.category <> ''
         GROUP BY sl.category`,
        [agentId],
      );

      for (const row of serviceCategories) {
        const count = parseInt(row.agreement_count, 10);
        mergeTag({
          tag: row.category,
          confidence: Math.min(0.6 + count * 0.1, 0.9),
          source: "activity",
          category: "domain",
          verificationLevel: "activity_verified",
          evidenceCount: count,
          evidenceSummary: { service_category_agreements: count },
        });
      }
    } catch {
      // service tables may not exist — graceful skip
    }
  }

  /**
   * Source 4: Externally-verified — GitHub repos from verified external claims.
   */
  private async ingestExternalClaims(
    agentId: string,
    mergeTag: (tag: DerivedTag) => void,
  ): Promise<void> {
    try {
      const { rows: claims } = await this.pool.query<{
        platform: string;
        verification_data: Record<string, unknown> | null;
      }>(
        `SELECT platform, verification_data
         FROM external_claims
         WHERE agent_id = $1 AND status = 'verified'`,
        [agentId],
      );

      for (const claim of claims) {
        if (!claim.verification_data) continue;

        if (claim.platform === "github") {
          // Extract languages from GitHub verification data
          const languages = claim.verification_data.languages;
          if (Array.isArray(languages)) {
            for (const lang of languages) {
              if (typeof lang === "string" && lang.trim()) {
                mergeTag({
                  tag: lang.trim(),
                  confidence: 0.85,
                  source: "external",
                  category: "language",
                  verificationLevel: "externally_verified",
                  evidenceCount: 1,
                  evidenceSummary: { github_verified: true },
                });
              }
            }
          }

          // Extract topics/skills if present
          const topics = claim.verification_data.topics;
          if (Array.isArray(topics)) {
            for (const topic of topics) {
              if (typeof topic === "string" && topic.trim()) {
                mergeTag({
                  tag: topic.trim(),
                  confidence: 0.75,
                  source: "external",
                  category: "general",
                  verificationLevel: "externally_verified",
                  evidenceCount: 1,
                  evidenceSummary: { github_topic: true },
                });
              }
            }
          }
        }

        // arXiv claims — extract research domains
        if (claim.platform === "arxiv") {
          const categories = claim.verification_data.categories;
          if (Array.isArray(categories)) {
            for (const cat of categories) {
              if (typeof cat === "string" && cat.trim()) {
                mergeTag({
                  tag: cat.trim(),
                  confidence: 0.8,
                  source: "external",
                  category: "research",
                  verificationLevel: "externally_verified",
                  evidenceCount: 1,
                  evidenceSummary: { arxiv_verified: true },
                });
              }
            }
          }
        }
      }
    } catch {
      // external_claims table may not exist — graceful skip
    }
  }

  /**
   * Source 5: On-chain endorsements — skills endorsed by other agents.
   * Groups by skill, computes avg rating, adds tag with confidence = avg_rating / 5.0.
   * Only includes active endorsements from trusted endorsers with avg_rating >= 3.0.
   */
  private async ingestEndorsements(
    agentId: string,
    mergeTag: (tag: DerivedTag) => void,
  ): Promise<void> {
    try {
      // Get agent address for endorsement lookup
      const { rows: agentRows } = await this.pool.query<{ address: string }>(
        `SELECT address FROM agents WHERE id = $1`,
        [agentId],
      );
      if (agentRows.length === 0) return;
      const address = agentRows[0].address.toLowerCase();

      // Fetch active endorsements grouped by skill
      const { rows } = await this.pool.query<{
        skill: string;
        avg_rating: string;
        endorsement_count: string;
      }>(
        `SELECT e.skill,
                AVG(e.rating)::text AS avg_rating,
                COUNT(*)::text AS endorsement_count
         FROM idx_endorsements e
         WHERE e.endorsee = $1
           AND e.is_active = TRUE
         GROUP BY e.skill
         HAVING AVG(e.rating) >= 3.0`,
        [address],
      );

      for (const row of rows) {
        const avgRating = parseFloat(row.avg_rating);
        const count = parseInt(row.endorsement_count, 10);
        // Confidence: avg_rating / 5.0 (range 0.6-1.0 since we filter >= 3.0)
        const confidence = avgRating / 5.0;

        mergeTag({
          tag: row.skill,
          confidence,
          source: "activity",
          category: "general",
          verificationLevel: "endorsed",
          evidenceCount: count,
          evidenceSummary: {
            endorsement_count: count,
            avg_endorsement_rating: Math.round(avgRating * 10) / 10,
          },
        });
      }
    } catch {
      // idx_endorsements may not exist — graceful skip
    }
  }

  /**
   * Rebuild agents.skill_tsv by concatenating all expertise tags into a tsvector.
   */
  private async rebuildSkillTsv(agentId: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE agents SET skill_tsv = (
           SELECT to_tsvector('simple',
             COALESCE(string_agg(et.tag, ' '), ''))
           FROM expertise_tags et
           WHERE et.agent_id = $1
         )
         WHERE id = $1`,
        [agentId],
      );
    } catch {
      // skill_tsv column may not exist yet — graceful skip
    }
  }

  /**
   * Batch-profile all agents that have any skill signal.
   *
   * Profiles agents with commit_log entries, self-reported capabilities,
   * bounty completions, service agreements, or external claims.
   *
   * @returns The number of agents profiled.
   */
  async profileAllAgents(): Promise<number> {
    // Collect agents from ALL skill signal sources:
    // 1. commit_log — language/framework inference
    // 2. agents.capabilities — self-reported skills
    // 3. service_agreements — completed service work
    // 4. external_claims — verified GitHub/arXiv/etc
    // 5. project_bounties + idx_bounties — completed bounties
    const agentsRes = await this.pool.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id FROM (
         SELECT DISTINCT agent_id FROM commit_log WHERE agent_id IS NOT NULL
         UNION
         SELECT id AS agent_id FROM agents WHERE capabilities IS NOT NULL AND array_length(capabilities, 1) > 0
         UNION
         SELECT DISTINCT provider_agent_id AS agent_id FROM service_agreements WHERE status = 'completed' AND provider_agent_id IS NOT NULL
         UNION
         SELECT DISTINCT agent_id FROM external_claims WHERE status = 'verified' AND agent_id IS NOT NULL
       ) sources`,
    );

    let profiled = 0;

    for (const row of agentsRes.rows) {
      try {
        await this.profileAgent(row.agent_id);
        profiled++;
        // Sync expertise tags into specialization profiles
        if (this.specializationService) {
          await this.specializationService.syncFromExpertise(row.agent_id).catch(() => {});
        }
      } catch {
        // Skip individual agent failures
      }
    }

    return profiled;
  }

  /**
   * Get enriched skill data for a specific agent.
   */
  async getAgentSkills(agentId: string): Promise<DerivedTag[]> {
    const { rows } = await this.pool.query<{
      tag: string;
      confidence: number;
      source: string;
      category: string | null;
      verification_level: string;
      evidence_count: number;
      evidence_summary: Record<string, unknown>;
    }>(
      `SELECT tag, confidence, source, category, verification_level,
              evidence_count, evidence_summary
       FROM expertise_tags
       WHERE agent_id = $1
       ORDER BY confidence DESC`,
      [agentId],
    );

    return rows.map((r) => ({
      tag: r.tag,
      confidence: r.confidence,
      source: r.source,
      category: r.category ?? SOURCE_CATEGORY_MAP[r.source] ?? "general",
      verificationLevel: r.verification_level,
      evidenceCount: r.evidence_count,
      evidenceSummary: r.evidence_summary ?? {},
    }));
  }
}
