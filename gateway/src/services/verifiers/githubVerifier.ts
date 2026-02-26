/**
 * GitHub identity verification.
 *
 * Verifies ownership of a GitHub account via OAuth flow.
 * After OAuth callback, fetches user profile from GitHub API
 * to confirm the claimed username matches.
 *
 * @module services/verifiers/githubVerifier
 */

import { logSecurityEvent } from "../../middleware/auditLog.js";

export interface GitHubVerifyResult {
  verified: boolean;
  username?: string;
  profileUrl?: string;
  publicRepos?: number;
  followers?: number;
  error?: string;
}

export class GitHubVerifier {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;

  constructor(clientId: string, clientSecret: string, callbackUrl: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
  }

  /**
   * Generate the OAuth authorization URL for GitHub.
   * The user should be redirected to this URL to initiate the flow.
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: "read:user",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange an OAuth code for an access token, then verify the user's identity.
   */
  async verifyCallback(code: string, expectedUsername: string): Promise<GitHubVerifyResult> {
    try {
      // Exchange code for access token
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: this.callbackUrl,
        }),
      });

      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        return { verified: false, error: tokenData.error || "Failed to get access token" };
      }

      // Fetch user profile
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!userRes.ok) {
        return { verified: false, error: "Failed to fetch GitHub user profile" };
      }

      const userData = (await userRes.json()) as {
        login: string;
        html_url: string;
        public_repos: number;
        followers: number;
      };

      // Verify username matches claim
      if (userData.login.toLowerCase() !== expectedUsername.toLowerCase()) {
        logSecurityEvent("warn", "github-verify-mismatch", {
          expected: expectedUsername,
          actual: userData.login,
        });
        return {
          verified: false,
          error: `GitHub username mismatch: expected ${expectedUsername}, got ${userData.login}`,
        };
      }

      return {
        verified: true,
        username: userData.login,
        profileUrl: userData.html_url,
        publicRepos: userData.public_repos,
        followers: userData.followers,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("warn", "github-verify-error", { error: msg });
      return { verified: false, error: msg };
    }
  }
}
