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

export function createRuntimeRouter(
  pool: pg.Pool,
  hmacSecret: string,
  sessionManager: RuntimeSessionManager,
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

        res.status(201).json({
          sessionId,
          agentId: agent.id,
          address: agent.address,
          connectedAt,
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

  return router;
}
