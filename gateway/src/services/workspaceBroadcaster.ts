/**
 * Workspace broadcaster — manages workspace subscriptions on WebSocket
 * connections and fans out state-change events to subscribed agents.
 *
 * Mirrors the ChannelBroadcaster pattern: tracks workspaceId → Set<agentId>
 * for active subscribers. When a state event arrives on the message bus for
 * ws:{workspaceId}, fans out to all subscribed agents' WebSocket connections
 * via RuntimeEventBroadcaster.
 *
 * @module services/workspaceBroadcaster
 */

import type { MessageBus } from "./messageBus.js";
import type { RuntimeEventBroadcaster } from "./runtimeEventBroadcaster.js";
import type { WorkspaceService } from "./workspaceService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Maximum workspace subscriptions per agent WebSocket connection. */
const MAX_SUBSCRIPTIONS_PER_AGENT = 25;

export class WorkspaceBroadcaster {
  private readonly messageBus: MessageBus;
  private readonly eventBroadcaster: RuntimeEventBroadcaster;
  private readonly workspaceService: WorkspaceService;

  /** workspaceId → Set<agentId> for active subscribers. */
  private readonly subscriptions = new Map<string, Set<string>>();

  /** agentId → Set<workspaceId> for reverse lookup + cap enforcement. */
  private readonly agentWorkspaces = new Map<string, Set<string>>();

  /** Bus unsubscribe function. */
  private busUnsubscribe: (() => void) | null = null;

  constructor(
    messageBus: MessageBus,
    eventBroadcaster: RuntimeEventBroadcaster,
    workspaceService: WorkspaceService,
  ) {
    this.messageBus = messageBus;
    this.eventBroadcaster = eventBroadcaster;
    this.workspaceService = workspaceService;

    // Subscribe to all workspace messages on the bus
    this.busUnsubscribe = messageBus.subscribePattern("ws:", (channel, message) => {
      const workspaceId = channel.slice(3); // Strip "ws:" prefix
      this.fanOut(workspaceId, message);
    });
  }

  /**
   * Subscribe an agent to real-time workspace state events.
   * Verifies membership before allowing subscription.
   */
  async subscribe(agentId: string, workspaceId: string): Promise<boolean> {
    // Check subscription cap
    const agentSubs = this.agentWorkspaces.get(agentId);
    if (agentSubs && agentSubs.size >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      logSecurityEvent("warn", "workspace-sub-cap-reached", {
        agentId,
        workspaceId,
        current: agentSubs.size,
      });
      return false;
    }

    // Verify membership
    const isMember = await this.workspaceService.isMember(workspaceId, agentId);
    if (!isMember) {
      return false;
    }

    // Add to subscription maps
    if (!this.subscriptions.has(workspaceId)) {
      this.subscriptions.set(workspaceId, new Set());
    }
    this.subscriptions.get(workspaceId)!.add(agentId);

    if (!this.agentWorkspaces.has(agentId)) {
      this.agentWorkspaces.set(agentId, new Set());
    }
    this.agentWorkspaces.get(agentId)!.add(workspaceId);

    return true;
  }

  /**
   * Unsubscribe an agent from workspace state events.
   */
  unsubscribe(agentId: string, workspaceId: string): void {
    this.subscriptions.get(workspaceId)?.delete(agentId);
    if (this.subscriptions.get(workspaceId)?.size === 0) {
      this.subscriptions.delete(workspaceId);
    }

    this.agentWorkspaces.get(agentId)?.delete(workspaceId);
    if (this.agentWorkspaces.get(agentId)?.size === 0) {
      this.agentWorkspaces.delete(agentId);
    }
  }

  /**
   * Remove all subscriptions for an agent (on disconnect).
   */
  removeAgent(agentId: string): void {
    const workspaces = this.agentWorkspaces.get(agentId);
    if (workspaces) {
      for (const workspaceId of workspaces) {
        this.subscriptions.get(workspaceId)?.delete(agentId);
        if (this.subscriptions.get(workspaceId)?.size === 0) {
          this.subscriptions.delete(workspaceId);
        }
      }
    }
    this.agentWorkspaces.delete(agentId);
  }

  /**
   * Get workspaces an agent is subscribed to.
   */
  getAgentSubscriptions(agentId: string): string[] {
    return [...(this.agentWorkspaces.get(agentId) ?? [])];
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
    this.agentWorkspaces.clear();
  }

  // ============================================================
  //  Internal
  // ============================================================

  /**
   * Fan out a message to all agents subscribed to a workspace.
   */
  private fanOut(workspaceId: string, message: { type: string; timestamp: string; data: Record<string, unknown> }): void {
    const subscribers = this.subscriptions.get(workspaceId);
    if (!subscribers || subscribers.size === 0) return;

    for (const agentId of subscribers) {
      // Don't echo back to sender
      const senderId = message.data.agentId as string | undefined;
      if (senderId && senderId === agentId) continue;

      this.eventBroadcaster.broadcast(agentId, {
        type: message.type,
        timestamp: message.timestamp,
        data: message.data,
      });
    }
  }
}
