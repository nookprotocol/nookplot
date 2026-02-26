/**
 * Channel broadcaster — manages channel subscriptions on WebSocket connections
 * and fans out channel messages to subscribed agents.
 *
 * Tracks channelId → Set<agentId> for active subscribers. When a message
 * arrives on the message bus for ch:{channelId}, fans out to all subscribed
 * agents' WebSocket connections via RuntimeEventBroadcaster.
 *
 * @module services/channelBroadcaster
 */

import type { MessageBus } from "./messageBus.js";
import type { RuntimeEventBroadcaster } from "./runtimeEventBroadcaster.js";
import type { ChannelService } from "./channelService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Maximum channel subscriptions per agent WebSocket connection. */
const MAX_SUBSCRIPTIONS_PER_AGENT = 50;

export class ChannelBroadcaster {
  private readonly messageBus: MessageBus;
  private readonly eventBroadcaster: RuntimeEventBroadcaster;
  private readonly channelService: ChannelService;

  /** channelId → Set<agentId> for active subscribers. */
  private readonly subscriptions = new Map<string, Set<string>>();

  /** agentId → Set<channelId> for reverse lookup + cap enforcement. */
  private readonly agentChannels = new Map<string, Set<string>>();

  /** Bus unsubscribe function. */
  private busUnsubscribe: (() => void) | null = null;

  constructor(
    messageBus: MessageBus,
    eventBroadcaster: RuntimeEventBroadcaster,
    channelService: ChannelService,
  ) {
    this.messageBus = messageBus;
    this.eventBroadcaster = eventBroadcaster;
    this.channelService = channelService;

    // Subscribe to all channel messages on the bus
    this.busUnsubscribe = messageBus.subscribePattern("ch:", (channel, message) => {
      const channelId = channel.slice(3); // Strip "ch:" prefix
      this.fanOut(channelId, message);
    });
  }

  /**
   * Subscribe an agent to real-time channel messages.
   * Verifies membership before allowing subscription.
   */
  async subscribe(agentId: string, channelId: string): Promise<boolean> {
    // Check subscription cap
    const agentSubs = this.agentChannels.get(agentId);
    if (agentSubs && agentSubs.size >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      logSecurityEvent("warn", "channel-sub-cap-reached", {
        agentId,
        channelId,
        current: agentSubs.size,
      });
      return false;
    }

    // Verify membership
    const isMember = await this.channelService.isMember(channelId, agentId);
    if (!isMember) {
      return false;
    }

    // Add to subscription maps
    if (!this.subscriptions.has(channelId)) {
      this.subscriptions.set(channelId, new Set());
    }
    this.subscriptions.get(channelId)!.add(agentId);

    if (!this.agentChannels.has(agentId)) {
      this.agentChannels.set(agentId, new Set());
    }
    this.agentChannels.get(agentId)!.add(channelId);

    return true;
  }

  /**
   * Unsubscribe an agent from channel messages.
   */
  unsubscribe(agentId: string, channelId: string): void {
    this.subscriptions.get(channelId)?.delete(agentId);
    if (this.subscriptions.get(channelId)?.size === 0) {
      this.subscriptions.delete(channelId);
    }

    this.agentChannels.get(agentId)?.delete(channelId);
    if (this.agentChannels.get(agentId)?.size === 0) {
      this.agentChannels.delete(agentId);
    }
  }

  /**
   * Remove all subscriptions for an agent (on disconnect).
   */
  removeAgent(agentId: string): void {
    const channels = this.agentChannels.get(agentId);
    if (channels) {
      for (const channelId of channels) {
        this.subscriptions.get(channelId)?.delete(agentId);
        if (this.subscriptions.get(channelId)?.size === 0) {
          this.subscriptions.delete(channelId);
        }
      }
    }
    this.agentChannels.delete(agentId);
  }

  /**
   * Get channels an agent is subscribed to.
   */
  getAgentSubscriptions(agentId: string): string[] {
    return [...(this.agentChannels.get(agentId) ?? [])];
  }

  /**
   * Shut down the broadcaster.
   */
  shutdown(): void {
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
    this.subscriptions.clear();
    this.agentChannels.clear();
  }

  // ============================================================
  //  Internal
  // ============================================================

  /**
   * Fan out a message to all agents subscribed to a channel.
   */
  private fanOut(channelId: string, message: { type: string; timestamp: string; data: Record<string, unknown> }): void {
    const subscribers = this.subscriptions.get(channelId);
    if (!subscribers || subscribers.size === 0) return;

    for (const agentId of subscribers) {
      // Don't echo back to sender
      const senderId = message.data.fromAgentId as string | undefined;
      if (senderId && senderId === agentId) continue;

      this.eventBroadcaster.broadcast(agentId, {
        type: message.type,
        timestamp: message.timestamp,
        data: message.data,
      });
    }
  }
}
