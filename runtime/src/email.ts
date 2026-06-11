/**
 * Email manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the Agent Email REST endpoints — create inbox, send/receive,
 * reply, threads, attachments, and stats.
 *
 * All email operations are off-chain (gateway-managed), no on-chain signing needed.
 *
 * @module email
 */

import type { ConnectionManager } from "./connection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmailInbox {
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

export interface EmailMessage {
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
  status: "delivered" | "read" | "bounced" | "complained" | "failed";
  created_at: string;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  cc?: string[];
  inReplyTo?: string;
}

export interface ReplyEmailInput {
  bodyText: string;
  bodyHtml?: string;
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

export interface EmailStats {
  sent: number;
  received: number;
  unread: number;
  dailySendsRemaining: number;
}

export interface EmailAttachmentResult {
  attachment: {
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  };
  presignedUrl: string;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class EmailManager {
  constructor(private readonly connection: ConnectionManager) {}

  /** Create an email inbox — claim a @agent.nookplot.com address. */
  async createInbox(input: CreateInboxInput): Promise<EmailInbox> {
    return this.connection.request<EmailInbox>("POST", "/v1/email/inbox", input);
  }

  /** Get the agent's email inbox. */
  async getInbox(): Promise<EmailInbox | null> {
    try {
      return await this.connection.request<EmailInbox>("GET", "/v1/email/inbox");
    } catch {
      return null;
    }
  }

  /** Update inbox settings (displayName, autoReply, forwardToAgent). */
  async updateInbox(input: UpdateInboxInput): Promise<EmailInbox> {
    return this.connection.request<EmailInbox>("PATCH", "/v1/email/inbox", input);
  }

  /** Deactivate the inbox. */
  async deleteInbox(): Promise<void> {
    await this.connection.request("DELETE", "/v1/email/inbox");
  }

  /** Check if a username is available. */
  async checkUsername(username: string): Promise<{ available: boolean }> {
    return this.connection.request<{ available: boolean }>(
      "GET", `/v1/email/inbox/check/${encodeURIComponent(username)}`,
    );
  }

  /** Send an email. */
  async send(input: SendEmailInput): Promise<EmailMessage> {
    return this.connection.request<EmailMessage>("POST", "/v1/email/send", input);
  }

  /** Reply to an email by message ID. */
  async reply(messageId: string, input: ReplyEmailInput): Promise<EmailMessage> {
    return this.connection.request<EmailMessage>(
      "POST", `/v1/email/${encodeURIComponent(messageId)}/reply`, input,
    );
  }

  /** List messages with optional filters. */
  async listMessages(params?: {
    direction?: "inbound" | "outbound";
    threadId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ messages: EmailMessage[]; total: number }> {
    const searchParams = new URLSearchParams();
    if (params?.direction) searchParams.set("direction", params.direction);
    if (params?.threadId) searchParams.set("threadId", params.threadId);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return this.connection.request<{ messages: EmailMessage[]; total: number }>(
      "GET", `/v1/email/messages${qs ? `?${qs}` : ""}`,
    );
  }

  /** Get a single message by ID. */
  async getMessage(id: string): Promise<EmailMessage> {
    return this.connection.request<EmailMessage>("GET", `/v1/email/messages/${encodeURIComponent(id)}`);
  }

  /** Get all messages in a thread. */
  async getThread(threadId: string): Promise<{ messages: EmailMessage[] }> {
    return this.connection.request<{ messages: EmailMessage[] }>(
      "GET", `/v1/email/threads/${encodeURIComponent(threadId)}`,
    );
  }

  /** Mark a message as read. */
  async markRead(id: string): Promise<void> {
    await this.connection.request("POST", `/v1/email/messages/${encodeURIComponent(id)}/read`);
  }

  /** Delete a message. */
  async deleteMessage(id: string): Promise<void> {
    await this.connection.request("DELETE", `/v1/email/messages/${encodeURIComponent(id)}`);
  }

  /** Get a presigned URL for an attachment. */
  async getAttachment(id: string): Promise<EmailAttachmentResult> {
    return this.connection.request<EmailAttachmentResult>(
      "GET", `/v1/email/attachments/${encodeURIComponent(id)}`,
    );
  }

  /** Get email stats (sent, received, unread, daily sends remaining). */
  async getStats(): Promise<EmailStats> {
    return this.connection.request<EmailStats>("GET", "/v1/email/stats");
  }
}
