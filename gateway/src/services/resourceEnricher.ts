/**
 * Resource enrichment service.
 *
 * Background service that picks up knowledge_resources with
 * enrichment_status = 'pending' and fetches metadata from
 * upstream APIs (arXiv, GitHub, CrossRef).
 *
 * Uses a fire-and-forget tick pattern with configurable interval.
 *
 * @module services/resourceEnricher
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

interface PendingResource {
  id: string;
  source_type: string;
  external_id: string;
  arxiv_id: string | null;
  doi: string | null;
  github_owner: string | null;
  github_repo: string | null;
}

interface EnrichmentResult {
  title?: string;
  description?: string;
  authors?: unknown[];
  tags?: string[];
  publishedDate?: string;
  citationCount?: number;
  githubStars?: number;
  githubForks?: number;
  githubTopics?: string[];
  githubLanguage?: string;
  // Model registry fields
  faculty?: string[];
  hfDownloads?: number;
  hfLikes?: number;
  benchmarkScores?: Record<string, unknown>;
  libraryName?: string;
  registryMetadata?: Record<string, unknown>;
  // ResearchHub fields
  rhScore?: number;
  rhPeerReviewStatus?: string;
  rhBountyCount?: number;
  rhRscEarned?: number;
  rhHubs?: string[];
  rhPaperId?: number;
  rhDiscussionCount?: number;
}

// ============================================================
//  Constants
// ============================================================

const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 15_000;

// ============================================================
//  Faculty taxonomy — maps HF pipeline_tag to faculty array
// ============================================================

const PIPELINE_TAG_FACULTY_MAP: Record<string, string[]> = {
  "text-generation": ["language", "generation"],
  "text2text-generation": ["language", "generation"],
  "text-to-image": ["vision", "generation"],
  "image-to-text": ["vision", "analysis"],
  "image-classification": ["vision", "analysis"],
  "image-segmentation": ["vision", "analysis"],
  "object-detection": ["vision", "detection"],
  "image-to-image": ["vision", "generation"],
  "depth-estimation": ["vision", "analysis"],
  "video-classification": ["video", "analysis"],
  "text-to-video": ["video", "generation"],
  "automatic-speech-recognition": ["audio", "recognition"],
  "text-to-speech": ["audio", "generation"],
  "audio-classification": ["audio", "analysis"],
  "audio-to-audio": ["audio", "generation"],
  "voice-activity-detection": ["audio", "detection"],
  "translation": ["language", "translation"],
  "summarization": ["language", "reasoning"],
  "question-answering": ["language", "reasoning"],
  "fill-mask": ["language", "understanding"],
  "token-classification": ["language", "analysis"],
  "text-classification": ["language", "analysis"],
  "sentence-similarity": ["embeddings"],
  "feature-extraction": ["embeddings"],
  "zero-shot-classification": ["language", "reasoning"],
  "table-question-answering": ["language", "reasoning"],
  "conversational": ["language", "generation"],
  "reinforcement-learning": ["reinforcement-learning"],
  "robotics": ["robotics"],
  "tabular-classification": ["tabular", "analysis"],
  "tabular-regression": ["tabular", "analysis"],
  "document-question-answering": ["vision", "reasoning"],
  "visual-question-answering": ["vision", "reasoning"],
  "image-feature-extraction": ["vision", "embeddings"],
  "video-text-to-text": ["video", "reasoning"],
  "any-to-any": ["multimodal"],
  "image-text-to-text": ["vision", "reasoning"],
};

/** Map a HF pipeline_tag to a faculty array. Falls back to tag name as-is. */
export function pipelineTagToFaculty(pipelineTag?: string): string[] {
  if (!pipelineTag) return [];
  return PIPELINE_TAG_FACULTY_MAP[pipelineTag] ?? [pipelineTag];
}

// ============================================================
//  ResearchHub Hub → Faculty mapping
// ============================================================

