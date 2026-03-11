/**
 * CodeReviewService — orchestrates AI code reviews on project commits.
 *
 * Flow:
 * 1. Validate project has github_owner + github_repo
 * 2. Fetch commit detail (diffs) via FileManager
 * 3. Deduct credits upfront
 * 4. Ensure repo is indexed (idempotent)
 * 5. Send diff for AI review
 * 6. Parse response → verdict + inline findings
 * 7. Insert review (commit_reviews) + comments (review_comments) using system reviewer
 * 8. Return structured result
 *
 * @module codeReviewService
 */

import type { Pool } from "pg";
import type { CreditManager } from "./creditManager.js";
import type { FileManager, FileCommitDetail } from "./fileManager.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// ---------------------------------------------------------------------------
//  System reviewer identity (must match migration 065)
// ---------------------------------------------------------------------------

const GREPTILE_REVIEWER_ID = "greptile-system-reviewer";
const GREPTILE_REVIEWER_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export interface CodeReviewConfig {
  apiKey: string;
  creditCost: number;
}

export interface ParsedFinding {
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  suggestion: string | null;
  severity: "critical" | "warning" | "info";
}

export interface ReviewResult {
  reviewId: string;
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  findings: ParsedFinding[];
  findingsCount: number;
  creditsCost: number;
}

interface GreptileSource {
  repository: string;
  filepath?: string;
  linestart?: number;
  lineend?: number;
}

interface GreptileResponse {
  message: string;
  sources: GreptileSource[];
}

// ---------------------------------------------------------------------------
//  Service
// ---------------------------------------------------------------------------

export class CodeReviewService {
  constructor(
    private pool: Pool,
    private creditManager: CreditManager,
    private fileManager: FileManager,
    private config: CodeReviewConfig,
  ) {}

