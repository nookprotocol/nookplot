/**
 * Convergence backflow service.
 *
 * Computes which external papers/resources have been independently verified
 * by convergent agent research chains on Nookplot. This data flows back to
 * source platforms (ResearchHub, arXiv) as machine-generated verification signals.
 *
 * A paper is "convergence-verified" when multiple independent agent chains
 * (different origin agents, different research paths) all end up citing it.
 * The more independent chains → the stronger the verification signal.
 *
 * @module services/convergenceBackflowService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface ConvergenceRecord {
  resourceId: string;
  externalId: string;
  sourcePlatform: string;
  title: string | null;
  url: string | null;
  chainCount: number;
  uniqueAgents: number;
  convergenceScore: number;
  firstVerified: string;
  lastUpdated: string;
  chains: ChainDetail[];
}

interface ChainDetail {
  agentId: string;
  agentName: string | null;
  bundleId: string | null;
  citationPattern: string | null;
  citedAt: string;
}

export interface ConvergenceStats {
  totalVerifiedResources: number;
  byPlatform: Record<string, number>;
  avgChainCount: number;
  avgConvergenceScore: number;
  topVerified: Array<{
    externalId: string;
    title: string | null;
    convergenceScore: number;
    chainCount: number;
  }>;
}

// ============================================================
//  Constants
// ============================================================

// Minimum independent agents needed to count as "convergence-verified"
const MIN_CHAINS_FOR_VERIFICATION = 2;

// Score formula weights
const CHAIN_COUNT_WEIGHT = 25;     // More independent chains → higher score
const UNIQUE_AGENT_WEIGHT = 20;    // More distinct agents → stronger signal
const QUALITY_WEIGHT = 30;         // Average quality of citing agents
const DIVERSITY_WEIGHT = 25;       // How different the chains are from each other

// ============================================================
//  ConvergenceBackflowService
// ============================================================

export class ConvergenceBackflowService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Recompute convergence backflow for all resources that have been cited
   * by multiple independent agents. Called on a schedule (e.g. hourly).
   */
  async recompute(): Promise<number> {
    const start = Date.now();

    try {
      // Find all resources cited by >= MIN_CHAINS_FOR_VERIFICATION distinct agents
      // citation_reward_scores table was removed (orphaned — writer service deleted).
      // avg_quality defaults to 0 until a replacement quality source is wired up.
      const { rows } = await this.pool.query<{
        resource_id: string;
        external_id: string;
        source_type: string;
        title: string | null;
        url: string | null;
        chain_count: number;
        unique_agents: number;
        avg_quality: number;
      }>(`
        SELECT
          kr.id AS resource_id,
          kr.external_id,
          kr.source_type,
          kr.title,
          kr.url,
          COUNT(DISTINCT rc.id)::int AS chain_count,
          COUNT(DISTINCT rc.citing_agent_id)::int AS unique_agents,
          0::numeric AS avg_quality
        FROM knowledge_resources kr
        JOIN resource_citations rc ON rc.resource_id = kr.id
        WHERE kr.enrichment_status = 'complete'
        GROUP BY kr.id, kr.external_id, kr.source_type, kr.title, kr.url
        HAVING COUNT(DISTINCT rc.citing_agent_id) >= $1
        ORDER BY COUNT(DISTINCT rc.citing_agent_id) DESC
      `, [MIN_CHAINS_FOR_VERIFICATION]);

      let upserted = 0;

      for (const row of rows) {
        // Fetch individual chain details
        const { rows: chains } = await this.pool.query<{
          agent_id: string;
          display_name: string | null;
          source_id: string | null;
          citation_pattern: string | null;
          created_at: string;
        }>(`
          SELECT rc.citing_agent_id AS agent_id,
                 a.display_name,
                 rc.source_id,
                 rc.citation_pattern,
                 rc.created_at
          FROM resource_citations rc
          LEFT JOIN agents a ON a.id = rc.citing_agent_id
          WHERE rc.resource_id = $1
          ORDER BY rc.created_at ASC
        `, [row.resource_id]);

        // Compute convergence score (0-100)
        const chainScore = Math.min(CHAIN_COUNT_WEIGHT,
          Math.log2(row.chain_count + 1) * (CHAIN_COUNT_WEIGHT / 3));
        const agentScore = Math.min(UNIQUE_AGENT_WEIGHT,
          Math.log2(row.unique_agents + 1) * (UNIQUE_AGENT_WEIGHT / 3));
        const qualityScore = Math.min(QUALITY_WEIGHT,
          (Number(row.avg_quality) / 100) * QUALITY_WEIGHT);
        // Diversity: ratio of unique agents to total citations (1.0 = all independent)
        const diversityRatio = row.chain_count > 0
          ? row.unique_agents / row.chain_count
          : 0;
        const diversityScore = diversityRatio * DIVERSITY_WEIGHT;

        const convergenceScore = Math.round(
          Math.min(100, chainScore + agentScore + qualityScore + diversityScore)
        );

        const chainDetails = chains.map((c) => ({
          agentId: c.agent_id,
          agentName: c.display_name,
          bundleId: c.source_id,
          citationPattern: c.citation_pattern,
          citedAt: c.created_at,
        }));

        // Map source_type to platform name
        const platform = this.sourceTypeToPlatform(row.source_type);

        // Upsert convergence_backflow
        await this.pool.query(`
          INSERT INTO convergence_backflow (
            resource_id, external_id, source_platform,
            chain_count, unique_agents, convergence_score,
            chain_details, last_updated
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (resource_id) DO UPDATE SET
            chain_count = EXCLUDED.chain_count,
            unique_agents = EXCLUDED.unique_agents,
            convergence_score = EXCLUDED.convergence_score,
            chain_details = EXCLUDED.chain_details,
            last_updated = NOW()
        `, [
          row.resource_id,
          row.external_id,
          platform,
          row.chain_count,
          row.unique_agents,
          convergenceScore,
          JSON.stringify(chainDetails),
        ]);

        upserted++;
      }

      logSecurityEvent("info", "convergence-backflow-recompute", {
        resourcesProcessed: rows.length,
        upserted,
        durationMs: Date.now() - start,
      });

      return upserted;
    } catch (err) {
      logSecurityEvent("error", "convergence-backflow-recompute-failed", {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
      return 0;
    }
  }

  /**
   * List convergence-verified resources, optionally filtered by platform.
   */
  async listConvergenceVerified(opts: {
    platform?: string;
    minScore?: number;
    page?: number;
    limit?: number;
  } = {}): Promise<{ resources: ConvergenceRecord[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;

    if (opts.platform) {
      conditions.push(`cb.source_platform = $${idx++}`);
      params.push(opts.platform);
    }
    if (opts.minScore && opts.minScore > 0) {
      conditions.push(`cb.convergence_score >= $${idx++}`);
      params.push(opts.minScore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countResult, dataResult] = await Promise.all([
      this.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM convergence_backflow cb ${whereClause}`,
        params,
      ),
      this.pool.query(`
        SELECT cb.*, kr.title, kr.url
        FROM convergence_backflow cb
        JOIN knowledge_resources kr ON kr.id = cb.resource_id
        ${whereClause}
        ORDER BY cb.convergence_score DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, limit, offset]),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    const resources: ConvergenceRecord[] = dataResult.rows.map((r: Record<string, unknown>) => ({
      resourceId: r.resource_id as string,
      externalId: r.external_id as string,
      sourcePlatform: r.source_platform as string,
      title: r.title as string | null,
      url: r.url as string | null,
      chainCount: r.chain_count as number,
      uniqueAgents: r.unique_agents as number,
      convergenceScore: Number(r.convergence_score),
      firstVerified: String(r.first_verified),
      lastUpdated: String(r.last_updated),
      chains: (r.chain_details as ChainDetail[]) ?? [],
    }));

    return {
      resources,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get convergence data for a specific external resource.
   */
  async getConvergenceByExternalId(externalId: string): Promise<ConvergenceRecord | null> {
    const { rows } = await this.pool.query(`
      SELECT cb.*, kr.title, kr.url
      FROM convergence_backflow cb
      JOIN knowledge_resources kr ON kr.id = cb.resource_id
      WHERE cb.external_id = $1
    `, [externalId]);

    if (rows.length === 0) return null;

    const r = rows[0];
    return {
      resourceId: r.resource_id,
      externalId: r.external_id,
      sourcePlatform: r.source_platform,
      title: r.title,
      url: r.url,
      chainCount: r.chain_count,
      uniqueAgents: r.unique_agents,
      convergenceScore: Number(r.convergence_score),
      firstVerified: String(r.first_verified),
      lastUpdated: String(r.last_updated),
      chains: r.chain_details ?? [],
    };
  }

  /**
   * Aggregate stats for partnership reporting.
   */
  async getStats(): Promise<ConvergenceStats> {
    const [totalResult, platformResult, avgResult, topResult] = await Promise.all([
      this.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM convergence_backflow`,
      ),
      this.pool.query<{ source_platform: string; cnt: number }>(
        `SELECT source_platform, COUNT(*)::int AS cnt FROM convergence_backflow GROUP BY source_platform`,
      ),
      this.pool.query<{ avg_chains: number; avg_score: number }>(`
        SELECT
          COALESCE(AVG(chain_count), 0)::numeric AS avg_chains,
          COALESCE(AVG(convergence_score), 0)::numeric AS avg_score
        FROM convergence_backflow
      `),
      this.pool.query(`
        SELECT cb.external_id, kr.title, cb.convergence_score, cb.chain_count
        FROM convergence_backflow cb
        JOIN knowledge_resources kr ON kr.id = cb.resource_id
        ORDER BY cb.convergence_score DESC
        LIMIT 10
      `),
    ]);

    const byPlatform: Record<string, number> = {};
    for (const row of platformResult.rows) {
      byPlatform[row.source_platform] = row.cnt;
    }

    return {
      totalVerifiedResources: totalResult.rows[0]?.total ?? 0,
      byPlatform,
      avgChainCount: Number(avgResult.rows[0]?.avg_chains ?? 0),
      avgConvergenceScore: Number(avgResult.rows[0]?.avg_score ?? 0),
      topVerified: topResult.rows.map((r) => ({
        externalId: r.external_id,
        title: r.title,
        convergenceScore: Number(r.convergence_score),
        chainCount: r.chain_count,
      })),
    };
  }

  private sourceTypeToPlatform(sourceType: string): string {
    const map: Record<string, string> = {
      paper: "arxiv",
      github_repo: "github",
      huggingface_model: "huggingface",
      huggingface_dataset: "huggingface",
      replicate_model: "replicate",
      ollama_model: "ollama",
      pypi_package: "pypi",
      researchhub_paper: "researchhub",
    };
    return map[sourceType] ?? sourceType;
  }
}
