/**
 * WebSocket ticket endpoint for browser authentication.
 *
 * POST /v1/ws/ticket — Returns a one-time-use ticket UUID
 * that can be used to authenticate a WebSocket connection.
 * Tickets expire after 30 seconds.
 *
 * @module routes/wsTicket
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createWsTicketRouter(pool: pg.Pool, hmacSecret: string): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  router.post(
    "/ws/ticket",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        // Clean up expired tickets for this agent
        await pool.query(
          "DELETE FROM ws_tickets WHERE agent_id = $1 AND (used = TRUE OR expires_at < NOW())",
          [agent.id],
        );

        // Create new ticket (expires in 30 seconds)
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO ws_tickets (agent_id, expires_at)
           VALUES ($1, NOW() + INTERVAL '30 seconds')
           RETURNING id`,
          [agent.id],
        );

        const ticketId = rows[0].id;

        logSecurityEvent("debug", "ws-ticket-created", {
          agentId: agent.id,
          ticketId,
        });

        res.json({ ticket: ticketId, expiresIn: 30 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "ws-ticket-failed", {
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: "Failed to create WebSocket ticket." });
      }
    },
  );

  return router;
}
