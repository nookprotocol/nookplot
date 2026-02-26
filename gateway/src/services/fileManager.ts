/**
 * File manager for gateway-hosted project files.
 *
 * Provides CRUD operations for project files stored in PostgreSQL,
 * commit history with atomic multi-file commits, code review system
 * with approval thresholds, and export-to-GitHub functionality.
 *
 * Reuses GitHubClient's secret scanning + path validation for security.
 *
 * @module services/fileManager
 */

import type pg from "pg";
import { createHash } from "crypto";
import type { GitHubClient } from "./githubClient.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Constants
// ============================================================

/** Maximum file size (1 MB). */
const MAX_FILE_SIZE = 1_048_576;

/** Maximum total project size (50 MB). */
const MAX_PROJECT_SIZE = 50 * 1_048_576;

/** Maximum files per commit. */
const MAX_FILES_PER_COMMIT = 50;

/** Approvals needed to transition commit to "approved". */
const APPROVAL_THRESHOLD = 1;

/** Language detection from file extensions. */
const EXT_MAP: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".sol": "Solidity", ".rs": "Rust", ".go": "Go",
  ".java": "Java", ".rb": "Ruby", ".css": "CSS", ".html": "HTML",
  ".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
  ".sh": "Shell", ".sql": "SQL", ".toml": "TOML", ".c": "C", ".cpp": "C++",
  ".h": "C", ".hpp": "C++", ".swift": "Swift", ".kt": "Kotlin",
};

// ============================================================
//  Types
// ============================================================

export interface GatewayFileEntry {
  path: string;
  size: number;
  language: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GatewayFileContent {
  path: string;
  content: string;
  size: number;
  language: string | null;
  sha256: string;
  updatedAt: string;
}

export interface CommitFileInput {
  path: string;
  content: string | null; // null = delete
}

export interface FileCommitResult {
  commitId: string;
  message: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  reviewStatus: string;
  createdAt: string;
}

export interface FileCommit {
  id: string;
  commitId: string; // backward compat alias (same value as id)
  projectId: string;
  authorAddress: string | null;
  authorName: string | null;
  message: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  reviewStatus: string;
  approvals: number;
  rejections: number;
  source: string;
  createdAt: string;
}

export interface FileCommitChange {
  filePath: string;
  changeType: string;
  linesAdded: number;
  linesRemoved: number;
  oldContent: string | null;
  newContent: string | null;
}

export interface FileCommitDetail extends FileCommit {
  changes: FileCommitChange[];
  reviews: CommitReviewRecord[];
}

export interface CommitReviewRecord {
  id: string;
  reviewerAddress: string | null;
  reviewerName: string | null;
  verdict: string;
  body: string | null;
  createdAt: string;
}

export interface ProjectActivityEvent {
  id: string;
  projectId: string;
  projectName: string | null;
  eventType: string;
  actorAddress: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ============================================================
//  FileManager
// ============================================================

export interface LinkedTask {
  taskId: string;
  milestoneId: string | null;
  title: string;
}

export class FileManager {
  /** Tasks auto-linked by the last commitFiles() call. Consumed by the route handler for signal emission. */
  _lastLinkedTasks: LinkedTask[] | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly githubClient: GitHubClient,
  ) {}

  /** Consume and clear the linked tasks from the last commit. */
  consumeLinkedTasks(): LinkedTask[] {
    const tasks = this._lastLinkedTasks ?? [];
    this._lastLinkedTasks = null;
    return tasks;
  }

  // ------------------------------------------------------------------
  //  Helpers
  // ------------------------------------------------------------------

  private sha256(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }

  private detectLanguage(filePath: string): string | null {
    const dot = filePath.lastIndexOf(".");
    if (dot === -1) return null;
    const ext = filePath.slice(dot).toLowerCase();
    return EXT_MAP[ext] ?? null;
  }

  private computeLineDiff(
    oldContent: string | null,
    newContent: string | null,
  ): { added: number; removed: number } {
    const oldLines = oldContent ? oldContent.split("\n").length : 0;
    const newLines = newContent ? newContent.split("\n").length : 0;
    if (!oldContent && newContent) return { added: newLines, removed: 0 };
    if (oldContent && !newContent) return { added: 0, removed: oldLines };
    // Simple heuristic: count net change
    return {
      added: Math.max(0, newLines - oldLines) + Math.min(oldLines, newLines),
      removed: Math.max(0, oldLines - newLines) + Math.min(oldLines, newLines),
    };
  }

