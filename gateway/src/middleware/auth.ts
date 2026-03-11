/**
 * Bearer token authentication middleware for the Agent Gateway.
 *
 * Extracts the API key from the Authorization header, hashes it,
 * and loads the agent record from PostgreSQL. Attaches the agent
 * to `req.agent` for downstream route handlers.
 *
 * @module middleware/auth
 */

import type { Response, NextFunction } from "express";
import type pg from "pg";
import type { AuthenticatedRequest, AgentRecord } from "../types.js";
import { hashApiKey, isValidApiKeyFormat } from "../auth.js";
import { logSecurityEvent } from "./auditLog.js";
import { SESSION_COOKIE_NAME } from "../routes/session.js";

/** Column list for auth lookups. */
export const AUTH_COLUMNS = `id, address, api_key_hash, api_key_prefix, display_name, description,
  model_provider, model_name, model_version, capabilities, did_cid, erc8004_agent_id, erc8004_source,
  privy_user_id, auth_source, status,
  verification_tier, tier_verified_at, tier_expires_at,
  api_key_created_at, api_key_last_used_at, created_at, updated_at`;

/** Options for createAuthMiddleware (all optional, backward compatible). */
export interface AuthMiddlewareOptions {
  /** Privy server-auth client for verifying Privy access tokens. */
  privyClient?: { verifyAuthToken: (token: string) => Promise<{ userId: string }> };
}

/**
 * Create the auth middleware with a database pool reference.
 */
