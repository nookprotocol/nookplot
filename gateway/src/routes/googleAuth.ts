/**
 * Google OAuth authentication endpoint for frontend web users.
 *
 * Receives a Google access_token from the frontend (via @react-oauth/google
 * implicit flow), validates it by calling Google's userinfo endpoint,
 * upserts into web_users, and returns a Nookplot session JWT for browsing.
 * On-chain actions still require a connected wallet.
 */

import { Router } from "express";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

interface GoogleAuthConfig {
  googleClientId: string;
  googleAuthJwtSecret: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export function createGoogleAuthRouter(pool: Pool, config: GoogleAuthConfig) {
  const router = Router();

  router.post("/auth/google", async (req, res) => {
    try {
      const { credential } = req.body;
      if (!credential || typeof credential !== "string") {
        return res.status(400).json({ error: "Missing credential" });
      }

      // Validate the access token by calling Google's userinfo endpoint
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${credential}` },
      });

      if (!userInfoRes.ok) {
        return res.status(401).json({ error: "Invalid Google token" });
      }

      const userInfo = (await userInfoRes.json()) as GoogleUserInfo;
      if (!userInfo.sub) {
        return res.status(401).json({ error: "Invalid Google token" });
      }

      const { sub: googleId, email, name, picture } = userInfo;

      // Upsert into web_users
      const result = await pool.query(
        `INSERT INTO web_users (google_id, email, name, picture)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_id) DO UPDATE SET
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           updated_at = NOW()
         RETURNING id, google_id, email, name, picture, wallet_address`,
        [googleId, email ?? null, name ?? null, picture ?? null],
      );

      const user = result.rows[0];

      // Sign a session JWT (7-day expiry)
      const token = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
        },
        config.googleAuthJwtSecret,
        { expiresIn: "7d" },
      );

      logSecurityEvent("info", "google-auth-success", {
        userId: user.id,
        email: user.email,
      });

      return res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSecurityEvent("warn", "google-auth-failed", { error: message });
      return res.status(401).json({ error: "Google authentication failed" });
    }
  });

  return router;
}
