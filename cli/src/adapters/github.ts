/**
 * GitHub knowledge adapter.
 *
 * Fetches README + description for each configured repo
 * and returns them as knowledge entries for sync.
 *
 * Usage in nookplot.yaml:
 * ```yaml
 * knowledge:
 *   sources:
 *     - type: github
 *       repos: ["langchain-ai/langchain", "anthropics/anthropic-cookbook"]
 *       includeReadme: true  # default: true
 *       pat: ${GITHUB_PAT}   # optional, for private repos / higher rate limits
 * ```
 *
 * @module adapters/github
 */

import type { KnowledgeAdapter, KnowledgeEntry } from "./types.js";
import { computeHash } from "../utils/knowledge.js";

const GITHUB_API = "https://api.github.com";

export interface GitHubAdapterConfig {
  repos: string[];
  pat?: string;
  includeReadme?: boolean;
}

export class GitHubAdapter implements KnowledgeAdapter {
  readonly name = "github";
  private readonly config: GitHubAdapterConfig;

  constructor(config: GitHubAdapterConfig) {
    this.config = config;
  }

  async discover(): Promise<KnowledgeEntry[]> {
    if (!this.config.repos || this.config.repos.length === 0) {
      throw new Error("GitHub adapter requires at least one repo in the 'repos' array.");
    }

    const entries: KnowledgeEntry[] = [];
    const includeReadme = this.config.includeReadme !== false;

    for (const repoRef of this.config.repos) {
      const parts = repoRef.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        console.warn(`[github] Skipping invalid repo reference: "${repoRef}" (expected "owner/repo")`);
        continue;
      }

      const [owner, repo] = parts;

      try {
        // Fetch repo metadata
        const repoData = await this.fetchJson<{
          full_name: string;
          description: string | null;
          topics: string[];
          language: string | null;
          stargazers_count: number;
          license: { spdx_id: string } | null;
        }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);

        let body = repoData.description ?? `GitHub repository: ${repoData.full_name}`;
        const tags = [...(repoData.topics ?? [])];
        if (repoData.language) tags.push(repoData.language.toLowerCase());

        // Fetch README if enabled
        if (includeReadme) {
          try {
            const readmeData = await this.fetchJson<{
              content: string;
              encoding: string;
            }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`);

            const readmeContent = Buffer.from(readmeData.content, "base64").toString("utf-8");
            body = `${body}\n\n---\n\n${readmeContent}`;
          } catch {
            // README not found — continue with description only
          }
        }

        entries.push({
          id: `github:${repoData.full_name}`,
          title: repoData.full_name,
          body,
          tags: tags.length > 0 ? tags : undefined,
          hash: computeHash(repoData.full_name + body),
        });
      } catch (err) {
        console.warn(`[github] Failed to fetch repo "${repoRef}": ${err}`);
      }
    }

    return entries;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NookplotCLI/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (this.config.pat) {
      headers.Authorization = `Bearer ${this.config.pat}`;
    }

    const response = await fetch(`${GITHUB_API}${path}`, { headers });

    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
