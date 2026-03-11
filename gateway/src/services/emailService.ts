/**
 * Agent email service — @agent.nookplot.com inboxes via Resend.
 *
 * Handles inbox creation, outbound sending, inbound processing
 * (Resend webhook), threading, bounce/complaint suppression, and
 * anti-abuse rate limiting.
 *
 * Feature-gated behind EMAIL_ENABLED.
 *
 * @module services/emailService
 */

import type pg from "pg";
import { Resend } from "resend";
import { encryptSecret, decryptSecret } from "../secretManager.js";
import type { CreditManager } from "./creditManager.js";
import type { ContentScanner } from "./contentScanner.js";
import type { RuntimeEventBroadcaster } from "./runtimeEventBroadcaster.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

/* ---------- At-rest encryption helpers ---------- */

const ENC_PREFIX = "enc:v1:";

/** Encrypt a string for DB storage. Returns prefixed blob or null. */
function encryptField(plaintext: string | null | undefined, masterKey: string): string | null {
  if (!plaintext) return null;
  const { encryptedKey, iv, authTag } = encryptSecret(plaintext, masterKey);
  return `${ENC_PREFIX}${iv}:${authTag}:${encryptedKey}`;
}

/** Decrypt a DB field. Handles both encrypted (prefixed) and legacy values. */
function decryptField(stored: string | null | undefined, masterKey: string): string | null {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy value
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return stored; // malformed — return as-is
  const [iv, authTag, ciphertext] = parts;
  try {
    return decryptSecret(ciphertext, iv, authTag, masterKey);
  } catch {
    logSecurityEvent("error", "email-decrypt-failed", {});
    return null;
  }
}

/* ---------- Types ---------- */

export interface EmailInboxRow {
  id: string;
  agent_id: string;
  username: string;
  email_address: string;
  display_name: string | null;
  auto_reply: string | null;
  forward_to_agent: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailMessageRow {
  id: string;
  inbox_id: string;
  agent_id: string;
  direction: "inbound" | "outbound";
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[] | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  has_attachments: boolean;
  s3_key: string | null;
  ses_message_id: string | null;
  status: "delivered" | "read" | "bounced" | "complained" | "failed";
  created_at: string;
}

export interface EmailAttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  s3_key: string;
  created_at: string;
}

export interface CreateInboxInput {
  username: string;
  displayName?: string;
  autoReply?: string;
  forwardToAgent?: boolean;
}

export interface UpdateInboxInput {
  displayName?: string;
  autoReply?: string | null;
  forwardToAgent?: boolean;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  cc?: string[];
  inReplyTo?: string;
}

export interface EmailStats {
  sent: number;
  received: number;
  unread: number;
  dailySendsRemaining: number;
}

/** Resend inbound webhook payload (email.received event).
 *  Note: Resend webhooks do NOT include the email body (text/html).
 *  The body must be fetched via GET /emails/receiving/{email_id}. */
export interface ResendInboundPayload {
  created_at: string;
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  message_id?: string;
  in_reply_to?: string;
  attachments?: Array<{
    filename: string;
    content_type: string;
    size: number;
  }>;
  headers?: Array<{ name: string; value: string }>;
}

/* ---------- Constants ---------- */

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "support", "help", "info", "noreply", "no-reply",
  "postmaster", "abuse", "mailer-daemon", "hostmaster", "webmaster",
  "security", "root", "system", "mail", "contact", "feedback",
  "nookplot", "nook", "protocol", "api", "gateway", "bot",
]);

const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- Error class ---------- */

export class EmailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/* ---------- Service ---------- */

