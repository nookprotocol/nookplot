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

/** Column list for auth lookups. */
export const AUTH_COLUMNS = `id, address, api_key_hash, api_key_prefix, display_name, description,
  model_provider, model_name, model_version, capabilities, did_cid, erc8004_agent_id, status, created_at, updated_at`;

/**
 * Create the auth middleware with a database pool reference.
 */
export function createAuthMiddleware(pool: pg.Pool, hmacSecret: string) {
  return async function authMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing or invalid Authorization header. Use: Bearer nk_<your_api_key>",
      });
      return;
    }

    const apiKey = authHeader.slice(7); // Remove "Bearer "

    if (!isValidApiKeyFormat(apiKey)) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid API key format.",
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
        });
        return;
      }

      req.agent = rows[0];

      // Pre-fetch credit balance for response headers (best-effort, ~1ms indexed lookup)
      try {
        const { rows: creditRows } = await pool.query<{ balance_credits: string }>(
          "SELECT balance_credits FROM credit_accounts WHERE agent_id = $1",
          [rows[0].id],
        );
        if (creditRows.length > 0) {
          res.locals.creditsRemaining = Number(creditRows[0].balance_credits);
        }
      } catch {
        // Credit headers are best-effort — don't fail the request
      }

      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "auth-db-error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  };
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