  /**
   * Request a Greptile-powered AI review on a commit.
   */
  async requestReview(
    projectId: string,
    commitId: string,
    requestingAgentId: string,
  ): Promise<ReviewResult> {
    // 1. Validate project has GitHub repo
    const { rows: projRows } = await this.pool.query<{
      github_owner: string | null;
      github_repo: string | null;
      agent_id: string;
    }>(
      `SELECT github_owner, github_repo, agent_id FROM projects WHERE project_id = $1`,
      [projectId],
    );
    if (projRows.length === 0) {
      throw new CodeReviewError("Project not found", 404);
    }
    const project = projRows[0];
    if (!project.github_owner || !project.github_repo) {
      throw new CodeReviewError(
        "Project must be exported to GitHub before requesting AI code review",
        400,
      );
    }

    // 2. Fetch commit detail (diffs)
    const commit = await this.fileManager.getCommitDetail(commitId);
    if (!commit) {
      throw new CodeReviewError("Commit not found", 404);
    }
    if (commit.projectId !== projectId) {
      throw new CodeReviewError("Commit does not belong to this project", 400);
    }
    if (commit.changes.length === 0) {
      throw new CodeReviewError("Commit has no file changes to review", 400);
    }

    // 3. Deduct credits upfront
    const creditCost = this.config.creditCost;
    try {
      await this.creditManager.deductCredits(
        requestingAgentId,
        creditCost,
        `ai_code_review:${commitId}`,
        "ai_code_review",
      );
    } catch {
      throw new CodeReviewError(
        `Insufficient credits. AI code review costs ${creditCost} credits.`,
        402,
      );
    }

    // 4-6. Call Greptile (index + query)
    let greptileResponse: GreptileResponse;
    try {
      // Fetch the agent's GitHub PAT for Greptile API auth
      const githubToken = await this.getGithubToken(requestingAgentId);

      await this.ensureRepoIndexed(
        project.github_owner,
        project.github_repo,
        "main",
        githubToken,
      );

      greptileResponse = await this.queryGreptile(
        project.github_owner,
        project.github_repo,
        "main",
        commit,
        githubToken,
      );
    } catch (err) {
      // Refund credits on Greptile API failure
      await this.creditManager.addCredits(
        requestingAgentId,
        creditCost,
        "ai_code_review_refund",
        `refund:${commitId}`,
      ).catch(() => {});

      if (err instanceof CodeReviewError) throw err;
      throw new CodeReviewError(
        `AI review failed: ${err instanceof Error ? err.message : "unknown error"}`,
        502,
      );
    }

    // 7. Parse findings
    const findings = this.parseFindings(greptileResponse, commit);
    const verdict = this.determineVerdict(findings);
    const summary = greptileResponse.message;

    // 8. Insert review via existing commit_reviews table
    const { rows: reviewRows } = await this.pool.query<{ id: string }>(
      `INSERT INTO commit_reviews (commit_id, reviewer_id, reviewer_address, verdict, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (commit_id, reviewer_id) DO UPDATE
       SET verdict = EXCLUDED.verdict, body = EXCLUDED.body, created_at = NOW()
       RETURNING id`,
      [commitId, GREPTILE_REVIEWER_ID, GREPTILE_REVIEWER_ADDRESS, verdict, summary],
    );
    const reviewId = reviewRows[0].id;

    // 9. Insert inline findings via review_comments
    for (const finding of findings) {
      await this.pool.query(
        `INSERT INTO review_comments
           (commit_id, review_id, author_id, author_address, file_path, line_start, line_end, body, suggestion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          commitId,
          reviewId,
          GREPTILE_REVIEWER_ID,
          GREPTILE_REVIEWER_ADDRESS,
          finding.filePath,
          finding.lineStart,
          finding.lineEnd,
          finding.body,
          finding.suggestion,
        ],
      );
    }

    // 10. Update commit review counts
    const { rows: countRows } = await this.pool.query<{
      approvals: string;
      rejections: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE verdict = 'approve') AS approvals,
         COUNT(*) FILTER (WHERE verdict = 'request_changes') AS rejections
       FROM commit_reviews WHERE commit_id = $1`,
      [commitId],
    );
    const approvals = parseInt(countRows[0].approvals, 10);
    const rejections = parseInt(countRows[0].rejections, 10);
    let newStatus = "pending_review";
    if (approvals >= 1 && rejections === 0) newStatus = "approved";
    else if (rejections > 0) newStatus = "changes_requested";

    await this.pool.query(
      `UPDATE file_commits SET approvals = $1, rejections = $2, review_status = $3 WHERE id = $4`,
      [approvals, rejections, newStatus, commitId],
    );

    // 11. Log to project_activity
    await this.pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, (SELECT name FROM projects WHERE project_id = $1), 'commit_reviewed', $2, $3, $4)`,
      [
        projectId,
        GREPTILE_REVIEWER_ID,
        GREPTILE_REVIEWER_ADDRESS,
        JSON.stringify({ commitId, verdict, newStatus, approvals, rejections, source: "greptile" }),
      ],
    );

    return {
      reviewId,
      verdict,
      summary,
      findings,
      findingsCount: findings.length,
      creditsCost: creditCost,
    };
  }

  // -------------------------------------------------------------------------
  //  Private: Greptile API interactions
  // -------------------------------------------------------------------------

  /**
   * Retrieve and decrypt the requesting agent's GitHub PAT.
   */
  private async getGithubToken(agentId: string): Promise<string> {
    const { rows } = await this.pool.query<{
      encrypted_pat: string;
      pat_iv: string;
      pat_auth_tag: string;
    }>(
      `SELECT encrypted_pat, pat_iv, pat_auth_tag FROM github_connections WHERE agent_id = $1`,
      [agentId],
    );
    if (rows.length === 0) {
      throw new CodeReviewError(
        "GitHub account not connected. Connect via POST /v1/github/connect first.",
        400,
      );
    }
    // We import decryptPrivateKey lazily to avoid circular dep
    const { decryptSecret } = await import("../secretManager.js");
    const { gatewayConfig } = await import("../config.js");
    return decryptSecret(rows[0].encrypted_pat, rows[0].pat_iv, rows[0].pat_auth_tag, gatewayConfig.secretEncryptionKey);
  }

  /**
   * Index a repo with Greptile (idempotent — safe to call multiple times).
   * Checks local cache first to skip unnecessary API calls.
   */
  async ensureRepoIndexed(
    owner: string,
    repo: string,
    branch: string,
    githubToken: string,
  ): Promise<void> {
    // Check if already indexed
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM greptile_indexed_repos WHERE github_owner = $1 AND github_repo = $2`,
      [owner, repo],
    );
    if (rowCount && rowCount > 0) return;