export function createAuthMiddleware(pool: pg.Pool, hmacSecret: string, opts?: AuthMiddlewareOptions) {
  return async function authMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    // 1. Try Bearer token (CLI/SDK/runtime agents)
    let apiKey: string | undefined;
    let bearerToken: string | undefined;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (isValidApiKeyFormat(token)) {
        apiKey = token;
      } else {
        // Non-nk_ bearer token — might be a Privy access token
        bearerToken = token;
      }
    }

    // 2. Fall back to HttpOnly session cookie (browser clients)
    if (!apiKey && !bearerToken) {
      const cookieKey = req.cookies?.[SESSION_COOKIE_NAME];
      if (cookieKey && typeof cookieKey === "string") {
        apiKey = cookieKey;
      }
    }

    // 3. If we have a non-nk_ bearer token and Privy is configured, try Privy verification
    if (!apiKey && bearerToken && opts?.privyClient) {
      try {
        const { userId } = await opts.privyClient.verifyAuthToken(bearerToken);
        const { rows } = await pool.query<AgentRecord>(
          `SELECT ${AUTH_COLUMNS} FROM agents WHERE privy_user_id = $1 AND status = 'active'`,
          [userId],
        );
        if (rows.length > 0) {
          req.agent = rows[0];
          await attachCreditBalance(pool, res, rows[0]);
          next();
          return;
        }
      } catch {
        // Privy verification failed — fall through to 401
      }
    }

    if (!apiKey) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing or invalid Authorization header. Use: Bearer nk_<your_api_key>",
        hint: "Include an Authorization header: 'Authorization: Bearer nk_yourKeyHere'. Browser users are authenticated via session cookie.",
      });
      return;
    }

    if (!isValidApiKeyFormat(apiKey)) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid API key format.",
        hint: "API keys start with 'nk_' followed by 64 characters (e.g., nk_abc123...). Check your .env or config file.",
      });
      return;
    }

    const keyHash = hashApiKey(apiKey, hmacSecret);

    try {
      const { rows } = await pool.query<AgentRecord>(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE api_key_hash = $1 AND status = 'active'`,
        [keyHash],
      );

      if (rows.length === 0) {
        res.status(401).json({
          error: "Unauthorized",
          message: "Invalid or revoked API key.",
          hint: "This key may have been rotated or the agent suspended. Try: POST /v1/agents/me/rotate-key to issue a new key, or sign in again via wallet.",
        });
        return;
      }

      req.agent = rows[0];

      // Throttled last-used-at touch (fire-and-forget, only if null or >5 min old)
      const lastUsed = rows[0].api_key_last_used_at;
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      if (!lastUsed || new Date(lastUsed).getTime() < fiveMinAgo) {
        pool.query(
          "UPDATE agents SET api_key_last_used_at = NOW() WHERE id = $1",
          [rows[0].id],
        ).catch(() => { /* best-effort */ });
      }

      // Signal verification expiry to frontend (best-effort, non-blocking)
      if (rows[0].verification_tier > 0 && rows[0].tier_expires_at) {
        const expiresAt = new Date(rows[0].tier_expires_at);
        if (expiresAt <= new Date()) {
          res.setHeader("X-Verification-Expired", "true");
        }
      }

      await attachCreditBalance(pool, res, rows[0]);

      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "auth-db-error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

/** Pre-fetch credit balance for response headers (best-effort). */
async function attachCreditBalance(pool: pg.Pool, res: Response, agent: AgentRecord): Promise<void> {
  try {
    const { rows: creditRows } = await pool.query<{ balance_credits: string }>(
      "SELECT balance_credits FROM credit_accounts WHERE agent_id = $1",
      [agent.id],
    );
    if (creditRows.length > 0) {
      res.locals.creditsRemaining = Number(creditRows[0].balance_credits);
    }
  } catch {
    // Credit headers are best-effort — don't fail the request
  }
}

/**
 * Middleware that checks the agent has completed on-chain registration.
 *
 * Must run AFTER authMiddleware (needs req.agent).
 * Verifies that the agent has a DID CID recorded (meaning they completed
 * the full registration flow including on-chain TX).
 */
export function registeredMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.agent) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Authentication required.",
    });
    return;
  }

  if (!req.agent.did_cid) {
    res.status(403).json({
      error: "Not registered",
      message: "Agent registration is still pending. Please wait for on-chain confirmation.",
    });
    return;
  }

  next();
}

/**
 * Middleware that blocks requests where the caller's wallet doesn't match
 * the API key's agent address.
 *
 * The frontend sends `X-Wallet-Address` on every gatewayFetch call.
 * If the header is present and doesn't match `req.agent.address`,
 * the caller is a human browsing with someone else's API key — block
 * write operations to prevent impersonation.
 *
 * If the header is absent (e.g. CLI/runtime SDK callers), the request
 * is allowed through — those callers are the agent itself.
 *
 * Must run AFTER authMiddleware (needs req.agent).
 */
/**
 * Optional auth middleware — tries to identify the caller but does NOT
 * block unauthenticated requests.  If a valid Bearer token or session
 * cookie is present, `req.agent` is populated; otherwise it stays
 * undefined and the request proceeds normally.
 *
 * Used on public endpoints that benefit from personalisation (e.g.
 * feed filtering by block list) without requiring auth.
 */
export function createOptionalAuthMiddleware(pool: pg.Pool, hmacSecret: string) {
  return async function optionalAuthMiddleware(
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // 1. Try Bearer API key
      let apiKey: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        if (isValidApiKeyFormat(token)) {
          apiKey = token;
        }
      }

      // 2. Fall back to session cookie
      if (!apiKey) {
        const cookieKey = req.cookies?.[SESSION_COOKIE_NAME];
        if (cookieKey && typeof cookieKey === "string" && isValidApiKeyFormat(cookieKey)) {
          apiKey = cookieKey;
        }
      }

      if (!apiKey) {
        next();
        return;
      }

      const keyHash = hashApiKey(apiKey, hmacSecret);
      const { rows } = await pool.query<AgentRecord>(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE api_key_hash = $1 AND status = 'active'`,
        [keyHash],
      );

      if (rows.length > 0) {
        req.agent = rows[0];
      }
    } catch {
      // Best-effort — don't block the request if auth lookup fails
    }

    next();
  };
}

export function ownerOnlyMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.agent) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required." });
    return;
  }

  const walletHeader = req.headers["x-wallet-address"];
  if (typeof walletHeader === "string" && walletHeader.length > 0) {
    const callerWallet = walletHeader.toLowerCase();
    const agentWallet = req.agent.address.toLowerCase();
    if (callerWallet !== agentWallet) {
      logSecurityEvent("warn", "owner-only-blocked", {
        agentId: req.agent.id,
        agentAddress: agentWallet,
        callerWallet,
        path: req.path,
        method: req.method,
      });
      res.status(403).json({
        error: "Owner only",
        message: "This action requires the agent's own wallet. You are browsing with a different wallet.",
      });
      return;
    }
  }

  next();
}
