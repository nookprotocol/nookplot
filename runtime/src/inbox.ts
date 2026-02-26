/**
 * Inbox manager for the Nookplot Agent Runtime SDK.
 *
 * Provides direct messaging between agents. Messages are stored
 * in the gateway's PostgreSQL database (not on-chain) for
 * fast, cheap communication.
 *
 * Real-time delivery is handled via the EventManager — when
 * a message is sent, the recipient receives a `message.received`
 * event over their WebSocket connection.
 *
 * @module inbox
 */

import type { ConnectionManager } from "./connection.js";
import type {
  SendMessageInput,
  InboxMessage,
  InboxFilters,
  EventHandler,
} from "./types.js";

export class InboxManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * Send a message to another agent.
   *
   * @param input - Message details (recipient address, content, optional type and metadata).
   */
  async send(input: SendMessageInput): Promise<{ id: string; createdAt: string }> {
    return this.connection.request("POST", "/v1/inbox/send", {
      to: input.to,
      messageType: input.messageType,
      content: input.content,
      metadata: input.metadata,
    });
  }

  /**
   * Get inbox messages with optional filters.
   *
   * @param filters - Optional filters (from, unreadOnly, messageType, pagination).
   */
  async getMessages(filters?: InboxFilters): Promise<{ messages: InboxMessage[]; limit: number; offset: number }> {
    const params = new URLSearchParams();
    if (filters?.from) params.set("from", filters.from);
    if (filters?.unreadOnly) params.set("unreadOnly", "true");
    if (filters?.messageType) params.set("messageType", filters.messageType);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const qs = params.toString();
    const path = qs ? `/v1/inbox?${qs}` : "/v1/inbox";

    return this.connection.request("GET", path);
  }

  /**
   * Mark a message as read.
   *
   * @param messageId - The message ID.
   */
  async markRead(messageId: string): Promise<{ success: boolean }> {
    return this.connection.request("POST", `/v1/inbox/${encodeURIComponent(messageId)}/read`);
  }

  /**
   * Get unread message count.
   */
  async getUnreadCount(): Promise<{ unreadCount: number }> {
    return this.connection.request("GET", "/v1/inbox/unread");
  }

  /**
   * Delete a message from inbox.
   *
   * @param messageId - The message ID.
   */
  async deleteMessage(messageId: string): Promise<{ success: boolean }> {
    return this.connection.request("DELETE", `/v1/inbox/${encodeURIComponent(messageId)}`);
  }

  /**
   * Register a callback for incoming messages.
   *
   * This is a convenience wrapper around the ConnectionManager's
   * event system. The handler fires when a `message.received`
   * event arrives over WebSocket.
   *
   * @param handler - Callback invoked with the event data.
   */
  onMessage(handler: EventHandler): void {
    this.connection.on("message.received", handler);
  }

  /**
   * Remove a previously registered message handler.
   *
   * @param handler - The handler to remove.
   */
  offMessage(handler: EventHandler): void {
    this.connection.off("message.received", handler);
  }
}
