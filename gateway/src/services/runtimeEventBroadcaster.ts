/**
 * Runtime event broadcaster — delivers real-time events to connected agents.
 *
 * Manages WebSocket connections for runtime SDK clients, handles
 * heartbeat messages, and broadcasts events to specific agents
 * or all connected agents.
 *
 * Uses the same `noServer: true` + manual upgrade pattern as
 * CollabServer and ExecServer.
 *
 * @module services/runtimeEventBroadcaster
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type pg from "pg";
import type { RuntimeSessionManager } from "./runtimeSessionManager.js";
import type { MessageBus } from "./messageBus.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "./subgraphGateway.js";

/** A runtime event sent over WebSocket. */
export interface RuntimeWsEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** WS message from client (heartbeat, subscribe, etc.). */
interface ClientMessage {
  type: string;
  timestamp?: string;
  eventTypes?: string[];
  channelId?: string;
}

export class RuntimeEventBroadcaster {
  private readonly pool: pg.Pool;
  private readonly sessionManager: RuntimeSessionManager;
  private readonly hmacSecret: string;
  private readonly wss: WebSocketServer;

  /** Map of agentId -> Set of WebSocket connections. */
  private readonly connections = new Map<string, Set<WebSocket>>();

  /** Map of WebSocket -> agentId (reverse lookup). */
  private readonly wsToAgent = new Map<WebSocket, string>();

  /** MEDIUM-3: Maximum WebSocket connections per agent to prevent DoS. */
  private readonly maxConnectionsPerAgent = 3;

  /** Subgraph polling interval. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly subgraphGateway: SubgraphGateway | undefined;
  private lastPollTimestamp = Math.floor(Date.now() / 1000).toString();

  /** Optional message bus for decoupled message routing. */
  private readonly messageBus: MessageBus | undefined;
  private dmUnsubscribe: (() => void) | null = null;

  /** Optional channel broadcaster for WebSocket channel subscriptions. */
  private channelBroadcaster: { subscribe: (agentId: string, channelId: string) => Promise<boolean>; unsubscribe: (agentId: string, channelId: string) => void; removeAgent: (agentId: string) => void } | null = null;

  /** Optional proactive scheduler for reactive signals on new posts/comments. */
  private proactiveScheduler: { handleReactiveSignal: (agentId: string, signal: { signalType: string; channelId?: string; channelName?: string; senderId?: string; senderAddress?: string; messagePreview?: string; community?: string; postCid?: string }) => Promise<void> } | null = null;

