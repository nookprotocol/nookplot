/**
 * Runtime session manager — tracks active agent connections.
 *
 * Manages the lifecycle of runtime sessions: creation, heartbeat
 * updates, disconnection, and presence queries. Cleans up stale
 * sessions that haven't sent a heartbeat within the timeout window.
 *
 * @module services/runtimeSessionManager
 */

import crypto from "crypto";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

export interface RuntimeSession {
  id: string;
  agentId: string;
  sessionId: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  metadata: Record<string, unknown>;
  disconnectedAt: Date | null;
}

export interface ActiveAgentPresence {
  agentId: string;
  address: string;
  displayName: string | null;
  /** SECURITY: sessionId intentionally omitted from presence to prevent session hijacking. */
  connectedAt: string;
  lastHeartbeat: string;
}

export class RuntimeSessionManager {
  private readonly pool: pg.Pool;
  private readonly sessionTimeoutMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool, sessionTimeoutMs = 120_000) {
    this.pool = pool;
    this.sessionTimeoutMs = sessionTimeoutMs;
  }

  /**
   * Create a new runtime session for an agent.
   * Disconnects any existing active session for the agent first.
   */
  async createSession(
    agentId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ sessionId: string; connectedAt: string }> {
    const sessionId = crypto.randomBytes(32).toString("hex");

    // Disconnect any existing active session for this agent
    await this.pool.query(
      `UPDATE runtime_sessions SET disconnected_at = NOW()
       WHERE agent_id = $1 AND disconnected_at IS NULL`,
      [agentId],
    );

    // Create new session
    const { rows } = await this.pool.query<{ connected_at: Date }>(
      `INSERT INTO runtime_sessions (agent_id, session_id, metadata)
       VALUES ($1, $2, $3)
       RETURNING connected_at`,
      [agentId, sessionId, JSON.stringify(metadata ?? {})],
    );

    logSecurityEvent("info", "runtime-session-created", {
      agentId,
      sessionId: sessionId.slice(0, 8) + "...",
    });

    return {
      sessionId,
      connectedAt: rows[0].connected_at.toISOString(),
    };
  }

  /**
   * Update the heartbeat timestamp for a session.
   */
  async heartbeat(sessionId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE runtime_sessions SET last_heartbeat = NOW()
       WHERE session_id = $1 AND disconnected_at IS NULL`,
      [sessionId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Disconnect a session.
   *
   * SECURITY: Requires agentId to verify ownership — prevents
   * any agent from disconnecting another agent's session.
   */
  async disconnect(sessionId: string, agentId?: string): Promise<boolean> {
    let query: string;
    let params: string[];

    if (agentId) {
      // Ownership-verified disconnect (used by route handlers)
      query = `UPDATE runtime_sessions SET disconnected_at = NOW()
               WHERE session_id = $1 AND agent_id = $2 AND disconnected_at IS NULL`;
      params = [sessionId, agentId];
    } else {
      // Internal use only (cleanup, stale session reaping)
      query = `UPDATE runtime_sessions SET disconnected_at = NOW()
               WHERE session_id = $1 AND disconnected_at IS NULL`;
      params = [sessionId];
    }

    const { rowCount } = await this.pool.query(query, params);
    if ((rowCount ?? 0) > 0) {
      logSecurityEvent("info", "runtime-session-disconnected", {
        sessionId: sessionId.slice(0, 8) + "...",
      });
    }
    return (rowCount ?? 0) > 0;
  }

  /**
   * Disconnect all sessions for an agent.
   */
  async disconnectAgent(agentId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE runtime_sessions SET disconnected_at = NOW()
       WHERE agent_id = $1 AND disconnected_at IS NULL`,
      [agentId],
    );
    return rowCount ?? 0;
  }

  /**
   * Get the active session for an agent (if any).
   */
  async getActiveSession(agentId: string): Promise<RuntimeSession | null> {
    const { rows } = await this.pool.query<{
      id: string;
      agent_id: string;
      session_id: string;
      connected_at: Date;
      last_heartbeat: Date;
      metadata: Record<string, unknown>;
      disconnected_at: Date | null;
    }>(
      `SELECT id, agent_id, session_id, connected_at, last_heartbeat, metadata, disconnected_at
       FROM runtime_sessions
       WHERE agent_id = $1 AND disconnected_at IS NULL
       ORDER BY connected_at DESC LIMIT 1`,
      [agentId],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      connectedAt: row.connected_at,
      lastHeartbeat: row.last_heartbeat,
      metadata: row.metadata,
      disconnectedAt: row.disconnected_at,
    };
  }

  /**
   * Get all currently connected agents with their presence info.
   */
  async getPresence(limit = 50, offset = 0): Promise<ActiveAgentPresence[]> {
    const { rows } = await this.pool.query<{
      agent_id: string;
      address: string;
      display_name: string | null;
      connected_at: Date;
      last_heartbeat: Date;
    }>(
      `SELECT rs.agent_id, a.address, a.display_name,
              rs.connected_at, rs.last_heartbeat
       FROM runtime_sessions rs
       JOIN agents a ON a.id = rs.agent_id
       WHERE rs.disconnected_at IS NULL
       ORDER BY rs.connected_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return rows.map((row) => ({
      agentId: row.agent_id,
      address: row.address,
      displayName: row.display_name,
      connectedAt: row.connected_at.toISOString(),
      lastHeartbeat: row.last_heartbeat.toISOString(),
    }));
  }

  /**
   * Get the count of currently connected agents.
   */
  async getActiveCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM runtime_sessions WHERE disconnected_at IS NULL`,
    );
    return parseInt(rows[0].count, 10);
  }

  /**
   * Clean up stale sessions that haven't sent a heartbeat within the timeout.
   */
  async cleanupStaleSessions(): Promise<number> {
    const timeoutDate = new Date(Date.now() - this.sessionTimeoutMs);
    const { rowCount } = await this.pool.query(
      `UPDATE runtime_sessions SET disconnected_at = NOW()
       WHERE disconnected_at IS NULL AND last_heartbeat < $1`,
      [timeoutDate],
    );
    const cleaned = rowCount ?? 0;
    if (cleaned > 0) {
      logSecurityEvent("info", "runtime-stale-sessions-cleaned", { count: cleaned });
    }
    return cleaned;
  }

  /**
   * Start periodic cleanup of stale sessions.
   */
  startCleanup(intervalMs = 60_000): void {
    this.stopCleanup();
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions().catch(() => {});
    }, intervalMs);
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
