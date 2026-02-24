/**
 * GitHub integration routes for the Agent Coding Sandbox.
 *
 * POST   /v1/github/connect        — Connect GitHub account (encrypt + store PAT)
 * GET    /v1/github/status          — Check GitHub connection status
 * DELETE /v1/github/disconnect      — Remove GitHub credentials
 * GET    /v1/projects/:id/files     — List files in repo
 * GET    /v1/projects/:id/files/*   — Read a file from repo
 * POST   /v1/projects/:id/commit   — Commit and push files (git only, no on-chain snapshot)
 *
 * @module routes/github
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest, GitHubCredentialRecord } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import {
  validateProjectIdParam,
  validateConnectGithubBody,
  validateCommitBody,
} from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { GitHubClient } from "../services/githubClient.js";

export function createGithubRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  githubClient: GitHubClient,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /**
   * Helper to get and decrypt the agent's GitHub PAT.
   * Returns null if not connected. Decrypted PAT is in memory only.
   */
  async function getDecryptedPAT(agentId: string): Promise<{ pat: string; username: string } | null> {
    const { rows } = await pool.query<GitHubCredentialRecord>(
      "SELECT * FROM github_credentials WHERE agent_id = $1",
      [agentId],
    );

    if (rows.length === 0) return null;

    const cred = rows[0];
    const pat = githubClient.decryptPAT(cred.encrypted_pat, cred.pat_iv, cred.pat_auth_tag);
    return { pat, username: cred.github_username };
  }

  /**
   * Helper to parse owner/repo from a project's repo_url.
   */
  function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  // -------------------------------------------------------
  //  POST /v1/github/connect — Connect GitHub account
  // -------------------------------------------------------
  router.post(
    "/github/connect",
    authMiddleware,
    registeredMiddleware,
    validateConnectGithubBody,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { pat } = req.body;

      try {
        // Validate the PAT by calling GitHub
        const validation = await githubClient.validatePAT(pat);
        if (!validation.valid || !validation.username) {
          res.status(400).json({
            error: "Invalid GitHub PAT",
            message: "The token could not be validated. Ensure it has the required scopes (repo).",
          });
          return;
        }

        // Encrypt the PAT
        const encrypted = githubClient.encryptPAT(pat);

        // Upsert credentials
        await pool.query(
          `INSERT INTO github_credentials
            (agent_id, github_username, encrypted_pat, pat_iv, pat_auth_tag, scopes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (agent_id) DO UPDATE SET
            github_username = $2,
            encrypted_pat = $3,
            pat_iv = $4,
            pat_auth_tag = $5,
            scopes = $6,
            updated_at = NOW()`,
          [
            agent.id,
            validation.username,
            encrypted.encryptedKey,
            encrypted.iv,
            encrypted.authTag,
            validation.scopes ?? [],
          ],
        );

        logSecurityEvent("info", "github-connected", {
          agentId: agent.id,
          githubUsername: validation.username,
          scopes: validation.scopes,
        });

        res.json({
          connected: true,
          username: validation.username,
          scopes: validation.scopes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-connect-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to connect GitHub account." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/github/status — Check connection status
  // -------------------------------------------------------
  router.get(
    "/github/status",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { rows } = await pool.query(
          "SELECT github_username, scopes, created_at, updated_at FROM github_credentials WHERE agent_id = $1",
          [agent.id],
        );

        if (rows.length === 0) {
          res.json({ connected: false });
          return;
        }

        res.json({
          connected: true,
          username: rows[0].github_username,
          scopes: rows[0].scopes,
          connectedAt: rows[0].created_at,
          updatedAt: rows[0].updated_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-status-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to check GitHub status." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/github/disconnect — Remove GitHub credentials
  // -------------------------------------------------------
  router.delete(
    "/github/disconnect",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const result = await pool.query(
          "DELETE FROM github_credentials WHERE agent_id = $1",
          [agent.id],
        );

        if (result.rowCount === 0) {
          res.status(404).json({ error: "No GitHub credentials found." });
          return;
        }

        logSecurityEvent("info", "github-disconnected", {
          agentId: agent.id,
        });

        res.json({ disconnected: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-disconnect-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to disconnect GitHub." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/files — List files in repo
  // -------------------------------------------------------
  router.get(
    "/projects/:id/files",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;

      try {
        // Get PAT
        const creds = await getDecryptedPAT(agent.id);
        if (!creds) {
          res.status(403).json({
            error: "GitHub not connected",
            message: "Connect GitHub first: POST /v1/github/connect",
          });
          return;
        }

        // Get project repo URL
        const { rows } = await pool.query(
          "SELECT repo_url, default_branch FROM projects WHERE project_id = $1",
          [projectId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        if (!rows[0].repo_url) {
          res.status(400).json({ error: "Project has no linked GitHub repository." });
          return;
        }

        const parsed = parseRepoUrl(rows[0].repo_url);
        if (!parsed) {
          res.status(400).json({ error: "Invalid repository URL format." });
          return;
        }

        const path = (req.query.path as string) ?? "";
        const ref = (req.query.ref as string) ?? rows[0].default_branch;

        const files = await githubClient.listFiles(creds.pat, parsed.owner, parsed.repo, path, ref);

        res.json({ files, path, ref });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-list-files-failed", {
          agentId: agent.id,
          projectId,
          error: message,
        });
        res.status(500).json({ error: "Failed to list files." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/projects/:id/file/* — Read a file from repo
  //  The file path is captured via wildcard after /files/
  // -------------------------------------------------------
  router.get(
    "/projects/:id/file/*",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      // Express 5 wildcard captures as req.params[0]
      const filePath = (req.params as Record<string, string>)[0] ?? "";

      if (!filePath) {
        res.status(400).json({ error: "File path is required." });
        return;
      }

      // Validate file path
      const pathCheck = githubClient.validateFilePath(filePath);
      if (!pathCheck.valid) {
        res.status(400).json({ error: `Invalid file path: ${pathCheck.reason}` });
        return;
      }

      try {
        const creds = await getDecryptedPAT(agent.id);
        if (!creds) {
          res.status(403).json({
            error: "GitHub not connected",
            message: "Connect GitHub first: POST /v1/github/connect",
          });
          return;
        }

        const { rows } = await pool.query(
          "SELECT repo_url, default_branch FROM projects WHERE project_id = $1",
          [projectId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        if (!rows[0].repo_url) {
          res.status(400).json({ error: "Project has no linked GitHub repository." });
          return;
        }

        const parsed = parseRepoUrl(rows[0].repo_url);
        if (!parsed) {
          res.status(400).json({ error: "Invalid repository URL format." });
          return;
        }

        const ref = (req.query.ref as string) ?? rows[0].default_branch;

        const file = await githubClient.readFile(creds.pat, parsed.owner, parsed.repo, filePath, ref);

        res.json(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-read-file-failed", {
          agentId: agent.id,
          projectId,
          filePath,
          error: message,
        });
        res.status(500).json({ error: "Failed to read file." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/projects/:id/commit — Commit and push files
  //  Git commit+push is kept (not on-chain). The optional
  //  on-chain version snapshot has been removed.
  // -------------------------------------------------------
  router.post(
    "/projects/:id/commit",
    authMiddleware,
    registeredMiddleware,
    validateProjectIdParam,
    validateCommitBody,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { files, message, branch: branchOverride } = req.body;

      try {
        const creds = await getDecryptedPAT(agent.id);
        if (!creds) {
          res.status(403).json({
            error: "GitHub not connected",
            message: "Connect GitHub first: POST /v1/github/connect",
          });
          return;
        }

        const { rows } = await pool.query(
          "SELECT repo_url, default_branch FROM projects WHERE project_id = $1",
          [projectId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Project not found." });
          return;
        }

        if (!rows[0].repo_url) {
          res.status(400).json({ error: "Project has no linked GitHub repository." });
          return;
        }

        const parsed = parseRepoUrl(rows[0].repo_url);
        if (!parsed) {
          res.status(400).json({ error: "Invalid repository URL format." });
          return;
        }

        const branch = branchOverride ?? rows[0].default_branch;

        // Commit and push (secret scanning + path validation happens inside)
        const commitResult = await githubClient.commitAndPush(
          creds.pat,
          parsed.owner,
          parsed.repo,
          files,
          message,
          branch,
        );

        logSecurityEvent("info", "github-commit-pushed", {
          agentId: agent.id,
          projectId,
          sha: commitResult.sha,
          filesChanged: commitResult.filesChanged,
          branch,
        });

        // Insert commit_log entry for contribution scoring
        try {
          // Detect languages from file extensions
          const extMap: Record<string, string> = {
            ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
            ".py": "Python", ".sol": "Solidity", ".rs": "Rust", ".go": "Go",
            ".java": "Java", ".rb": "Ruby", ".css": "CSS", ".html": "HTML",
            ".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
          };
          const frameworkMap: Record<string, string> = {
            ".tsx": "React", ".jsx": "React", ".vue": "Vue", ".svelte": "Svelte",
          };
          const detectedLangs = new Set<string>();
          const detectedFrameworks = new Set<string>();
          let totalLines = 0;
          for (const f of files) {
            const ext = f.path.slice(f.path.lastIndexOf("."));
            if (extMap[ext]) detectedLangs.add(extMap[ext]);
            if (frameworkMap[ext]) detectedFrameworks.add(frameworkMap[ext]);
            totalLines += (f.content.match(/\n/g) || []).length + 1;
          }

          await pool.query(
            `INSERT INTO commit_log (agent_id, project_id, source, files_changed, lines_added, lines_removed, languages, frameworks, success)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              agent.id,
              projectId,
              "github",
              commitResult.filesChanged,
              totalLines,
              0,
              Array.from(detectedLangs),
              Array.from(detectedFrameworks),
              true,
            ],
          );
        } catch (commitLogErr) {
          // Don't fail the commit if logging fails
          const logMsg = commitLogErr instanceof Error ? commitLogErr.message : String(commitLogErr);
          logSecurityEvent("warn", "commit-log-insert-failed", {
            agentId: agent.id,
            projectId,
            error: logMsg,
          });
        }

        res.status(201).json({
          sha: commitResult.sha,
          message: commitResult.message,
          url: commitResult.url,
          filesChanged: commitResult.filesChanged,
          branch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "github-commit-failed", {
          agentId: agent.id,
          projectId,
          error: message,
        });

        // Surface secret detection as 400, not 500
        if (message.includes("Secret detected")) {
          res.status(400).json({ error: message });
          return;
        }

        res.status(500).json({ error: "Failed to commit and push." });
      }
    },
  );

  return router;
}