  constructor(
    pool: pg.Pool,
    sessionManager: RuntimeSessionManager,
    hmacSecret: string,
    subgraphGateway?: SubgraphGateway,
    pollIntervalMs = 10_000,
    messageBus?: MessageBus,
  ) {
    this.pool = pool;
    this.sessionManager = sessionManager;
    this.hmacSecret = hmacSecret;
    this.subgraphGateway = subgraphGateway;
    this.messageBus = messageBus;

    // Create WebSocket server in noServer mode
    this.wss = new WebSocketServer({ noServer: true });

    // Start subgraph polling if endpoint configured
    if (subgraphGateway && pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.pollForEvents().catch((err) => {
          logSecurityEvent("warn", "event-broadcaster-poll-failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, pollIntervalMs);
    }

    // Subscribe to DM messages on the bus and route to WebSocket connections
    if (messageBus) {
      this.dmUnsubscribe = messageBus.subscribePattern("dm:", (channel, message) => {
        // Channel format: dm:{agentId}
        const agentId = channel.slice(3);
        this.broadcast(agentId, {
          type: message.type,
          timestamp: message.timestamp,
          data: message.data,
        });
      });
    }
  }

  /**
   * Set the channel broadcaster for handling channel subscribe/unsubscribe
   * WebSocket messages. Set after construction to avoid circular dependency.
   */
  setChannelBroadcaster(broadcaster: { subscribe: (agentId: string, channelId: string) => Promise<boolean>; unsubscribe: (agentId: string, channelId: string) => void; removeAgent: (agentId: string) => void }): void {
    this.channelBroadcaster = broadcaster;
  }

  /**
   * Set the proactive scheduler for emitting reactive signals when new
   * posts/comments are discovered via subgraph polling.
   */
  setProactiveScheduler(scheduler: { handleReactiveSignal: (agentId: string, signal: { signalType: string; channelId?: string; channelName?: string; senderId?: string; senderAddress?: string; messagePreview?: string; community?: string; postCid?: string }) => Promise<void> }): void {
    this.proactiveScheduler = scheduler;
  }

  /**
   * Handle HTTP upgrade to WebSocket for /ws/runtime connections.
   *
   * Authenticates via WS ticket query parameter, then upgrades.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ticket = url.searchParams.get("ticket");

    if (!ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Validate ticket from database
    this.validateTicket(ticket)
      .then((agentId) => {
        if (!agentId) {
          socket.write("HTTP/1.1 401 Invalid ticket\r\n\r\n");
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.registerConnection(agentId, ws);
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  }

  /**
   * Broadcast an event to a specific agent.
   */
  broadcast(agentId: string, event: RuntimeWsEvent): void {
    const conns = this.connections.get(agentId);
    if (!conns) return;

    const msg = JSON.stringify(event);
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * Broadcast an event to all connected agents.
   */
  broadcastToAll(event: RuntimeWsEvent): void {
    const msg = JSON.stringify(event);
    for (const conns of this.connections.values()) {
      for (const ws of conns) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
    }
  }

  /**
   * Get the number of currently connected agents.
   */
  get connectedCount(): number {
    return this.connections.size;
  }

  /**
   * Shut down the broadcaster.
   */
  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Unsubscribe from message bus
    if (this.dmUnsubscribe) {
      this.dmUnsubscribe();
      this.dmUnsubscribe = null;
    }

    // Close all connections
    for (const conns of this.connections.values()) {
      for (const ws of conns) {
        ws.close(1001, "server shutdown");
      }
    }
    this.connections.clear();
    this.wsToAgent.clear();
    this.wss.close();
  }

  // ============================================================
  //  Internal Methods
  // ============================================================

  private registerConnection(agentId: string, ws: WebSocket): boolean {
    // Enforce per-agent connection cap — reject new connections at limit.
    // Closing the oldest (previous behavior) creates a DoS vector where
    // an attacker constantly reconnects to kick legitimate connections.
    const conns = this.connections.get(agentId);
    if (conns && conns.size >= this.maxConnectionsPerAgent) {
      ws.close(1008, "connection limit exceeded — close an existing connection first");
      return false;
    }

    // Add to connection maps
    let agentConns = conns;
    if (!agentConns) {
      agentConns = new Set();
      this.connections.set(agentId, agentConns);
    }
    agentConns.add(ws);
    this.wsToAgent.set(ws, agentId);

    logSecurityEvent("info", "runtime-ws-connected", {
      agentId,
      totalConnections: this.connectedCount,
    });

    // Auto-enable proactive settings for connected agents (ensures enabled=true on every reconnect)
    this.pool.query(
      `INSERT INTO proactive_settings (agent_id, enabled, scan_interval_minutes, max_credits_per_cycle, max_actions_per_day)
       VALUES ($1, true, 60, 5000, 10)
       ON CONFLICT (agent_id) DO UPDATE SET enabled = true`,
      [agentId],
    ).catch((err) => {
      logSecurityEvent("warn", "proactive-auto-enable-failed", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Handle incoming messages
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(agentId, msg, ws);
      } catch {
        // Ignore non-JSON messages
      }
    });

    // Handle disconnect
    ws.on("close", () => {
      this.unregisterConnection(agentId, ws);
    });

    ws.on("error", () => {
      this.unregisterConnection(agentId, ws);
    });

    // Send welcome event
    ws.send(JSON.stringify({
      type: "connection.state",
      timestamp: new Date().toISOString(),
      data: { state: "connected", agentId },
    }));

    return true;
  }

  private unregisterConnection(agentId: string, ws: WebSocket): void {
    const conns = this.connections.get(agentId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        this.connections.delete(agentId);
        // Clean up channel subscriptions when agent fully disconnects
        if (this.channelBroadcaster) {
          this.channelBroadcaster.removeAgent(agentId);
        }
      }
    }
    this.wsToAgent.delete(ws);

    logSecurityEvent("info", "runtime-ws-disconnected", {
      agentId,
      totalConnections: this.connectedCount,
    });
  }

  private handleClientMessage(agentId: string, msg: ClientMessage, ws?: WebSocket): void {
    switch (msg.type) {
      case "heartbeat":
        // Update session heartbeat
        this.sessionManager.getActiveSession(agentId)
          .then((session) => {
            if (session) {
              return this.sessionManager.heartbeat(session.sessionId);
            }
          })
          .catch((err) => {
            logSecurityEvent("warn", "event-broadcaster-heartbeat-failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;

      case "channel.subscribe":
        if (this.channelBroadcaster && msg.channelId) {
          this.channelBroadcaster.subscribe(agentId, msg.channelId)
            .then((ok) => {
              const responseWs = ws ?? this.getFirstConnection(agentId);
              if (responseWs && responseWs.readyState === WebSocket.OPEN) {
                responseWs.send(JSON.stringify({
                  type: ok ? "channel.joined" : "channel.error",
                  timestamp: new Date().toISOString(),
                  data: { channelId: msg.channelId, error: ok ? undefined : "Cannot subscribe — not a member or limit reached" },
                }));
              }
            })
            .catch((err) => {
              logSecurityEvent("warn", "event-broadcaster-channel-subscribe-failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
        break;

      case "channel.unsubscribe":
        if (this.channelBroadcaster && msg.channelId) {
          this.channelBroadcaster.unsubscribe(agentId, msg.channelId);
          const responseWs = ws ?? this.getFirstConnection(agentId);
          if (responseWs && responseWs.readyState === WebSocket.OPEN) {
            responseWs.send(JSON.stringify({
              type: "channel.left",
              timestamp: new Date().toISOString(),
              data: { channelId: msg.channelId },
            }));
          }
        }
        break;

      default:
        break;
    }
  }

  /** Get first open WS connection for an agent. */
  private getFirstConnection(agentId: string): WebSocket | undefined {
    const conns = this.connections.get(agentId);
    if (!conns) return undefined;
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return undefined;
  }

  private async validateTicket(ticket: string): Promise<string | null> {
    // WS tickets are stored by the wsTicket route as short-lived tokens.
    // SECURITY NOTE: DELETE ... RETURNING is atomic in PostgreSQL — if two
    // concurrent connections try the same ticket, only one DELETE succeeds
    // (Postgres acquires a row lock). This prevents ticket reuse races.
    const { rows } = await this.pool.query<{ agent_id: string }>(
      `DELETE FROM ws_tickets
       WHERE id = $1 AND used = FALSE AND expires_at > NOW()
       RETURNING agent_id`,
      [ticket],
    );
    return rows.length > 0 ? rows[0].agent_id : null;
  }

  /**
   * Poll subgraph for new events and broadcast to relevant agents.
   */
  private async pollForEvents(): Promise<void> {
    if (!this.subgraphGateway || this.connections.size === 0) return;

    try {
      // Get new content entries since last poll
      // SECURITY: lastPollTimestamp is internally managed. Belt-and-suspenders:
      // parse as integer to guarantee no injection (The Graph doesn't support
      // GraphQL variables, so we must interpolate, but only a validated integer).
      const parsedTs = parseInt(this.lastPollTimestamp, 10);
      const safePollTs = Number.isFinite(parsedTs) && parsedTs >= 0 ? String(parsedTs) : "0";
      const query = `{
        contents(
          first: 50
          orderBy: timestamp
          orderDirection: asc
          where: { timestamp_gt: "${safePollTs}" }
        ) {
          cid
          author { id }
          community { id }
          score
          timestamp
        }
      }`;

      const sgResult = await this.subgraphGateway!.query<{ contents?: Array<{
        cid: string; author: { id: string }; community: { id: string };
        score: number; timestamp: string;
      }> }>(query);

      const entries = sgResult.data?.contents ?? [];
      if (entries.length === 0) return;

      // Update last poll timestamp
      this.lastPollTimestamp = entries[entries.length - 1].timestamp;

      // Broadcast new post events to all connected agents
      for (const entry of entries) {
        this.broadcastToAll({
          type: "post.new",
          timestamp: new Date(parseInt(entry.timestamp) * 1000).toISOString(),
          data: {
            cid: entry.cid,
            author: entry.author.id,
            community: entry.community.id,
            score: entry.score,
          },
        });

        // Emit reactive signals to proactive agents in this community
        if (this.proactiveScheduler) {
          this.emitPostReactiveSignals(entry).catch((err) => {
            logSecurityEvent("warn", "event-broadcaster-reactive-signal-failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "event-broadcaster-poll-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit reactive signals to proactive agents when a new post is discovered.
   * Finds agents who are members of the post's community and notifies them.
   */
  private async emitPostReactiveSignals(entry: {
    cid: string; author: { id: string }; community: { id: string };
  }): Promise<void> {
    if (!this.proactiveScheduler) return;

    try {
      // Find proactive-enabled agents that are connected (have active sessions)
      // We use connected agents as a proxy for "interested in this community"
      // since community membership is on-chain and we don't have a direct table.
      const connectedAgentIds = [...this.connections.keys()];
      if (connectedAgentIds.length === 0) return;

      // Check which connected agents have proactive enabled
      const placeholders = connectedAgentIds.map((_, i) => `$${i + 1}`).join(", ");
      const { rows: proactiveAgents } = await this.pool.query<{ agent_id: string; address: string }>(
        `SELECT ps.agent_id, a.address
         FROM proactive_settings ps
         JOIN agents a ON a.id = ps.agent_id
         WHERE ps.enabled = true AND ps.agent_id IN (${placeholders})`,
        connectedAgentIds,
      );

      for (const agent of proactiveAgents) {
        // Don't signal the post's own author
        if (agent.address.toLowerCase() === entry.author.id.toLowerCase()) continue;

        this.proactiveScheduler.handleReactiveSignal(agent.agent_id, {
          signalType: "new_post_in_community",
          community: entry.community.id,
          postCid: entry.cid,
          senderAddress: entry.author.id,
        }).catch((err) => {
          logSecurityEvent("warn", "event-broadcaster-reactive-dispatch-failed", {
            agentId: agent.agent_id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logSecurityEvent("warn", "event-broadcaster-reactive-signals-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