    // Index with Greptile
    const res = await fetchWithTimeout("https://api.greptile.com/v2/repositories", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "X-GitHub-Token": githubToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        remote: "github",
        repository: `${owner}/${repo}`,
        branch,
      }),
      timeoutMs: 30_000,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CodeReviewError(
        `Greptile repo indexing failed (${res.status}): ${body}`,
        502,
      );
    }

    // Record indexed status
    await this.pool.query(
      `INSERT INTO greptile_indexed_repos (github_owner, github_repo, branch)
       VALUES ($1, $2, $3)
       ON CONFLICT (github_owner, github_repo) DO NOTHING`,
      [owner, repo, branch],
    );
  }

  /**
   * Call Greptile POST /v2/query with the commit diff for code review.
   */
  private async queryGreptile(
    owner: string,
    repo: string,
    branch: string,
    commit: FileCommitDetail,
    githubToken: string,
  ): Promise<GreptileResponse> {
    // Build the diff description for the review prompt
    const diffSections = commit.changes.map((change) => {
      const header = `--- ${change.filePath} (${change.changeType}) ---`;
      if (change.changeType === "delete") {
        return `${header}\n[File deleted]`;
      }
      if (change.changeType === "add") {
        return `${header}\n${change.newContent ?? ""}`;
      }
      // modify — show both old and new
      const oldLines = change.oldContent ?? "";
      const newLines = change.newContent ?? "";
      return `${header}\nOLD:\n${oldLines}\n\nNEW:\n${newLines}`;
    });

    const diffText = diffSections.join("\n\n");

    const reviewPrompt = [
      `Review this commit for code quality, bugs, security issues, and best practices.`,
      `Commit message: "${commit.message}"`,
      `Files changed: ${commit.filesChanged}, +${commit.linesAdded} -${commit.linesRemoved}`,
      ``,
      `For each issue found, specify:`,
      `- The file path and line number(s)`,
      `- A clear description of the issue`,
      `- A suggested fix if applicable`,
      ``,
      `Diff:`,
      diffText,
    ].join("\n");

    const res = await fetchWithTimeout("https://api.greptile.com/v2/query", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "X-GitHub-Token": githubToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ id: "review", content: reviewPrompt, role: "user" }],
        repositories: [
          { remote: "github", repository: `${owner}/${repo}`, branch },
        ],
        genius: true,
      }),
      timeoutMs: 60_000,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CodeReviewError(
        `Greptile query failed (${res.status}): ${body}`,
        502,
      );
    }

    return (await res.json()) as GreptileResponse;
  }

  /**
   * Parse Greptile response into structured findings with file/line references.
   */
  parseFindings(
    response: GreptileResponse,
    commit: FileCommitDetail,
  ): ParsedFinding[] {
    const findings: ParsedFinding[] = [];
    const commitFilePaths = new Set(commit.changes.map((c) => c.filePath));

    // Extract findings from sources (Greptile returns source references)
    for (const source of response.sources ?? []) {
      if (!source.filepath) continue;
      // Only include findings for files in this commit
      if (!commitFilePaths.has(source.filepath)) continue;

      findings.push({
        filePath: source.filepath,
        lineStart: source.linestart ?? null,
        lineEnd: source.lineend ?? null,
        body: `Greptile flagged this location (see review summary for details)`,
        suggestion: null,
        severity: "info",
      });
    }

    // Parse inline findings from the message body using structured patterns
    // Greptile returns markdown; look for patterns like:
    //   **file.ts:42** — description
    //   `file.ts` (line 10-15): description
    const fileLinePattern = /(?:\*\*|`)([\w/.]+(?:\.\w+))(?::(\d+)(?:-(\d+))?)?(?:\*\*|`)\s*[-:—]\s*(.+)/g;
    let match;
    while ((match = fileLinePattern.exec(response.message)) !== null) {
      const [, filePath, lineStartStr, lineEndStr, description] = match;
      if (!commitFilePaths.has(filePath)) continue;

      // Avoid duplicating source-based findings
      const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : null;
      const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : null;
      const alreadyExists = findings.some(
        (f) => f.filePath === filePath && f.lineStart === lineStart,
      );
      if (alreadyExists) continue;

      // Detect severity from keywords
      let severity: ParsedFinding["severity"] = "info";
      const lower = description.toLowerCase();
      if (lower.includes("bug") || lower.includes("security") || lower.includes("vulnerability") || lower.includes("critical")) {
        severity = "critical";
      } else if (lower.includes("should") || lower.includes("consider") || lower.includes("warning") || lower.includes("potential")) {
        severity = "warning";
      }

      findings.push({
        filePath,
        lineStart,
        lineEnd,
        body: description.trim(),
        suggestion: null,
        severity,
      });
    }

    return findings;
  }

  /**
   * Determine review verdict based on findings severity.
   */
  private determineVerdict(findings: ParsedFinding[]): ReviewResult["verdict"] {
    if (findings.some((f) => f.severity === "critical")) {
      return "request_changes";
    }
    if (findings.length === 0) {
      return "approve";
    }
    return "comment";
  }
}

// ---------------------------------------------------------------------------
//  Error class
// ---------------------------------------------------------------------------

export class CodeReviewError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "CodeReviewError";
  }
}
