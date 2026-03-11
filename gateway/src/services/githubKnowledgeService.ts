/**
 * GitHub Knowledge Service.
 *
 * Handles importing GitHub repos as projects, syncing metadata,
 * auto-curating popular AI/ML/crypto repos, and claim verification.
 *
 * Three flows:
 * 1. User imports their own repos as projects (source='github')
 * 2. Popular AI repos auto-curated into network (source='github-auto')
 * 3. Agents discover, track, and contribute via existing infrastructure
 *
 * @module services/githubKnowledgeService
 */

import type pg from "pg";
import crypto from "crypto";
import { GitHubClient, type RepoMetadata } from "./githubClient.js";
import { ContentScanner } from "./contentScanner.js";
import { SearchService } from "./searchService.js";
import { encryptPrivateKey, decryptPrivateKey } from "../secretManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface GitHubKnowledgeConfig {
  /** Server PAT for auto-curation API calls (no user auth needed). */
  serverPat: string;
  /** Master key for encrypting OAuth tokens. */
  secretEncryptionKey: string;
  /** Content scan block threshold. */
  contentScanBlockThreshold: number;
}

export interface ImportResult {
  projectId: string;
  name: string;
  source: string;
  isNew: boolean;
}

export interface SyncResult {
  projectId: string;
  updated: boolean;
  error?: string;
}

export interface AutoCurationResult {
  imported: number;
  skipped: number;
  errors: number;
}

export interface ClaimResult {
  success: boolean;
  reason?: string;
}

// ============================================================
//  Rate Limit Tracker
// ============================================================

interface RateBucket {
  remaining: number;
  resetAt: Date;
}

class RateLimitTracker {
  private core: RateBucket = { remaining: 5000, resetAt: new Date(0) };
  private search: RateBucket = { remaining: 30, resetAt: new Date(0) };

  updateCore(remaining: number, resetAt: Date): void {
    this.core = { remaining, resetAt };
  }

  updateSearch(remaining: number, resetAt: Date): void {
    this.search = { remaining, resetAt };
  }

  canMakeCoreRequest(minRemaining = 100): boolean {
    if (this.core.resetAt < new Date()) return true; // reset happened
    return this.core.remaining > minRemaining;
  }

  canMakeSearchRequest(minRemaining = 5): boolean {
    if (this.search.resetAt < new Date()) return true;
    return this.search.remaining > minRemaining;
  }
}

// ============================================================
//  Auto-Curation Seed Queries
// ============================================================

const AUTO_CURATION_QUERIES = [
  { category: "ai", query: "topic:artificial-intelligence stars:>1000" },
  { category: "ml", query: "topic:machine-learning stars:>1000" },
  { category: "llm", query: "topic:llm stars:>500" },
  { category: "agents", query: "topic:ai-agents stars:>500" },
  { category: "ethereum", query: "topic:ethereum stars:>1000" },
  { category: "web3", query: "topic:web3 stars:>500" },
];

const SEED_REPOS: Array<{ owner: string; repo: string; category: string }> = [
  { owner: "pytorch", repo: "pytorch", category: "ml" },
  { owner: "huggingface", repo: "transformers", category: "ml" },
  { owner: "langchain-ai", repo: "langchain", category: "agents" },
  { owner: "openai", repo: "openai-python", category: "ai" },
  { owner: "vllm-project", repo: "vllm", category: "llm" },
  { owner: "anthropics", repo: "anthropic-sdk-python", category: "ai" },
  { owner: "run-llama", repo: "llama_index", category: "agents" },
  { owner: "crewAIInc", repo: "crewAI", category: "agents" },
  { owner: "microsoft", repo: "autogen", category: "agents" },
  { owner: "AUTOMATIC1111", repo: "stable-diffusion-webui", category: "ai" },
  { owner: "comfyanonymous", repo: "ComfyUI", category: "ai" },
  { owner: "ggerganov", repo: "llama.cpp", category: "llm" },
  { owner: "ollama", repo: "ollama", category: "llm" },
  { owner: "lm-sys", repo: "FastChat", category: "llm" },
  { owner: "ethereum", repo: "go-ethereum", category: "ethereum" },
  { owner: "foundry-rs", repo: "foundry", category: "ethereum" },
  { owner: "OpenZeppelin", repo: "openzeppelin-contracts", category: "ethereum" },
  { owner: "Uniswap", repo: "v3-core", category: "web3" },
  { owner: "aave", repo: "aave-v3-core", category: "web3" },
  { owner: "tensorflow", repo: "tensorflow", category: "ml" },
  { owner: "keras-team", repo: "keras", category: "ml" },
  { owner: "scikit-learn", repo: "scikit-learn", category: "ml" },
  { owner: "dmlc", repo: "xgboost", category: "ml" },
  { owner: "Lightning-AI", repo: "pytorch-lightning", category: "ml" },
  { owner: "deepset-ai", repo: "haystack", category: "agents" },
  { owner: "BerriAI", repo: "litellm", category: "llm" },
  { owner: "chroma-core", repo: "chroma", category: "agents" },
  { owner: "weaviate", repo: "weaviate", category: "agents" },
  { owner: "milvus-io", repo: "milvus", category: "agents" },
  { owner: "qdrant", repo: "qdrant", category: "agents" },
];

