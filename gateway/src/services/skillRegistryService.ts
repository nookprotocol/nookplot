/**
 * Skill Registry service — package manager for agent skills.
 *
 * Agents publish skills (SKILL.md files, MCP server packages, GitHub repos),
 * other agents discover and install them. Bidirectional conversion between
 * knowledge bundles and skills creates a content flywheel.
 *
 * @module services/skillRegistryService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillPackageRow {
  id: string;
  publisher_id: string;
  publisher_address: string;
  name: string;
  slug: string;
  description: string;
  package_type: string;
  github_url: string | null;
  github_path: string | null;
  npm_package: string | null;
  install_command: string | null;
  version: string;
  tags: string[];
  category: string | null;
  content: string | null;
  source_bundle_id: number | null;
  status: string;
  install_count: number;
  rating_count: number;
  rating_avg: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SkillReviewRow {
  id: string;
  skill_id: string;
  reviewer_id: string;
  rating: number;
  review: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillInstallRow {
  id: string;
  skill_id: string;
  installer_id: string;
  installed_at: string;
}

export interface PublishSkillInput {
  name: string;
  description: string;
  packageType?: string;
  githubUrl?: string;
  githubPath?: string;
  npmPackage?: string;
  installCommand?: string;
  version?: string;
  tags?: string[];
  category?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  packageType?: string;
  githubUrl?: string;
  githubPath?: string;
  npmPackage?: string;
  installCommand?: string;
  version?: string;
  tags?: string[];
  category?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillListOptions {
  q?: string;
  category?: string;
  tags?: string[];
  packageType?: string;
  publisherId?: string;
  status?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface SkillRegistryConfig {
  publishCost: number;
  updateCost: number;
  reviewCost: number;
  githubImportCost: number;
  bundleExtractCost: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_PACKAGE_TYPES = new Set(["skill_md", "mcp_server", "both"]);
const VALID_CATEGORIES = new Set([
  "identity", "messaging", "content", "marketplace", "bounties", "credits",
  "projects", "teams", "reputation", "tools", "integrations", "reference",
  "ai", "data", "infrastructure", "other",
]);
const MAX_TAGS = 10;
const MAX_NAME_LEN = 100;
const MAX_DESC_LEN = 5000;
const MAX_CONTENT_LEN = 100000;

// ─── Service ──────────────────────────────────────────────────────────────────

export class SkillRegistryService {
  private readonly pool: pg.Pool;
  private readonly config: SkillRegistryConfig;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private contentScanner: any = null;
  private messageBus: any = null;
  private specializationService: any = null;
  private proactiveScheduler: any = null;
  private inboxService: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool, config: SkillRegistryConfig) {
    this.pool = pool;
    this.config = config;
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setContentScanner(cs: any): void { this.contentScanner = cs; }
  setMessageBus(mb: any): void { this.messageBus = mb; }
  setSpecializationService(svc: any): void { this.specializationService = svc; }
  setProactiveScheduler(svc: any): void { this.proactiveScheduler = svc; }
  setInboxService(svc: any): void { this.inboxService = svc; }

  // ============================================================
  //  Publish Skill
  // ============================================================

  async publishSkill(
    agentId: string,
    address: string,
    input: PublishSkillInput,
  ): Promise<{ skill: SkillPackageRow } | { error: string; code: string }> {
    // Validate name
    if (!input.name || input.name.length < 2 || input.name.length > MAX_NAME_LEN) {
      return { error: "name is required (2-100 chars)", code: "INVALID_INPUT" };
    }

    // Validate description
    if (!input.description || input.description.length < 10 || input.description.length > MAX_DESC_LEN) {
      return { error: "description is required (10-5000 chars)", code: "INVALID_INPUT" };
    }

    // Validate package type
    const packageType = input.packageType ?? "skill_md";
    if (!VALID_PACKAGE_TYPES.has(packageType)) {
      return { error: `Invalid package_type: ${packageType}`, code: "INVALID_INPUT" };
    }

    // Validate category
    if (input.category && !VALID_CATEGORIES.has(input.category)) {
      return { error: `Invalid category: ${input.category}`, code: "INVALID_INPUT" };
    }

    // Validate content length
    if (input.content && input.content.length > MAX_CONTENT_LEN) {
      return { error: `content exceeds ${MAX_CONTENT_LEN} chars`, code: "INVALID_INPUT" };
    }

    const tags = (input.tags ?? []).slice(0, MAX_TAGS).map(t => t.toLowerCase().trim()).filter(Boolean);

    // Content safety scan
    if (this.contentScanner) {
      try {
        const scanResult = await this.contentScanner.scanContent(
          `${input.name}\n${input.description}\n${input.content ?? ""}`,
          agentId,
          "skill_publish",
        );
        if (scanResult?.blocked) {
          return { error: "Content flagged by safety scanner", code: "CONTENT_SAFETY_BLOCK" };
        }
      } catch {
        // Scan failure doesn't block
      }
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, this.config.publishCost, requestId, "skill_publish");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Generate slug
    const slug = await this.generateSlug(input.name);

    const { rows } = await this.pool.query<SkillPackageRow>(
      `INSERT INTO skill_packages
         (publisher_id, publisher_address, name, slug, description, package_type,
          github_url, github_path, npm_package, install_command, version,
          tags, category, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        agentId, address, input.name, slug, input.description, packageType,
        input.githubUrl ?? null, input.githubPath ?? null,
        input.npmPackage ?? null, input.installCommand ?? null,
        input.version ?? "1.0.0",
        tags, input.category ?? null, input.content ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const skill = rows[0];

    this.publishEvent("skill.published", {
      skillId: skill.id,
      publisherId: agentId,
      name: skill.name,
      slug: skill.slug,
      packageType,
      category: skill.category,
      tags,
    });

    // Notify agents whose skill gaps/recommendations match this new skill (fire-and-forget)
    this.notifyAgentsOfNewSkill(skill).catch(() => {});

    return { skill };
  }

  // ============================================================
  //  Skill-Gap Bridge: notify agents when a new skill matches their gaps
  // ============================================================

  /**
   * After a skill is published, find agents who have matching skill gaps
   * or active specialization recommendations and notify them.
   * Same fire-and-forget pattern as intent matching.
   */
  private async notifyAgentsOfNewSkill(skill: SkillPackageRow): Promise<void> {
    if (!this.proactiveScheduler && !this.inboxService) return;
    if (!skill.tags || skill.tags.length === 0) return;

    try {
      const loweredTags = skill.tags.map(t => t.toLowerCase());

      // Find agents with active recommendations matching this skill's tags
      const { rows: matches } = await this.pool.query<{
        agent_id: string;
        skill_domain: string;
        gap_opportunity: number;
      }>(
        `SELECT DISTINCT ON (sr.agent_id)
                sr.agent_id, sr.skill_domain, sr.gap_opportunity
         FROM specialization_recommendations sr
         JOIN agents a ON a.id = sr.agent_id
         WHERE sr.status = 'active'
           AND LOWER(sr.skill_domain) = ANY($1::text[])
           AND a.status = 'active'
           AND sr.agent_id != $2
         ORDER BY sr.agent_id, sr.gap_opportunity DESC
         LIMIT 10`,
        [loweredTags, skill.publisher_id],
      );

      // Also find agents with high gap_opportunity in matching domains
      const { rows: gapMatches } = await this.pool.query<{
        agent_id: string;
        skill_domain: string;
        gap_opportunity: number;
      }>(
        `SELECT DISTINCT ON (asp.agent_id)
                asp.agent_id, asp.skill_domain, asp.gap_opportunity
         FROM agent_specializations asp
         JOIN agents a ON a.id = asp.agent_id
         WHERE asp.gap_opportunity > 10
           AND LOWER(asp.skill_domain) = ANY($1::text[])
           AND a.status = 'active'
           AND asp.agent_id != $2
           AND asp.agent_id NOT IN (SELECT unnest($3::text[]))
         ORDER BY asp.agent_id, asp.gap_opportunity DESC
         LIMIT 10`,
        [loweredTags, skill.publisher_id, matches.map(m => m.agent_id)],
      );

      const allMatches = [...matches, ...gapMatches];
      if (allMatches.length === 0) return;

      for (const match of allMatches) {
        // Proactive signal
        if (this.proactiveScheduler) {
          this.proactiveScheduler.handleReactiveSignal(match.agent_id, {
            signalType: "skill_published_match",
            senderAddress: skill.publisher_address,
            messagePreview: `New skill "${skill.name}" matches your ${match.skill_domain} gap — install it to level up!`,
            metadata: {
              skillId: skill.id,
              slug: skill.slug,
              name: skill.name,
              tags: skill.tags,
              category: skill.category,
              matchedDomain: match.skill_domain,
              gapOpportunity: match.gap_opportunity,
            },
          }).catch((err: Error) => {
            logSecurityEvent("debug", "skill-gap-signal-failed", {
              signalType: "skill_published_match", error: err.message,
            });
          });
        }

        // Inbox message
        if (this.inboxService) {
          this.inboxService.send({
            fromAgentId: skill.publisher_id,
            toAgentId: match.agent_id,
            messageType: "skill_recommendation",
            content: `A new skill "${skill.name}" was just published that matches your ${match.skill_domain} learning goal. Check it out: /skills/${skill.slug}`,
            metadata: { skillId: skill.id, slug: skill.slug, matchedDomain: match.skill_domain },
          }).catch(() => {});
        }
      }

      // Record supply signal for each tag
      if (this.specializationService) {
        for (const tag of loweredTags.slice(0, 5)) {
          this.specializationService.recordSignal(
            tag, "supply", 1.0, "skill_registry", skill.id,
            { name: skill.name, slug: skill.slug },
          ).catch(() => {});
        }
      }

      logSecurityEvent("info", "skill-gap-bridge-notified", {
        skillId: skill.id, matchCount: allMatches.length, tags: loweredTags.slice(0, 5),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("warn", "skill-gap-bridge-failed", { skillId: skill.id, error: msg });
    }
  }

  // ============================================================
  //  List Skills (with FTS)
  // ============================================================

  async listSkills(opts?: SkillListOptions): Promise<{ skills: SkillPackageRow[]; total: number }> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = opts?.offset ?? 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Default: only active
    const status = opts?.status ?? "active";
    conditions.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;

    // Full-text search
    if (opts?.q && opts.q.trim().length > 0) {
      conditions.push(`search_tsv @@ plainto_tsquery('english', $${paramIdx})`);
      params.push(opts.q.trim());
      paramIdx++;
    }

    if (opts?.category) {
      conditions.push(`category = $${paramIdx}`);
      params.push(opts.category);
      paramIdx++;
    }

    if (opts?.tags && opts.tags.length > 0) {
      conditions.push(`tags && $${paramIdx}`);
      params.push(opts.tags);
      paramIdx++;
    }

    if (opts?.packageType) {
      conditions.push(`package_type = $${paramIdx}`);
      params.push(opts.packageType);
      paramIdx++;
    }

    if (opts?.publisherId) {
      conditions.push(`publisher_id = $${paramIdx}`);
      params.push(opts.publisherId);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Sort
    let orderClause: string;
    if (opts?.q && opts.q.trim().length > 0) {
      orderClause = `ORDER BY ts_rank(search_tsv, plainto_tsquery('english', $${paramIdx})) DESC, created_at DESC`;
      params.push(opts.q.trim());
      paramIdx++;
    } else {
      const sort = opts?.sort ?? "newest";
      switch (sort) {
        case "popular": orderClause = "ORDER BY install_count DESC, created_at DESC"; break;
        case "rating": orderClause = "ORDER BY rating_avg DESC, rating_count DESC, created_at DESC"; break;
        default: orderClause = "ORDER BY created_at DESC"; break;
      }
    }

    params.push(limit);
    params.push(offset);

    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<SkillPackageRow>(
        `SELECT * FROM skill_packages ${whereClause} ${orderClause} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        params,
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM skill_packages ${whereClause}`,
        params.slice(0, paramIdx - 1), // exclude limit/offset and extra sort param
      ),
    ]);

    return { skills: rows, total: parseInt(countResult.rows[0].count, 10) };
  }

  // ============================================================
  //  Get Skill
  // ============================================================

  async getSkill(id: string): Promise<SkillPackageRow | null> {
    const { rows } = await this.pool.query<SkillPackageRow>(
      `SELECT * FROM skill_packages WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getSkillBySlug(slug: string): Promise<SkillPackageRow | null> {
    const { rows } = await this.pool.query<SkillPackageRow>(
      `SELECT * FROM skill_packages WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  // ============================================================
  //  Update Skill
  // ============================================================

  async updateSkill(
    agentId: string,
    skillId: string,
    input: UpdateSkillInput,
  ): Promise<{ skill: SkillPackageRow } | { error: string; code: string }> {
    // Verify ownership
    const existing = await this.getSkill(skillId);
    if (!existing) {
      return { error: "Skill not found", code: "NOT_FOUND" };
    }
    if (existing.publisher_id !== agentId) {
      return { error: "Not the skill owner", code: "FORBIDDEN" };
    }

    // Validate fields if provided
    if (input.name !== undefined && (input.name.length < 2 || input.name.length > MAX_NAME_LEN)) {
      return { error: "name must be 2-100 chars", code: "INVALID_INPUT" };
    }
    if (input.description !== undefined && (input.description.length < 10 || input.description.length > MAX_DESC_LEN)) {
      return { error: "description must be 10-5000 chars", code: "INVALID_INPUT" };
    }
    if (input.packageType !== undefined && !VALID_PACKAGE_TYPES.has(input.packageType)) {
      return { error: `Invalid package_type: ${input.packageType}`, code: "INVALID_INPUT" };
    }
    if (input.category !== undefined && input.category !== null && !VALID_CATEGORIES.has(input.category)) {
      return { error: `Invalid category: ${input.category}`, code: "INVALID_INPUT" };
    }
    if (input.content !== undefined && input.content !== null && input.content.length > MAX_CONTENT_LEN) {
      return { error: `content exceeds ${MAX_CONTENT_LEN} chars`, code: "INVALID_INPUT" };
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, this.config.updateCost, requestId, "skill_update");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Build dynamic update
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: any[] = [];
    let paramIdx = 1;

    const maybeSet = (col: string, val: any) => {
      if (val !== undefined) {
        setClauses.push(`${col} = $${paramIdx}`);
        params.push(col === "tags" ? (val as string[]).slice(0, MAX_TAGS).map((t: string) => t.toLowerCase().trim()).filter(Boolean) : val);
        paramIdx++;
      }
    };

    maybeSet("name", input.name);
    maybeSet("description", input.description);
    maybeSet("package_type", input.packageType);
    maybeSet("github_url", input.githubUrl);
    maybeSet("github_path", input.githubPath);
    maybeSet("npm_package", input.npmPackage);
    maybeSet("install_command", input.installCommand);
    maybeSet("version", input.version);
    maybeSet("tags", input.tags);
    maybeSet("category", input.category);
    maybeSet("content", input.content);
    if (input.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIdx}`);
      params.push(JSON.stringify(input.metadata));
      paramIdx++;
    }

    params.push(skillId);

    const { rows } = await this.pool.query<SkillPackageRow>(
      `UPDATE skill_packages SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );

    return { skill: rows[0] };
  }

  // ============================================================
  //  Unlist Skill
  // ============================================================

  async unlistSkill(
    agentId: string,
    skillId: string,
  ): Promise<{ skill: SkillPackageRow } | { error: string; code: string }> {
    const existing = await this.getSkill(skillId);
    if (!existing) {
      return { error: "Skill not found", code: "NOT_FOUND" };
    }
    if (existing.publisher_id !== agentId) {
      return { error: "Not the skill owner", code: "FORBIDDEN" };
    }

    const { rows } = await this.pool.query<SkillPackageRow>(
      `UPDATE skill_packages SET status = 'unlisted', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [skillId],
    );

    this.publishEvent("skill.unlisted", { skillId, publisherId: agentId });

    return { skill: rows[0] };
  }

  // ============================================================
  //  Review Skill
  // ============================================================

  async reviewSkill(
    agentId: string,
    skillId: string,
    rating: number,
    review?: string,
  ): Promise<{ review: SkillReviewRow } | { error: string; code: string }> {
    // Load skill
    const skill = await this.getSkill(skillId);
    if (!skill) {
      return { error: "Skill not found", code: "NOT_FOUND" };
    }

    // Block self-review
    if (skill.publisher_id === agentId) {
      return { error: "Cannot review your own skill", code: "SELF_REVIEW" };
    }

    // Validate rating
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { error: "rating must be an integer 1-5", code: "INVALID_INPUT" };
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, this.config.reviewCost, requestId, "skill_review");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Upsert review
    const { rows } = await this.pool.query<SkillReviewRow>(
      `INSERT INTO skill_reviews (skill_id, reviewer_id, rating, review)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (skill_id, reviewer_id)
       DO UPDATE SET rating = EXCLUDED.rating, review = EXCLUDED.review, updated_at = NOW()
       RETURNING *`,
      [skillId, agentId, rating, review ?? null],
    );

    // Recalculate rating_avg and rating_count
    await this.pool.query(
      `UPDATE skill_packages SET
         rating_count = (SELECT COUNT(*) FROM skill_reviews WHERE skill_id = $1),
         rating_avg = (SELECT COALESCE(AVG(rating), 0) FROM skill_reviews WHERE skill_id = $1),
         updated_at = NOW()
       WHERE id = $1`,
      [skillId],
    );

    this.publishEvent("skill.reviewed", {
      skillId,
      reviewerId: agentId,
      rating,
      publisherId: skill.publisher_id,
    });

    return { review: rows[0] };
  }

  // ============================================================
  //  Record Install
  // ============================================================

  async recordInstall(
    agentId: string,
    skillId: string,
  ): Promise<{ skill: SkillPackageRow; installed: boolean } | { error: string; code: string }> {
    const skill = await this.getSkill(skillId);
    if (!skill) {
      return { error: "Skill not found", code: "NOT_FOUND" };
    }

    // Insert (idempotent)
    const { rowCount } = await this.pool.query(
      `INSERT INTO skill_installs (skill_id, installer_id)
       VALUES ($1, $2)
       ON CONFLICT (skill_id, installer_id) DO NOTHING`,
      [skillId, agentId],
    );

    const isNew = (rowCount ?? 0) > 0;

    if (isNew) {
      await this.pool.query(
        `UPDATE skill_packages SET install_count = install_count + 1, updated_at = NOW() WHERE id = $1`,
        [skillId],
      );

      this.publishEvent("skill.installed", {
        skillId,
        installerId: agentId,
        publisherId: skill.publisher_id,
      });
    }

    // Refresh to get updated count
    const updated = await this.getSkill(skillId);
    return { skill: updated!, installed: isNew };
  }

  // ============================================================
  //  Get Reviews
  // ============================================================

  async getReviews(
    skillId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ reviews: Array<SkillReviewRow & { reviewer_name?: string }>; total: number }> {
    const safeLimit = Math.min(limit, 200);

    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<SkillReviewRow & { reviewer_name?: string }>(
        `SELECT sr.*, a.name AS reviewer_name
         FROM skill_reviews sr
         LEFT JOIN agents a ON a.id = sr.reviewer_id
         WHERE sr.skill_id = $1
         ORDER BY sr.created_at DESC
         LIMIT $2 OFFSET $3`,
        [skillId, safeLimit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM skill_reviews WHERE skill_id = $1`,
        [skillId],
      ),
    ]);

    return { reviews: rows, total: parseInt(countResult.rows[0].count, 10) };
  }

  // ============================================================
  //  Trending
  // ============================================================

  async getTrending(
    limit = 20,
    timeframeDays = 7,
  ): Promise<SkillPackageRow[]> {
    const safeLimit = Math.min(limit, 100);

    const { rows } = await this.pool.query<SkillPackageRow>(
      `SELECT sp.* FROM skill_packages sp
       LEFT JOIN (
         SELECT skill_id,
           COUNT(*) FILTER (WHERE installed_at > NOW() - ($1 || ' days')::INTERVAL) * 3 +
           COUNT(*) FILTER (WHERE installed_at <= NOW() - ($1 || ' days')::INTERVAL) AS weighted_installs
         FROM skill_installs
         GROUP BY skill_id
       ) si ON si.skill_id = sp.id
       WHERE sp.status = 'active' AND sp.install_count > 0
       ORDER BY COALESCE(si.weighted_installs, 0) DESC, sp.created_at DESC
       LIMIT $2`,
      [timeframeDays, safeLimit],
    );

    return rows;
  }

  // ============================================================
  //  Import from GitHub
  // ============================================================

  async importFromGitHub(
    agentId: string,
    address: string,
    githubUrl: string,
  ): Promise<{ skill: SkillPackageRow } | { error: string; code: string }> {
    // Validate URL
    const match = githubUrl.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:blob|tree)\/([^/]+)\/(.+))?$/,
    );
    if (!match) {
      return { error: "Invalid GitHub URL. Expected: https://github.com/owner/repo or .../blob/branch/path", code: "INVALID_INPUT" };
    }

    const [, owner, repo, branch, filePath] = match;
    const ref = branch ?? "main";
    const path = filePath ?? "SKILL.md";

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, this.config.githubImportCost, requestId, "skill_github_import");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Fetch raw content
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    let content: string;
    try {
      const response = await fetch(rawUrl);
      if (!response.ok) {
        return { error: `Failed to fetch from GitHub: ${response.status}`, code: "GITHUB_FETCH_FAILED" };
      }
      content = await response.text();
    } catch (err) {
      return { error: `GitHub fetch error: ${err instanceof Error ? err.message : String(err)}`, code: "GITHUB_FETCH_FAILED" };
    }

    // Extract name from first heading or repo name
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const name = headingMatch ? headingMatch[1].trim().slice(0, MAX_NAME_LEN) : `${owner}/${repo}`;

    // Extract first paragraph as description
    const descMatch = content.match(/^(?!#)(.{10,200})/m);
    const description = descMatch ? descMatch[1].trim() : `Skill imported from ${owner}/${repo}`;

    return this.publishSkill(agentId, address, {
      name,
      description,
      packageType: "skill_md",
      githubUrl,
      githubPath: path,
      content,
      tags: ["imported", "github"],
    });
  }

  // ============================================================
  //  Extract from Bundle
  // ============================================================

  async extractFromBundle(
    agentId: string,
    address: string,
    bundleId: string,
  ): Promise<{ skill: SkillPackageRow } | { error: string; code: string }> {
    // Look up bundle from indexer tables
    let bundle: any;
    try {
      const { rows } = await this.pool.query(
        `SELECT * FROM idx_knowledge_bundles WHERE bundle_id = $1`,
        [bundleId],
      );
      if (rows.length === 0) {
        return { error: "Bundle not found", code: "NOT_FOUND" };
      }
      bundle = rows[0];
    } catch {
      return { error: "Bundle lookup failed (indexer tables may not exist)", code: "NOT_FOUND" };
    }

    // Get contributors
    let contributors: string[] = [];
    try {
      const { rows } = await this.pool.query(
        `SELECT contributor FROM idx_bundle_contributors WHERE bundle_id = $1`,
        [bundleId],
      );
      contributors = rows.map((r: any) => r.contributor);
    } catch {
      // Non-critical
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, this.config.bundleExtractCost, requestId, "skill_bundle_extract");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Generate SKILL.md content from bundle
    const name = bundle.name || `Bundle #${bundleId}`;
    const description = bundle.summary || bundle.description || `Skill extracted from knowledge bundle #${bundleId}`;
    const tags = (bundle.tags || []).slice(0, MAX_TAGS);
    const category = bundle.domain || "other";

    const contentParts = [
      `# ${name}`,
      "",
      description,
      "",
    ];

    if (bundle.bundle_type) {
      contentParts.push(`**Type:** ${bundle.bundle_type}`);
    }
    if (contributors.length > 0) {
      contentParts.push(`**Contributors:** ${contributors.join(", ")}`);
    }
    if (bundle.content_cid) {
      contentParts.push(`**Content CID:** ${bundle.content_cid}`);
    }
    contentParts.push("");
    contentParts.push(`*Extracted from knowledge bundle #${bundleId}*`);

    const content = contentParts.join("\n");

    // Publish with source_bundle_id set
    const result = await this.publishSkill(agentId, address, {
      name,
      description,
      tags,
      category: VALID_CATEGORIES.has(category) ? category : "other",
      content,
    });

    // Set source_bundle_id on the created skill
    if ("skill" in result) {
      await this.pool.query(
        `UPDATE skill_packages SET source_bundle_id = $1 WHERE id = $2`,
        [parseInt(bundleId, 10), result.skill.id],
      );
      result.skill.source_bundle_id = parseInt(bundleId, 10);
    }

    return result;
  }

  // ============================================================
  //  Convert to Bundle (returns data for caller to prepare+relay)
  // ============================================================

  async convertToBundle(
    agentId: string,
    skillId: string,
  ): Promise<{ bundleData: { name: string; description: string; content: string; suggestedTags: string[]; suggestedDomain: string } } | { error: string; code: string }> {
    const skill = await this.getSkill(skillId);
    if (!skill) {
      return { error: "Skill not found", code: "NOT_FOUND" };
    }
    if (skill.publisher_id !== agentId) {
      return { error: "Not the skill owner", code: "FORBIDDEN" };
    }

    return {
      bundleData: {
        name: skill.name,
        description: skill.description,
        content: skill.content ?? skill.description,
        suggestedTags: skill.tags,
        suggestedDomain: skill.category ?? "other",
      },
    };
  }

  // ============================================================
  //  Internal Helpers
  // ============================================================

  private async generateSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    // Check for collision
    const { rows } = await this.pool.query<{ slug: string }>(
      `SELECT slug FROM skill_packages WHERE slug LIKE $1 || '%'`,
      [base],
    );

    if (rows.length === 0) return base;

    const existing = new Set(rows.map(r => r.slug));
    if (!existing.has(base)) return base;

    // Add numeric suffix
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }

    // Fallback: append random
    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private publishEvent(type: string, data: Record<string, unknown>): void {
    if (this.messageBus) {
      this.messageBus.publish("skill-registry", {
        type,
        timestamp: new Date().toISOString(),
        data,
      });
    }
  }
}
