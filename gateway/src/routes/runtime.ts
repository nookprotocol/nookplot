/**
 * Runtime session routes.
 *
 * POST   /v1/runtime/connect     — Establish a runtime session
 * POST   /v1/runtime/disconnect  — End a runtime session
 * GET    /v1/runtime/status      — Get current agent status + session info
 * POST   /v1/runtime/heartbeat   — Manual heartbeat (WS heartbeat is preferred)
 * GET    /v1/runtime/presence    — List currently connected agents
 *
 * @module routes/runtime
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { RuntimeSessionManager } from "../services/runtimeSessionManager.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// -------------------------------------------------------
//  Version comparison helpers (exported for testing)
// -------------------------------------------------------

export interface ConnectNotice {
  type: "deprecation_warning" | "update_available";
  severity: "warning" | "info";
  message: string;
}

export interface ClientVersionPolicy {
  minRuntime: string;
  latestRuntime: string;
  minRuntimePy: string;
  latestRuntimePy: string;
  minCli: string;
  latestCli: string;
}

/**
 * Compare two MAJOR.MINOR.PATCH semver strings.
 * Returns true if `a` is strictly less than `b`.
 */
export function semverLt(a: string, b: string): boolean {
  const parse = (v: string) => {
    const parts = v.replace(/^v/, "").split(".");
    return {
      major: parseInt(parts[0], 10) || 0,
      minor: parseInt(parts[1], 10) || 0,
      patch: parseInt(parts[2], 10) || 0,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.major !== pb.major) return pa.major < pb.major;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor;
  return pa.patch < pb.patch;
}

/**
 * Compute notices for a connecting client based on its version.
 */
export function computeNotices(
  clientName: string,
  clientVersion: string | undefined,
  minVersion: string,
  latestVersion: string,
  updateCmd: string,
): ConnectNotice[] {
  if (!clientVersion) return [];

  const notices: ConnectNotice[] = [];

  // Check deprecation (below minimum)
  if (minVersion !== "0.0.0" && semverLt(clientVersion, minVersion)) {
    notices.push({
      type: "deprecation_warning",
      severity: "warning",
      message: `${clientName} ${clientVersion} is deprecated (minimum: ${minVersion}). Please update: ${updateCmd}`,
    });
  }
  // Check if update available (below latest, but not already deprecated)
  else if (latestVersion !== "0.0.0" && semverLt(clientVersion, latestVersion)) {
    notices.push({
      type: "update_available",
      severity: "info",
      message: `Update available: ${clientName} ${clientVersion} → ${latestVersion}. Run: ${updateCmd}`,
    });
  }

  return notices;
}

export function createRuntimeRouter(
  pool: pg.Pool,
  hmacSecret: string,
  sessionManager: RuntimeSessionManager,
  gatewayVersion: string,
  clientVersionPolicy: ClientVersionPolicy,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/runtime/connect
  // -------------------------------------------------------
  router.post(
    "/runtime/connect",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const rawMetadata = typeof req.body?.metadata === "object" ? req.body.metadata : {};
        // HIGH-3: Cap metadata size to prevent storage DoS
        const metadataStr = JSON.stringify(rawMetadata);
        if (metadataStr.length > 8192) {
          res.status(400).json({ error: "metadata too large (max 8KB)" });
          return;
        }
        const metadata = rawMetadata;
        const { sessionId, connectedAt } = await sessionManager.createSession(
          agent.id,
          metadata,
        );

        // Version exchange — build notices based on client identity
        const clientVersion = typeof req.body?.clientVersion === "string" ? req.body.clientVersion : undefined;
        const clientName = typeof req.body?.clientName === "string" ? req.body.clientName : undefined;

        let notices: ConnectNotice[] = [];
        if (clientName && clientVersion) {
          const p = clientVersionPolicy;
          if (clientName === "@nookplot/runtime") {
            notices = computeNotices(clientName, clientVersion, p.minRuntime, p.latestRuntime, "npm update @nookplot/runtime");
          } else if (clientName === "nookplot-runtime") {
            notices = computeNotices(clientName, clientVersion, p.minRuntimePy, p.latestRuntimePy, "pip install --upgrade nookplot-runtime");
          } else if (clientName === "@nookplot/cli") {
            notices = computeNotices(clientName, clientVersion, p.minCli, p.latestCli, "npm update -g @nookplot/cli");
          }
        }

        res.status(201).json({
          sessionId,
          agentId: agent.id,
          address: agent.address,
          connectedAt,
          gatewayVersion,
          notices,
        });
      } catch (err) {
        logSecurityEvent("error", "runtime-connect-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to create runtime session" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/runtime/disconnect
  // -------------------------------------------------------
  router.post(
    "/runtime/disconnect",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { sessionId } = req.body ?? {};

        if (sessionId && typeof sessionId === "string") {
          // Disconnect specific session — pass agent.id for ownership check
          const success = await sessionManager.disconnect(sessionId, agent.id);
          if (!success) {
            res.status(404).json({ error: "Session not found or already disconnected" });
            return;
          }
        } else {
          // Disconnect all sessions for this agent
          await sessionManager.disconnectAgent(agent.id);
        }

        res.json({ success: true });
      } catch (err) {
        logSecurityEvent("error", "runtime-disconnect-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to disconnect runtime session" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/runtime/status
  // -------------------------------------------------------
  router.get(
    "/runtime/status",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const session = await sessionManager.getActiveSession(agent.id);

        res.json({
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          status: agent.status,
          session: session
            ? {
                sessionId: session.sessionId,
                connectedAt: session.connectedAt.toISOString(),
                lastHeartbeat: session.lastHeartbeat.toISOString(),
              }
            : null,
        });
      } catch (err) {
        logSecurityEvent("error", "runtime-status-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get runtime status" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/runtime/heartbeat
  // -------------------------------------------------------
  router.post(
    "/runtime/heartbeat",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const session = await sessionManager.getActiveSession(agent.id);
        if (!session) {
          res.status(404).json({ error: "No active session. Call POST /v1/runtime/connect first." });
          return;
        }

        const success = await sessionManager.heartbeat(session.sessionId);
        if (!success) {
          res.status(404).json({ error: "Session expired. Reconnect required." });
          return;
        }

        res.json({ success: true, lastHeartbeat: new Date().toISOString() });
      } catch (err) {
        logSecurityEvent("error", "runtime-heartbeat-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Heartbeat failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/runtime/presence
  // -------------------------------------------------------
  router.get(
    "/runtime/presence",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
        const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

        const presence = await sessionManager.getPresence(limit, offset);
        const total = await sessionManager.getActiveCount();

        res.json({ agents: presence, total, limit, offset });
      } catch (err) {
        logSecurityEvent("error", "runtime-presence-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get presence" });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/runtime/availability — Set availability status
  // -------------------------------------------------------
  router.patch(
    "/runtime/availability",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { availability } = req.body ?? {};
        const VALID_STATUSES = ["accepting_work", "busy", "offline"];

        if (!availability || !VALID_STATUSES.includes(availability)) {
          res.status(400).json({
            error: `availability must be one of: ${VALID_STATUSES.join(", ")}`,
          });
          return;
        }

        // Update the metadata on the active session
        const session = await sessionManager.getActiveSession(agent.id);
        if (!session) {
          res.status(404).json({ error: "No active session. Call POST /v1/runtime/connect first." });
          return;
        }

        // Merge availability into session metadata
        await pool.query(
          `UPDATE runtime_sessions
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
           WHERE id = $2 AND agent_id = $3`,
          [JSON.stringify({ availability }), session.sessionId, agent.id],
        );

        res.json({ success: true, availability });
      } catch (err) {
        logSecurityEvent("error", "runtime-availability-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to update availability" });
      }
    },
  );

  return router;
}
