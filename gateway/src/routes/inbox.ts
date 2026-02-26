/**
 * Agent inbox routes — direct messaging between agents.
 *
 * POST   /v1/inbox/send      — Send a message
 * GET    /v1/inbox            — List inbox messages
 * POST   /v1/inbox/:id/read  — Mark message as read
 * GET    /v1/inbox/unread     — Unread count
 * DELETE /v1/inbox/:id        — Delete a message
 *
 * @module routes/inbox
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { InboxService } from "../services/inboxService.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { MessageBus } from "../services/messageBus.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { ContentScanner } from "../services/contentScanner.js";
import { shouldQuarantine } from "../services/contentScanner.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { gatewayConfig } from "../config.js";

/** Allowed message types — prevents arbitrary type injection. */
const ALLOWED_MESSAGE_TYPES = new Set([
  "text",
  "system",
  "collaboration",
  "trade",
  "attestation",
  "proposal",
]);

/** Maximum metadata JSON size in bytes. */
const MAX_METADATA_SIZE = 4096;

export function createInboxRouter(
  pool: pg.Pool,
  hmacSecret: string,
  inboxService: InboxService,
  eventBroadcaster?: RuntimeEventBroadcaster,
  messageBus?: MessageBus,
  proactiveScheduler?: ProactiveScheduler,
  contentScanner?: ContentScanner,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/inbox/send
  //  Send a message to another agent.
  // -------------------------------------------------------
  router.post(
    "/inbox/send",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { to, messageType, content, metadata, signature } = req.body ?? {};

        if (!to || typeof to !== "string") {
          res.status(400).json({ error: "to is required (agent address)" });
          return;
        }
        if (!content || typeof content !== "string") {
          res.status(400).json({ error: "content is required (string)" });
          return;
        }
        if (content.length > 10_000) {
          res.status(400).json({ error: "content too long (max 10,000 chars)" });
          return;
        }

        // Look up recipient by address OR display name (case-insensitive).
        // Agents may pass an address ("0x9ebE...") or a name ("Kimmy").
        const { rows: recipientRows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)
           UNION
           SELECT id FROM agents WHERE LOWER(display_name) = LOWER($1)
           LIMIT 1`,
          [to],
        );
        if (recipientRows.length === 0) {
          res.status(404).json({ error: "Recipient agent not found" });
          return;
        }

        const toAgentId = recipientRows[0].id;

        // Prevent self-messaging
        if (toAgentId === agent.id) {
          res.status(400).json({ error: "Cannot send a message to yourself" });
          return;
        }

        // HIGH-2: Validate messageType against allowlist
        const resolvedType = typeof messageType === "string" ? messageType : "text";
        if (!ALLOWED_MESSAGE_TYPES.has(resolvedType)) {
          res.status(400).json({
            error: `Invalid messageType. Allowed: ${[...ALLOWED_MESSAGE_TYPES].join(", ")}`,
          });
          return;
        }

        // HIGH-3: Cap metadata size to prevent storage DoS
        let validatedMetadata: Record<string, unknown> | undefined;
        if (metadata && typeof metadata === "object") {
          const metadataStr = JSON.stringify(metadata);
          if (metadataStr.length > MAX_METADATA_SIZE) {
            res.status(400).json({ error: `metadata too large (max ${MAX_METADATA_SIZE} bytes)` });
            return;
          }
          validatedMetadata = metadata;
        }

        // Store signature in metadata if provided
        if (signature && typeof signature === "string") {
          validatedMetadata = { ...(validatedMetadata ?? {}), _signature: signature };
        }

        // Pre-persist content safety scan: block high-severity, quarantine medium
        let isQuarantined = false;
        if (contentScanner && gatewayConfig.contentScanBlockEnabled) {
          const { blocked, result: scanResult } = contentScanner.scanForBlocking(
            content,
            gatewayConfig.contentScanBlockThreshold,
          );
          if (blocked) {
            contentScanner.recordBlockedContent(agent.id, "dm", scanResult).catch(() => {});
            logSecurityEvent("warn", "inbox-send-blocked", {
              agentId: agent.id,
              threatLevel: scanResult.threatLevel,
              maxSeverity: scanResult.maxSeverity,
            });
            res.status(422).json({
              error: "Message blocked by safety scanner",
              threatLevel: scanResult.threatLevel,
            });
            return;
          }
          isQuarantined = shouldQuarantine(scanResult, gatewayConfig.contentScanBlockThreshold);
        }

        // Send the message
        const message = await inboxService.send({
          fromAgentId: agent.id,
          toAgentId,
          messageType: resolvedType,
          content,
          metadata: validatedMetadata,
          quarantined: isQuarantined,
        });

        // Fire-and-forget content safety scan — flags medium/low threats for admin review
        if (contentScanner) {
          contentScanner.scanAndRecord(agent.id, "dm", message.id, content).catch(() => {});
        }

        // Broadcast real-time event — prefer message bus, fall back to direct broadcast
        const dmEvent = {
          type: "message.received",
          timestamp: new Date().toISOString(),
          data: {
            messageId: message.id,
            from: agent.address,
            messageType: message.message_type,
            preview: content.slice(0, 200),
          },
        };

        if (messageBus) {
          messageBus.publish(`dm:${toAgentId}`, dmEvent);
        } else if (eventBroadcaster) {
          eventBroadcaster.broadcast(toAgentId, dmEvent);
        }

        // Emit reactive signal for proactive DM response
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(toAgentId, {
            signalType: "dm_received",
            senderId: agent.id,
            senderAddress: agent.address,
            messagePreview: content.slice(0, 300),
          }).catch(() => {}); // Best-effort — don't block response
        }

        res.status(201).json({
          id: message.id,
          to,
          messageType: message.message_type,
          createdAt: message.created_at,
        });
      } catch (err) {
        logSecurityEvent("error", "inbox-send-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to send message" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/inbox
  //  List inbox messages with pagination + filters.
  // -------------------------------------------------------
  router.get(
    "/inbox",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const from = req.query.from ? String(req.query.from) : undefined;
        const unreadOnly = req.query.unreadOnly === "true";
        const messageType = req.query.messageType ? String(req.query.messageType) : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        // If filtering by from address, resolve to agent ID
        let fromAgentId: string | undefined;
        if (from) {
          const { rows: fromRows } = await pool.query<{ id: string }>(
            "SELECT id FROM agents WHERE LOWER(address) = LOWER($1)",
            [from],
          );
          if (fromRows.length > 0) {
            fromAgentId = fromRows[0].id;
          } else {
            // No agent with that address — return empty
            res.json({ messages: [], limit, offset });
            return;
          }
        }

        const messages = await inboxService.getMessages(agent.id, {
          fromAgentId,
          unreadOnly,
          messageType,
          limit,
          offset,
        });

        // Enrich with sender addresses
        const agentIds = [...new Set(messages.map((m) => m.from_agent_id))];
        let addressMap = new Map<string, { address: string; display_name: string | null }>();
        if (agentIds.length > 0) {
          const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
          const { rows: agentRows } = await pool.query<{
            id: string; address: string; display_name: string | null;
          }>(
            `SELECT id, address, display_name FROM agents WHERE id IN (${placeholders})`,
            agentIds,
          );
          addressMap = new Map(agentRows.map((r) => [r.id, { address: r.address, display_name: r.display_name }]));
        }

        // Look up content safety flags for these messages (if scanner is active)
        let threatMap = new Map<string, { threatLevel: string }>();
        if (contentScanner && messages.length > 0) {
          try {
            const msgIds = messages.map((m) => m.id);
            const ph = msgIds.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: flagRows } = await pool.query<{ content_id: string; threat_level: string }>(
              `SELECT content_id, threat_level FROM content_threat_flags
               WHERE content_type = 'dm' AND content_id IN (${ph})`,
              msgIds,
            );
            threatMap = new Map(flagRows.map((r) => [r.content_id, { threatLevel: r.threat_level }]));
          } catch {
            // Non-fatal — safety annotations unavailable
          }
        }

        const enrichedMessages = messages.map((m) => {
          const sender = addressMap.get(m.from_agent_id);
          const flag = threatMap.get(m.id);
          return {
            id: m.id,
            from: sender?.address ?? "unknown",
            fromName: sender?.display_name ?? null,
            to: agent.address,
            messageType: m.message_type,
            content: m.content,
            metadata: m.metadata,
            readAt: m.read_at,
            createdAt: m.created_at,
            ...(contentScanner ? {
              _contentSafety: {
                scanned: !!flag,
                threatLevel: flag?.threatLevel ?? "none",
              },
            } : {}),
          };
        });

        res.json({ messages: enrichedMessages, limit, offset });
      } catch (err) {
        logSecurityEvent("error", "inbox-list-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to list messages" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/inbox/:id/read
  //  Mark a message as read.
  // -------------------------------------------------------
  router.post(
    "/inbox/:id/read",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const messageId = String(req.params.id);
        const updated = await inboxService.markRead(messageId, agent.id);

        if (!updated) {
          res.status(404).json({ error: "Message not found or already read" });
          return;
        }

        res.json({ success: true });
      } catch (err) {
        logSecurityEvent("error", "inbox-mark-read-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to mark message as read" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/inbox/unread
  //  Get unread message count.
  // -------------------------------------------------------
  router.get(
    "/inbox/unread",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const count = await inboxService.getUnreadCount(agent.id);
        res.json({ unreadCount: count });
      } catch (err) {
        logSecurityEvent("error", "inbox-unread-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get unread count" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/inbox/:id
  //  Delete a message from inbox.
  // -------------------------------------------------------
  router.delete(
    "/inbox/:id",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const messageId = String(req.params.id);
        const deleted = await inboxService.deleteMessage(messageId, agent.id);

        if (!deleted) {
          res.status(404).json({ error: "Message not found" });
          return;
        }

        res.json({ success: true });
      } catch (err) {
        logSecurityEvent("error", "inbox-delete-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to delete message" });
      }
    },
  );

  return router;
}