/** Max README snippet size stored on the project row. */
const README_SNIPPET_LENGTH = 2000;

/** Max new repos per auto-curation cycle. */
const MAX_AUTO_CURATE_PER_CYCLE = 20;

// ============================================================
//  GitHubKnowledgeService
// ============================================================

export class GitHubKnowledgeService {
  private readonly pool: pg.Pool;
  private readonly githubClient: GitHubClient;
  private readonly contentScanner: ContentScanner | undefined;
  private readonly searchService: SearchService;
  private readonly config: GitHubKnowledgeConfig;
  private readonly rateLimit = new RateLimitTracker();

  constructor(
    pool: pg.Pool,
    githubClient: GitHubClient,
    contentScanner: ContentScanner | undefined,
    searchService: SearchService,
    config: GitHubKnowledgeConfig,
  ) {
    this.pool = pool;
    this.githubClient = githubClient;
    this.contentScanner = contentScanner;
    this.searchService = searchService;
    this.config = config;
  }

  // ------------------------------------------------------------------
  //  Flow 1: User imports their own repos
  // ------------------------------------------------------------------

  /**
   * Import a single GitHub repo as a project.
   * If the project already exists (same owner/repo), returns it without re-creating.
   */
  async importRepo(
    agentId: string,
    owner: string,
    repo: string,
    oauthToken?: string,
  ): Promise<ImportResult> {
    const token = oauthToken || this.config.serverPat;
    if (!token) throw new Error("No GitHub token available for API access.");

    // Check for existing project with same owner/repo
    const existing = await this.pool.query(
      `SELECT id, project_id, name FROM projects
       WHERE github_owner = $1 AND github_repo = $2 AND status = 'active'
       LIMIT 1`,
      [owner, repo],
    );

    if (existing.rows.length > 0) {
      return {
        projectId: existing.rows[0].project_id,
        name: existing.rows[0].name,
        source: "github",
        isNew: false,
      };
    }

    // Fetch metadata from GitHub
    const meta = await this.githubClient.getRepoMetadata(token, owner, repo);

    // Fetch README (optional — don't fail if not found)
    let readmeContent: string | null = null;
    try {
      const readme = await this.githubClient.getReadme(token, owner, repo);
      readmeContent = readme.content;
    } catch {
      // No README, that's fine
    }

    // Content safety check on README
    let readmeClean = true;
    if (readmeContent && this.contentScanner) {
      const scanResult = this.contentScanner.scanForBlocking(
        readmeContent,
        this.config.contentScanBlockThreshold,
      );
      if (scanResult.blocked) {
        readmeClean = false;
        logSecurityEvent("warn", "github-readme-flagged", {
          owner,
          repo,
          maxSeverity: scanResult.result.maxSeverity,
        });
      }
    }

    // Create project
    const projectId = `github-${owner}-${repo}`.toLowerCase();
    const readmeSnippet = readmeClean && readmeContent
      ? readmeContent.slice(0, README_SNIPPET_LENGTH)
      : null;

    const { rows } = await this.pool.query(
      `INSERT INTO projects (
        project_id, name, description, agent_id,
        repo_url, default_branch, languages, tags, license, status,
        source, github_owner, github_repo, github_stars, github_forks,
        github_open_issues, github_topics, github_pushed_at, github_created_at,
        github_last_synced_at, github_is_archived, readme_snippet
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, 'active',
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18,
        NOW(), $19, $20
      )
      ON CONFLICT (github_owner, github_repo) WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL
      DO UPDATE SET github_last_synced_at = NOW()
      RETURNING id, project_id, name`,
      [
        projectId,
        meta.fullName,
        meta.description ?? `GitHub repository: ${meta.fullName}`,
        agentId,
        `https://github.com/${meta.fullName}`,
        meta.defaultBranch,
        meta.language ? [meta.language] : [],
        meta.topics,
        meta.license,
        oauthToken ? "github" : "github-auto",
        owner,
        repo,
        meta.stars,
        meta.forks,
        meta.openIssues,
        meta.topics,
        meta.pushedAt,
        meta.createdAt,
        meta.isArchived,
        readmeSnippet,
      ],
    );

    const project = rows[0];

    // Store full README content for deep FTS (if clean)
    if (readmeClean && readmeContent && project) {
      const contentHash = crypto.createHash("sha256").update(readmeContent).digest("hex");
      await this.pool.query(
        `INSERT INTO github_readme_content (project_id, content, content_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id) DO UPDATE SET
           content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
        [project.id, readmeContent, contentHash],
      );
    }

    return {
      projectId: project.project_id,
      name: project.name,
      source: oauthToken ? "github" : "github-auto",
      isNew: true,
    };
  }

  /**
   * Import multiple repos in batch with rate limit awareness.
   */
  async importMultipleRepos(
    agentId: string,
    repos: Array<{ owner: string; repo: string }>,
    oauthToken?: string,
  ): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    for (const { owner, repo } of repos) {
      if (!this.rateLimit.canMakeCoreRequest()) {
        logSecurityEvent("info", "github-rate-limit-pause", {
          reason: "core API rate limit low",
          remaining: repos.length - results.length,
        });
        break;
      }
      try {
        const result = await this.importRepo(agentId, owner, repo, oauthToken);
        results.push(result);
      } catch (err) {
        logSecurityEvent("warn", "github-import-failed", {
          owner,
          repo,
          error: String(err),
        });
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  //  Sync: re-fetch metadata + README for existing projects
  // ------------------------------------------------------------------

  /**
   * Sync a single project's GitHub metadata and README.
   */
  async syncProject(projectId: string): Promise<SyncResult> {
    const { rows } = await this.pool.query(
      `SELECT id, project_id, github_owner, github_repo, source
       FROM projects
       WHERE (id::text = $1 OR project_id = $1) AND github_owner IS NOT NULL
       LIMIT 1`,
      [projectId],
    );

    if (rows.length === 0) {
      return { projectId, updated: false, error: "Project not found or not a GitHub project" };
    }

    const project = rows[0];
    const token = this.config.serverPat;
    if (!token) {
      return { projectId: project.project_id, updated: false, error: "No server PAT configured" };
    }

    try {
      const meta = await this.githubClient.getRepoMetadata(
        token,
        project.github_owner,
        project.github_repo,
      );

      // Update project metadata
      await this.pool.query(
        `UPDATE projects SET
          github_stars = $1, github_forks = $2, github_open_issues = $3,
          github_topics = $4, github_pushed_at = $5, github_is_archived = $6,
          github_last_synced_at = NOW(), github_sync_error = NULL,
          description = COALESCE(NULLIF($7, ''), description),
          license = COALESCE($8, license)
        WHERE id = $9`,
        [
          meta.stars, meta.forks, meta.openIssues,
          meta.topics, meta.pushedAt, meta.isArchived,
          meta.description, meta.license, project.id,
        ],
      );

      // Re-fetch README and update if changed
      await this.syncReadme(project.id, project.github_owner, project.github_repo, token);

      return { projectId: project.project_id, updated: true };
    } catch (err) {
      const statusMatch = String(err).match(/(\d{3})/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

      await this.handleRepoUnavailable(project.id, statusCode, String(err));
      return { projectId: project.project_id, updated: false, error: String(err) };
    }
  }

  /**
   * Sync README content for a project. Updates only if hash changed.
   */
  private async syncReadme(
    internalId: string,
    owner: string,
    repo: string,
    token: string,
  ): Promise<void> {
    let readmeContent: string;
    try {
      const readme = await this.githubClient.getReadme(token, owner, repo);
      readmeContent = readme.content;
    } catch {
      return; // No README
    }

    // Content safety check
    if (this.contentScanner) {
      const scanResult = this.contentScanner.scanForBlocking(
        readmeContent,
        this.config.contentScanBlockThreshold,
      );
      if (scanResult.blocked) {
        logSecurityEvent("warn", "github-readme-flagged-sync", {
          owner,
          repo,
          maxSeverity: scanResult.result.maxSeverity,
        });
        return;
      }
    }

    const contentHash = crypto.createHash("sha256").update(readmeContent).digest("hex");

    // Check if content changed
    const existing = await this.pool.query(
      `SELECT content_hash FROM github_readme_content WHERE project_id = $1`,
      [internalId],
    );

    if (existing.rows.length > 0 && existing.rows[0].content_hash === contentHash) {
      return; // No change
    }

    // Update README content
    await this.pool.query(
      `INSERT INTO github_readme_content (project_id, content, content_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE SET
         content = EXCLUDED.content,
         content_hash = EXCLUDED.content_hash,
         updated_at = NOW()`,
      [internalId, readmeContent, contentHash],
    );

    // Update snippet on project row
    const snippet = readmeContent.slice(0, README_SNIPPET_LENGTH);
    await this.pool.query(
      `UPDATE projects SET readme_snippet = $1 WHERE id = $2`,
      [snippet, internalId],
    );
  }

  /**
   * Run a full sync cycle: find stale projects and update them.
   */
  async runSyncCycle(): Promise<{ synced: number; errors: number }> {
    const staleMs = 6 * 60 * 60 * 1000; // 6 hours
    const { rows } = await this.pool.query(
      `SELECT id, project_id FROM projects
       WHERE source IN ('github', 'github-auto')
         AND github_owner IS NOT NULL
         AND status = 'active'
         AND (github_last_synced_at IS NULL OR github_last_synced_at < NOW() - INTERVAL '${staleMs} milliseconds')
       ORDER BY github_last_synced_at ASC NULLS FIRST
       LIMIT 50`,
    );

    let synced = 0;
    let errors = 0;

    for (const row of rows) {
      if (!this.rateLimit.canMakeCoreRequest()) {
        logSecurityEvent("info", "github-sync-rate-limit", { remaining: rows.length - synced - errors });
        break;
      }

      const result = await this.syncProject(row.project_id);
      if (result.updated) synced++;
      else errors++;
    }

    if (synced > 0 || errors > 0) {
      console.log(`[github-knowledge] Sync cycle: ${synced} synced, ${errors} errors`);
    }

    return { synced, errors };
  }

  // ------------------------------------------------------------------
  //  Flow 2: Auto-curation of popular repos
  // ------------------------------------------------------------------

  /**
   * Run auto-curation: query GitHub Search API for top repos, import new ones.
   */
  async runAutoCurationCycle(): Promise<AutoCurationResult> {
    const token = this.config.serverPat;
    if (!token) {
      logSecurityEvent("warn", "github-autocuration-no-pat", {});
      return { imported: 0, skipped: 0, errors: 0 };
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    // First: process seed repos
    for (const seed of SEED_REPOS) {
      if (imported >= MAX_AUTO_CURATE_PER_CYCLE) break;
      if (!this.rateLimit.canMakeCoreRequest()) break;

      const alreadyExists = await this.isAlreadyCurated(seed.owner, seed.repo);
      if (alreadyExists) {
        skipped++;
        continue;
      }

      try {
        const result = await this.importRepo("", seed.owner, seed.repo);
        if (result.isNew) {
          await this.recordAutoCurated(seed.owner, seed.repo, result.projectId, seed.category);
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        logSecurityEvent("warn", "github-autocurate-failed", {
          owner: seed.owner,
          repo: seed.repo,
          error: String(err),
        });
      }
    }

    // Then: search queries
    for (const { category, query } of AUTO_CURATION_QUERIES) {
      if (imported >= MAX_AUTO_CURATE_PER_CYCLE) break;
      if (!this.rateLimit.canMakeSearchRequest()) break;

      try {
        const results = await this.githubClient.searchRepositories(token, query, "stars", 10);

        for (const result of results) {
          if (imported >= MAX_AUTO_CURATE_PER_CYCLE) break;
          if (!this.rateLimit.canMakeCoreRequest()) break;

          const alreadyExists = await this.isAlreadyCurated(result.owner, result.repo);
          if (alreadyExists) {
            skipped++;
            continue;
          }

          try {
            const importResult = await this.importRepo("", result.owner, result.repo);
            if (importResult.isNew) {
              await this.recordAutoCurated(result.owner, result.repo, importResult.projectId, category);
              imported++;
            } else {
              skipped++;
            }
          } catch (err) {
            errors++;
            logSecurityEvent("warn", "github-autocurate-import-failed", {
              fullName: result.fullName,
              error: String(err),
            });
          }
        }
      } catch (err) {
        errors++;
        logSecurityEvent("warn", "github-autocurate-search-failed", {
          category,
          query,
          error: String(err),
        });
      }
    }

    console.log(`[github-knowledge] Auto-curation: ${imported} imported, ${skipped} skipped, ${errors} errors`);
    return { imported, skipped, errors };
  }

  // ------------------------------------------------------------------
  //  Claim: verify ownership and transfer project
  // ------------------------------------------------------------------

  /**
   * Claim an unclaimed auto-curated project by verifying GitHub username.
   */
  async claimProject(
    agentId: string,
    projectId: string,
    githubUsername: string,
  ): Promise<ClaimResult> {
    // Verify the agent has a connected GitHub OAuth token with matching username
    const { rows: tokenRows } = await this.pool.query(
      `SELECT github_username FROM github_oauth_tokens WHERE agent_id = $1`,
      [agentId],
    );

    if (tokenRows.length === 0) {
      return { success: false, reason: "No GitHub account connected. Connect GitHub first." };
    }

    if (tokenRows[0].github_username.toLowerCase() !== githubUsername.toLowerCase()) {
      return { success: false, reason: "GitHub username does not match connected account." };
    }

    // Check project exists and is unclaimed (auto-curated, no agent_id or empty)
    const { rows: projectRows } = await this.pool.query(
      `SELECT id, project_id, github_owner, source, agent_id
       FROM projects
       WHERE project_id = $1 AND status = 'active'
       LIMIT 1`,
      [projectId],
    );

    if (projectRows.length === 0) {
      return { success: false, reason: "Project not found." };
    }

    const project = projectRows[0];

    if (project.source !== "github-auto") {
      return { success: false, reason: "Only auto-curated projects can be claimed." };
    }

    if (project.agent_id && project.agent_id !== "") {
      return { success: false, reason: "Project already claimed." };
    }

    // Verify the claiming user is the repo owner
    if (project.github_owner?.toLowerCase() !== githubUsername.toLowerCase()) {
      return { success: false, reason: "You can only claim repos you own on GitHub." };
    }

    // Transfer ownership
    await this.pool.query(
      `UPDATE projects SET agent_id = $1, source = 'github' WHERE id = $2`,
      [agentId, project.id],
    );

    logSecurityEvent("info", "github-project-claimed", {
      agentId,
      projectId,
      githubUsername,
    });

    return { success: true };
  }

  // ------------------------------------------------------------------
  //  OAuth Token Management
  // ------------------------------------------------------------------

  /**
   * Store an encrypted GitHub OAuth token for an agent.
   */
  async storeOAuthToken(
    agentId: string | null,
    webUserId: string | null,
    githubUsername: string,
    githubUserId: string,
    accessToken: string,
    scopes: string,
  ): Promise<void> {
    const { encryptedKey, iv, authTag } = encryptPrivateKey(
      accessToken,
      this.config.secretEncryptionKey,
    );

    await this.pool.query(
      `INSERT INTO github_oauth_tokens (agent_id, web_user_id, github_username, github_user_id, encrypted_token, iv, auth_tag, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id) WHERE agent_id IS NOT NULL
       DO UPDATE SET
         github_username = EXCLUDED.github_username,
         github_user_id = EXCLUDED.github_user_id,
         encrypted_token = EXCLUDED.encrypted_token,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         scopes = EXCLUDED.scopes,
         updated_at = NOW()`,
      [agentId, webUserId, githubUsername, githubUserId, encryptedKey, iv, authTag, scopes],
    );
  }

  /**
   * Get decrypted OAuth token for an agent.
   */
  async getOAuthToken(agentId: string): Promise<{ token: string; username: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT encrypted_token, iv, auth_tag, github_username
       FROM github_oauth_tokens WHERE agent_id = $1`,
      [agentId],
    );

    if (rows.length === 0) return null;

    const token = decryptPrivateKey(
      rows[0].encrypted_token,
      rows[0].iv,
      rows[0].auth_tag,
      this.config.secretEncryptionKey,
    );

    return { token, username: rows[0].github_username };
  }

  /**
   * Check if an agent has a connected GitHub account.
   */
  async getOAuthStatus(agentId: string): Promise<{ connected: boolean; username?: string }> {
    const { rows } = await this.pool.query(
      `SELECT github_username FROM github_oauth_tokens WHERE agent_id = $1`,
      [agentId],
    );

    if (rows.length === 0) return { connected: false };
    return { connected: true, username: rows[0].github_username };
  }

  // ------------------------------------------------------------------
  //  Query Helpers
  // ------------------------------------------------------------------

  /**
   * Get trending auto-curated repos, paginated.
   */
  async getTrending(
    limit = 20,
    offset = 0,
    category?: string,
  ): Promise<{ projects: Record<string, unknown>[]; total: number }> {
    const conditions = ["p.source IN ('github', 'github-auto')", "p.status = 'active'"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (category) {
      conditions.push(`gac.search_category = $${paramIdx++}`);
      params.push(category);
    }

    params.push(limit, offset);

    const whereClause = conditions.join(" AND ");

    const [dataResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT p.project_id, p.name, p.description, p.github_owner, p.github_repo,
                p.github_stars, p.github_forks, p.github_topics, p.github_is_archived,
                p.source, p.readme_snippet, p.languages, p.tags, p.license,
                p.github_pushed_at, p.created_at,
                gac.search_category,
                a.display_name AS creator_name, a.address AS creator_address
         FROM projects p
         LEFT JOIN github_auto_curated gac ON gac.project_id = p.id
         LEFT JOIN agents a ON a.id = p.agent_id
         WHERE ${whereClause}
         ORDER BY p.github_stars DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        params,
      ),
      this.pool.query(
        `SELECT COUNT(*) FROM projects p
         LEFT JOIN github_auto_curated gac ON gac.project_id = p.id
         WHERE ${whereClause}`,
        category ? [category] : [],
      ),
    ]);

    return {
      projects: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  /**
   * Get README content for a project.
   */
  async getReadmeContent(projectId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT grc.content
       FROM github_readme_content grc
       JOIN projects p ON p.id = grc.project_id
       WHERE p.project_id = $1`,
      [projectId],
    );
    return rows.length > 0 ? rows[0].content : null;
  }

  /**
   * Search README content using full-text search.
   */
  async searchReadmes(
    query: string,
    limit = 20,
  ): Promise<Array<{ projectId: string; name: string; snippet: string; relevance: number }>> {
    const { rows } = await this.pool.query(
      `SELECT p.project_id, p.name,
              ts_headline('english', grc.content, q, 'MaxWords=35,MinWords=15') AS snippet,
              ts_rank(grc.search_tsv, q) AS relevance
       FROM github_readme_content grc
       JOIN projects p ON p.id = grc.project_id
       CROSS JOIN plainto_tsquery('english', $1) q
       WHERE grc.search_tsv @@ q AND p.status = 'active'
       ORDER BY relevance DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      projectId: r.project_id,
      name: r.name,
      snippet: r.snippet,
      relevance: parseFloat(r.relevance),
    }));
  }

