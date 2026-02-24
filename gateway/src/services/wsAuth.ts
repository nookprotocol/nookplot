/**
 * WebSocket authentication for the Agent Gateway.
 *
 * Supports two auth methods:
 * 1. API key via `?token=nk_XXX` query param (for agents)
 * 2. One-time ticket via `?ticket=UUID` query param (for browsers)
 *
 * @module services/wsAuth
 */

import type pg from "pg";
import type { IncomingMessage } from "http";
import type { AgentRecord } from "../types.js";
import { hashApiKey, isValidApiKeyFormat } from "../auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Result of WebSocket authentication. */
export interface WsAuthResult {
  agent: AgentRecord;
}

/**
 * Authenticate an incoming WebSocket upgrade request.
 * Returns the agent record or null if auth fails.
 */
export async function authenticateWs(
  req: IncomingMessage,
  pool: pg.Pool,
  hmacSecret: string,
): Promise<WsAuthResult | null> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Method 1: API key token (DEPRECATED — use ticket-based auth instead)
  // Hard cutoff: reject after 2026-06-01
  const TOKEN_AUTH_CUTOFF = new Date("2026-06-01T00:00:00Z");
  const token = url.searchParams.get("token");
  if (token && isValidApiKeyFormat(token)) {
    if (new Date() >= TOKEN_AUTH_CUTOFF) {
      logSecurityEvent("warn", "ws-auth-token-param-rejected", {
        ip: req.socket.remoteAddress,
        message: "?token= query param auth has been disabled. Use ticket-based auth (POST /v1/ws/ticket).",
      });
      return null;
    }
    logSecurityEvent("warn", "ws-auth-deprecated-token-param", {
      ip: req.socket.remoteAddress,
      message: "Using ?token= query param is deprecated. Migrate to ticket-based auth (POST /v1/ws/ticket).",
    });
    const keyHash = hashApiKey(token, hmacSecret);
    const { rows } = await pool.query<AgentRecord>(
      "SELECT * FROM agents WHERE api_key_hash = $1 AND status IN ('active', 'exported')",
      [keyHash],
    );
    if (rows.length > 0) {
      return { agent: rows[0] };
    }
    logSecurityEvent("warn", "ws-auth-invalid-token", {
      ip: req.socket.remoteAddress,
    });
    return null;
  }

  // Method 2: One-time ticket
  const ticket = url.searchParams.get("ticket");
  if (ticket) {
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticket)) {
      return null;
    }

    const { rows } = await pool.query(
      `UPDATE ws_tickets SET used = TRUE
       WHERE id = $1 AND used = FALSE AND expires_at > NOW()
       RETURNING agent_id`,
      [ticket],
    );

    if (rows.length === 0) {
      logSecurityEvent("warn", "ws-auth-invalid-ticket", {
        ip: req.socket.remoteAddress,
      });
      return null;
    }

    const agentId = rows[0].agent_id;
    const { rows: agentRows } = await pool.query<AgentRecord>(
      "SELECT * FROM agents WHERE id = $1 AND status IN ('active', 'exported')",
      [agentId],
    );

    if (agentRows.length > 0) {
      return { agent: agentRows[0] };
    }
    return null;
  }

  logSecurityEvent("warn", "ws-auth-missing", {
    ip: req.socket.remoteAddress,
  });
  return null;
}