  /**
   * Check if an agent has write access to a project.
   * Returns role: -1 = no access, 0 = viewer, 1 = editor, 2 = admin, 3 = owner.
   */
  async getAccessLevel(projectId: string, agentId: string): Promise<number> {
    // Check if owner
    const ownerResult = await this.pool.query(
      `SELECT agent_id FROM projects WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    if (ownerResult.rows.length === 0) return -1; // project not found
    if (ownerResult.rows[0].agent_id === agentId) return 3; // owner

    // Check collaborator role
    const collabResult = await this.pool.query(
      `SELECT pc.role FROM project_collaborators pc
       JOIN projects p ON p.id = pc.project_id
       WHERE p.project_id = $1 AND pc.agent_id = $2`,
      [projectId, agentId],
    );
    if (collabResult.rows.length === 0) return -1; // not a collaborator
    return collabResult.rows[0].role as number;
  }

  // ------------------------------------------------------------------
  //  File Operations
  // ------------------------------------------------------------------

  /**
   * List all files in a gateway-hosted project.
   */
  async listFiles(projectId: string): Promise<GatewayFileEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT pf.file_path, pf.size_bytes, pf.language, pf.updated_at,
              a.address AS updated_by_address
       FROM project_files pf
       LEFT JOIN agents a ON a.id = pf.updated_by
       WHERE pf.project_id = $1
       ORDER BY pf.file_path ASC`,
      [projectId],
    );
    return rows.map((r) => ({
      path: r.file_path,
      size: r.size_bytes,
      language: r.language,
      updatedAt: r.updated_at?.toISOString() ?? new Date().toISOString(),
      updatedBy: r.updated_by_address ?? null,
    }));
  }

  /**
   * Read a single file's content.
   */
  async readFile(projectId: string, filePath: string): Promise<GatewayFileContent | null> {
    const { rows } = await this.pool.query(
      `SELECT file_path, content, size_bytes, language, sha256, updated_at
       FROM project_files
       WHERE project_id = $1 AND file_path = $2`,
      [projectId, filePath],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      path: r.file_path,
      content: r.content,
      size: r.size_bytes,
      language: r.language,
      sha256: r.sha256,
      updatedAt: r.updated_at?.toISOString() ?? new Date().toISOString(),
    };
  }

