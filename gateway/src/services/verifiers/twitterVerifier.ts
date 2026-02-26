/**
 * Twitter/X identity verification via OAuth 2.0.
 *
 * Verifies ownership of a Twitter account via OAuth 2.0 PKCE flow.
 * After OAuth callback, fetches user profile from Twitter API v2
 * to confirm the claimed handle matches.
 *
 * @module services/verifiers/twitterVerifier
 */

import { logSecurityEvent } from "../../middleware/auditLog.js";
import { exchangeTwitterCode, fetchTwitterProfile } from "./twitterApi.js";

export interface TwitterVerifyResult {
  verified: boolean;
  username?: string;
  displayName?: string;
  followersCount?: number;
  error?: string;
}

export class TwitterVerifier {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;

  constructor(clientId: string, clientSecret: string, callbackUrl: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
  }

  /**
   * Generate the OAuth 2.0 PKCE authorization URL for Twitter.
   */
  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: "users.read tweet.read",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange an OAuth code for an access token, then verify the user's identity.
   */
  async verifyCallback(
    code: string,
    codeVerifier: string,
    expectedUsername: string,
  ): Promise<TwitterVerifyResult> {
    try {
      const accessToken = await exchangeTwitterCode(
        this.clientId,
        this.clientSecret,
        code,
        codeVerifier,
        this.callbackUrl,
      );

      const profile = await fetchTwitterProfile(accessToken);

      // Verify username matches claim
      if (profile.username.toLowerCase() !== expectedUsername.toLowerCase()) {
        logSecurityEvent("warn", "twitter-verify-mismatch", {
          expected: expectedUsername,
          actual: profile.username,
        });
        return {
          verified: false,
          error: `Twitter handle mismatch: expected ${expectedUsername}, got ${profile.username}`,
        };
      }

      return {
        verified: true,
        username: profile.username,
        displayName: profile.name,
        followersCount: profile.followersCount,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("warn", "twitter-verify-error", { error: msg });
      return { verified: false, error: msg };
    }
  }
}