export class EmailService {
  private resend: Resend;
  private creditManager: CreditManager | null = null;
  private eventBroadcaster: RuntimeEventBroadcaster | null = null;
  private contentScanner: ContentScanner | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: {
      resendApiKey: string;
      domain: string;
      encryptionKey: string;     // 32-byte hex — same SECRET_ENCRYPTION_KEY used elsewhere
      createInboxCost: number;   // stored units (50 = 0.50 credit)
      sendCost: number;          // stored units (15 = 0.15 credit)
      sendAttachmentCost: number;// stored units (25 = 0.25 credit)
      dailyLimitTier1: number;
      dailyLimitTier2: number;
    },
  ) {
    this.resend = new Resend(config.resendApiKey);
  }

  /* ---- Dependency setters (circular dep avoidance) ---- */

  setCreditManager(cm: CreditManager): void { this.creditManager = cm; }
  setEventBroadcaster(eb: RuntimeEventBroadcaster): void { this.eventBroadcaster = eb; }
  setContentScanner(cs: ContentScanner): void { this.contentScanner = cs; }

  /** Decrypt sensitive fields on a message row returned from DB. */
  private decryptMessage(row: EmailMessageRow): EmailMessageRow {
    return {
      ...row,
      subject: decryptField(row.subject, this.config.encryptionKey),
      body_text: decryptField(row.body_text, this.config.encryptionKey),
      body_html: decryptField(row.body_html, this.config.encryptionKey),
    };
  }

  /* ================================================================
   *  Inbox CRUD
   * ================================================================ */

  async createInbox(agentId: string, input: CreateInboxInput): Promise<EmailInboxRow> {
    const username = input.username.toLowerCase().trim();

    // Validate username
    if (!USERNAME_REGEX.test(username)) {
      throw new EmailError(
        "Username must be 2-64 chars, lowercase alphanumeric, dots, hyphens, underscores. Must start/end with alphanumeric.",
        "INVALID_USERNAME", 400,
      );
    }
    if (RESERVED_USERNAMES.has(username)) {
      throw new EmailError("This username is reserved", "RESERVED_USERNAME", 400);
    }

    // Check agent doesn't already have an inbox
    const existing = await this.pool.query(
      `SELECT id FROM agent_email_inboxes WHERE agent_id = $1`,
      [agentId],
    );
    if (existing.rows.length > 0) {
      throw new EmailError("Agent already has an email inbox", "ALREADY_EXISTS", 409);
    }

    // Check username availability
    const taken = await this.pool.query(
      `SELECT id FROM agent_email_inboxes WHERE username = $1`,
      [username],
    );
    if (taken.rows.length > 0) {
      throw new EmailError("Username already taken", "USERNAME_TAKEN", 409);
    }

    // Deduct credits (stored units — passed directly to deductCredits)
    if (this.creditManager) {
      await this.creditManager.deductCredits(
        agentId, this.config.createInboxCost,
        `email_create_inbox:${Date.now()}`, "email_create_inbox",
      );
    }

    const emailAddress = `${username}@${this.config.domain}`;

    // Coerce non-string autoReply to null (frontend may send boolean false/true)
    const autoReply = typeof input.autoReply === "string" && input.autoReply.trim().length > 0
      ? input.autoReply
      : null;

    const result = await this.pool.query<EmailInboxRow>(
      `INSERT INTO agent_email_inboxes
         (agent_id, username, email_address, display_name, auto_reply, forward_to_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        agentId, username, emailAddress,
        input.displayName ?? null,
        autoReply,
        input.forwardToAgent ?? false,
      ],
    );

    logSecurityEvent("info", "email-inbox-created", { agentId, username, emailAddress });

    return result.rows[0];
  }

  async getInbox(agentId: string): Promise<EmailInboxRow | null> {
    const result = await this.pool.query<EmailInboxRow>(
      `SELECT * FROM agent_email_inboxes WHERE agent_id = $1 AND is_active = true`,
      [agentId],
    );
    return result.rows[0] ?? null;
  }

  async updateInbox(agentId: string, input: UpdateInboxInput): Promise<EmailInboxRow> {
    const inbox = await this.getInbox(agentId);
    if (!inbox) {
      throw new EmailError("No active inbox found", "NOT_FOUND", 404);
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (input.displayName !== undefined) {
      sets.push(`display_name = $${idx++}`);
      vals.push(input.displayName);
    }
    if (input.autoReply !== undefined) {
      sets.push(`auto_reply = $${idx++}`);
      // Accept string to set, anything else (null, boolean, empty) clears it
      vals.push(
        typeof input.autoReply === "string" && input.autoReply.trim().length > 0
          ? input.autoReply
          : null,
      );
    }
    if (input.forwardToAgent !== undefined) {
      sets.push(`forward_to_agent = $${idx++}`);
      vals.push(input.forwardToAgent);
    }

    if (sets.length === 0) {
      return inbox;
    }

    sets.push(`updated_at = NOW()`);
    vals.push(inbox.id);

    const result = await this.pool.query<EmailInboxRow>(
      `UPDATE agent_email_inboxes SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      vals,
    );

    return result.rows[0];
  }

  async deleteInbox(agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE agent_email_inboxes SET is_active = false, updated_at = NOW()
       WHERE agent_id = $1 AND is_active = true`,
      [agentId],
    );
    if (result.rowCount === 0) {
      throw new EmailError("No active inbox found", "NOT_FOUND", 404);
    }
    logSecurityEvent("info", "email-inbox-deactivated", { agentId });
  }

  async checkUsernameAvailable(username: string): Promise<{ available: boolean }> {
    const lower = username.toLowerCase().trim();
    if (!USERNAME_REGEX.test(lower)) {
      return { available: false };
    }
    if (RESERVED_USERNAMES.has(lower)) {
      return { available: false };
    }
    const result = await this.pool.query(
      `SELECT id FROM agent_email_inboxes WHERE username = $1`,
      [lower],
    );
    return { available: result.rows.length === 0 };
  }

  /* ================================================================
   *  Outbound — Send Email
   * ================================================================ */

  async sendEmail(agentId: string, input: SendEmailInput): Promise<EmailMessageRow> {
    // 1. Verify inbox
    const inbox = await this.getInbox(agentId);
    if (!inbox) {
      throw new EmailError("No active inbox. Create one first.", "NO_INBOX", 404);
    }

    const toAddresses = Array.isArray(input.to) ? input.to : [input.to];
    if (toAddresses.length === 0) {
      throw new EmailError("At least one recipient required", "NO_RECIPIENTS", 400);
    }

    // Validate email addresses
    for (const addr of toAddresses) {
      if (!EMAIL_REGEX.test(addr)) {
        throw new EmailError(`Invalid email address: ${addr}`, "INVALID_ADDRESS", 400);
      }
    }
    if (input.cc) {
      for (const addr of input.cc) {
        if (!EMAIL_REGEX.test(addr)) {
          throw new EmailError(`Invalid CC address: ${addr}`, "INVALID_ADDRESS", 400);
        }
      }
    }

    if (!input.subject || input.subject.length > 998) {
      throw new EmailError("Subject required (max 998 chars)", "INVALID_SUBJECT", 400);
    }
    if (!input.bodyText) {
      throw new EmailError("Body text required", "NO_BODY", 400);
    }

    // 2. Check daily send limit
    const dailyLimit = await this.getDailyLimit(agentId);
    const todaySends = await this.getTodaySendCount(agentId);
    if (todaySends >= dailyLimit) {
      throw new EmailError(
        `Daily send limit reached (${dailyLimit}/day)`,
        "DAILY_LIMIT", 429,
      );
    }

    // 3. Check suppression list
    const allRecipients = [...toAddresses, ...(input.cc ?? [])];
    for (const addr of allRecipients) {
      const suppressed = await this.isEmailSuppressed(addr);
      if (suppressed) {
        throw new EmailError(
          `Cannot send to ${addr} — address is on suppression list (bounced or complained)`,
          "SUPPRESSED", 400,
        );
      }
    }

    // 4. Content scan (blocking)
    if (this.contentScanner) {
      const textToScan = `${input.subject}\n${input.bodyText}`;
      const { blocked, result: scanResult } = this.contentScanner.scanForBlocking(textToScan, 70);
      if (blocked) {
        this.contentScanner.recordBlockedContent(agentId, "email_outbound", scanResult).catch(() => {});
        throw new EmailError("Content blocked by safety scanner", "CONTENT_BLOCKED", 400);
      }
    }

    // 5. Deduct credits (stored units — passed directly to deductCredits)
    const hasAttachments = false; // outbound attachments not supported in v1
    const cost = hasAttachments ? this.config.sendAttachmentCost : this.config.sendCost;
    if (this.creditManager) {
      await this.creditManager.deductCredits(
        agentId, cost,
        `email_send:${Date.now()}`, "email_send",
      );
    }

    // 6. Send via Resend API
    const messageId = `<${crypto.randomUUID()}@${this.config.domain}>`;
    const fromAddress = inbox.display_name
      ? `${inbox.display_name} <${inbox.email_address}>`
      : inbox.email_address;

    let resendId: string | undefined;
    try {
      const sendPayload: {
        from: string;
        to: string[];
        subject: string;
        text: string;
        html?: string;
        cc?: string[];
        headers: Record<string, string>;
      } = {
        from: fromAddress,
        to: toAddresses,
        subject: input.subject,
        text: input.bodyText,
        headers: { "Message-ID": messageId },
      };

      if (input.bodyHtml) sendPayload.html = input.bodyHtml;
      if (input.cc && input.cc.length > 0) sendPayload.cc = input.cc;
      if (input.inReplyTo) {
        sendPayload.headers["In-Reply-To"] = input.inReplyTo;
        sendPayload.headers["References"] = input.inReplyTo;
      }

      const { data, error } = await this.resend.emails.send(sendPayload);
      if (error) throw new Error(error.message);
      resendId = data?.id;
    } catch (err) {
      // Refund credits on send failure (stored units)
      if (this.creditManager) {
        await this.creditManager.addCredits(
          agentId, cost,
          `email_send_refund:${Date.now()}`, "email_send_refund",
        );
      }
      logSecurityEvent("error", "email-send-failed", { agentId, error: (err as Error).message });
      throw new EmailError("Failed to send email via Resend", "RESEND_ERROR", 502);
    }

    // 7. Resolve thread
    let threadId: string | null = null;
    if (input.inReplyTo) {
      const parentMsg = await this.pool.query<{ thread_id: string; id: string }>(
        `SELECT thread_id, id FROM agent_email_messages WHERE message_id = $1 LIMIT 1`,
        [input.inReplyTo],
      );
      if (parentMsg.rows.length > 0) {
        threadId = parentMsg.rows[0].thread_id ?? parentMsg.rows[0].id;
      }
    }
    if (!threadId) {
      threadId = crypto.randomUUID();
    }

    // 8. Store message (encrypt sensitive fields at rest)
    const encKey = this.config.encryptionKey;
    const result = await this.pool.query<EmailMessageRow>(
      `INSERT INTO agent_email_messages
         (inbox_id, agent_id, direction, from_address, to_addresses, cc_addresses,
          subject, body_text, body_html, message_id, in_reply_to, thread_id,
          has_attachments, ses_message_id, status)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13, 'delivered')
       RETURNING *`,
      [
        inbox.id, agentId, inbox.email_address, toAddresses, input.cc ?? null,
        encryptField(input.subject, encKey),
        encryptField(input.bodyText, encKey),
        encryptField(input.bodyHtml ?? null, encKey),
        messageId, input.inReplyTo ?? null, threadId,
        hasAttachments, resendId ?? null,
      ],
    );

    // 9. Increment daily counter
    await this.pool.query(
      `INSERT INTO agent_email_daily_sends (agent_id, send_date, send_count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (agent_id, send_date) DO UPDATE SET send_count = agent_email_daily_sends.send_count + 1`,
      [agentId],
    );

    logSecurityEvent("info", "email-sent", {
      agentId, to: toAddresses, subject: input.subject.slice(0, 50),
    });

    return this.decryptMessage(result.rows[0]);
  }

  async replyToEmail(agentId: string, originalMessageId: string, input: { bodyText: string; bodyHtml?: string }): Promise<EmailMessageRow> {
    // Look up the original message
    const original = await this.pool.query<EmailMessageRow>(
      `SELECT * FROM agent_email_messages WHERE id = $1 AND agent_id = $2`,
      [originalMessageId, agentId],
    );
    if (original.rows.length === 0) {
      throw new EmailError("Message not found", "NOT_FOUND", 404);
    }

    const orig = this.decryptMessage(original.rows[0]);
    const replyTo = orig.direction === "inbound" ? orig.from_address : orig.to_addresses[0];
    const subject = orig.subject?.startsWith("Re: ") ? orig.subject : `Re: ${orig.subject ?? "(no subject)"}`;

    return this.sendEmail(agentId, {
      to: replyTo,
      subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      inReplyTo: orig.message_id ?? undefined,
    });
  }

  /* ================================================================
   *  Inbound — Process received email (Resend webhook payload)
   * ================================================================ */

  async processInboundEmail(payload: ResendInboundPayload): Promise<void> {
    const fromAddress = payload.from ?? "unknown@unknown.com";

    // Resend webhooks do NOT include the email body (text/html).
    // Fetch it from the Resend Receiving API: GET /emails/receiving/{id}
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;

    if (payload.email_id) {
      try {
        const resp = await fetchWithTimeout(`https://api.resend.com/emails/receiving/${payload.email_id}`, {
          headers: { Authorization: `Bearer ${this.config.resendApiKey}` },
          timeoutMs: 10_000,
        });
        if (resp.ok) {
          const data = await resp.json() as Record<string, unknown>;
          bodyText = (data.text as string) ?? null;
          bodyHtml = (data.html as string) ?? null;
          logSecurityEvent("info", "email-inbound-body-fetched", {
            emailId: payload.email_id,
            hasText: bodyText != null && bodyText.length > 0,
            hasHtml: bodyHtml != null && bodyHtml.length > 0,
          });
        } else {
          logSecurityEvent("warn", "email-inbound-body-fetch-failed", {
            emailId: payload.email_id,
            status: resp.status,
            statusText: resp.statusText,
          });
        }
      } catch (err) {
        logSecurityEvent("warn", "email-inbound-body-fetch-error", {
          emailId: payload.email_id,
          error: (err as Error).message,
        });
      }
    }

    // Find matching inbox from recipients
    let inbox: EmailInboxRow | null = null;
    for (const recipient of payload.to) {
      // Handle both "user@domain" and "Display Name <user@domain>" formats
      const emailMatch = recipient.match(/<([^>]+)>/);
      const email = emailMatch ? emailMatch[1] : recipient;
      const localPart = email.split("@")[0]?.toLowerCase();
      if (!localPart) continue;

      const result = await this.pool.query<EmailInboxRow>(
        `SELECT * FROM agent_email_inboxes WHERE username = $1 AND is_active = true`,
        [localPart],
      );
      if (result.rows.length > 0) {
        inbox = result.rows[0];
        break;
      }
    }

    if (!inbox) {
      logSecurityEvent("warn", "email-inbound-no-inbox", {
        recipients: payload.to,
      });
      return;
    }

    // Thread resolution
    let threadId: string | null = null;
    if (payload.in_reply_to) {
      const parentMsg = await this.pool.query<{ thread_id: string; id: string }>(
        `SELECT thread_id, id FROM agent_email_messages WHERE message_id = $1 LIMIT 1`,
        [payload.in_reply_to],
      );
      if (parentMsg.rows.length > 0) {
        threadId = parentMsg.rows[0].thread_id ?? parentMsg.rows[0].id;
      }
    }
    if (!threadId) {
      threadId = crypto.randomUUID();
    }

    // Store message (encrypt sensitive fields at rest)
    const hasAttachments = (payload.attachments?.length ?? 0) > 0;
    const encKey = this.config.encryptionKey;

    const msgResult = await this.pool.query<EmailMessageRow>(
      `INSERT INTO agent_email_messages
         (inbox_id, agent_id, direction, from_address, to_addresses,
          subject, body_text, body_html, message_id, in_reply_to, thread_id,
          has_attachments, ses_message_id, status)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12, 'delivered')
       RETURNING *`,
      [
        inbox.id, inbox.agent_id, fromAddress, payload.to,
        encryptField(payload.subject ?? null, encKey),
        encryptField(bodyText, encKey),
        encryptField(bodyHtml, encKey),
        payload.message_id ?? null, payload.in_reply_to ?? null, threadId,
        hasAttachments, payload.email_id ?? null,
      ],
    );

    const storedMessage = msgResult.rows[0];

    // Store attachments metadata
    if (payload.attachments && payload.attachments.length > 0) {
      for (const att of payload.attachments) {
        await this.pool.query(
          `INSERT INTO agent_email_attachments
             (message_id, filename, content_type, size_bytes, s3_key)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            storedMessage.id,
            att.filename ?? "attachment",
            att.content_type ?? "application/octet-stream",
            att.size ?? 0,
            `resend/${payload.email_id}/${att.filename ?? crypto.randomUUID()}`,
          ],
        );
      }
    }

    // Content scan (fire-and-forget) — scan BOTH text and html bodies
    if (this.contentScanner) {
      const htmlStripped = (bodyHtml ?? "").replace(/<[^>]*>/g, " ").slice(0, 5000);
      const textToScan = `${payload.subject ?? ""}\n${bodyText ?? ""}\n${htmlStripped}`;
      this.contentScanner.scanAndRecord(
        inbox.agent_id, "email_inbound", storedMessage.id, textToScan,
      ).catch(() => {});
    }

    // WebSocket broadcast — truncate fields, fall back to HTML-stripped preview
    if (this.eventBroadcaster) {
      const textPreview = (bodyText ?? "").slice(0, 200);
      const htmlPreview = textPreview
        ? textPreview
        : (bodyHtml ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

      this.eventBroadcaster.broadcast(inbox.agent_id, {
        type: "email.received",
        timestamp: new Date().toISOString(),
        data: {
          messageId: storedMessage.id,
          from: fromAddress.slice(0, 200),
          subject: (payload.subject ?? "").slice(0, 200) || null,
          preview: htmlPreview,
          threadId,
        },
      });
    }

    // Forward to Nookplot inbox if enabled — sanitize preview for agent consumption
    if (inbox.forward_to_agent) {
      try {
        const fwdPreview = (bodyText ?? "").slice(0, 500)
          || (bodyHtml ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

        await this.pool.query(
          `INSERT INTO agent_messages (sender_id, recipient_id, content, message_type)
           VALUES ('system', $1, $2, 'email_notification')`,
          [
            inbox.agent_id,
            JSON.stringify({
              type: "email_received",
              from: fromAddress.slice(0, 200),
              subject: (payload.subject ?? "(no subject)").slice(0, 200),
              preview: fwdPreview,
              emailMessageId: storedMessage.id,
            }),
          ],
        );
      } catch {
        // agent_messages table may not exist — non-critical
      }
    }

    // Auto-reply (with flood prevention)
    if (inbox.auto_reply) {
      await this.maybeAutoReply(inbox, fromAddress, payload);
    }

    logSecurityEvent("info", "email-inbound-processed", {
      agentId: inbox.agent_id, from: fromAddress, subject: payload.subject,
    });
  }

  /* ================================================================
   *  Read / Query
   * ================================================================ */

  async listMessages(
    agentId: string,
    params?: { direction?: string; threadId?: string; status?: string; limit?: number; offset?: number },
  ): Promise<{ messages: EmailMessageRow[]; total: number }> {
    const inbox = await this.getInbox(agentId);
    if (!inbox) {
      throw new EmailError("No active inbox", "NO_INBOX", 404);
    }

    const conditions = [`inbox_id = $1`];
    const vals: unknown[] = [inbox.id];
    let idx = 2;

    if (params?.direction) {
      conditions.push(`direction = $${idx++}`);
      vals.push(params.direction);
    }
    if (params?.threadId) {
      conditions.push(`thread_id = $${idx++}::uuid`);
      vals.push(params.threadId);
    }
    if (params?.status) {
      conditions.push(`status = $${idx++}`);
      vals.push(params.status);
    }

    const where = conditions.join(" AND ");
    const limit = Math.min(params?.limit ?? 50, 100);
    const offset = params?.offset ?? 0;

    const [messages, countResult] = await Promise.all([
      this.pool.query<EmailMessageRow>(
        `SELECT * FROM agent_email_messages WHERE ${where}
         ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        [...vals, limit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM agent_email_messages WHERE ${where}`,
        vals,
      ),
    ]);

    return {
      messages: messages.rows.map((r) => this.decryptMessage(r)),
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async getMessage(agentId: string, messageId: string): Promise<EmailMessageRow> {
    const result = await this.pool.query<EmailMessageRow>(
      `SELECT * FROM agent_email_messages WHERE id = $1 AND agent_id = $2`,
      [messageId, agentId],
    );
    if (result.rows.length === 0) {
      throw new EmailError("Message not found", "NOT_FOUND", 404);
    }
    return this.decryptMessage(result.rows[0]);
  }

  async getThread(agentId: string, threadId: string): Promise<EmailMessageRow[]> {
    const inbox = await this.getInbox(agentId);
    if (!inbox) {
      throw new EmailError("No active inbox", "NO_INBOX", 404);
    }

    const result = await this.pool.query<EmailMessageRow>(
      `SELECT * FROM agent_email_messages
       WHERE inbox_id = $1 AND thread_id = $2::uuid
       ORDER BY created_at ASC`,
      [inbox.id, threadId],
    );
    return result.rows.map((r) => this.decryptMessage(r));
  }

  async markRead(agentId: string, messageId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE agent_email_messages SET status = 'read'
       WHERE id = $1 AND agent_id = $2 AND status = 'delivered'`,
      [messageId, agentId],
    );
    if (result.rowCount === 0) {
      throw new EmailError("Message not found or already read", "NOT_FOUND", 404);
    }
  }

  async deleteMessage(agentId: string, messageId: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM agent_email_messages WHERE id = $1 AND agent_id = $2`,
      [messageId, agentId],
    );
    if (result.rowCount === 0) {
      throw new EmailError("Message not found", "NOT_FOUND", 404);
    }
  }

  async getAttachment(agentId: string, attachmentId: string): Promise<{ attachment: EmailAttachmentRow; downloadUrl: string }> {
    const result = await this.pool.query<EmailAttachmentRow & { msg_agent_id: string }>(
      `SELECT a.*, m.agent_id as msg_agent_id
       FROM agent_email_attachments a
       JOIN agent_email_messages m ON m.id = a.message_id
       WHERE a.id = $1`,
      [attachmentId],
    );
    if (result.rows.length === 0 || result.rows[0].msg_agent_id !== agentId) {
      throw new EmailError("Attachment not found", "NOT_FOUND", 404);
    }

    const att = result.rows[0];
    // Resend attachments are referenced by email_id stored in s3_key as "resend/<email_id>/<filename>"
    // The Resend API doesn't provide direct attachment download URLs in the same way as S3.
    // For now, return the s3_key as a reference; attachment content was stored during inbound processing.
    return { attachment: att, downloadUrl: att.s3_key };
  }

  async getEmailStats(agentId: string): Promise<EmailStats> {
    const inbox = await this.getInbox(agentId);
    if (!inbox) {
      throw new EmailError("No active inbox", "NO_INBOX", 404);
    }

    const [sent, received, unread] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM agent_email_messages
         WHERE inbox_id = $1 AND direction = 'outbound'`,
        [inbox.id],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM agent_email_messages
         WHERE inbox_id = $1 AND direction = 'inbound'`,
        [inbox.id],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM agent_email_messages
         WHERE inbox_id = $1 AND direction = 'inbound' AND status = 'delivered'`,
        [inbox.id],
      ),
    ]);

    const dailyLimit = await this.getDailyLimit(agentId);
    const todaySends = await this.getTodaySendCount(agentId);

    return {
      sent: parseInt(sent.rows[0].count, 10),
      received: parseInt(received.rows[0].count, 10),
      unread: parseInt(unread.rows[0].count, 10),
      dailySendsRemaining: Math.max(0, dailyLimit - todaySends),
    };
  }

  /* ================================================================
   *  Bounce / Complaint handling (Resend webhook payloads)
   * ================================================================ */

  async processBounceNotification(data: Record<string, unknown>): Promise<void> {
    // Resend email.bounced payload: { email_id, created_at, from, to, ... }
    const toAddresses = (data.to as string[]) ?? [];
    const emailId = (data.email_id as string) ?? "";

    for (const addr of toAddresses) {
      // Add to suppression list
      await this.pool.query(
        `INSERT INTO agent_email_suppressions (email_address, reason, bounce_type, diagnostic)
         VALUES ($1, 'hard_bounce', 'Permanent', $2)
         ON CONFLICT (email_address, reason) DO NOTHING`,
        [addr, `Resend bounce for email ${emailId}`],
      );

      // Update message status
      await this.pool.query(
        `UPDATE agent_email_messages SET status = 'bounced'
         WHERE ses_message_id = $1`,
        [emailId],
      );

      logSecurityEvent("warn", "email-hard-bounce", { address: addr, emailId });
    }
  }

  async processComplaintNotification(data: Record<string, unknown>): Promise<void> {
    // Resend email.complained payload: { email_id, created_at, from, to, ... }
    const toAddresses = (data.to as string[]) ?? [];
    const emailId = (data.email_id as string) ?? "";

    for (const addr of toAddresses) {
      await this.pool.query(
        `INSERT INTO agent_email_suppressions (email_address, reason, bounce_type, diagnostic)
         VALUES ($1, 'complaint', 'Complaint', $2)
         ON CONFLICT (email_address, reason) DO NOTHING`,
        [addr, `Resend complaint for email ${emailId}`],
      );

      await this.pool.query(
        `UPDATE agent_email_messages SET status = 'complained'
         WHERE ses_message_id = $1`,
        [emailId],
      );

      logSecurityEvent("warn", "email-complaint", { address: addr, emailId });
    }
  }

  async isEmailSuppressed(emailAddress: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT id FROM agent_email_suppressions WHERE email_address = $1`,
      [emailAddress.toLowerCase()],
    );
    return result.rows.length > 0;
  }

  /* ================================================================
   *  Internal helpers
   * ================================================================ */

  private async getDailyLimit(agentId: string): Promise<number> {
    // Check if agent is tier 2 (purchased/subscriber)
    try {
      const result = await this.pool.query<{ has_purchased: boolean }>(
        `SELECT has_purchased FROM credit_balances WHERE agent_id = $1`,
        [agentId],
      );
      if (result.rows.length > 0 && result.rows[0].has_purchased) {
        return this.config.dailyLimitTier2;
      }
    } catch {
      // credit_balances may not exist
    }
    return this.config.dailyLimitTier1;
  }

  private async getTodaySendCount(agentId: string): Promise<number> {
    const result = await this.pool.query<{ send_count: number }>(
      `SELECT send_count FROM agent_email_daily_sends
       WHERE agent_id = $1 AND send_date = CURRENT_DATE`,
      [agentId],
    );
    return result.rows[0]?.send_count ?? 0;
  }

  private async maybeAutoReply(
    inbox: EmailInboxRow,
    fromAddress: string,
    payload: ResendInboundPayload,
  ): Promise<void> {
    // Skip auto-reply for auto-generated emails
    if (payload.headers) {
      const autoSubmitted = payload.headers.find((h) => h.name.toLowerCase() === "auto-submitted");
      if (autoSubmitted && autoSubmitted.value !== "no") return;
    }

    // Skip for bounce notifications
    if (fromAddress.toLowerCase().includes("mailer-daemon")) return;
    if (fromAddress.toLowerCase().includes("postmaster")) return;

    // Flood prevention: max 1 auto-reply per sender per hour
    const recentReply = await this.pool.query(
      `SELECT id FROM agent_email_messages
       WHERE inbox_id = $1 AND direction = 'outbound'
         AND to_addresses @> ARRAY[$2]
         AND subject LIKE 'Auto-Reply:%'
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [inbox.id, fromAddress],
    );
    if (recentReply.rows.length > 0) return;

    // Send auto-reply via Resend (no credit charge)
    const subject = `Auto-Reply: ${payload.subject ?? "(no subject)"}`;

    try {
      const { data, error } = await this.resend.emails.send({
        from: inbox.display_name
          ? `${inbox.display_name} <${inbox.email_address}>`
          : inbox.email_address,
        to: [fromAddress],
        subject,
        text: inbox.auto_reply!,
        headers: {
          "Auto-Submitted": "auto-replied",
          ...(payload.message_id ? { "In-Reply-To": payload.message_id, "References": payload.message_id } : {}),
        },
      });

      if (error) throw new Error(error.message);

      // Store auto-reply in DB (encrypted at rest)
      const ek = this.config.encryptionKey;
      await this.pool.query(
        `INSERT INTO agent_email_messages
           (inbox_id, agent_id, direction, from_address, to_addresses,
            subject, body_text, message_id, in_reply_to, thread_id,
            has_attachments, ses_message_id, status)
         VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, $9::uuid, false, $10, 'delivered')`,
        [
          inbox.id, inbox.agent_id, inbox.email_address, [fromAddress],
          encryptField(subject, ek), encryptField(inbox.auto_reply, ek),
          `<${crypto.randomUUID()}@${this.config.domain}>`,
          payload.message_id ?? null,
          crypto.randomUUID(), // new thread for auto-reply
          data?.id ?? null,
        ],
      );

      // Don't count auto-replies against daily limit
    } catch (err) {
      logSecurityEvent("error", "email-auto-reply-failed", {
        agentId: inbox.agent_id, to: fromAddress, error: (err as Error).message,
      });
    }
  }
}
