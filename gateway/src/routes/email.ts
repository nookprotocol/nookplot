/**
 * Agent email routes — @agent.nookplot.com inbox management.
 *
 * POST   /v1/email/inbox              — Create inbox (claim username)
 * GET    /v1/email/inbox              — Get my inbox
 * PATCH  /v1/email/inbox              — Update settings
 * DELETE /v1/email/inbox              — Deactivate inbox
 * GET    /v1/email/inbox/check/:user  — Check username availability
 * POST   /v1/email/send               — Send email
 * POST   /v1/email/:id/reply          — Reply to email
 * GET    /v1/email/messages            — List messages
 * GET    /v1/email/messages/:id        — Get single message
 * GET    /v1/email/threads/:threadId   — Get full thread
 * POST   /v1/email/messages/:id/read   — Mark as read
 * DELETE /v1/email/messages/:id        — Delete message
 * GET    /v1/email/attachments/:id     — Get attachment (presigned URL)
 * GET    /v1/email/stats               — Email stats
 *
 * All endpoints require auth + registered agent.
 * Feature-gated behind EMAIL_ENABLED.
 *
 * @module routes/email
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { EmailService, EmailInboxRow, EmailMessageRow } from "../services/emailService.js";
import { EmailError } from "../services/emailService.js";

/* ---- Response mappers (snake_case DB → camelCase API) ---- */

function mapInbox(row: EmailInboxRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    username: row.username,
    email: row.email_address,
    displayName: row.display_name ?? null,
    autoReply: row.auto_reply ?? null,
    forwardToAgent: row.forward_to_agent ?? false,
    status: row.is_active ? "active" : "inactive",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: EmailMessageRow) {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    agentId: row.agent_id,
    direction: row.direction,
    fromAddress: row.from_address,
    toAddress: row.to_addresses?.[0] ?? "",
    toAddresses: row.to_addresses ?? [],
    ccAddresses: row.cc_addresses ?? [],
    subject: row.subject ?? null,
    bodyText: row.body_text ?? null,
    bodyHtml: row.body_html ?? null,
    messageId: row.message_id ?? null,
    inReplyTo: row.in_reply_to ?? null,
    threadId: row.thread_id ?? null,
    hasAttachments: row.has_attachments ?? false,
    sesMessageId: row.ses_message_id ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createEmailRouter(
  pool: pg.Pool,
  hmacSecret: string,
  emailService: EmailService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  function handleError(res: Response, err: unknown, fallbackMsg: string): void {
    if (err instanceof EmailError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient")) { res.status(402).json({ error: msg }); return; }
    logSecurityEvent("error", "email-route-error", { error: msg });
    res.status(500).json({ error: fallbackMsg });
  }

  /* ---- Create inbox ---- */
  router.post("/email/inbox", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const inbox = await emailService.createInbox(agent.id, {
        username: req.body.username,
        displayName: req.body.displayName,
        autoReply: req.body.autoReply,
        forwardToAgent: req.body.forwardToAgent,
      });
      res.status(201).json(mapInbox(inbox));
    } catch (err) {
      handleError(res, err, "Failed to create inbox");
    }
  });

  /* ---- Get my inbox ---- */
  router.get("/email/inbox", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const inbox = await emailService.getInbox(agent.id);
      if (!inbox) { res.status(404).json({ error: "No inbox found" }); return; }
      res.status(200).json(mapInbox(inbox));
    } catch (err) {
      handleError(res, err, "Failed to get inbox");
    }
  });

  /* ---- Update inbox settings ---- */
  router.patch("/email/inbox", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const inbox = await emailService.updateInbox(agent.id, {
        displayName: req.body.displayName,
        autoReply: req.body.autoReply,
        forwardToAgent: req.body.forwardToAgent,
      });
      res.status(200).json(mapInbox(inbox));
    } catch (err) {
      handleError(res, err, "Failed to update inbox");
    }
  });

  /* ---- Deactivate inbox ---- */
  router.delete("/email/inbox", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      await emailService.deleteInbox(agent.id);
      res.status(200).json({ ok: true });
    } catch (err) {
      handleError(res, err, "Failed to deactivate inbox");
    }
  });

  /* ---- Check username availability ---- */
  router.get("/email/inbox/check/:username", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await emailService.checkUsernameAvailable(String(req.params.username));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err, "Failed to check username");
    }
  });

  /* ---- Send email ---- */
  router.post("/email/send", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const message = await emailService.sendEmail(agent.id, {
        to: req.body.to,
        subject: req.body.subject,
        bodyText: req.body.bodyText,
        bodyHtml: req.body.bodyHtml,
        cc: req.body.cc,
        inReplyTo: req.body.inReplyTo,
      });
      res.status(200).json(mapMessage(message));
    } catch (err) {
      handleError(res, err, "Failed to send email");
    }
  });

  /* ---- Reply to email ---- */
  router.post("/email/:id/reply", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const message = await emailService.replyToEmail(agent.id, String(req.params.id), {
        bodyText: req.body.bodyText,
        bodyHtml: req.body.bodyHtml,
      });
      res.status(200).json(mapMessage(message));
    } catch (err) {
      handleError(res, err, "Failed to reply to email");
    }
  });

  /* ---- List messages ---- */
  router.get("/email/messages", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const result = await emailService.listMessages(agent.id, {
        direction: req.query.direction as string | undefined,
        threadId: req.query.threadId as string | undefined,
        status: req.query.status as string | undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
      });
      res.status(200).json({ messages: result.messages.map(mapMessage), total: result.total });
    } catch (err) {
      handleError(res, err, "Failed to list messages");
    }
  });

  /* ---- Get single message ---- */
  router.get("/email/messages/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const message = await emailService.getMessage(agent.id, String(req.params.id));
      res.status(200).json(mapMessage(message));
    } catch (err) {
      handleError(res, err, "Failed to get message");
    }
  });

  /* ---- Get thread ---- */
  router.get("/email/threads/:threadId", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const messages = await emailService.getThread(agent.id, String(req.params.threadId));
      res.status(200).json({ messages: messages.map(mapMessage) });
    } catch (err) {
      handleError(res, err, "Failed to get thread");
    }
  });

  /* ---- Mark as read ---- */
  router.post("/email/messages/:id/read", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      await emailService.markRead(agent.id, String(req.params.id));
      res.status(200).json({ ok: true });
    } catch (err) {
      handleError(res, err, "Failed to mark as read");
    }
  });

  /* ---- Delete message ---- */
  router.delete("/email/messages/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      await emailService.deleteMessage(agent.id, String(req.params.id));
      res.status(200).json({ ok: true });
    } catch (err) {
      handleError(res, err, "Failed to delete message");
    }
  });

  /* ---- Get attachment (presigned URL) ---- */
  router.get("/email/attachments/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const result = await emailService.getAttachment(agent.id, String(req.params.id));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err, "Failed to get attachment");
    }
  });

  /* ---- Stats ---- */
  router.get("/email/stats", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const stats = await emailService.getEmailStats(agent.id);
      res.status(200).json(stats);
    } catch (err) {
      handleError(res, err, "Failed to get email stats");
    }
  });

  return router;
}
