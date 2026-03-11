/**
 * Knowledge Resource Service — unified submission, enrichment, and query for
 * papers, GitHub repos, datasets, and documentation.
 *
 * @module services/knowledgeResourceService
 */

import type pg from "pg";
import crypto from "crypto";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// ============================================================
//  Types
// ============================================================

export interface KnowledgeResource {
  id: string;
  source_type: string;
  external_id: string;
  title: string;
  description: string | null;
  url: string | null;
  authors: unknown[];
  tags: unknown[];
  faculty: string[];
  published_date: string | null;
  quality_score: number;
  quality_breakdown: Record<string, unknown>;
  submitted_by: string | null;
  submission_type: string;
  arxiv_id: string | null;
  doi: string | null;
  semantic_scholar_id: string | null;
  citation_count: number;
  grokipedia_score: number;
  github_owner: string | null;
  github_repo: string | null;
  github_stars: number;
  github_forks: number;
  github_topics: unknown[];
  github_language: string | null;
  hf_downloads: number;
  hf_likes: number;
  benchmark_scores: Record<string, unknown>;
  library_name: string | null;
  registry_metadata: Record<string, unknown>;
  content_cid: string | null;
  enrichment_status: string;
  created_at: string;
  updated_at: string;
}

export interface SubmitResult {
  resourceId: string;
  status: "created" | "duplicate";
}

export interface ResourceListOptions {
  page?: number;
  limit?: number;
  sourceType?: string;
  minQuality?: number;
  search?: string;
  sort?: string;
  faculty?: string;
}

export interface ResourceStats {
  total: number;
  byType: Record<string, number>;
  pendingEnrichment: number;
}

export interface KnowledgeResourceConfig {
  submitCostCredits: number;     // stored units (100 = 1.00 display)
  enrichmentIntervalMs: number;
  maxEnrichBatch: number;
  dailyCapPerAgent: number;
}

// ============================================================
//  Identifier parsing
// ============================================================

type ResourceSourceType =
  | "paper"
  | "github_repo"
  | "huggingface_model"
  | "huggingface_dataset"
  | "replicate_model"
  | "ollama_model"
  | "pypi_package"
  | "researchhub_paper";

const VALID_SOURCE_TYPES: ResourceSourceType[] = [
  "paper",
  "github_repo",
  "huggingface_model",
  "huggingface_dataset",
  "replicate_model",
  "ollama_model",
  "pypi_package",
  "researchhub_paper",
];

interface ParsedIdentifier {
  sourceType: ResourceSourceType;
  externalId: string;
  arxivId?: string;
  doi?: string;
  githubOwner?: string;
  githubRepo?: string;
  url?: string;
}

/**
 * Parse a user-supplied identifier into canonical form.
 * Handles: arxiv IDs, DOIs, GitHub owner/repo, HF models/datasets,
 * Replicate models, Ollama models, PyPI packages, and full URLs.
 */
