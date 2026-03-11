/**
 * GitHub Knowledge routes.
 *
 * Handles GitHub OAuth connection, repo import, sync,
 * trending browse, project claiming, and README content.
 *
 * POST   /v1/github/connect-oauth           — Start OAuth flow
 * GET    /v1/github/oauth/callback           — OAuth callback
 * GET    /v1/github/repos                    — List user's repos [auth]
 * POST   /v1/github/import                   — Import selected repos [auth]
 * POST   /v1/github/import/:projectId/sync   — Force re-sync [auth, owner]
 * GET    /v1/github/knowledge/trending       — Browse auto-curated [public]
 * POST   /v1/github/knowledge/:projectId/claim — Claim unclaimed project [auth]
 * GET    /v1/github/knowledge/:projectId/readme — Get README content [public]
 *
 * @module routes/githubKnowledge
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import crypto from "crypto";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { GitHubKnowledgeService } from "../services/githubKnowledgeService.js";
import { gatewayConfig } from "../config.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// In-memory state store for OAuth flows (short-lived, keyed by random state)
const oauthStates = new Map<string, { agentId: string; createdAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createGithubKnowledgeRouter(
  pool: pg.Pool,
  hmacSecret: string,
  knowledgeService: GitHubKnowledgeService,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool, hmacSecret);

  // ------------------------------------------------------------------
  //  OAuth Flow
  // ------------------------------------------------------------------

  /**
   * POST /v1/github/connect-oauth
   * Start GitHub OAuth flow. Returns the redirect URL.
   */
  router.post("/github/connect-oauth", auth, async (req: Request, res: Response) => {
    try {
      const agent = (req as AuthenticatedRequest).agent;
      if (!agent) return res.status(401).json({ error: "Authentication required" });

      if (!gatewayConfig.githubClientId || !gatewayConfig.githubClientSecret) {
        return res.status(503).json({ error: "GitHub OAuth not configured" });
      }

      // Generate state token
      const state = crypto.randomBytes(32).toString("hex");
      oauthStates.set(state, { agentId: agent.id, createdAt: Date.now() });

      // Clean up expired states
      for (const [key, val] of oauthStates) {
        if (Date.now() - val.createdAt > STATE_TTL_MS) oauthStates.delete(key);
      }

      const params = new URLSearchParams({
        client_id: gatewayConfig.githubClientId,
        redirect_uri: gatewayConfig.githubCallbackUrl || `${req.protocol}://${req.get("host")}/v1/github/oauth/callback`,
        scope: "read:user,repo",
        state,
      });

      return res.json({
        redirectUrl: `https://github.com/login/oauth/authorize?${params.toString()}`,
      });
    } catch (err) {
      logSecurityEvent("error", "github-oauth-start-failed", { error: String(err) });
      return res.status(500).json({ error: "Failed to start OAuth flow" });
    }
  });

  /**
   * GET /v1/github/oauth/callback
   * OAuth callback — exchange code for token, store encrypted.
   */
  router.get("/github/oauth/callback", async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };

      if (!code || !state) {
        return res.status(400).json({ error: "Missing code or state parameter" });
      }

      const storedState = oauthStates.get(state);
      if (!storedState || Date.now() - storedState.createdAt > STATE_TTL_MS) {
        oauthStates.delete(state ?? "");
        return res.status(400).json({ error: "Invalid or expired state" });
      }

      oauthStates.delete(state);

      // Exchange code for access token
      const tokenRes = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: gatewayConfig.githubClientId,
          client_secret: gatewayConfig.githubClientSecret,
          code,
        }),
        timeoutMs: 10_000,
      });

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
      };

      if (!tokenData.access_token) {
        return res.status(400).json({ error: tokenData.error || "Failed to get access token" });
      }

      // Fetch user profile
      const userRes = await fetchWithTimeout("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github.v3+json",
        },
        timeoutMs: 10_000,
      });

      if (!userRes.ok) {
        return res.status(500).json({ error: "Failed to fetch GitHub profile" });
      }

      const userData = (await userRes.json()) as { login: string; id: number };

      // Store encrypted token
      await knowledgeService.storeOAuthToken(
        storedState.agentId,
        null,
        userData.login,
        String(userData.id),
        tokenData.access_token,
        tokenData.scope ?? "",
      );

      logSecurityEvent("info", "github-oauth-connected", {
        agentId: storedState.agentId,
        githubUsername: userData.login,
      });

      // Redirect to frontend success page
      return res.redirect(`${req.protocol}://${req.get("host")}/../github?connected=true`);
    } catch (err) {
      logSecurityEvent("error", "github-oauth-callback-failed", { error: String(err) });
      return res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  // ------------------------------------------------------------------
  //  Repo Listing & Import
  // ------------------------------------------------------------------

  /**
   * GET /v1/github/repos
   * List authenticated user's GitHub repos (requires connected GitHub).
   */
  router.get("/github/repos", auth, async (req: Request, res: Response) => {
    try {
      const agent = (req as AuthenticatedRequest).agent;
      if (!agent) return res.status(401).json({ error: "Authentication required" });

      const tokenInfo = await knowledgeService.getOAuthToken(agent.id);
      if (!tokenInfo) {
        return res.status(400).json({ error: "GitHub not connected. Use POST /v1/github/connect-oauth first." });
      }

      const { GitHubClient } = await import("../services/githubClient.js");
      const client = new GitHubClient(gatewayConfig.secretEncryptionKey);
      const repos = await client.listUserRepos(tokenInfo.token, "updated", 100);

      return res.json({ repos, username: tokenInfo.username });
    } catch (err) {
      logSecurityEvent("error", "github-repos-list-failed", { error: String(err) });
      return res.status(500).json({ error: "Failed to list GitHub repos" });
    }
  });

  /**
   * POST /v1/github/import
   * Import selected GitHub repos as projects.
   * Body: { repos: [{ owner: string, repo: string }, ...] }
   */
  router.post("/github/import", auth, async (req: Request, res: Response) => {
    try {
      const agent = (req as AuthenticatedRequest).agent;
      if (!agent) return res.status(401).json({ error: "Authentication required" });

      const { repos } = req.body as { repos?: Array<{ owner: string; repo: string }> };
      if (!repos || !Array.isArray(repos) || repos.length === 0) {
        return res.status(400).json({ error: "repos array is required" });
      }

      if (repos.length > 20) {
        return res.status(400).json({ error: "Maximum 20 repos per import" });
      }

      // Validate repo entries
      for (const r of repos) {
        if (!r.owner || !r.repo || typeof r.owner !== "string" || typeof r.repo !== "string") {
          return res.status(400).json({ error: "Each repo must have owner and repo strings" });
        }
      }

      // Get OAuth token if available
      const tokenInfo = await knowledgeService.getOAuthToken(agent.id);
      const results = await knowledgeService.importMultipleRepos(
        agent.id,
        repos,
        tokenInfo?.token,
      );

      // Auto-create repo watches for imported repos
      for (const result of results) {
        if (result.isNew) {
          try {
            await pool.query(
              `INSERT INTO github_repo_watches (agent_id, github_owner, github_repo)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [agent.id, result.name.split("/")[0], result.name.split("/")[1]],
            );
          } catch {
            // Non-critical — watch creation is best-effort
          }
        }
      }

      return res.json({ results });
    } catch (err) {
      logSecurityEvent("error", "github-import-failed", { error: String(err) });
      return res.status(500).json({ error: "Import failed" });
    }
  });

  /**
   * POST /v1/github/import/:projectId/sync
   * Force re-sync a specific project's GitHub data.
   */
  router.post("/github/import/:projectId/sync", auth, async (req: Request, res: Response) => {
    try {
      const agent = (req as AuthenticatedRequest).agent;
      if (!agent) return res.status(401).json({ error: "Authentication required" });

      const { projectId } = req.params;

      // Verify ownership
      const { rows } = await pool.query(
        `SELECT id FROM projects WHERE project_id = $1 AND agent_id = $2 AND status = 'active'`,
        [projectId, agent.id],
      );
      if (rows.length === 0) {
        return res.status(403).json({ error: "Project not found or not owned by you" });
      }

      const result = await knowledgeService.syncProject(projectId as string);
      return res.json(result);
    } catch (err) {
      logSecurityEvent("error", "github-sync-failed", { error: String(err) });
      return res.status(500).json({ error: "Sync failed" });
    }
  });

  // ------------------------------------------------------------------
  //  Public Browsing
  // ------------------------------------------------------------------

  /**
   * GET /v1/github/knowledge/trending
   * Browse auto-curated and imported GitHub repos.
   * Query params: limit, offset, category
   */
  router.get("/github/knowledge/trending", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const category = req.query.category as string | undefined;

      const result = await knowledgeService.getTrending(limit, offset, category);
      return res.json({ ...result, limit, offset });
    } catch (err) {
      logSecurityEvent("error", "github-trending-failed", { error: String(err) });
      return res.status(500).json({ error: "Failed to fetch trending repos" });
    }
  });

  /**
   * POST /v1/github/knowledge/:projectId/claim
   * Claim an unclaimed auto-curated project.
   */
  router.post("/github/knowledge/:projectId/claim", auth, async (req: Request, res: Response) => {
    try {
      const agent = (req as AuthenticatedRequest).agent;
      if (!agent) return res.status(401).json({ error: "Authentication required" });

      const { projectId } = req.params;
      const { githubUsername } = req.body as { githubUsername?: string };

      if (!githubUsername) {
        return res.status(400).json({ error: "githubUsername is required" });
      }

      const result = await knowledgeService.claimProject(agent.id, projectId as string, githubUsername);

      if (!result.success) {
        return res.status(400).json({ error: result.reason });
      }

      return res.json({ success: true, projectId });
    } catch (err) {
      logSecurityEvent("error", "github-claim-failed", { error: String(err) });
      return res.status(500).json({ error: "Claim failed" });
    }
  });

  /**
   * GET /v1/github/knowledge/:projectId/readme
   * Get README content for a GitHub-sourced project.
   */
  router.get("/github/knowledge/:projectId/readme", async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const content = await knowledgeService.getReadmeContent(projectId as string);

      if (content === null) {
        return res.status(404).json({ error: "README not found for this project" });
      }

      return res.json({ projectId, content });
    } catch (err) {
      logSecurityEvent("error", "github-readme-failed", { error: String(err) });
      return res.status(500).json({ error: "Failed to fetch README" });
    }
  });

  return router;
}