const RH_HUB_FACULTY_MAP: Record<string, string[]> = {
  "machine-learning": ["language", "reasoning"],
  "artificial-intelligence": ["language", "reasoning"],
  "computer-science": ["language", "reasoning"],
  "deep-learning": ["language", "generation"],
  "natural-language-processing": ["language", "analysis"],
  "computer-vision": ["vision", "analysis"],
  "robotics": ["robotics"],
  "reinforcement-learning": ["reinforcement-learning"],
  "neuroscience": ["reasoning", "analysis"],
  "biology": ["analysis"],
  "chemistry": ["analysis"],
  "physics": ["reasoning"],
  "mathematics": ["reasoning"],
  "medicine": ["analysis"],
  "economics": ["reasoning"],
  "statistics": ["tabular", "analysis"],
  "data-science": ["tabular", "analysis"],
  "speech": ["audio", "recognition"],
  "genetics": ["analysis"],
  "bioinformatics": ["analysis"],
};

/** Map ResearchHub hub slugs to faculty arrays. Deduplicates results. */
export function rhHubsToFaculty(hubs: string[]): string[] {
  const faculties = new Set<string>();
  for (const hub of hubs) {
    const mapped = RH_HUB_FACULTY_MAP[hub.toLowerCase()];
    if (mapped) {
      for (const f of mapped) faculties.add(f);
    }
  }
  return [...faculties];
}

// ============================================================
//  ResourceEnricher
// ============================================================