  /**
   * Commit files atomically. Creates/updates/deletes files in a single transaction.
   */
  async commitFiles(
    projectId: string,
    files: CommitFileInput[],
    message: string,
    agentId: string,
    agentAddress: string,
  ): Promise<FileCommitResult> {
    if (files.length === 0) throw new Error("No files to commit.");
    if (files.length > MAX_FILES_PER_COMMIT) {
      throw new Error(`Too many files. Maximum ${MAX_FILES_PER_COMMIT} per commit.`);
    }
    if (!message || message.length > 1000) {
      throw new Error("Commit message is required (max 1000 chars).");
    }

    // Validate all file paths and scan for secrets
    for (const f of files) {
      const pathCheck = this.githubClient.validateFilePath(f.path);
      if (!pathCheck.valid) {
        throw new Error(`Invalid path "${f.path}": ${pathCheck.reason}`);
      }
      if (f.content !== null) {
        if (Buffer.byteLength(f.content, "utf-8") > MAX_FILE_SIZE) {
          throw new Error(`File "${f.path}" exceeds 1 MB limit.`);
        }
        const scan = this.githubClient.scanForSecrets(f.content);
        if (!scan.clean) {
          throw new Error(`Secret detected in "${f.path}": ${scan.matches.join(", ")}. Remove secrets before committing.`);
        }
      }
    }

    // Check total project size (approximate — current + new)
    const sizeResult = await this.pool.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM project_files WHERE project_id = $1`,
      [projectId],
    );
    const currentSize = Number(sizeResult.rows[0].total);
    const newContentSize = files.reduce(
      (sum, f) => sum + (f.content ? Buffer.byteLength(f.content, "utf-8") : 0),
      0,
    );
    if (currentSize + newContentSize > MAX_PROJECT_SIZE) {
      throw new Error(`Project would exceed 50 MB limit. Current: ${Math.round(currentSize / 1024)}KB, adding: ${Math.round(newContentSize / 1024)}KB.`);
    }

    // Get project name for activity log
    const projResult = await this.pool.query(
      `SELECT name FROM projects WHERE project_id = $1`,
      [projectId],
    );
    const projectName = projResult.rows[0]?.name ?? projectId;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      let totalAdded = 0;
      let totalRemoved = 0;
      const detectedLangs = new Set<string>();
      const changes: { path: string; type: string; old: string | null; new_: string | null; added: number; removed: number }[] = [];

      for (const f of files) {
        // Get existing file content for diff
        const existing = await client.query(
          `SELECT content FROM project_files WHERE project_id = $1 AND file_path = $2`,
          [projectId, f.path],
        );
        const oldContent = existing.rows.length > 0 ? existing.rows[0].content : null;

        if (f.content === null) {
          // Delete file
          await client.query(
            `DELETE FROM project_files WHERE project_id = $1 AND file_path = $2`,
            [projectId, f.path],
          );
          const diff = this.computeLineDiff(oldContent, null);
          changes.push({ path: f.path, type: "delete", old: oldContent, new_: null, added: 0, removed: diff.removed });
          totalRemoved += diff.removed;
        } else {
          const hash = this.sha256(f.content);
          const size = Buffer.byteLength(f.content, "utf-8");
          const lang = this.detectLanguage(f.path);
          if (lang) detectedLangs.add(lang);

          const changeType = oldContent === null ? "add" : "modify";

          // Upsert file
          await client.query(
            `INSERT INTO project_files (project_id, file_path, content, size_bytes, language, sha256, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (project_id, file_path) DO UPDATE SET
               content = EXCLUDED.content,
               size_bytes = EXCLUDED.size_bytes,
               language = EXCLUDED.language,
               sha256 = EXCLUDED.sha256,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
            [projectId, f.path, f.content, size, lang, hash, agentId],
          );

          // Compute simple line diff
          const diff = changeType === "add"
            ? { added: (f.content.match(/\n/g) || []).length + 1, removed: 0 }
            : {
                added: Math.max(0, (f.content.split("\n").length) - (oldContent?.split("\n").length ?? 0)),
                removed: Math.max(0, (oldContent?.split("\n").length ?? 0) - (f.content.split("\n").length)),
              };
          // For modifications, ensure at least 1 line changed
          if (changeType === "modify" && diff.added === 0 && diff.removed === 0) {
            diff.added = (f.content.match(/\n/g) || []).length + 1;
          }
          changes.push({ path: f.path, type: changeType, old: oldContent, new_: f.content, added: diff.added, removed: diff.removed });
          totalAdded += diff.added;
          totalRemoved += diff.removed;
        }
      }

      // Insert commit record
      const commitResult = await client.query(
        `INSERT INTO file_commits (project_id, author_id, author_address, message, files_changed, lines_added, lines_removed, languages, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'gateway')
         RETURNING id, created_at`,
        [projectId, agentId, agentAddress, message, files.length, totalAdded, totalRemoved, Array.from(detectedLangs)],
      );
      const commitId = commitResult.rows[0].id;
      const createdAt = commitResult.rows[0].created_at;

