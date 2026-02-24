/**
 * Twitter/X OAuth 2.0 authentication endpoints for frontend web users.
 *
 * Uses the PKCE redirect flow:
 *   1. GET /auth/twitter — generate PKCE pair, store session, redirect to Twitter
 *   2. GET /auth/twitter/callback — exchange code, upsert user, auto-create
 *      verified external claim, sign JWT, redirect back to frontend
 *
 * The frontend URL receives the token via URL fragment (never logged by servers).
 */

import crypto from "crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { exchangeTwitterCode, fetchTwitterProfile } from "../services/verifiers/twitterApi.js";

interface TwitterAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  jwtSecret: string;
  frontendUrl: string;
}

/**
 * Generate a PKCE code_verifier (43-128 chars, URL-safe).
 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Derive the code_challenge from a code_verifier using SHA-256.
 */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function createTwitterAuthRouter(pool: Pool, config: TwitterAuthConfig) {
  const router = Router();

  // -------------------------------------------------------
  //  GET /auth/twitter — Initiate OAuth (redirects browser)
  // -------------------------------------------------------
  router.get("/auth/twitter", async (_req, res) => {
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = crypto.randomBytes(32).toString("hex");

      // Store session (10-minute expiry)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query(
        `INSERT INTO twitter_auth_sessions (state, code_verifier, expires_at)
         VALUES ($1, $2, $3)`,
        [state, codeVerifier, expiresAt],
      );

      const params = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        scope: "users.read tweet.read",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
      res.redirect(authUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "twitter-auth-init-failed", { error: msg });
      res.redirect(`${config.frontendUrl}/auth/callback?error=init_failed`);
    }
  });

  // -------------------------------------------------------
  //  GET /auth/twitter/callback — Handle Twitter redirect
  // -------------------------------------------------------
  router.get("/auth/twitter/callback", async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    // Twitter may redirect with an error (e.g. user denied access)
    if (oauthError) {
      logSecurityEvent("info", "twitter-auth-denied", { error: oauthError });
      res.redirect(`${config.frontendUrl}/auth/callback?error=access_denied`);
      return;
    }

    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      res.redirect(`${config.frontendUrl}/auth/callback?error=missing_params`);
      return;
    }

    try {
      // Look up and atomically delete the session (prevents replay)
      const { rows: sessions } = await pool.query<{
        code_verifier: string;
        expires_at: Date;
      }>(
        `DELETE FROM twitter_auth_sessions
         WHERE state = $1
         RETURNING code_verifier, expires_at`,
        [state],
      );

      if (sessions.length === 0) {
        logSecurityEvent("warn", "twitter-auth-invalid-state", { state: state.slice(0, 16) });
        res.redirect(`${config.frontendUrl}/auth/callback?error=invalid_state`);
        return;
      }

      const session = sessions[0];
      if (new Date() > session.expires_at) {
        logSecurityEvent("info", "twitter-auth-expired-session", {});
        res.redirect(`${config.frontendUrl}/auth/callback?error=session_expired`);
        return;
      }

      // Exchange code for access token
      const accessToken = await exchangeTwitterCode(
        config.clientId,
        config.clientSecret,
        code,
        session.code_verifier,
        config.callbackUrl,
      );

      // Fetch Twitter profile
      const profile = await fetchTwitterProfile(accessToken);

      // Upsert into web_users (by twitter_id)
      const result = await pool.query(
        `INSERT INTO web_users (twitter_id, twitter_username, twitter_followers_count, auth_provider, name, picture)
         VALUES ($1, $2, $3, 'twitter', $4, $5)
         ON CONFLICT (twitter_id) DO UPDATE SET
           twitter_username = EXCLUDED.twitter_username,
           twitter_followers_count = EXCLUDED.twitter_followers_count,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           updated_at = NOW()
         RETURNING id, twitter_id, twitter_username, name, picture, wallet_address, linked_agent_id`,
        [
          profile.id,
          profile.username,
          profile.followersCount,
          profile.name,
          profile.profileImageUrl ?? null,
        ],
      );

      const user = result.rows[0];

      // Auto-create verified external claim (idempotent — ON CONFLICT updates)
      const influenceBoost = Math.min(20, Math.floor(profile.followersCount / 100));
      try {
        await pool.query(
          `INSERT INTO external_claims (
             agent_id, platform, external_id, claim_type,
             status, verification_method, verification_data,
             reputation_boost, verified_at
           ) VALUES (
             $1, 'twitter', $2, 'identity',
             'verified', 'oauth2_login', $3,
             $4, NOW()
           )
           ON CONFLICT (platform, external_id, claim_type) DO UPDATE SET
             verification_data = EXCLUDED.verification_data,
             reputation_boost = EXCLUDED.reputation_boost,
             updated_at = NOW()`,
          [
            user.linked_agent_id ?? null,
            profile.username.toLowerCase(),
            JSON.stringify({
              twitterId: profile.id,
              username: profile.username,
              followersCount: profile.followersCount,
              verifiedVia: "twitter_login",
              webUserId: user.id,
            }),
            JSON.stringify({
              influence: influenceBoost,
              trust: 5,
              source: "twitter_oauth_login",
            }),
          ],
        );
      } catch (claimErr) {
        // Non-fatal — user still gets a session even if claim fails
        const msg = claimErr instanceof Error ? claimErr.message : String(claimErr);
        logSecurityEvent("warn", "twitter-auth-claim-failed", { error: msg, userId: user.id });
      }

      // Sign 7-day JWT
      const token = jwt.sign(
        {
          sub: user.id,
          provider: "twitter",
          twitterUsername: profile.username,
          name: profile.name,
          picture: profile.profileImageUrl ?? null,
        },
        config.jwtSecret,
        { expiresIn: "7d" },
      );

      logSecurityEvent("info", "twitter-auth-success", {
        userId: user.id,
        twitterUsername: profile.username,
      });

      // Redirect with token in URL fragment (never logged by servers)
      res.redirect(
        `${config.frontendUrl}/auth/callback#token=${encodeURIComponent(token)}&provider=twitter`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "twitter-auth-callback-failed", { error: msg });
      res.redirect(`${config.frontendUrl}/auth/callback?error=auth_failed`);
    }
  });

  return router;
}