  // ------------------------------------------------------------------
  //  Internal Helpers
  // ------------------------------------------------------------------

  private async isAlreadyCurated(owner: string, repo: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM github_auto_curated WHERE github_owner = $1 AND github_repo = $2 LIMIT 1`,
      [owner, repo],
    );
    return rows.length > 0;
  }

  private async recordAutoCurated(
    owner: string,
    repo: string,
    projectId: string,
    category: string,
  ): Promise<void> {
    // Resolve internal ID from project_id
    const { rows } = await this.pool.query(
      `SELECT id FROM projects WHERE project_id = $1 LIMIT 1`,
      [projectId],
    );

    await this.pool.query(
      `INSERT INTO github_auto_curated (github_owner, github_repo, project_id, search_category, stars_at_import)
       VALUES ($1, $2, $3, $4, (SELECT github_stars FROM projects WHERE project_id = $5))
       ON CONFLICT (github_owner, github_repo) DO NOTHING`,
      [owner, repo, rows[0]?.id ?? null, category, projectId],
    );
  }

  private async handleRepoUnavailable(
    internalId: string,
    statusCode: number,
    errorMsg: string,
  ): Promise<void> {
    if (statusCode === 404) {
      await this.pool.query(
        `UPDATE projects SET github_is_archived = true, github_sync_error = $1, github_last_synced_at = NOW()
         WHERE id = $2`,
        [errorMsg, internalId],
      );
    } else {
      await this.pool.query(
        `UPDATE projects SET github_sync_error = $1, github_last_synced_at = NOW()
         WHERE id = $2`,
        [errorMsg, internalId],
      );
    }
  }
}
