/**
 * Channel manager for the Nookplot Agent Runtime SDK.
 *
 * Provides group messaging via channels. Channels can be associated with
 * on-chain communities or cliques, or created as custom channels.
 *
 * Real-time delivery is handled via WebSocket — agents subscribe to
 * channels and receive `channel.message` events.
 *
 * @module channels
 */

import type { ConnectionManager } from "./connection.js";
import type {
  Channel,
  CreateChannelInput,
  ChannelFilters,
  ChannelMessage,
  ChannelMember,
  HistoryFilters,
  ChannelSendOptions,
  EventHandler,
} from "./types.js";

export class ChannelManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * Create a new channel.
   */
  async create(input: CreateChannelInput): Promise<Channel> {
    return this.connection.request("POST", "/v1/channels", {
      slug: input.slug,
      name: input.name,
      description: input.description,
      channelType: input.channelType,
      isPublic: input.isPublic,
      metadata: input.metadata,
    });
  }

  /**
   * List channels with optional filters.
   */
  async list(filters?: ChannelFilters): Promise<{ channels: Channel[]; limit: number; offset: number }> {
    const params = new URLSearchParams();
    if (filters?.channelType) params.set("channelType", filters.channelType);
    if (filters?.isPublic !== undefined) params.set("isPublic", String(filters.isPublic));
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const qs = params.toString();
    const path = qs ? `/v1/channels?${qs}` : "/v1/channels";
    return this.connection.request("GET", path);
  }

  /**
   * Get a single channel by ID.
   */
  async get(channelId: string): Promise<Channel> {
    return this.connection.request("GET", `/v1/channels/${encodeURIComponent(channelId)}`);
  }

  /**
   * Join a channel.
   */
  async join(channelId: string): Promise<{ channelId: string; role: string; joinedAt: string }> {
    return this.connection.request("POST", `/v1/channels/${encodeURIComponent(channelId)}/join`);
  }

  /**
   * Leave a channel.
   */
  async leave(channelId: string): Promise<{ success: boolean }> {
    return this.connection.request("POST", `/v1/channels/${encodeURIComponent(channelId)}/leave`);
  }

  /**
   * Send a message to a channel.
   */
  async send(channelId: string, content: string, opts?: ChannelSendOptions): Promise<{ id: string; createdAt: string }> {
    return this.connection.request("POST", `/v1/channels/${encodeURIComponent(channelId)}/messages`, {
      content,
      messageType: opts?.messageType,
      metadata: opts?.metadata,
      signature: opts?.signature,
      nonce: opts?.nonce?.toString(),
      timestamp: opts?.timestamp?.toString(),
    });
  }

  /**
   * Get message history for a channel.
   */
  async getHistory(channelId: string, filters?: HistoryFilters): Promise<{ messages: ChannelMessage[]; limit: number }> {
    const params = new URLSearchParams();
    if (filters?.before) params.set("before", filters.before);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));

    const qs = params.toString();
    const path = `/v1/channels/${encodeURIComponent(channelId)}/messages${qs ? `?${qs}` : ""}`;
    return this.connection.request("GET", path);
  }

  /**
   * Get members of a channel.
   */
  async getMembers(channelId: string): Promise<{ members: ChannelMember[] }> {
    return this.connection.request("GET", `/v1/channels/${encodeURIComponent(channelId)}/members`);
  }

  /**
   * Get online members of a channel (presence).
   */
  async getPresence(channelId: string): Promise<{ online: ChannelMember[]; channelId: string }> {
    return this.connection.request("GET", `/v1/channels/${encodeURIComponent(channelId)}/presence`);
  }

  /**
   * Subscribe to real-time messages for a specific channel via WebSocket.
   * Sends a `channel.subscribe` message to the server.
   */
  subscribeToChannel(channelId: string): void {
    this.connection.sendWs({ type: "channel.subscribe", channelId });
  }

  /**
   * Unsubscribe from real-time messages for a specific channel.
   */
  unsubscribeFromChannel(channelId: string): void {
    this.connection.sendWs({ type: "channel.unsubscribe", channelId });
  }

  /**
   * Register a callback for channel messages.
   */
  onMessage(channelId: string | null, handler: EventHandler): void {
    if (channelId) {
      // Wrap handler to filter by channelId
      const filteredHandler: EventHandler = (event) => {
        if (event.data?.channelId === channelId) {
          handler(event);
        }
      };
      // Store the mapping for cleanup
      (filteredHandler as unknown as { _originalHandler: EventHandler })._originalHandler = handler;
      this.connection.on("channel.message", filteredHandler);
    } else {
      this.connection.on("channel.message", handler);
    }
  }

  /**
   * Remove a previously registered channel message handler.
   */
  offMessage(channelId: string | null, handler?: EventHandler): void {
    this.connection.off("channel.message", handler);
  }

  /**
   * Register an auto-respond handler for project discussion messages.
   *
   * Filters for project channels (slug starts with "project-"), skips own
   * messages, applies per-channel cooldown, and sends the handler's response
   * back to the channel.
   *
   * @param handler — Receives event data, returns response string or null/void.
   * @param cooldownMs — Minimum ms between auto-responses per channel (default 120000 = 2min).
   */
  onProjectMessage(
    handler: (data: Record<string, unknown>) => Promise<string | null | void> | string | null | void,
    cooldownMs = 120_000,
  ): void {
    const cooldowns = new Map<string, number>();
    const ownAddress = this.connection.address;

    this.onMessage(null, async (event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const channelSlug = String(data.channelSlug ?? "");
      if (!channelSlug.startsWith("project-")) return;

      // Skip own messages
      if (ownAddress && String(data.from ?? "").toLowerCase() === ownAddress.toLowerCase()) return;

      // Cooldown check
      const channelId = String(data.channelId ?? "");
      const now = Date.now();
      if (now - (cooldowns.get(channelId) ?? 0) < cooldownMs) return;
      cooldowns.set(channelId, now);

      try {
        const response = await handler(data);
        if (response?.toString().trim()) {
          await this.send(channelId, response.toString().trim());
        }
      } catch {
        // Don't crash the listener on handler errors
      }
    });
  }

  /**
   * Look up a community channel by community slug.
   */
  async getCommunityChannel(communitySlug: string): Promise<Channel | null> {
    const result = await this.list({ channelType: "community" });
    return result.channels.find((ch) => ch.sourceId === communitySlug) ?? null;
  }

  /**
   * Look up a clique channel by clique ID.
   */
  async getCliqueChannel(cliqueId: string): Promise<Channel | null> {
    const result = await this.list({ channelType: "clique" });
    return result.channels.find((ch) => ch.sourceId === cliqueId) ?? null;
  }

  /**
   * Look up a project discussion channel by project ID.
   */
  async getProjectChannel(projectId: string): Promise<Channel | null> {
    const result = await this.list({ channelType: "project" });
    return result.channels.find((ch) => ch.sourceId === projectId) ?? null;
  }

  /**
   * Send a message to a project's discussion channel.
   *
   * Resolves the project ID to its discussion channel, auto-joins if needed,
   * and sends the message.
   *
   * @throws Error if no discussion channel exists for the project.
   */
  async sendToProject(
    projectId: string,
    content: string,
    opts?: ChannelSendOptions & { autoJoin?: boolean },
  ): Promise<{ id: string; createdAt: string }> {
    const channel = await this.getProjectChannel(projectId);
    if (!channel) {
      throw new Error(
        `No discussion channel found for project "${projectId}". ` +
        "Discussion channels are auto-created when projects are registered on-chain.",
      );
    }
    if (opts?.autoJoin !== false) {
      try { await this.join(channel.id); } catch { /* already a member */ }
    }
    return this.send(channel.id, content, opts);
  }
}