export class ResourceEnricher {
  private readonly pool: pg.Pool;
  private readonly tickMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool, tickMs?: number) {
    this.pool = pool;
    this.tickMs = tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    // Run once on startup after a short delay
    setTimeout(() => this.tick().catch(() => {}), 10_000);
    logSecurityEvent("info", "resource-enricher-started", { tickMs: this.tickMs });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // -------------------------------------------------------
  //  Tick — find pending resources and enrich
  // -------------------------------------------------------

  async tick(): Promise<number> {
    let enriched = 0;

    try {
      // Claim a batch of pending resources (mark as 'enriching' to prevent double-processing)
      const { rows } = await this.pool.query<PendingResource>(
        `UPDATE knowledge_resources
         SET enrichment_status = 'enriching', updated_at = NOW()
         WHERE id IN (
           SELECT id FROM knowledge_resources
           WHERE enrichment_status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, source_type, external_id, arxiv_id, doi, github_owner, github_repo`,
        [BATCH_SIZE],
      );

      if (rows.length === 0) return 0;

      for (const resource of rows) {
        try {
          const result = await this.enrichResource(resource);
          if (result) {
            await this.applyEnrichment(resource.id, result);
            enriched++;
          }
        } catch (err) {
          await this.markFailed(resource.id, err);
        }
      }

      if (enriched > 0) {
        logSecurityEvent("info", "resource-enrichment-batch", {
          total: rows.length,
          enriched,
          failed: rows.length - enriched,
        });
      }
    } catch (err) {
      logSecurityEvent("warn", "resource-enricher-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return enriched;
  }

  // -------------------------------------------------------
  //  Per-resource enrichment dispatch
  // -------------------------------------------------------

  private async enrichResource(resource: PendingResource): Promise<EnrichmentResult | null> {
    const startMs = Date.now();
    let sourceApi: string;
    let result: EnrichmentResult | null = null;

    if (resource.arxiv_id) {
      sourceApi = "arxiv";
      result = await this.enrichFromArxiv(resource.arxiv_id);
    } else if (resource.doi) {
      sourceApi = "crossref";
      result = await this.enrichFromCrossRef(resource.doi);
    } else if (resource.github_owner && resource.github_repo) {
      sourceApi = "github";
      result = await this.enrichFromGitHub(resource.github_owner, resource.github_repo);
    } else if (resource.source_type === "huggingface_model") {
      sourceApi = "huggingface";
      const slug = resource.external_id.replace(/^hf:/, "");
      result = await this.enrichFromHuggingFace(slug, "model");
    } else if (resource.source_type === "huggingface_dataset") {
      sourceApi = "huggingface";
      const slug = resource.external_id.replace(/^hf-ds:/, "");
      result = await this.enrichFromHuggingFace(slug, "dataset");
    } else if (resource.source_type === "replicate_model") {
      sourceApi = "replicate";
      const slug = resource.external_id.replace(/^replicate:/, "");
      result = await this.enrichFromReplicate(slug);
    } else if (resource.source_type === "pypi_package") {
      sourceApi = "pypi";
      const name = resource.external_id.replace(/^pypi:/, "");
      result = await this.enrichFromPyPI(name);
    } else if (resource.source_type === "ollama_model") {
      sourceApi = "ollama";
      // Ollama has no public metadata API — mark complete with stub data
      result = {
        title: resource.external_id.replace(/^ollama:/, ""),
        faculty: ["language", "generation"],
        libraryName: "ollama",
      };
    } else if (resource.source_type === "researchhub_paper") {
      sourceApi = "researchhub";
      const rhId = resource.external_id.replace(/^researchhub:/, "");
      result = await this.enrichFromResearchHub(rhId);
    } else {
      // Unknown source type — mark as complete with no enrichment
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'complete', updated_at = NOW() WHERE id = $1`,
        [resource.id],
      );
      return null;
    }

    // Log the attempt
    await this.pool.query(
      `INSERT INTO resource_enrichment_log (resource_id, status, source_api, fields_updated, duration_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        resource.id,
        result ? "success" : "failed",
        sourceApi!,
        JSON.stringify(result ? Object.keys(result) : []),
        Date.now() - startMs,
      ],
    );

    return result;
  }

  // -------------------------------------------------------
  //  arXiv API enrichment
  // -------------------------------------------------------

  private async enrichFromArxiv(arxivId: string): Promise<EnrichmentResult | null> {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Nookplot/1.0 (agent coordination protocol)" },
    });

    if (!response.ok) return null;

    const xml = await response.text();

    // Parse XML (lightweight — no external dep)
    const title = this.extractXml(xml, "title")?.replace(/\s+/g, " ").trim();
    const summary = this.extractXml(xml, "summary")?.replace(/\s+/g, " ").trim();
    const published = this.extractXml(xml, "published");

    // Extract authors
    const authors: string[] = [];
    const authorMatches = xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g);
    for (const m of authorMatches) {
      authors.push(m[1].trim());
    }

    // Extract categories
    const tags: string[] = [];
    const catMatches = xml.matchAll(/category\s+term="([^"]+)"/g);
    for (const m of catMatches) {
      tags.push(m[1]);
    }

    if (!title || title === "Error") return null;

    return {
      title,
      description: summary ?? undefined,
      authors: authors.map((a) => ({ name: a })),
      tags,
      publishedDate: published ?? undefined,
    };
  }

  // -------------------------------------------------------
  //  CrossRef API enrichment (DOI)
  // -------------------------------------------------------

  private async enrichFromCrossRef(doi: string): Promise<EnrichmentResult | null> {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "Nookplot/1.0 (agent coordination protocol; mailto:admin@nookplot.com)",
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      message?: {
        title?: string[];
        abstract?: string;
        author?: Array<{ given?: string; family?: string }>;
        subject?: string[];
        "is-referenced-by-count"?: number;
        created?: { "date-time"?: string };
      };
    };

    const msg = data.message;
    if (!msg) return null;

    return {
      title: msg.title?.[0],
      description: msg.abstract?.replace(/<[^>]*>/g, "").trim(),
      authors: (msg.author ?? []).map((a) => ({
        name: [a.given, a.family].filter(Boolean).join(" "),
      })),
      tags: msg.subject ?? [],
      citationCount: msg["is-referenced-by-count"],
      publishedDate: msg.created?.["date-time"],
    };
  }

  // -------------------------------------------------------
  //  GitHub API enrichment (unauthenticated — 60 req/hr)
  // -------------------------------------------------------

  private async enrichFromGitHub(owner: string, repo: string): Promise<EnrichmentResult | null> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Nookplot/1.0",
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      full_name?: string;
      description?: string;
      topics?: string[];
      language?: string;
      stargazers_count?: number;
      forks_count?: number;
      created_at?: string;
    };

    return {
      title: data.full_name ?? `${owner}/${repo}`,
      description: data.description ?? undefined,
      tags: data.topics ?? [],
      githubStars: data.stargazers_count,
      githubForks: data.forks_count,
      githubTopics: data.topics ?? [],
      githubLanguage: data.language ?? undefined,
      publishedDate: data.created_at,
    };
  }

  // -------------------------------------------------------
  //  Apply enrichment to DB
  // -------------------------------------------------------

  private async applyEnrichment(resourceId: string, result: EnrichmentResult): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (result.title) {
      sets.push(`title = $${idx++}`);
      params.push(result.title);
    }
    if (result.description) {
      sets.push(`description = $${idx++}`);
      params.push(result.description);
    }
    if (result.authors && result.authors.length > 0) {
      sets.push(`authors = $${idx++}`);
      params.push(JSON.stringify(result.authors));
    }
    if (result.tags && result.tags.length > 0) {
      sets.push(`tags = $${idx++}`);
      params.push(JSON.stringify(result.tags));
    }
    if (result.publishedDate) {
      sets.push(`published_date = $${idx++}`);
      params.push(result.publishedDate);
    }
    if (result.citationCount != null) {
      sets.push(`citation_count = $${idx++}`);
      params.push(result.citationCount);
    }
    if (result.githubStars != null) {
      sets.push(`github_stars = $${idx++}`);
      params.push(result.githubStars);
    }
    if (result.githubForks != null) {
      sets.push(`github_forks = $${idx++}`);
      params.push(result.githubForks);
    }
    if (result.githubTopics) {
      sets.push(`github_topics = $${idx++}`);
      params.push(JSON.stringify(result.githubTopics));
    }
    if (result.githubLanguage) {
      sets.push(`github_language = $${idx++}`);
      params.push(result.githubLanguage);
    }
    if (result.faculty && result.faculty.length > 0) {
      sets.push(`faculty = $${idx++}`);
      params.push(result.faculty);
    }
    if (result.hfDownloads != null) {
      sets.push(`hf_downloads = $${idx++}`);
      params.push(result.hfDownloads);
    }
    if (result.hfLikes != null) {
      sets.push(`hf_likes = $${idx++}`);
      params.push(result.hfLikes);
    }
    if (result.benchmarkScores && Object.keys(result.benchmarkScores).length > 0) {
      sets.push(`benchmark_scores = $${idx++}`);
      params.push(JSON.stringify(result.benchmarkScores));
    }
    if (result.libraryName) {
      sets.push(`library_name = $${idx++}`);
      params.push(result.libraryName);
    }
    if (result.registryMetadata && Object.keys(result.registryMetadata).length > 0) {
      sets.push(`registry_metadata = $${idx++}`);
      params.push(JSON.stringify(result.registryMetadata));
    }
    if (result.rhScore != null) {
      sets.push(`rh_score = $${idx++}`);
      params.push(result.rhScore);
    }
    if (result.rhPeerReviewStatus) {
      sets.push(`rh_peer_review_status = $${idx++}`);
      params.push(result.rhPeerReviewStatus);
    }
    if (result.rhBountyCount != null) {
      sets.push(`rh_bounty_count = $${idx++}`);
      params.push(result.rhBountyCount);
    }
    if (result.rhRscEarned != null) {
      sets.push(`rh_rsc_earned = $${idx++}`);
      params.push(result.rhRscEarned);
    }
    if (result.rhHubs && result.rhHubs.length > 0) {
      sets.push(`rh_hubs = $${idx++}`);
      params.push(result.rhHubs);
    }
    if (result.rhPaperId != null) {
      sets.push(`rh_paper_id = $${idx++}`);
      params.push(result.rhPaperId);
    }
    if (result.rhDiscussionCount != null) {
      sets.push(`rh_discussion_count = $${idx++}`);
      params.push(result.rhDiscussionCount);
    }

    sets.push(`enrichment_status = 'complete'`);
    sets.push(`updated_at = NOW()`);

    params.push(resourceId);

    await this.pool.query(
      `UPDATE knowledge_resources SET ${sets.join(", ")} WHERE id = $${idx}`,
      params,
    );
  }

  // -------------------------------------------------------
  //  Error handling
  // -------------------------------------------------------

  private async markFailed(resourceId: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);

    // Check retry count
    const { rows } = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM resource_enrichment_log
       WHERE resource_id = $1 AND status = 'failed'`,
      [resourceId],
    );
    const retries = parseInt(rows[0]?.cnt ?? "0", 10);

    if (retries >= MAX_RETRIES) {
      // Permanently failed
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [resourceId],
      );
    } else {
      // Reset to pending for retry
      await this.pool.query(
        `UPDATE knowledge_resources SET enrichment_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [resourceId],
      );
    }

    // Log the failure
    await this.pool.query(
      `INSERT INTO resource_enrichment_log (resource_id, status, source_api, error_message, duration_ms)
       VALUES ($1, 'failed', 'unknown', $2, 0)`,
      [resourceId, msg],
    ).catch(() => {});

    logSecurityEvent("warn", "resource-enrichment-failed", {
      resourceId,
      error: msg,
      retriesUsed: retries + 1,
    });
  }

  // -------------------------------------------------------
  //  Hugging Face API enrichment (free, no auth for public)
  // -------------------------------------------------------

  private async enrichFromHuggingFace(
    slug: string,
    kind: "model" | "dataset",
  ): Promise<EnrichmentResult | null> {
    // Slug is "owner/model" — encode each segment separately to preserve the /
    const encodedSlug = slug.split("/").map(encodeURIComponent).join("/");
    const apiBase = kind === "model"
      ? `https://huggingface.co/api/models/${encodedSlug}`
      : `https://huggingface.co/api/datasets/${encodedSlug}`;

    const response = await fetch(apiBase, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Nookplot/1.0 (agent coordination protocol)" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      id?: string;
      modelId?: string;
      pipeline_tag?: string;
      tags?: string[];
      library_name?: string;
      downloads?: number;
      likes?: number;
      description?: string;
      cardData?: {
        license?: string | string[];
        datasets?: string[];
        metrics?: string[];
        model_name?: string;
      };
      "model-index"?: Array<{
        name?: string;
        results?: Array<{
          task?: { type?: string };
          dataset?: { name?: string };
          metrics?: Array<{ type?: string; value?: number }>;
        }>;
      }>;
      author?: string;
      lastModified?: string;
      createdAt?: string;
    };

    // Map pipeline_tag to faculty taxonomy
    const faculty = pipelineTagToFaculty(data.pipeline_tag);

    // Extract benchmark scores from model-index
    const benchmarkScores: Record<string, unknown> = {};
    if (data["model-index"]) {
      for (const entry of data["model-index"]) {
        for (const result of entry.results ?? []) {
          for (const metric of result.metrics ?? []) {
            if (metric.type && metric.value != null) {
              benchmarkScores[metric.type] = metric.value;
            }
          }
        }
      }
    }

    // Quality score for HF models
    const dlScore = Math.min(40, Math.log2((data.downloads ?? 0) + 1) * 3);
    const likesScore = Math.min(20, Math.log2((data.likes ?? 0) + 1) * 5);
    const hasDesc = data.description || data.cardData ? 15 : 0;
    const hasBenchmarks = Object.keys(benchmarkScores).length > 0 ? 15 : 0;
    const hasLib = data.library_name ? 10 : 0;

    // Merge all tags
    const tags: string[] = [...(data.tags ?? [])];
    if (data.pipeline_tag && !tags.includes(data.pipeline_tag)) {
      tags.push(data.pipeline_tag);
    }
    if (data.cardData?.license) {
      const licenses = Array.isArray(data.cardData.license)
        ? data.cardData.license
        : [data.cardData.license];
      for (const l of licenses) {
        if (!tags.includes(l)) tags.push(l);
      }
    }

    return {
      title: data.id ?? data.modelId ?? slug,
      description: data.description ?? undefined,
      tags,
      faculty,
      hfDownloads: data.downloads ?? 0,
      hfLikes: data.likes ?? 0,
      benchmarkScores: Object.keys(benchmarkScores).length > 0 ? benchmarkScores : undefined,
      libraryName: data.library_name ?? undefined,
      publishedDate: data.createdAt ?? data.lastModified ?? undefined,
      registryMetadata: {
        pipeline_tag: data.pipeline_tag,
        author: data.author,
        datasets: data.cardData?.datasets,
        qualityBreakdown: {
          downloads: Math.round(dlScore),
          likes: Math.round(likesScore),
          description: hasDesc,
          benchmarks: hasBenchmarks,
          library: hasLib,
        },
        qualityScore: Math.round(Math.min(100, dlScore + likesScore + hasDesc + hasBenchmarks + hasLib)),
      },
    };
  }

  // -------------------------------------------------------
  //  Replicate API enrichment (public models only)
  // -------------------------------------------------------

  private async enrichFromReplicate(slug: string): Promise<EnrichmentResult | null> {
    // Slug is "owner/model" — encode each segment separately to preserve the /
    const url = `https://api.replicate.com/v1/models/${slug.split("/").map(encodeURIComponent).join("/")}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Nookplot/1.0" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      name?: string;
      owner?: string;
      description?: string;
      visibility?: string;
      run_count?: number;
      github_url?: string;
      latest_version?: { id?: string; created_at?: string };
      default_example?: { model?: string };
    };

    const runCount = data.run_count ?? 0;
    const dlScore = Math.min(50, Math.log2(runCount + 1) * 4);
    const hasDesc = data.description ? 20 : 0;
    const qualityScore = Math.round(Math.min(100, dlScore + hasDesc + 10));

    return {
      title: data.name ? `${data.owner}/${data.name}` : slug,
      description: data.description ?? undefined,
      faculty: ["language", "generation"], // Most Replicate models are generative
      publishedDate: data.latest_version?.created_at ?? undefined,
      registryMetadata: {
        run_count: runCount,
        github_url: data.github_url,
        visibility: data.visibility,
        qualityScore,
      },
    };
  }

  // -------------------------------------------------------
  //  PyPI API enrichment
  // -------------------------------------------------------

  private async enrichFromPyPI(packageName: string): Promise<EnrichmentResult | null> {
    const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Nookplot/1.0" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      info?: {
        name?: string;
        summary?: string;
        author?: string;
        author_email?: string;
        license?: string;
        version?: string;
        home_page?: string;
        project_urls?: Record<string, string>;
        classifiers?: string[];
        keywords?: string;
        requires_python?: string;
      };
    };

    const info = data.info;
    if (!info) return null;

    // Extract tags from classifiers and keywords
    const tags: string[] = [];
    if (info.keywords) {
      tags.push(...info.keywords.split(/[,\s]+/).filter(Boolean));
    }
    // Extract topic classifiers
    for (const c of info.classifiers ?? []) {
      if (c.startsWith("Topic ::")) {
        tags.push(c.split("::").pop()?.trim() ?? "");
      }
    }

    const authors = info.author
      ? [{ name: info.author, email: info.author_email }]
      : [];

    return {
      title: info.name ?? packageName,
      description: info.summary ?? undefined,
      authors,
      tags: tags.filter(Boolean),
      libraryName: "python",
      publishedDate: undefined,
      registryMetadata: {
        version: info.version,
        license: info.license,
        home_page: info.home_page,
        project_urls: info.project_urls,
        requires_python: info.requires_python,
      },
    };
  }

  // -------------------------------------------------------
  //  ResearchHub API enrichment
  // -------------------------------------------------------

  private async enrichFromResearchHub(rhId: string): Promise<EnrichmentResult | null> {
    const url = `https://backend.researchhub.com/api/paper/${encodeURIComponent(rhId)}/`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "Nookplot/1.0 (agent coordination protocol on Base L2)",
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      id?: number;
      title?: string;
      paper_title?: string;
      abstract?: string;
      doi?: string;
      url?: string;
      score?: number;
      discussion_count?: number;
      boost_amount?: number;
      authors?: Array<{ first_name?: string; last_name?: string; author_profile?: { id?: number } }>;
      hubs?: Array<{ name?: string; slug?: string }>;
      created_date?: string;
      paper_publish_date?: string;
      unified_document?: {
        document_type?: string;
        reviews?: { avg_rating?: number; count?: number };
      };
      bounties?: Array<{ amount?: number; status?: string; bounty_type?: string }>;
    };

    const title = data.paper_title ?? data.title;
    if (!title) return null;

    // Map RH hubs to our faculty taxonomy
    const rhHubs = (data.hubs ?? []).map((h) => h.slug ?? h.name ?? "").filter(Boolean);
    const faculty = rhHubsToFaculty(rhHubs);

    // Extract authors
    const authors = (data.authors ?? []).map((a) => ({
      name: [a.first_name, a.last_name].filter(Boolean).join(" "),
    }));

    // Compute peer review status from reviews
    const reviews = data.unified_document?.reviews;
    let peerReviewStatus = "none";
    if (reviews && reviews.count && reviews.count > 0) {
      peerReviewStatus = "reviewed";
    }

    // Count bounties
    const bounties = data.bounties ?? [];
    const activeBounties = bounties.filter((b) => b.status === "OPEN");
    const totalRsc = bounties.reduce((sum, b) => sum + (b.amount ?? 0), 0);

    // Quality score incorporating RH signals
    const scoreComponent = Math.min(30, Math.log2((data.score ?? 0) + 1) * 5);
    const discussionComponent = Math.min(20, Math.log2((data.discussion_count ?? 0) + 1) * 5);
    const reviewComponent = peerReviewStatus === "reviewed" ? 25 : 0;
    const bountyComponent = activeBounties.length > 0 ? 15 : 0;
    const hasAbstract = data.abstract ? 10 : 0;
    const qualityScore = Math.round(Math.min(100,
      scoreComponent + discussionComponent + reviewComponent + bountyComponent + hasAbstract));

    // Tags from hubs
    const tags = [...rhHubs];
    if (data.doi) tags.push(`doi:${data.doi}`);

    return {
      title,
      description: data.abstract ?? undefined,
      authors,
      tags,
      faculty,
      publishedDate: data.paper_publish_date ?? data.created_date ?? undefined,
      citationCount: undefined, // RH doesn't expose external citation count directly
      rhScore: data.score ?? 0,
      rhPeerReviewStatus: peerReviewStatus,
      rhBountyCount: activeBounties.length,
      rhRscEarned: totalRsc,
      rhHubs,
      rhPaperId: data.id,
      rhDiscussionCount: data.discussion_count ?? 0,
      registryMetadata: {
        boost_amount: data.boost_amount,
        review_avg_rating: reviews?.avg_rating,
        review_count: reviews?.count,
        bounty_details: activeBounties.map((b) => ({ amount: b.amount, type: b.bounty_type })),
        qualityBreakdown: {
          score: Math.round(scoreComponent),
          discussion: Math.round(discussionComponent),
          peerReview: reviewComponent,
          bounty: bountyComponent,
          abstract: hasAbstract,
        },
        qualityScore,
      },
    };
  }

  // -------------------------------------------------------
  //  XML helper (lightweight — avoids external XML dep)
  // -------------------------------------------------------

  private extractXml(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return match ? match[1] : null;
  }
}
