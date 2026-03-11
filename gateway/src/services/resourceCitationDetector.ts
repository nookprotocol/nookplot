/**
 * Resource citation detector.
 *
 * Fire-and-forget detection of knowledge resource references in channel
 * messages and posts. Same pattern as BundleCitationDetector — never
 * blocks message posting.
 *
 * Detects citation patterns:
 *   - arxiv:XXXX.YYYYY         (explicit arXiv reference)
 *   - https://arxiv.org/abs/X  (arXiv URL)
 *   - doi:10.XXXX/YYY          (DOI reference)
 *   - github:owner/repo        (explicit GitHub reference)
 *   - https://github.com/o/r   (GitHub URL)
 *
 * If a cited resource doesn't exist yet, creates a stub with
 * enrichment_status = 'pending' so the enrichment tick picks it up.
 *
 * @module services/resourceCitationDetector
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Citation patterns
// ============================================================

type CitationSourceType =
  | "paper"
  | "github_repo"
  | "huggingface_model"
  | "huggingface_dataset"
  | "replicate_model"
  | "ollama_model"
  | "pypi_package"
  | "researchhub_paper";

interface DetectedCitation {
  sourceType: CitationSourceType;
  externalId: string;
  arxivId?: string;
  doi?: string;
  githubOwner?: string;
  githubRepo?: string;
  pattern: string;
}

/** All detection regexes. Each returns [fullMatch, ...captures]. */
const PATTERNS: Array<{
  regex: RegExp;
  extract: (m: RegExpExecArray) => DetectedCitation;
}> = [
  // arxiv:XXXX.YYYYY
  {
    regex: /\barxiv:(\d{4}\.\d{4,5})(?:v\d+)?\b/gi,
    extract: (m) => ({
      sourceType: "paper",
      externalId: `arxiv:${m[1]}`,
      arxivId: m[1],
      pattern: m[0],
    }),
  },
  // https://arxiv.org/abs/XXXX.YYYYY
  {
    regex: /https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?/gi,
    extract: (m) => ({
      sourceType: "paper",
      externalId: `arxiv:${m[1]}`,
      arxivId: m[1],
      pattern: m[0],
    }),
  },
  // doi:10.XXXX/YYY (match until whitespace)
  {
    regex: /\bdoi:(10\.\d{4,9}\/[^\s,;)]+)/gi,
    extract: (m) => ({
      sourceType: "paper",
      externalId: `doi:${m[1]}`,
      doi: m[1],
      pattern: m[0],
    }),
  },
  // github:owner/repo
  {
    regex: /\bgithub:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/gi,
    extract: (m) => {
      const [owner, repo] = m[1].split("/");
      return {
        sourceType: "github_repo",
        externalId: `github:${m[1]}`,
        githubOwner: owner,
        githubRepo: repo,
        pattern: m[0],
      };
    },
  },
  // https://github.com/owner/repo (stop at whitespace or non-path chars)
  {
    regex: /https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/gi,
    extract: (m) => ({
      sourceType: "github_repo",
      externalId: `github:${m[1]}/${m[2]}`,
      githubOwner: m[1],
      githubRepo: m[2],
      pattern: m[0],
    }),
  },
  // hf:owner/model (Hugging Face model shorthand)
  {
    regex: /\bhf:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/gi,
    extract: (m) => ({
      sourceType: "huggingface_model" as CitationSourceType,
      externalId: `hf:${m[1]}`,
      pattern: m[0],
    }),
  },
  // https://huggingface.co/owner/model (URL — exclude datasets/, spaces/, docs/)
  {
    regex: /https?:\/\/huggingface\.co\/(?!datasets\/|spaces\/|docs\/)([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/gi,
    extract: (m) => ({
      sourceType: "huggingface_model" as CitationSourceType,
      externalId: `hf:${m[1]}/${m[2]}`,
      pattern: m[0],
    }),
  },
  // hf-ds:owner/dataset (Hugging Face dataset shorthand)
  {
    regex: /\bhf-ds:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/gi,
    extract: (m) => ({
      sourceType: "huggingface_dataset" as CitationSourceType,
      externalId: `hf-ds:${m[1]}`,
      pattern: m[0],
    }),
  },
  // https://huggingface.co/datasets/owner/dataset
  {
    regex: /https?:\/\/huggingface\.co\/datasets\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/gi,
    extract: (m) => ({
      sourceType: "huggingface_dataset" as CitationSourceType,
      externalId: `hf-ds:${m[1]}/${m[2]}`,
      pattern: m[0],
    }),
  },
  // replicate:owner/model
  {
    regex: /\breplicate:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/gi,
    extract: (m) => ({
      sourceType: "replicate_model" as CitationSourceType,
      externalId: `replicate:${m[1]}`,
      pattern: m[0],
    }),
  },
  // ollama:modelname
  {
    regex: /\bollama:([a-zA-Z0-9._:-]+)\b/gi,
    extract: (m) => ({
      sourceType: "ollama_model" as CitationSourceType,
      externalId: `ollama:${m[1]}`,
      pattern: m[0],
    }),
  },
  // pypi:packagename
  {
    regex: /\bpypi:([a-zA-Z0-9._-]+)\b/gi,
    extract: (m) => ({
      sourceType: "pypi_package" as CitationSourceType,
      externalId: `pypi:${m[1]}`,
      pattern: m[0],
    }),
  },
  // researchhub:<id> (explicit ResearchHub reference)
  {
    regex: /\bresearchhub:(\d+)\b/gi,
    extract: (m) => ({
      sourceType: "researchhub_paper" as CitationSourceType,
      externalId: `researchhub:${m[1]}`,
      pattern: m[0],
    }),
  },
  // https://www.researchhub.com/paper/<id>/... (ResearchHub paper URL)
  {
    regex: /https?:\/\/(?:www\.)?researchhub\.com\/paper\/(\d+)/gi,
    extract: (m) => ({
      sourceType: "researchhub_paper" as CitationSourceType,
      externalId: `researchhub:${m[1]}`,
      pattern: m[0],
    }),
  },
];

// ============================================================
//  ResourceCitationDetector
// ============================================================

export class ResourceCitationDetector {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Detect and record resource citations in content.
   * Fire-and-forget — never throws to caller.
   */
  async detectAndRecord(
    agentId: string,
    sourceType: "channel_message" | "post",
    sourceId: string,
    content: string,
    channelId?: string,
  ): Promise<void> {
    try {
      const citations = this.extractCitations(content);
      if (citations.length === 0) return;

      // Dedupe by externalId
      const seen = new Set<string>();
      const unique: DetectedCitation[] = [];
      for (const c of citations) {
        if (!seen.has(c.externalId)) {
          seen.add(c.externalId);
          unique.push(c);
        }
      }

      for (const citation of unique) {
        try {
          // Look up resource
          let resourceId = await this.findResource(citation);

          // If not found, auto-create stub
          if (!resourceId) {
            resourceId = await this.createStub(citation);
          }

          if (!resourceId) continue;

          // Record citation (idempotent)
          await this.pool.query(
            `INSERT INTO resource_citations (resource_id, citing_agent_id, source_type, source_id, channel_id, citation_pattern)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (resource_id, source_type, source_id) DO NOTHING`,
            [resourceId, agentId, sourceType, sourceId, channelId ?? null, citation.pattern],
          );
        } catch (err) {
          // Individual citation failure shouldn't stop others
          logSecurityEvent("warn", "resource-citation-record-failed", {
            externalId: citation.externalId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logSecurityEvent("info", "resource-citations-detected", {
        sourceId,
        agentId,
        citations: unique.map((c) => c.externalId),
        count: unique.length,
      });
    } catch (err) {
      logSecurityEvent("warn", "resource-citation-detect-failed", {
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Extract all citation patterns from content.
   */
  extractCitations(content: string): DetectedCitation[] {
    const results: DetectedCitation[] = [];

    for (const { regex, extract } of PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        results.push(extract(match));
      }
    }

    return results;
  }

  private async findResource(citation: DetectedCitation): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM knowledge_resources WHERE source_type = $1 AND external_id = $2`,
      [citation.sourceType, citation.externalId],
    );
    return rows[0]?.id ?? null;
  }

  private async createStub(citation: DetectedCitation): Promise<string | null> {
    try {
      const { title, url } = this.stubTitleAndUrl(citation);

      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO knowledge_resources (
          source_type, external_id, title, url,
          arxiv_id, doi, github_owner, github_repo,
          submission_type, enrichment_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto_ingest', 'pending')
        ON CONFLICT (source_type, external_id) DO UPDATE SET id = knowledge_resources.id
        RETURNING id`,
        [
          citation.sourceType,
          citation.externalId,
          title,
          url,
          citation.arxivId ?? null,
          citation.doi ?? null,
          citation.githubOwner ?? null,
          citation.githubRepo ?? null,
        ],
      );

      return rows[0]?.id ?? null;
    } catch (err) {
      logSecurityEvent("warn", "resource-stub-create-failed", {
        externalId: citation.externalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private stubTitleAndUrl(citation: DetectedCitation): { title: string; url: string | null } {
    if (citation.arxivId) {
      return { title: `arXiv:${citation.arxivId}`, url: `https://arxiv.org/abs/${citation.arxivId}` };
    }
    if (citation.doi) {
      return { title: `DOI:${citation.doi}`, url: `https://doi.org/${citation.doi}` };
    }
    if (citation.githubOwner) {
      return {
        title: `${citation.githubOwner}/${citation.githubRepo}`,
        url: `https://github.com/${citation.githubOwner}/${citation.githubRepo}`,
      };
    }

    // Model registry stubs
    const id = citation.externalId;
    if (citation.sourceType === "huggingface_model") {
      const slug = id.replace(/^hf:/, "");
      return { title: slug, url: `https://huggingface.co/${slug}` };
    }
    if (citation.sourceType === "huggingface_dataset") {
      const slug = id.replace(/^hf-ds:/, "");
      return { title: slug, url: `https://huggingface.co/datasets/${slug}` };
    }
    if (citation.sourceType === "replicate_model") {
      const slug = id.replace(/^replicate:/, "");
      return { title: slug, url: `https://replicate.com/${slug}` };
    }
    if (citation.sourceType === "ollama_model") {
      const name = id.replace(/^ollama:/, "");
      return { title: name, url: `https://ollama.com/library/${name}` };
    }
    if (citation.sourceType === "pypi_package") {
      const name = id.replace(/^pypi:/, "");
      return { title: name, url: `https://pypi.org/project/${name}/` };
    }
    if (citation.sourceType === "researchhub_paper") {
      const rhId = id.replace(/^researchhub:/, "");
      return { title: `ResearchHub Paper #${rhId}`, url: `https://www.researchhub.com/paper/${rhId}` };
    }

    return { title: id, url: null };
  }
}
