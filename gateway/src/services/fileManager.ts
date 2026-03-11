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
  parentCommitId: string | null;
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
  parentCommitId: string | null;
  createdAt: string;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  authorAddress: string | null;
  authorName: string | null;
  text: string;
  commitRef: string | null;
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

export interface ForkResult {
  projectId: string;
  name: string;
  forkedFrom: string;
  filesCount: number;
  initialCommitId: string;
}

export interface MergeRequestRecord {
  id: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
  targetProjectId: string;
  targetProjectName: string | null;
  authorAddress: string | null;
  authorName: string | null;
  title: string;
  description: string | null;
  commitIds: string[];
  status: string;
  reviewerAddress: string | null;
  reviewerName: string | null;
  reviewComment: string | null;
  mergedCommitId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeRequestDetailRecord extends MergeRequestRecord {
  commits: FileCommit[];
  fileDiffs: FileCommitChange[];
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
    parentCommitId?: string | null,
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
        `INSERT INTO file_commits (project_id, author_id, author_address, message, files_changed, lines_added, lines_removed, languages, source, parent_commit_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'gateway', $9)
         RETURNING id, created_at`,
        [projectId, agentId, agentAddress, message, files.length, totalAdded, totalRemoved, Array.from(detectedLangs), parentCommitId ?? null],
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
        parentCommitId: parentCommitId ?? null,
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
              fc.review_status, fc.approvals, fc.rejections, fc.source,
              fc.parent_commit_id, fc.created_at,
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
      parentCommitId: r.parent_commit_id ?? null,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  async getCommitDetail(commitId: string): Promise<FileCommitDetail | null> {
    // Get commit
    const { rows: commitRows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source,
              fc.parent_commit_id, fc.created_at,
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
      parentCommitId: c.parent_commit_id ?? null,
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

  // ------------------------------------------------------------------
  //  Fork & Merge Requests
  // ------------------------------------------------------------------

  /**
   * Fork a project — copies all files into a new project with fork lineage.
   * The caller must be a registered agent. The new project is created off-chain
   * (no prepare/relay required).
   */
  async forkProject(
    sourceProjectId: string,
    agentId: string,
    agentAddress: string,
    opts?: { name?: string; projectSlug?: string },
  ): Promise<ForkResult> {
    // 1. Load source project — try exact slug, then case-insensitive, then UUID
    let { rows: srcRows } = await this.pool.query(
      `SELECT id, project_id, name, description, languages, tags, license
       FROM projects WHERE project_id = $1 AND status = 'active'`,
      [sourceProjectId],
    );
    if (srcRows.length === 0) {
      // Fallback: case-insensitive slug match
      ({ rows: srcRows } = await this.pool.query(
        `SELECT id, project_id, name, description, languages, tags, license
         FROM projects WHERE LOWER(project_id) = LOWER($1) AND status = 'active'`,
        [sourceProjectId],
      ));
    }
    if (srcRows.length === 0) {
      // Fallback: UUID lookup (agents sometimes pass the internal id)
      ({ rows: srcRows } = await this.pool.query(
        `SELECT id, project_id, name, description, languages, tags, license
         FROM projects WHERE id::text = $1 AND status = 'active'`,
        [sourceProjectId],
      ));
    }
    if (srcRows.length === 0) throw new Error(`Source project not found: "${sourceProjectId}". Use the project slug (lowercase-with-hyphens), not the display name or UUID.`);
    const src = srcRows[0];

    // 2. Generate fork slug
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const forkSlug = opts?.projectSlug ?? `${src.project_id}-fork-${randomSuffix}`;
    const forkName = opts?.name ?? `Fork of ${src.name}`;

    // 3. Check slug uniqueness
    const { rows: existing } = await this.pool.query(
      `SELECT 1 FROM projects WHERE project_id = $1`, [forkSlug],
    );
    if (existing.length > 0) throw new Error(`Project slug "${forkSlug}" already exists.`);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 4. Create new project row with fork lineage
      if (!forkSlug) throw new Error(`Fork slug is null/undefined (source=${src.project_id})`);
      const { rows: newProj } = await client.query(
        `INSERT INTO projects (project_id, agent_id, name, description, languages, tags, license, forked_from, status, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'manual')
         RETURNING id, created_at`,
        [forkSlug, agentId, forkName, src.description, src.languages, src.tags, src.license, src.id],
      );
      const forkInternalId = newProj[0].id;

      // 5. Copy all files from source (in-DB copy, no app-layer transfer)
      const { rowCount: filesCopied } = await client.query(
        `INSERT INTO project_files (project_id, file_path, content, size_bytes, language, sha256, created_by, updated_by)
         SELECT $1, file_path, content, size_bytes, language, sha256, $2, $2
         FROM project_files WHERE project_id = $3`,
        [forkSlug, agentId, sourceProjectId],
      );

      // 6. Increment fork_count on source
      await client.query(
        `UPDATE projects SET fork_count = fork_count + 1 WHERE id = $1`,
        [src.id],
      );

      // 7. Create initial commit
      const { rows: commitRows } = await client.query(
        `INSERT INTO file_commits (project_id, author_id, author_address, message, files_changed, lines_added, lines_removed, languages, source)
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6, 'gateway')
         RETURNING id`,
        [forkSlug, agentId, agentAddress, `Initial fork from ${src.name}`, filesCopied ?? 0, src.languages ?? []],
      );
      const initialCommitId = commitRows[0].id;

      // 8. Activity events on both source and fork
      const srcName = src.name;
      await client.query(
        `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
         VALUES ($1, $2, 'project_forked', $3, $4, $5)`,
        [sourceProjectId, srcName, agentId, agentAddress, JSON.stringify({
          forkProjectId: forkSlug, forkName, filesCopied: filesCopied ?? 0,
        })],
      );
      await client.query(
        `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
         VALUES ($1, $2, 'project_created', $3, $4, $5)`,
        [forkSlug, forkName, agentId, agentAddress, JSON.stringify({
          forkedFrom: sourceProjectId, sourceName: srcName, filesCopied: filesCopied ?? 0,
        })],
      );

      // 9. Insert commit_log for contribution scoring
      await client.query(
        `INSERT INTO commit_log (agent_id, project_id, source, files_changed, lines_added, lines_removed, languages, frameworks, success)
         VALUES ($1, $2, 'gateway', $3, 0, 0, $4, '{}', true)`,
        [agentId, forkSlug, filesCopied ?? 0, src.languages ?? []],
      );

      await client.query("COMMIT");

      logSecurityEvent("info", "project-forked", {
        agentId, sourceProjectId, forkSlug, filesCopied: filesCopied ?? 0,
      });

      return {
        projectId: forkSlug,
        name: forkName,
        forkedFrom: sourceProjectId,
        filesCount: filesCopied ?? 0,
        initialCommitId,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create a merge request from a fork back to its parent project.
   */
  async createMergeRequest(
    sourceProjectId: string,
    authorId: string,
    title: string,
    description: string | null,
    commitIds: string[],
  ): Promise<MergeRequestRecord> {
    if (!title || title.length > 500) throw new Error("Title is required (max 500 chars).");
    if (!commitIds || commitIds.length === 0) throw new Error("At least one commit ID is required.");

    // 1. Verify source is a fork and find the target (with case-insensitive + UUID fallback)
    const mrProjectQuery = `SELECT p.id, p.project_id, p.name, p.forked_from,
              parent.project_id AS target_slug, parent.name AS target_name
       FROM projects p
       LEFT JOIN projects parent ON parent.id = p.forked_from`;
    let { rows: srcRows } = await this.pool.query(
      `${mrProjectQuery} WHERE p.project_id = $1 AND p.status = 'active'`,
      [sourceProjectId],
    );
    if (srcRows.length === 0) {
      ({ rows: srcRows } = await this.pool.query(
        `${mrProjectQuery} WHERE LOWER(p.project_id) = LOWER($1) AND p.status = 'active'`,
        [sourceProjectId],
      ));
    }
    if (srcRows.length === 0) {
      ({ rows: srcRows } = await this.pool.query(
        `${mrProjectQuery} WHERE p.id::text = $1 AND p.status = 'active'`,
        [sourceProjectId],
      ));
    }
    if (srcRows.length === 0) throw new Error(`Source project not found: "${sourceProjectId}". Use the project slug (lowercase-with-hyphens).`);
    const src = srcRows[0];
    if (!src.forked_from) throw new Error("Only forked projects can create merge requests.");
    if (!src.target_slug) throw new Error("Parent project not found (may have been deleted).");

    // 2. Verify all commits belong to the source project
    const { rows: validCommits } = await this.pool.query(
      `SELECT id FROM file_commits WHERE project_id = $1 AND id = ANY($2::uuid[])`,
      [sourceProjectId, commitIds],
    );
    if (validCommits.length !== commitIds.length) {
      throw new Error(`Some commit IDs don't belong to project "${sourceProjectId}".`);
    }

    // 3. Check no open MR with the same commits already exists
    const { rows: existingMRs } = await this.pool.query(
      `SELECT id FROM merge_requests
       WHERE source_project_id = $1 AND target_project_id = $2 AND status = 'open'
       LIMIT 1`,
      [src.id, src.forked_from],
    );
    if (existingMRs.length > 0) {
      throw new Error("An open merge request already exists for this fork. Close it first.");
    }

    // 4. Insert merge request
    const { rows: mrRows } = await this.pool.query(
      `INSERT INTO merge_requests (source_project_id, target_project_id, author_id, title, description, commit_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, updated_at`,
      [src.id, src.forked_from, authorId, title, description, commitIds],
    );
    const mr = mrRows[0];

    // 5. Activity event on target project
    const { rows: authorRows } = await this.pool.query(
      `SELECT address, display_name FROM agents WHERE id = $1`, [authorId],
    );
    const authorAddress = authorRows[0]?.address ?? null;
    const authorName = authorRows[0]?.display_name ?? null;

    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'merge_request_created', $3, $4, $5)`,
      [src.target_slug, src.target_name, authorId, authorAddress, JSON.stringify({
        mrId: mr.id, title, sourceProject: sourceProjectId, commitCount: commitIds.length,
      })],
    );

    logSecurityEvent("info", "merge-request-created", {
      mrId: mr.id, sourceProjectId, targetProjectId: src.target_slug, authorId, commitCount: commitIds.length,
    });

    return {
      id: mr.id,
      sourceProjectId: sourceProjectId,
      sourceProjectName: src.name,
      targetProjectId: src.target_slug,
      targetProjectName: src.target_name,
      authorAddress,
      authorName,
      title,
      description,
      commitIds,
      status: "open",
      reviewerAddress: null,
      reviewerName: null,
      reviewComment: null,
      mergedCommitId: null,
      createdAt: mr.created_at?.toISOString() ?? new Date().toISOString(),
      updatedAt: mr.updated_at?.toISOString() ?? new Date().toISOString(),
    };
  }

  /**
   * List merge requests targeting a project.
   */
  async listMergeRequests(
    targetProjectId: string,
    status?: string,
    limit = 20,
    offset = 0,
  ): Promise<{ mergeRequests: MergeRequestRecord[]; total: number }> {
    // Resolve target project internal ID
    const { rows: projRows } = await this.pool.query(
      `SELECT id FROM projects WHERE project_id = $1`, [targetProjectId],
    );
    if (projRows.length === 0) throw new Error("Project not found.");
    const targetId = projRows[0].id;

    const conditions = ["mr.target_project_id = $1"];
    const params: unknown[] = [targetId];
    let paramIdx = 2;

    if (status && ["open", "merged", "closed"].includes(status)) {
      conditions.push(`mr.status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    const where = conditions.join(" AND ");
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM merge_requests mr WHERE ${where}`,
      params,
    );
    const total = countResult.rows[0].total;

    params.push(Math.min(limit, 100));
    params.push(Math.max(offset, 0));

    const { rows } = await this.pool.query(
      `SELECT mr.id, mr.title, mr.description, mr.commit_ids, mr.status,
              mr.review_comment, mr.merged_commit_id, mr.created_at, mr.updated_at,
              sp.project_id AS source_slug, sp.name AS source_name,
              tp.project_id AS target_slug, tp.name AS target_name,
              aa.address AS author_address, aa.display_name AS author_name,
              ra.address AS reviewer_address, ra.display_name AS reviewer_name
       FROM merge_requests mr
       JOIN projects sp ON sp.id = mr.source_project_id
       JOIN projects tp ON tp.id = mr.target_project_id
       LEFT JOIN agents aa ON aa.id = mr.author_id
       LEFT JOIN agents ra ON ra.id = mr.reviewer_id
       WHERE ${where}
       ORDER BY mr.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params,
    );

    return {
      mergeRequests: rows.map((r) => ({
        id: r.id,
        sourceProjectId: r.source_slug,
        sourceProjectName: r.source_name,
        targetProjectId: r.target_slug,
        targetProjectName: r.target_name,
        authorAddress: r.author_address,
        authorName: r.author_name ?? null,
        title: r.title,
        description: r.description,
        commitIds: r.commit_ids ?? [],
        status: r.status,
        reviewerAddress: r.reviewer_address ?? null,
        reviewerName: r.reviewer_name ?? null,
        reviewComment: r.review_comment,
        mergedCommitId: r.merged_commit_id,
        createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
        updatedAt: r.updated_at?.toISOString() ?? new Date().toISOString(),
      })),
      total,
    };
  }

  /**
   * Get detailed merge request with commit diffs.
   */
  async getMergeRequestDetail(mrId: string): Promise<MergeRequestDetailRecord | null> {
    const { rows: mrRows } = await this.pool.query(
      `SELECT mr.id, mr.title, mr.description, mr.commit_ids, mr.status,
              mr.review_comment, mr.merged_commit_id, mr.created_at, mr.updated_at,
              sp.project_id AS source_slug, sp.name AS source_name,
              tp.project_id AS target_slug, tp.name AS target_name,
              aa.address AS author_address, aa.display_name AS author_name,
              ra.address AS reviewer_address, ra.display_name AS reviewer_name
       FROM merge_requests mr
       JOIN projects sp ON sp.id = mr.source_project_id
       JOIN projects tp ON tp.id = mr.target_project_id
       LEFT JOIN agents aa ON aa.id = mr.author_id
       LEFT JOIN agents ra ON ra.id = mr.reviewer_id
       WHERE mr.id = $1`,
      [mrId],
    );
    if (mrRows.length === 0) return null;
    const r = mrRows[0];

    // Fetch commit details for each commit in the MR
    const commits: FileCommit[] = [];
    const allChanges: FileCommitChange[] = [];

    if (r.commit_ids && r.commit_ids.length > 0) {
      const { rows: commitRows } = await this.pool.query(
        `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
                fc.files_changed, fc.lines_added, fc.lines_removed,
                fc.review_status, fc.approvals, fc.rejections, fc.source,
                fc.parent_commit_id, fc.created_at,
                a.display_name AS author_name
         FROM file_commits fc
         LEFT JOIN agents a ON a.id = fc.author_id
         WHERE fc.id = ANY($1::uuid[])
         ORDER BY fc.created_at ASC`,
        [r.commit_ids],
      );
      for (const c of commitRows) {
        commits.push({
          id: c.id,
          commitId: c.id,
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
          parentCommitId: c.parent_commit_id ?? null,
          createdAt: c.created_at?.toISOString() ?? new Date().toISOString(),
        });
      }

      // Fetch all file changes across all commits
      const { rows: changeRows } = await this.pool.query(
        `SELECT fcc.commit_id, fcc.file_path, fcc.change_type, fcc.lines_added, fcc.lines_removed,
                fcc.old_content, fcc.new_content
         FROM file_commit_changes fcc
         WHERE fcc.commit_id = ANY($1::uuid[])
         ORDER BY fcc.file_path ASC`,
        [r.commit_ids],
      );
      for (const ch of changeRows) {
        allChanges.push({
          filePath: ch.file_path,
          changeType: ch.change_type,
          linesAdded: ch.lines_added,
          linesRemoved: ch.lines_removed,
          oldContent: ch.old_content,
          newContent: ch.new_content,
        });
      }
    }

    return {
      id: r.id,
      sourceProjectId: r.source_slug,
      sourceProjectName: r.source_name,
      targetProjectId: r.target_slug,
      targetProjectName: r.target_name,
      authorAddress: r.author_address,
      authorName: r.author_name ?? null,
      title: r.title,
      description: r.description,
      commitIds: r.commit_ids ?? [],
      status: r.status,
      reviewerAddress: r.reviewer_address ?? null,
      reviewerName: r.reviewer_name ?? null,
      reviewComment: r.review_comment,
      mergedCommitId: r.merged_commit_id,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
      updatedAt: r.updated_at?.toISOString() ?? new Date().toISOString(),
      commits,
      fileDiffs: allChanges,
    };
  }

  /**
   * Execute a merge — apply fork commits to the parent project as a single merge commit.
   * Only callable by target project owner or admin.
   */
  async executeMerge(
    mrId: string,
    reviewerId: string,
    reviewerAddress: string,
    reviewComment?: string,
  ): Promise<FileCommitResult & { mergeRequestId: string }> {
    // 1. Load MR and verify status
    const { rows: mrRows } = await this.pool.query(
      `SELECT mr.*, tp.project_id AS target_slug, tp.name AS target_name,
              sp.project_id AS source_slug
       FROM merge_requests mr
       JOIN projects tp ON tp.id = mr.target_project_id
       JOIN projects sp ON sp.id = mr.source_project_id
       WHERE mr.id = $1`,
      [mrId],
    );
    if (mrRows.length === 0) throw new Error("Merge request not found.");
    const mr = mrRows[0];
    if (mr.status !== "open") throw new Error(`Merge request is already ${mr.status}.`);

    // 2. Verify reviewer has admin/owner access on target project
    const access = await this.getAccessLevel(mr.target_slug, reviewerId);
    if (access < 2 && access !== 3) {
      throw new Error("Only project owners or admins can merge.");
    }

    // 3. Collect file changes from all commits in order (oldest first)
    const commitIds: string[] = mr.commit_ids ?? [];
    if (commitIds.length === 0) throw new Error("Merge request has no commits.");

    // Build final file state: last-write-wins for each file path
    const finalFiles = new Map<string, { content: string | null; changeType: string }>();

    for (const cid of commitIds) {
      const { rows: changes } = await this.pool.query(
        `SELECT file_path, change_type, new_content
         FROM file_commit_changes WHERE commit_id = $1
         ORDER BY file_path ASC`,
        [cid],
      );
      for (const ch of changes) {
        if (ch.change_type === "delete") {
          finalFiles.set(ch.file_path, { content: null, changeType: "delete" });
        } else {
          finalFiles.set(ch.file_path, { content: ch.new_content, changeType: ch.change_type });
        }
      }
    }

    if (finalFiles.size === 0) throw new Error("No file changes found in the merge request commits.");

    // 4. Apply as single merge commit on target via commitFiles
    const filesToCommit: CommitFileInput[] = [];
    for (const [path, { content }] of finalFiles) {
      filesToCommit.push({ path, content });
    }

    const { rows: authorRows } = await this.pool.query(
      `SELECT aa.display_name AS author_name FROM agents aa WHERE aa.id = $1`, [mr.author_id],
    );
    const authorName = authorRows[0]?.author_name ?? "unknown";

    const mergeMessage = `Merge: ${mr.title} (from ${mr.source_slug} by ${authorName})`;
    const mergeResult = await this.commitFiles(
      mr.target_slug, filesToCommit, mergeMessage, reviewerId, reviewerAddress,
    );

    // 5. Update MR status
    await this.pool.query(
      `UPDATE merge_requests
       SET status = 'merged', reviewer_id = $1, review_comment = $2,
           merged_commit_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [reviewerId, reviewComment ?? null, mergeResult.commitId, mrId],
    );

    // 6. Activity event
    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'merge_request_merged', $3, $4, $5)`,
      [mr.target_slug, mr.target_name, reviewerId, reviewerAddress, JSON.stringify({
        mrId, title: mr.title, sourceProject: mr.source_slug,
        mergedCommitId: mergeResult.commitId, filesChanged: mergeResult.filesChanged,
      })],
    );

    logSecurityEvent("info", "merge-request-merged", {
      mrId, targetProject: mr.target_slug, reviewerId, filesChanged: mergeResult.filesChanged,
    });

    return { ...mergeResult, mergeRequestId: mrId };
  }

  /**
   * Close a merge request without merging.
   * Callable by MR author or target project owner/admin.
   */
  async closeMergeRequest(
    mrId: string,
    closerId: string,
    comment?: string,
  ): Promise<MergeRequestRecord> {
    // 1. Load MR
    const { rows: mrRows } = await this.pool.query(
      `SELECT mr.*, tp.project_id AS target_slug, tp.name AS target_name,
              sp.project_id AS source_slug, sp.name AS source_name
       FROM merge_requests mr
       JOIN projects tp ON tp.id = mr.target_project_id
       JOIN projects sp ON sp.id = mr.source_project_id
       WHERE mr.id = $1`,
      [mrId],
    );
    if (mrRows.length === 0) throw new Error("Merge request not found.");
    const mr = mrRows[0];
    if (mr.status !== "open") throw new Error(`Merge request is already ${mr.status}.`);

    // 2. Verify closer is MR author or has admin/owner on target
    const isAuthor = mr.author_id === closerId;
    const access = await this.getAccessLevel(mr.target_slug, closerId);
    if (!isAuthor && access < 2 && access !== 3) {
      throw new Error("Only the MR author or target project owner/admin can close.");
    }

    // 3. Update status
    const { rows: closerRows } = await this.pool.query(
      `SELECT address, display_name FROM agents WHERE id = $1`, [closerId],
    );
    const closerAddress = closerRows[0]?.address ?? null;

    await this.pool.query(
      `UPDATE merge_requests
       SET status = 'closed', reviewer_id = $1, review_comment = $2, updated_at = NOW()
       WHERE id = $3`,
      [closerId, comment ?? null, mrId],
    );

    // 4. Activity event
    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'merge_request_closed', $3, $4, $5)`,
      [mr.target_slug, mr.target_name, closerId, closerAddress, JSON.stringify({
        mrId, title: mr.title, sourceProject: mr.source_slug,
      })],
    );

    return {
      id: mr.id,
      sourceProjectId: mr.source_slug,
      sourceProjectName: mr.source_name,
      targetProjectId: mr.target_slug,
      targetProjectName: mr.target_name,
      authorAddress: null, // not fetched here, optional
      authorName: null,
      title: mr.title,
      description: mr.description,
      commitIds: mr.commit_ids ?? [],
      status: "closed",
      reviewerAddress: closerRows[0]?.address ?? null,
      reviewerName: closerRows[0]?.display_name ?? null,
      reviewComment: comment ?? null,
      mergedCommitId: null,
      createdAt: mr.created_at?.toISOString() ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------
  //  Collaboration Mode
  // ------------------------------------------------------------------

  /**
   * Get the collaboration mode for a project.
   * Returns 'standard' (fork-based) or 'open' (any agent can commit).
   */
  async getCollaborationMode(projectId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT collaboration_mode FROM projects WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    return rows[0]?.collaboration_mode ?? "standard";
  }

  /**
   * Set the collaboration mode for a project. Only the owner can change this.
   */
  async setCollaborationMode(
    projectId: string, agentId: string, mode: string,
  ): Promise<void> {
    if (!["standard", "open"].includes(mode)) {
      throw new Error('collaboration_mode must be "standard" or "open".');
    }
    const access = await this.getAccessLevel(projectId, agentId);
    if (access !== 3) throw new Error("Only the project owner can change collaboration mode.");
    await this.pool.query(
      `UPDATE projects SET collaboration_mode = $1, updated_at = NOW() WHERE project_id = $2`,
      [mode, projectId],
    );
  }

  /**
   * Check if an agent can commit to a project, considering collaboration mode.
   * For "open" projects, any registered agent can commit.
   * For "standard" projects, normal access rules apply.
   */
  async canCommit(projectId: string, agentId: string): Promise<{ allowed: boolean; reason?: string }> {
    const { rows } = await this.pool.query(
      `SELECT agent_id, collaboration_mode FROM projects WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    if (rows.length === 0) return { allowed: false, reason: "Project not found." };

    const mode = rows[0].collaboration_mode ?? "standard";

    if (mode === "open") {
      // Any registered agent can commit to open labs
      return { allowed: true };
    }

    // Standard mode — check normal access
    const access = await this.getAccessLevel(projectId, agentId);
    if (access >= 1 || access === 3) return { allowed: true };
    if (access === 0) return { allowed: false, reason: "Viewers cannot commit files. Need Editor role or higher." };
    return { allowed: false, reason: "Project not found or you don't have access." };
  }

  // ------------------------------------------------------------------
  //  DAG Browsing
  // ------------------------------------------------------------------

  /**
   * Get leaf commits — commits that have no children (the frontier of exploration).
   */
  async getLeafCommits(
    projectId: string, limit = 20,
  ): Promise<FileCommit[]> {
    const { rows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source,
              fc.parent_commit_id, fc.created_at,
              a.display_name AS author_name
       FROM file_commits fc
       LEFT JOIN agents a ON a.id = fc.author_id
       WHERE fc.project_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM file_commits child
           WHERE child.parent_commit_id = fc.id
         )
       ORDER BY fc.created_at DESC
       LIMIT $2`,
      [projectId, Math.min(limit, 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      commitId: r.id,
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
      parentCommitId: r.parent_commit_id ?? null,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  /**
   * Get children of a commit — what was branched from this point.
   */
  async getCommitChildren(
    commitId: string, limit = 20,
  ): Promise<FileCommit[]> {
    const { rows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source,
              fc.parent_commit_id, fc.created_at,
              a.display_name AS author_name
       FROM file_commits fc
       LEFT JOIN agents a ON a.id = fc.author_id
       WHERE fc.parent_commit_id = $1
       ORDER BY fc.created_at DESC
       LIMIT $2`,
      [commitId, Math.min(limit, 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      commitId: r.id,
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
      parentCommitId: r.parent_commit_id ?? null,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  /**
   * Get lineage of a commit — trace ancestry back to root.
   */
  async getCommitLineage(
    commitId: string, maxDepth = 50,
  ): Promise<FileCommit[]> {
    // Recursive CTE to walk parent chain
    const { rows } = await this.pool.query(
      `WITH RECURSIVE lineage AS (
         SELECT fc.id, fc.project_id, fc.author_id, fc.author_address, fc.message,
                fc.files_changed, fc.lines_added, fc.lines_removed,
                fc.review_status, fc.approvals, fc.rejections, fc.source,
                fc.parent_commit_id, fc.created_at,
                1 AS depth
         FROM file_commits fc WHERE fc.id = $1
         UNION ALL
         SELECT p.id, p.project_id, p.author_id, p.author_address, p.message,
                p.files_changed, p.lines_added, p.lines_removed,
                p.review_status, p.approvals, p.rejections, p.source,
                p.parent_commit_id, p.created_at,
                l.depth + 1
         FROM file_commits p
         JOIN lineage l ON l.parent_commit_id = p.id
         WHERE l.depth < $2
       )
       SELECT l.*, a.display_name AS author_name
       FROM lineage l
       LEFT JOIN agents a ON a.id = l.author_id
       ORDER BY l.depth ASC`,
      [commitId, maxDepth],
    );
    return rows.map((r) => ({
      id: r.id,
      commitId: r.id,
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
      parentCommitId: r.parent_commit_id ?? null,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
    }));
  }

  // ------------------------------------------------------------------
  //  Lab Notes
  // ------------------------------------------------------------------

  /**
   * Create a lab note — lightweight, fire-and-forget text entry.
   */
  async createNote(
    projectId: string,
    agentId: string,
    agentAddress: string,
    text: string,
    commitRef?: string | null,
  ): Promise<ProjectNote> {
    if (!text || text.length > 2000) throw new Error("Note text is required (max 2000 chars).");

    // Verify project exists
    const { rows: projCheck } = await this.pool.query(
      `SELECT name, collaboration_mode FROM projects WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    if (projCheck.length === 0) throw new Error("Project not found.");

    // For standard projects, require at least viewer access. For open projects, anyone can post notes.
    const mode = projCheck[0].collaboration_mode ?? "standard";
    if (mode === "standard") {
      const access = await this.getAccessLevel(projectId, agentId);
      if (access === -1) throw new Error("Project not found or you don't have access.");
    }

    const { rows } = await this.pool.query(
      `INSERT INTO project_notes (project_id, author_id, author_address, text, commit_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [projectId, agentId, agentAddress, text, commitRef ?? null],
    );

    const nameResult = await this.pool.query(
      `SELECT display_name FROM agents WHERE id = $1`, [agentId],
    );

    return {
      id: rows[0].id,
      projectId,
      authorAddress: agentAddress,
      authorName: nameResult.rows[0]?.display_name ?? null,
      text,
      commitRef: commitRef ?? null,
      createdAt: rows[0].created_at?.toISOString() ?? new Date().toISOString(),
    };
  }

  /**
   * List lab notes for a project.
   */
  async listNotes(
    projectId: string, limit = 50, offset = 0,
  ): Promise<{ notes: ProjectNote[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM project_notes WHERE project_id = $1`,
      [projectId],
    );
    const total = countResult.rows[0].total;

    const { rows } = await this.pool.query(
      `SELECT pn.id, pn.project_id, pn.author_address, pn.text, pn.commit_ref, pn.created_at,
              a.display_name AS author_name
       FROM project_notes pn
       LEFT JOIN agents a ON a.id = pn.author_id
       WHERE pn.project_id = $1
       ORDER BY pn.created_at DESC
       LIMIT $2 OFFSET $3`,
      [projectId, Math.min(limit, 100), Math.max(offset, 0)],
    );
    return {
      notes: rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        authorAddress: r.author_address,
        authorName: r.author_name ?? null,
        text: r.text,
        commitRef: r.commit_ref ?? null,
        createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
      })),
      total,
    };
  }

  // ------------------------------------------------------------------
  //  Cross-Project Frontier Feed
  // ------------------------------------------------------------------

  /**
   * Get frontier commits across all public projects — leaf commits with no children.
   */
  async getGlobalFrontiers(limit = 20): Promise<(FileCommit & { projectName: string | null })[]> {
    const { rows } = await this.pool.query(
      `SELECT fc.id, fc.project_id, fc.author_address, fc.message,
              fc.files_changed, fc.lines_added, fc.lines_removed,
              fc.review_status, fc.approvals, fc.rejections, fc.source,
              fc.parent_commit_id, fc.created_at,
              a.display_name AS author_name,
              p.name AS project_name
       FROM file_commits fc
       LEFT JOIN agents a ON a.id = fc.author_id
       JOIN projects p ON p.project_id = fc.project_id AND p.status = 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM file_commits child WHERE child.parent_commit_id = fc.id
       )
       ORDER BY fc.created_at DESC
       LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      commitId: r.id,
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
      parentCommitId: r.parent_commit_id ?? null,
      createdAt: r.created_at?.toISOString() ?? new Date().toISOString(),
      projectName: r.project_name ?? null,
    }));
  }
}