export function parseIdentifier(sourceType: string, identifier: string): ParsedIdentifier | null {
  const trimmed = identifier.trim();

  if (sourceType === "paper") {
    // arxiv:XXXX.YYYYY or just XXXX.YYYYY
    const arxivMatch = trimmed.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
    if (arxivMatch) {
      const id = arxivMatch[1].replace(/v\d+$/, ""); // strip version
      return {
        sourceType: "paper",
        externalId: `arxiv:${id}`,
        arxivId: id,
        url: `https://arxiv.org/abs/${id}`,
      };
    }

    // https://arxiv.org/abs/XXXX.YYYYY
    const arxivUrlMatch = trimmed.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivUrlMatch) {
      const id = arxivUrlMatch[1].replace(/v\d+$/, "");
      return {
        sourceType: "paper",
        externalId: `arxiv:${id}`,
        arxivId: id,
        url: `https://arxiv.org/abs/${id}`,
      };
    }

    // doi:10.XXXX/... or just 10.XXXX/...
    const doiMatch = trimmed.match(/^(?:doi:)?(10\.\d{4,9}\/[^\s]+)$/i);
    if (doiMatch) {
      return {
        sourceType: "paper",
        externalId: `doi:${doiMatch[1]}`,
        doi: doiMatch[1],
        url: `https://doi.org/${doiMatch[1]}`,
      };
    }

    return null;
  }

  if (sourceType === "github_repo") {
    // github:owner/repo
    const shortMatch = trimmed.match(/^(?:github:)?([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
    if (shortMatch) {
      return {
        sourceType: "github_repo",
        externalId: `github:${shortMatch[1]}/${shortMatch[2]}`,
        githubOwner: shortMatch[1],
        githubRepo: shortMatch[2],
        url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}`,
      };
    }

    // https://github.com/owner/repo
    const urlMatch = trimmed.match(/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/);
    if (urlMatch) {
      return {
        sourceType: "github_repo",
        externalId: `github:${urlMatch[1]}/${urlMatch[2]}`,
        githubOwner: urlMatch[1],
        githubRepo: urlMatch[2],
        url: `https://github.com/${urlMatch[1]}/${urlMatch[2]}`,
      };
    }

    return null;
  }

  if (sourceType === "huggingface_model") {
    // hf:owner/model or just owner/model
    const hfMatch = trimmed.match(/^(?:hf:)?([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)$/);
    if (hfMatch) {
      return {
        sourceType: "huggingface_model",
        externalId: `hf:${hfMatch[1]}`,
        url: `https://huggingface.co/${hfMatch[1]}`,
      };
    }

    // https://huggingface.co/owner/model
    const hfUrlMatch = trimmed.match(/huggingface\.co\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/);
    if (hfUrlMatch) {
      return {
        sourceType: "huggingface_model",
        externalId: `hf:${hfUrlMatch[1]}`,
        url: `https://huggingface.co/${hfUrlMatch[1]}`,
      };
    }

    return null;
  }

  if (sourceType === "huggingface_dataset") {
    // hf-ds:owner/dataset or just owner/dataset
    const dsMatch = trimmed.match(/^(?:hf-ds:)?([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)$/);
    if (dsMatch) {
      return {
        sourceType: "huggingface_dataset",
        externalId: `hf-ds:${dsMatch[1]}`,
        url: `https://huggingface.co/datasets/${dsMatch[1]}`,
      };
    }

    // https://huggingface.co/datasets/owner/dataset
    const dsUrlMatch = trimmed.match(/huggingface\.co\/datasets\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/);
    if (dsUrlMatch) {
      return {
        sourceType: "huggingface_dataset",
        externalId: `hf-ds:${dsUrlMatch[1]}`,
        url: `https://huggingface.co/datasets/${dsUrlMatch[1]}`,
      };
    }

    return null;
  }

  if (sourceType === "replicate_model") {
    // replicate:owner/model or just owner/model
    const repMatch = trimmed.match(/^(?:replicate:)?([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)$/);
    if (repMatch) {
      return {
        sourceType: "replicate_model",
        externalId: `replicate:${repMatch[1]}`,
        url: `https://replicate.com/${repMatch[1]}`,
      };
    }

    return null;
  }

  if (sourceType === "ollama_model") {
    // ollama:modelname or just modelname
    const ollamaMatch = trimmed.match(/^(?:ollama:)?([a-zA-Z0-9._:-]+)$/);
    if (ollamaMatch) {
      return {
        sourceType: "ollama_model",
        externalId: `ollama:${ollamaMatch[1]}`,
        url: `https://ollama.com/library/${ollamaMatch[1]}`,
      };
    }

    return null;
  }

  if (sourceType === "pypi_package") {
    // pypi:packagename or just packagename
    const pypiMatch = trimmed.match(/^(?:pypi:)?([a-zA-Z0-9._-]+)$/);
    if (pypiMatch) {
      return {
        sourceType: "pypi_package",
        externalId: `pypi:${pypiMatch[1]}`,
        url: `https://pypi.org/project/${pypiMatch[1]}/`,
      };
    }

    return null;
  }

  if (sourceType === "researchhub_paper") {
    // researchhub:<id> or just numeric ID
    const rhIdMatch = trimmed.match(/^(?:researchhub:)?(\d+)$/);
    if (rhIdMatch) {
      return {
        sourceType: "researchhub_paper",
        externalId: `researchhub:${rhIdMatch[1]}`,
        url: `https://www.researchhub.com/paper/${rhIdMatch[1]}`,
      };
    }

    // https://www.researchhub.com/paper/<id>/... (URL with optional slug)
    const rhUrlMatch = trimmed.match(/researchhub\.com\/paper\/(\d+)/i);
    if (rhUrlMatch) {
      return {
        sourceType: "researchhub_paper",
        externalId: `researchhub:${rhUrlMatch[1]}`,
        url: `https://www.researchhub.com/paper/${rhUrlMatch[1]}`,
      };
    }

    return null;
  }

  return null;
}

// ============================================================
//  KnowledgeResourceService
// ============================================================

export class KnowledgeResourceService {
  private enrichmentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly creditManager: CreditManager | null,
    private readonly config: KnowledgeResourceConfig,
  ) {}

  // ----------------------------------------------------------
  //  Submission
  // ----------------------------------------------------------

  async submitResource(
    agentId: string,
    sourceType: string,
    identifier: string,
  ): Promise<SubmitResult> {
    const parsed = parseIdentifier(sourceType, identifier);
    if (!parsed) {
      throw new Error("INVALID_IDENTIFIER");
    }

    // Dedup check
    const { rows: existing } = await this.pool.query<{ id: string }>(
      `SELECT id FROM knowledge_resources WHERE source_type = $1 AND external_id = $2`,
      [parsed.sourceType, parsed.externalId],
    );

    if (existing.length > 0) {
      return { resourceId: existing[0].id, status: "duplicate" };
    }

    // Daily cap check
    const { rows: dailyCount } = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_resources
       WHERE submitted_by = $1 AND created_at > NOW() - INTERVAL '24 hours'
         AND submission_type = 'agent'`,
      [agentId],
    );
    if (parseInt(dailyCount[0]?.cnt ?? "0", 10) >= this.config.dailyCapPerAgent) {
      throw new Error("DAILY_SUBMISSION_LIMIT");
    }

    // Deduct credits
    if (this.creditManager && this.config.submitCostCredits > 0) {
      const requestId = `resource_submit_${crypto.randomUUID()}`;
      await this.creditManager.deductCredits(
        agentId,
        this.config.submitCostCredits,
        requestId,
        "resource_submit",
      );
    }

    // Insert resource
    const id = crypto.randomUUID();
    const title = parsed.arxivId
      ? `arXiv:${parsed.arxivId}`
      : parsed.githubOwner
        ? `${parsed.githubOwner}/${parsed.githubRepo}`
        : parsed.externalId;

    await this.pool.query(
      `INSERT INTO knowledge_resources (
        id, source_type, external_id, title, url, submitted_by, submission_type,
        arxiv_id, doi, github_owner, github_repo, enrichment_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8, $9, $10, 'pending')`,
      [
        id,
        parsed.sourceType,
        parsed.externalId,
        title,
        parsed.url ?? null,
        agentId,
        parsed.arxivId ?? null,
        parsed.doi ?? null,
        parsed.githubOwner ?? null,
        parsed.githubRepo ?? null,
      ],
    );

    logSecurityEvent("info", "knowledge-resource-submitted", {
      resourceId: id,
      agentId,
      sourceType: parsed.sourceType,
      externalId: parsed.externalId,
    });

    return { resourceId: id, status: "created" };
  }

  // ----------------------------------------------------------
  //  Enrichment pipeline
  // ----------------------------------------------------------

  async enrichPendingResources(): Promise<number> {
    // Only handle paper + github_repo here. Model registry types (huggingface_*,
    // replicate_model, ollama_model, pypi_package) are handled by the ResourceEnricher
    // background service. Without this filter, this method races with the enricher
    // and marks model types as 'complete' before they get actual metadata.
    const { rows } = await this.pool.query<{ id: string; source_type: string; arxiv_id: string | null; doi: string | null; github_owner: string | null; github_repo: string | null }>(
      `SELECT id, source_type, arxiv_id, doi, github_owner, github_repo
       FROM knowledge_resources
       WHERE enrichment_status = 'pending'
         AND source_type IN ('paper', 'github_repo')
       ORDER BY created_at ASC
       LIMIT $1`,
      [this.config.maxEnrichBatch],
    );

    let enriched = 0;

    for (const row of rows) {
      try {
        // Mark as enriching
        await this.pool.query(
          `UPDATE knowledge_resources SET enrichment_status = 'enriching', updated_at = NOW() WHERE id = $1`,
          [row.id],
        );

        if (row.source_type === "paper") {
          await this.enrichPaper(row.id, row.arxiv_id, row.doi);
        } else if (row.source_type === "github_repo") {
          await this.enrichGithubRepo(row.id, row.github_owner!, row.github_repo!);
        }

        enriched++;
      } catch (err) {
        logSecurityEvent("warn", "knowledge-resource-enrichment-failed", {
          resourceId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.pool.query(
          `UPDATE knowledge_resources SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`,
          [row.id],
        ).catch(() => { /* best-effort */ });
      }
    }

    return enriched;
  }

  private async enrichPaper(resourceId: string, arxivId: string | null, doi: string | null): Promise<void> {
    // Try Semantic Scholar lookup
    const s2Query = arxivId ? `ArXiv:${arxivId}` : doi ? doi : null;
    if (!s2Query) {
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
        [resourceId],
      );
      return;
    }

    try {
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Query)}?fields=title,authors,citationCount,year,externalIds,abstract,fieldsOfStudy`;
      const resp = await fetchWithTimeout(s2Url, { timeoutMs: 15_000 });

      if (!resp.ok) {
        // S2 not found — still mark complete with what we have
        await this.pool.query(
          `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
          [resourceId],
        );
        return;
      }

      const paper = await resp.json() as {
        title?: string;
        authors?: { name: string; authorId?: string }[];
        citationCount?: number;
        year?: number;
        externalIds?: { ArXiv?: string; DOI?: string };
        abstract?: string;
        fieldsOfStudy?: string[];
      };

      // Simple quality score based on citation count + completeness
      const citScore = Math.min(40, Math.log2((paper.citationCount ?? 0) + 1) * 4);
      const hasAbstract = paper.abstract ? 20 : 0;
      const hasAuthors = (paper.authors?.length ?? 0) > 0 ? 20 : 0;
      const hasYear = paper.year ? 10 : 0;
      const hasFields = (paper.fieldsOfStudy?.length ?? 0) > 0 ? 10 : 0;
      const qualityScore = Math.round(Math.min(100, citScore + hasAbstract + hasAuthors + hasYear + hasFields));

      await this.pool.query(
        `UPDATE knowledge_resources SET
          title = COALESCE($2, title),
          description = COALESCE($3, description),
          authors = $4,
          tags = $5,
          published_date = $6,
          citation_count = $7,
          semantic_scholar_id = $8,
          doi = COALESCE($9, doi),
          quality_score = $10,
          quality_breakdown = $11,
          enrichment_status = 'complete',
          updated_at = NOW()
        WHERE id = $1`,
        [
          resourceId,
          paper.title ?? null,
          paper.abstract ?? null,
          JSON.stringify(paper.authors ?? []),
          JSON.stringify(paper.fieldsOfStudy ?? []),
          paper.year ? new Date(`${paper.year}-01-01`) : null,
          paper.citationCount ?? 0,
          null, // S2 doesn't return its own ID in the fields we requested
          paper.externalIds?.DOI ?? null,
          qualityScore,
          JSON.stringify({ citations: Math.round(citScore), abstract: hasAbstract, authors: hasAuthors, year: hasYear, fields: hasFields }),
        ],
      );
    } catch {
      // Network failure — mark complete with what we have rather than blocking
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
        [resourceId],
      );
    }
  }

  private async enrichGithubRepo(resourceId: string, owner: string, repo: string): Promise<void> {
    try {
      const resp = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "nookplot-gateway" },
        timeoutMs: 15_000,
      });

      if (!resp.ok) {
        await this.pool.query(
          `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
          [resourceId],
        );
        return;
      }

      const data = await resp.json() as {
        full_name?: string;
        description?: string;
        html_url?: string;
        stargazers_count?: number;
        forks_count?: number;
        topics?: string[];
        language?: string;
        created_at?: string;
      };

      // Quality score: log2(stars+1)*8, forks bonus, description bonus
      const starsScore = Math.log2((data.stargazers_count ?? 0) + 1) * 8;
      const forksBonus = Math.min(15, Math.log2((data.forks_count ?? 0) + 1) * 3);
      const descBonus = data.description ? 10 : 0;
      const qualityScore = Math.round(Math.min(100, starsScore + forksBonus + descBonus));

      await this.pool.query(
        `UPDATE knowledge_resources SET
          title = COALESCE($2, title),
          description = $3,
          url = $4,
          github_stars = $5,
          github_forks = $6,
          github_topics = $7,
          github_language = $8,
          published_date = $9,
          quality_score = $10,
          quality_breakdown = $11,
          enrichment_status = 'complete',
          updated_at = NOW()
        WHERE id = $1`,
        [
          resourceId,
          data.full_name ?? null,
          data.description ?? null,
          data.html_url ?? null,
          data.stargazers_count ?? 0,
          data.forks_count ?? 0,
          JSON.stringify(data.topics ?? []),
          data.language ?? null,
          data.created_at ? new Date(data.created_at) : null,
          qualityScore,
          JSON.stringify({ stars: Math.round(starsScore), forks: Math.round(forksBonus), description: descBonus }),
        ],
      );
    } catch {
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
        [resourceId],
      );
    }
  }

  // ----------------------------------------------------------
  //  Enrichment interval management
  // ----------------------------------------------------------

  startEnrichmentInterval(): void {
    if (this.enrichmentTimer) return;
    this.enrichmentTimer = setInterval(async () => {
      try {
        const count = await this.enrichPendingResources();
        if (count > 0) {
          logSecurityEvent("info", "knowledge-resource-enrichment-tick", { enriched: count });
        }
      } catch (err) {
        logSecurityEvent("warn", "knowledge-resource-enrichment-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.config.enrichmentIntervalMs);
  }

  stopEnrichmentInterval(): void {
    if (this.enrichmentTimer) {
      clearInterval(this.enrichmentTimer);
      this.enrichmentTimer = null;
    }
  }

  // ----------------------------------------------------------
  //  Query methods
  // ----------------------------------------------------------

  async listResources(opts: ResourceListOptions = {}): Promise<{ resources: KnowledgeResource[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (opts.sourceType) {
      conditions.push(`source_type = $${paramIdx}`);
      params.push(opts.sourceType);
      paramIdx++;
    }

    if (opts.minQuality && opts.minQuality > 0) {
      conditions.push(`quality_score >= $${paramIdx}`);
      params.push(opts.minQuality);
      paramIdx++;
    }

    if (opts.search) {
      conditions.push(`search_tsv @@ plainto_tsquery('english', $${paramIdx})`);
      params.push(opts.search);
      paramIdx++;
    }

    if (opts.faculty) {
      conditions.push(`faculty @> ARRAY[$${paramIdx}]::text[]`);
      params.push(opts.faculty);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const SORT_MAP: Record<string, string> = {
      "newest": "created_at DESC",
      "quality": "quality_score DESC",
      "most-cited": "citation_count DESC",
      "stars": "github_stars DESC",
      "downloads": "hf_downloads DESC",
      "likes": "hf_likes DESC",
    };
    const orderBy = SORT_MAP[opts.sort ?? "newest"] ?? SORT_MAP["newest"];

    const [countResult, dataResult] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS total FROM knowledge_resources ${whereClause}`, params),
      this.pool.query(
        `SELECT * FROM knowledge_resources ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    return {
      resources: dataResult.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getResource(id: string): Promise<KnowledgeResource | null> {
    const { rows } = await this.pool.query<KnowledgeResource>(
      `SELECT * FROM knowledge_resources WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getResourceByExternalId(sourceType: string, externalId: string): Promise<KnowledgeResource | null> {
    const { rows } = await this.pool.query<KnowledgeResource>(
      `SELECT * FROM knowledge_resources WHERE source_type = $1 AND external_id = $2`,
      [sourceType, externalId],
    );
    return rows[0] ?? null;
  }

  async getMostCited(opts: { limit?: number; sourceType?: string } = {}): Promise<KnowledgeResource[]> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));

    let query: string;
    const params: (string | number)[] = [];

    if (opts.sourceType) {
      query = `SELECT kr.*, COALESCE(rc.cite_count, 0) AS total_citations
               FROM knowledge_resources kr
               LEFT JOIN (SELECT resource_id, COUNT(*)::int AS cite_count FROM resource_citations GROUP BY resource_id) rc ON rc.resource_id = kr.id
               WHERE kr.source_type = $1
               ORDER BY COALESCE(rc.cite_count, 0) DESC, kr.citation_count DESC
               LIMIT $2`;
      params.push(opts.sourceType, limit);
    } else {
      query = `SELECT kr.*, COALESCE(rc.cite_count, 0) AS total_citations
               FROM knowledge_resources kr
               LEFT JOIN (SELECT resource_id, COUNT(*)::int AS cite_count FROM resource_citations GROUP BY resource_id) rc ON rc.resource_id = kr.id
               ORDER BY COALESCE(rc.cite_count, 0) DESC, kr.citation_count DESC
               LIMIT $1`;
      params.push(limit);
    }

    const { rows } = await this.pool.query(query, params);
    return rows;
  }

  async getResourceStats(): Promise<ResourceStats> {
    const [totalResult, byTypeResult, pendingResult] = await Promise.all([
      this.pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM knowledge_resources`),
      this.pool.query<{ source_type: string; cnt: number }>(
        `SELECT source_type, COUNT(*)::int AS cnt FROM knowledge_resources GROUP BY source_type`,
      ),
      this.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM knowledge_resources WHERE enrichment_status = 'pending'`,
      ),
    ]);

    const byType: Record<string, number> = {};
    for (const row of byTypeResult.rows) {
      byType[row.source_type] = row.cnt;
    }

    return {
      total: totalResult.rows[0]?.total ?? 0,
      byType,
      pendingEnrichment: pendingResult.rows[0]?.total ?? 0,
    };
  }

  async getFaculties(): Promise<Array<{ faculty: string; count: number }>> {
    const { rows } = await this.pool.query<{ faculty: string; cnt: number }>(
      `SELECT UNNEST(faculty) AS faculty, COUNT(*)::int AS cnt
       FROM knowledge_resources
       WHERE ARRAY_LENGTH(faculty, 1) > 0
       GROUP BY faculty
       ORDER BY cnt DESC`,
    );
    return rows.map((r) => ({ faculty: r.faculty, count: r.cnt }));
  }

  async getResourceCitations(resourceId: string, page = 1, limit = 20): Promise<{ citations: unknown[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const offset = (Math.max(1, page) - 1) * safeLimit;

    const [countResult, dataResult] = await Promise.all([
      this.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM resource_citations WHERE resource_id = $1`,
        [resourceId],
      ),
      this.pool.query(
        `SELECT rc.*, a.display_name AS citing_agent_name, a.address AS citing_agent_address
         FROM resource_citations rc
         LEFT JOIN agents a ON a.id = rc.citing_agent_id
         WHERE rc.resource_id = $1
         ORDER BY rc.created_at DESC
         LIMIT $2 OFFSET $3`,
        [resourceId, safeLimit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    return {
      citations: dataResult.rows,
      pagination: { page, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }
}