      // Insert file changes
      for (const c of changes) {
        await client.query(
          `INSERT INTO file_commit_changes (commit_id, file_path, change_type, old_content, new_content, lines_added, lines_removed)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [commitId, c.path, c.type, c.old, c.new_, c.added, c.removed],
        );
      }

      // Insert commit_log for contribution scoring (leaderboard)
      await client.query(
        `INSERT INTO commit_log (agent_id, project_id, source, files_changed, lines_added, lines_removed, languages, frameworks, success)
         VALUES ($1, $2, 'gateway', $3, $4, $5, $6, '{}', true)`,
        [agentId, projectId, files.length, totalAdded, totalRemoved, Array.from(detectedLangs)],
      );

      // Insert project_activity event
      await client.query(
        `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
         VALUES ($1, $2, 'file_committed', $3, $4, $5)`,
        [projectId, projectName, agentId, agentAddress, JSON.stringify({
          commitId,
          message,
          filesChanged: files.length,
          linesAdded: totalAdded,
          linesRemoved: totalRemoved,
          languages: Array.from(detectedLangs),
        })],
      );

      await client.query("COMMIT");

      logSecurityEvent("info", "gateway-commit", {
        agentId, projectId, commitId, filesChanged: files.length,
        linesAdded: totalAdded, linesRemoved: totalRemoved,
      });

      // Task-commit auto-linking: parse "closes #<uuid-prefix>" or "fixes #<uuid-prefix>"
      // This runs outside the transaction so failures don't break commits.
      try {
        const taskRefs = message.match(/(?:closes|fixes)\s+#([a-f0-9-]{4,36})/gi);
        if (taskRefs) {
          for (const ref of taskRefs) {
            const prefix = ref.replace(/^(?:closes|fixes)\s+#/i, "");
            // Match tasks whose UUID starts with this prefix
            const { rows: taskRows } = await this.pool.query(
              `SELECT id, milestone_id, title FROM project_tasks
               WHERE project_id = $1 AND CAST(id AS TEXT) LIKE $2 AND status != 'completed'
               LIMIT 1`,
              [projectId, `${prefix}%`],
            );
            if (taskRows.length > 0) {
              await this.pool.query(
                `UPDATE project_tasks SET status = 'completed', linked_commit_id = $1, completed_at = NOW(), updated_at = NOW()
                 WHERE id = $2`,
                [commitId, taskRows[0].id],
              );
              // Store linked task info for the caller to use for signal emission
              if (!this._lastLinkedTasks) this._lastLinkedTasks = [];
              this._lastLinkedTasks.push({
                taskId: taskRows[0].id,
                milestoneId: taskRows[0].milestone_id,
                title: taskRows[0].title,
              });
            }
          }
        }
      } catch { /* non-fatal — don't break the commit response */ }

      return {
        commitId,
        message,
        filesChanged: files.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        reviewStatus: "pending_review",
        createdAt: createdAt?.toISOString() ?? new Date().toISOString(),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a single file from a project.
   */
  async deleteFile(projectId: string, filePath: string, agentId: string, agentAddress: string): Promise<void> {
    await this.commitFiles(
      projectId,
      [{ path: filePath, content: null }],
      `Delete ${filePath}`,
      agentId,
      agentAddress,
    );
  }

  // ------------------------------------------------------------------
  //  Commit History
  // ------------------------------------------------------------------

  async getCommitHistory(
    projectId: string,
    limit = 20,
    offset = 0,
  ): Promise<FileCommit[]> {
    const { rows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source, fc.created_at,
              a.display_name AS author_name
       FROM file_commits fc
       LEFT JOIN agents a ON a.id = fc.author_id
       WHERE fc.project_id = $1
       ORDER BY fc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [projectId, Math.min(limit, 100), Math.max(offset, 0)],
    );
    return rows.map((r) => ({
      id: r.id,
      commitId: r.id, // backward compat alias
      projectId: r.project_id,
      authorAddress: r.author_address,
      authorName: r.author_name ?? null,
      message: r.message,
      filesChanged: r.files_changed,
      linesAdded: r.lines_added,
      linesRemoved: r.lines_removed,
      reviewStatus: r.review_status,
      approvals: r.approvals,
      rejections: r.rejections,
      source: r.source,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  async getCommitDetail(commitId: string): Promise<FileCommitDetail | null> {
    // Get commit
    const { rows: commitRows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source, fc.created_at,
              a.display_name AS author_name
       FROM file_commits fc
       LEFT JOIN agents a ON a.id = fc.author_id
       WHERE fc.id = $1`,
      [commitId],
    );
    if (commitRows.length === 0) return null;
    const c = commitRows[0];

    // Get changes
    const { rows: changeRows } = await this.pool.query(
      `SELECT file_path, change_type, lines_added, lines_removed, old_content, new_content
       FROM file_commit_changes
       WHERE commit_id = $1
       ORDER BY file_path ASC`,
      [commitId],
    );

    // Get reviews
    const { rows: reviewRows } = await this.pool.query(
      `SELECT cr.id, cr.reviewer_address, cr.verdict, cr.body, cr.created_at,
              a.display_name AS reviewer_name
       FROM commit_reviews cr
       LEFT JOIN agents a ON a.id = cr.reviewer_id
       WHERE cr.commit_id = $1
       ORDER BY cr.created_at ASC`,
      [commitId],
    );

    return {
      id: c.id,
      commitId: c.id, // backward compat alias
      projectId: c.project_id,
      authorAddress: c.author_address,
      authorName: c.author_name ?? null,
      message: c.message,
      filesChanged: c.files_changed,
      linesAdded: c.lines_added,
      linesRemoved: c.lines_removed,
      reviewStatus: c.review_status,
      approvals: c.approvals,
      rejections: c.rejections,
      source: c.source,
      createdAt: c.created_at?.toISOString() ?? new Date().toISOString(),
      changes: changeRows.map((r) => ({
        filePath: r.file_path,
        changeType: r.change_type,
        linesAdded: r.lines_added,
        linesRemoved: r.lines_removed,
        oldContent: r.old_content,
        newContent: r.new_content,
      })),
      reviews: reviewRows.map((r) => ({
        id: r.id,
        reviewerAddress: r.reviewer_address,
        reviewerName: r.reviewer_name ?? null,
        verdict: r.verdict,
        body: r.body,
        createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------
  //  Review System
  // ------------------------------------------------------------------

  async submitReview(
    commitId: string,
    reviewerId: string,
    reviewerAddress: string,
    verdict: string,
    body?: string,
  ): Promise<CommitReviewRecord> {
    // Validate verdict
    const validVerdicts = ["approve", "request_changes", "comment"];
    if (!validVerdicts.includes(verdict)) {
      throw new Error(`Invalid verdict. Must be one of: ${validVerdicts.join(", ")}`);
    }

    // Get commit details to check project and prevent self-review
    const commitResult = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_id, fc.review_status
       FROM file_commits fc
       WHERE fc.id = $1`,
      [commitId],
    );
    if (commitResult.rows.length === 0) throw new Error("Commit not found.");
    const commit = commitResult.rows[0];

    // Prevent self-review
    if (commit.author_id === reviewerId) {
      throw new Error("Cannot review your own commit.");
    }

    // Check reviewer has access to the project (any authenticated agent can review public projects)
    // This is intentional — like GitHub, anyone can review public repos

    // Get project name for activity log
    const projResult = await this.pool.query(
      `SELECT name FROM projects WHERE project_id = $1`,
      [commit.project_id],
    );
    const projectName = projResult.rows[0]?.name ?? commit.project_id;

    // Upsert review
    const { rows } = await this.pool.query(
      `INSERT INTO commit_reviews (commit_id, reviewer_id, reviewer_address, verdict, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (commit_id, reviewer_id) DO UPDATE SET
         verdict = EXCLUDED.verdict,
         body = EXCLUDED.body,
         created_at = NOW()
       RETURNING id, created_at`,
      [commitId, reviewerId, reviewerAddress, verdict, body ?? null],
    );

    // Recount approvals and rejections
    const countResult = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE verdict = 'approve') AS approvals,
         COUNT(*) FILTER (WHERE verdict = 'request_changes') AS rejections
       FROM commit_reviews
       WHERE commit_id = $1`,
      [commitId],
    );
    const approvals = Number(countResult.rows[0].approvals);
    const rejections = Number(countResult.rows[0].rejections);

    // Determine new review status
    let newStatus = commit.review_status;
    if (approvals >= APPROVAL_THRESHOLD && rejections === 0) {
      newStatus = "approved";
    } else if (rejections > 0) {
      newStatus = "changes_requested";
    } else {
      newStatus = "pending_review";
    }

    // Update commit
    await this.pool.query(
      `UPDATE file_commits SET approvals = $1, rejections = $2, review_status = $3 WHERE id = $4`,
      [approvals, rejections, newStatus, commitId],
    );

    // Insert activity event
    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'commit_reviewed', $3, $4, $5)`,
      [commit.project_id, projectName, reviewerId, reviewerAddress, JSON.stringify({
        commitId,
        verdict,
        newStatus,
        approvals,
        rejections,
      })],
    );

    logSecurityEvent("info", "commit-review", {
      commitId, reviewerId, verdict, newStatus, approvals, rejections,
    });

    // Get reviewer name
    const nameResult = await this.pool.query(
      `SELECT display_name FROM agents WHERE id = $1`,
      [reviewerId],
    );

    return {
      id: rows[0].id,
      reviewerAddress,
      reviewerName: nameResult.rows[0]?.display_name ?? null,
      verdict,
      body: body ?? null,
      createdAt: rows[0].created_at?.toISOString() ?? new Date().toISOString(),
    };
  }

  async getReviews(commitId: string): Promise<CommitReviewRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT cr.id, cr.reviewer_address, cr.verdict, cr.body, cr.created_at,
              a.display_name AS reviewer_name
       FROM commit_reviews cr
       LEFT JOIN agents a ON a.id = cr.reviewer_id
       WHERE cr.commit_id = $1
       ORDER BY cr.created_at ASC`,
      [commitId],
    );
    return rows.map((r) => ({
      id: r.id,
      reviewerAddress: r.reviewer_address,
      reviewerName: r.reviewer_name ?? null,
      verdict: r.verdict,
      body: r.body,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  // ------------------------------------------------------------------
  //  Activity Feed
  // ------------------------------------------------------------------

  async getProjectActivity(
    projectId: string,
    limit = 20,
  ): Promise<ProjectActivityEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT pa.id, pa.project_id, pa.project_name, pa.event_type,
              pa.actor_address, pa.metadata, pa.created_at,
              a.display_name AS actor_name
       FROM project_activity pa
       LEFT JOIN agents a ON a.id = pa.actor_id
       WHERE pa.project_id = $1
       ORDER BY pa.created_at DESC
       LIMIT $2`,
      [projectId, Math.min(limit, 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      eventType: r.event_type,
      actorAddress: r.actor_address,
      actorName: r.actor_name ?? null,
      metadata: r.metadata ?? {},
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  /**
   * Get recent activity across all projects (for global feed).
   */
  async getGlobalActivity(limit = 20): Promise<ProjectActivityEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT pa.id, pa.project_id, pa.project_name, pa.event_type,
              pa.actor_address, pa.metadata, pa.created_at,
              a.display_name AS actor_name
       FROM project_activity pa
       LEFT JOIN agents a ON a.id = pa.actor_id
       ORDER BY pa.created_at DESC
       LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      eventType: r.event_type,
      actorAddress: r.actor_address,
      actorName: r.actor_name ?? null,
      metadata: r.metadata ?? {},
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  // ------------------------------------------------------------------
  //  Export to GitHub
  // ------------------------------------------------------------------

  /**
   * Export all gateway-hosted files to the linked GitHub repo.
   * Only project owner or Admin collaborators can export.
   */
  async exportToGithub(
    projectId: string,
    agentId: string,
    agentAddress: string,
    getDecryptedPAT: (agentId: string) => Promise<{ pat: string; username: string } | null>,
    parseRepoUrl: (url: string) => { owner: string; repo: string } | null,
  ): Promise<{ sha: string; message: string; url: string; filesExported: number }> {
    // Check access level
    const access = await this.getAccessLevel(projectId, agentId);
    if (access < 2) {
      throw new Error("Only project owner or Admin collaborators can export to GitHub.");
    }

    // Get project repo URL
    const projResult = await this.pool.query(
      `SELECT repo_url, default_branch, name FROM projects WHERE project_id = $1`,
      [projectId],
    );
    if (projResult.rows.length === 0) throw new Error("Project not found.");
    const { repo_url, default_branch, name: projectName } = projResult.rows[0];
    if (!repo_url) throw new Error("Project has no linked GitHub repository.");

    const parsed = parseRepoUrl(repo_url);
    if (!parsed) throw new Error("Invalid repository URL format.");

    // Get PAT
    const creds = await getDecryptedPAT(agentId);
    if (!creds) throw new Error("GitHub not connected. Connect first: POST /v1/github/connect");

    // Get all files
    const files = await this.listFiles(projectId);
    if (files.length === 0) throw new Error("No files to export.");

    // Read all file contents
    const commitFiles: { path: string; content: string }[] = [];
    for (const f of files) {
      const fileContent = await this.readFile(projectId, f.path);
      if (fileContent) {
        commitFiles.push({ path: fileContent.path, content: fileContent.content });
      }
    }

    // Commit to GitHub
    const result = await this.githubClient.commitAndPush(
      creds.pat,
      parsed.owner,
      parsed.repo,
      commitFiles,
      `Export from Nookplot gateway (${projectId})`,
      default_branch ?? "main",
    );

    // Log activity
    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'file_exported', $3, $4, $5)`,
      [projectId, projectName, agentId, agentAddress, JSON.stringify({
        githubSha: result.sha,
        githubUrl: result.url,
        filesExported: commitFiles.length,
      })],
    );

    logSecurityEvent("info", "gateway-export-github", {
      agentId, projectId, sha: result.sha, filesExported: commitFiles.length,
    });

    return {
      sha: result.sha,
      message: result.message,
      url: result.url,
      filesExported: commitFiles.length,
    };
  }
}
