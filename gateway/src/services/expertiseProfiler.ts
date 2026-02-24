/**
 * Expertise tag derivation engine for the Agent Gateway.
 *
 * Analyzes an agent's commit_log entries to derive expertise tags with
 * confidence scores (0.0-1.0). Tags are sourced from:
 *   - Languages used in commits (source: "language")
 *   - Framework inference from language + file extension heuristics (source: "framework")
 *
 * Tags with confidence below 0.2 are filtered out. A maximum of 15 tags
 * per agent is enforced (top by confidence). Results are UPSERTed into
 * the expertise_tags table.
 *
 * All queries use parameterized SQL to prevent injection.
 *
 * @module services/expertiseProfiler
 */

import type { Pool } from "pg";

/** A derived expertise tag with its confidence and source. */
interface DerivedTag {
  tag: string;
  confidence: number;
  source: string;
}

/** Maximum number of tags per agent. */
const MAX_TAGS = 15;

/** Minimum confidence threshold — tags below this are filtered out. */
const MIN_CONFIDENCE = 0.2;

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
 * Derives expertise tags from commit history and persists them.
 */
export class ExpertiseProfiler {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Profile a single agent by analyzing their commit_log entries.
   *
   * Derives language and framework tags, normalizes confidence to 0-1,
   * filters out low-confidence tags, keeps top 15, and UPSERTs into
   * the expertise_tags table.
   *
   * @param agentId - UUID of the agent from the agents table.
   * @returns The number of tags written.
   */
  async profileAgent(agentId: string): Promise<number> {
    // 1. Get language frequency by unnesting the languages array
    const langRes = await this.pool.query<{
      lang: string;
      freq: string;
    }>(
      `SELECT unnest(languages) AS lang, COUNT(*)::text AS freq
       FROM commit_log
       WHERE agent_id = $1
         AND languages IS NOT NULL
       GROUP BY lang
       ORDER BY freq DESC`,
      [agentId],
    );

    if (langRes.rows.length === 0) {
      return 0;
    }

    // Find the max frequency for normalization
    const maxFreq = Math.max(
      ...langRes.rows.map((r) => parseInt(r.freq, 10)),
    );

    const tags: DerivedTag[] = [];

    // 2. Language tags with normalized confidence
    for (const row of langRes.rows) {
      const freq = parseInt(row.freq, 10);
      const confidence = Math.min(freq / maxFreq, 1.0);
      if (confidence >= MIN_CONFIDENCE) {
        tags.push({
          tag: row.lang,
          confidence,
          source: "language",
        });
      }
    }

    // 3. Framework inference from heuristics
    //    Check if the agent has commits with matching frameworks column entries
    const frameworkRes = await this.pool.query<{
      fw: string;
      freq: string;
    }>(
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
      // Check if the agent uses the required language
      if (!languageSet.has(heuristic.language)) continue;

      // Check if any framework entry contains the indicator string
      const matched = frameworkSet.has(heuristic.indicator.toLowerCase()) ||
        frameworkRes.rows.some((r) =>
          r.fw.toLowerCase().includes(heuristic.indicator.toLowerCase()),
        );

      if (matched) {
        // Confidence is based on the language's confidence, slightly reduced
        const langRow = langRes.rows.find((r) => r.lang === heuristic.language);
        const langFreq = langRow ? parseInt(langRow.freq, 10) : 0;
        const confidence = Math.min((langFreq / maxFreq) * 0.8, 1.0);

        if (confidence >= MIN_CONFIDENCE) {
          // Only add if not already present
          if (!tags.some((t) => t.tag === heuristic.framework)) {
            tags.push({
              tag: heuristic.framework,
              confidence,
              source: "framework",
            });
          }
        }
      }
    }

    // 4. Sort by confidence descending, take top MAX_TAGS
    tags.sort((a, b) => b.confidence - a.confidence);
    const topTags = tags.slice(0, MAX_TAGS);

    // 5. UPSERT into expertise_tags
    for (const tag of topTags) {
      await this.pool.query(
        `INSERT INTO expertise_tags (agent_id, tag, confidence, source, computed_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (agent_id, tag) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           source = EXCLUDED.source,
           computed_at = NOW()`,
        [agentId, tag.tag, tag.confidence, tag.source],
      );
    }

    // 6. Remove stale tags that are no longer in the top set
    const tagNames = topTags.map((t) => t.tag);
    if (tagNames.length > 0) {
      await this.pool.query(
        `DELETE FROM expertise_tags
         WHERE agent_id = $1
           AND tag <> ALL($2::varchar[])`,
        [agentId, tagNames],
      );
    } else {
      // No tags derived — clear all
      await this.pool.query(
        `DELETE FROM expertise_tags WHERE agent_id = $1`,
        [agentId],
      );
    }

    return topTags.length;
  }

  /**
   * Batch-profile all agents that have commit_log entries.
   *
   * @returns The number of agents profiled.
   */
  async profileAllAgents(): Promise<number> {
    const agentsRes = await this.pool.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id
       FROM commit_log
       WHERE agent_id IS NOT NULL`,
    );

    let profiled = 0;

    for (const row of agentsRes.rows) {
      await this.profileAgent(row.agent_id);
      profiled++;
    }

    return profiled;
  }
}
