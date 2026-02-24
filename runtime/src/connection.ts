/**
 * Connection manager for the Nookplot Agent Runtime SDK.
 *
 * Handles HTTP requests to the gateway REST API and maintains
 * a persistent WebSocket connection for real-time events.
 *
 * @module connection
 */

import WebSocket from "ws";
import type {
  RuntimeConfig,
  ConnectionState,
  ConnectResult,
  GatewayStatus,
  AgentPresence,
  HttpMethod,
  RuntimeEvent,
  EventHandler,
} from "./types.js";

/** Default reconnect settings. */
const DEFAULT_RECONNECT = {
  maxRetries: 10,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** Default heartbeat interval. */
const DEFAULT_HEARTBEAT_MS = 30000;

export class ConnectionManager {
  private readonly config: RuntimeConfig;
  private readonly baseUrl: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private _state: ConnectionState = "disconnected";
  private _sessionId: string | null = null;
  private _agentId: string | null = null;
  private _address: string | null = null;

  /** Event handlers keyed by event type. */
  private handlers = new Map<string, Set<EventHandler>>();

  /** State change listeners. */
  private stateListeners = new Set<(state: ConnectionState) => void>();

  constructor(config: RuntimeConfig) {
    this.config = config;
    // Normalize URL: strip trailing slash
    this.baseUrl = config.gatewayUrl.replace(/\/+$/, "");
  }

  // ============================================================
  //  Public Getters
  // ============================================================

  get state(): ConnectionState { return this._state; }
  get sessionId(): string | null { return this._sessionId; }
  get agentId(): string | null { return this._agentId; }
  get address(): string | null { return this._address; }
  /** Agent private key for signing on-chain transactions (optional). */
  get privateKey(): string | null { return this.config.privateKey ?? null; }

  // ============================================================
  //  HTTP Client
  // ============================================================

  /**
   * Make an authenticated HTTP request to the gateway.
   */
  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    _retries = 4,
    _attempt = 0,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    // Auto-retry on 429 (rate limited) with exponential backoff + jitter.
    // Default: up to 4 retries with 5s → 10s → 20s → 40s delays.
    if (response.status === 429 && _retries > 0) {
      const retryAfter = parseFloat(response.headers.get("retry-after") ?? "0") * 1000;
      // Exponential backoff: 5s, 10s, 20s, 40s — capped at 60s
      const expDelay = Math.min(5000 * Math.pow(2, _attempt), 60_000);
      // Use the larger of Retry-After header and exponential delay
      const baseDelay = Math.max(retryAfter, expDelay);
      // Add jitter (±20%) to avoid thundering herd
      const delay = baseDelay * (0.8 + Math.random() * 0.4);
      console.log(`[nookplot-runtime] Rate limited (429) — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${_attempt + 1}/${_attempt + _retries})`);
      await new Promise((r) => setTimeout(r, delay));
      return this.request<T>(method, path, body, _retries - 1, _attempt + 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed.message || parsed.error || errorBody;
      } catch {
        errorMessage = errorBody;
      }
      // SECURITY: Don't leak internal gateway path structure in errors
      throw new Error(`Gateway request failed (${response.status}): ${errorMessage}`);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ============================================================
  //  Connection Lifecycle
  // ============================================================

  /**
   * Connect to the gateway — establish HTTP session and WebSocket.
   */
  async connect(): Promise<ConnectResult> {
    if (this._state === "connected") {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.setState("connecting");
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    // 1. Register session via HTTP
    const result = await this.request<ConnectResult>("POST", "/v1/runtime/connect");
    this._sessionId = result.sessionId;
    this._agentId = result.agentId;
    this._address = result.address;

    // 2. Get WS ticket
    const ticket = await this.request<{ ticket: string }>("POST", "/v1/ws/ticket");

    // 3. Open WebSocket
    await this.openWebSocket(ticket.ticket);

    // 4. Start heartbeat
    this.startHeartbeat();

    // 5. Auto-subscribe to channels the agent is a member of
    try {
      const channelData = await this.request<{ channels: Array<{ id: string; isMember: boolean; slug?: string }> }>(
        "GET", "/v1/channels?limit=50",
      );
      for (const ch of channelData.channels ?? []) {
        if (ch.isMember) {
          this.sendWs({ type: "channel.subscribe", channelId: ch.id });
        }
      }
    } catch {
      // Non-fatal — agent may not have any channels yet
    }

    this.setState("connected");
    return result;
  }

  /**
   * Disconnect from the gateway — close WebSocket and clean up session.
   */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, "client disconnect");
      this.ws = null;
    }

    // Notify gateway
    if (this._sessionId) {
      try {
        await this.request("POST", "/v1/runtime/disconnect", {
          sessionId: this._sessionId,
        });
      } catch {
        // Best-effort cleanup — don't throw on disconnect failure
      }
    }

    this._sessionId = null;
    this._agentId = null;
    this._address = null;
    this.setState("disconnected");
  }

  /**
   * Get current connection status from the gateway.
   */
  async getStatus(): Promise<GatewayStatus> {
    return this.request<GatewayStatus>("GET", "/v1/runtime/status");
  }

  /**
   * Get list of currently connected agents (presence).
   */
  async getPresence(limit = 50, offset = 0): Promise<AgentPresence[]> {
    return this.request<AgentPresence[]>(
      "GET",
      `/v1/runtime/presence?limit=${limit}&offset=${offset}`,
    );
  }

  // ============================================================
  //  WebSocket Messaging
  // ============================================================

  /**
   * Send a JSON message over the WebSocket connection.
   * Used by managers (e.g., ChannelManager) to send subscribe/unsubscribe messages.
   */
  sendWs(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // ============================================================
  //  Event Subscription
  // ============================================================

  /**
   * Subscribe to an event type.
   */
  on(eventType: string, handler: EventHandler): void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);
  }

  /**
   * Unsubscribe from an event type.
   */
  off(eventType: string, handler?: EventHandler): void {
    if (!handler) {
      this.handlers.delete(eventType);
      return;
    }
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(eventType);
    }
  }

  /**
   * Listen for connection state changes.
   */
  onStateChange(listener: (state: ConnectionState) => void): void {
    this.stateListeners.add(listener);
  }

  /**
   * Remove a state change listener.
   */
  offStateChange(listener: (state: ConnectionState) => void): void {
    this.stateListeners.delete(listener);
  }

  // ============================================================
  //  WebSocket Internals
  // ============================================================

  private openWebSocket(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, "ws");
      const url = `${wsUrl}/ws/runtime?ticket=${encodeURIComponent(ticket)}`;

      this.ws = new WebSocket(url);

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      };

      const cleanup = () => {
        this.ws?.removeListener("open", onOpen);
        this.ws?.removeListener("error", onError);
      };

      this.ws.on("open", onOpen);
      this.ws.on("error", onError);

      // Attach persistent handlers after initial connection
      this.ws.on("message", (data) => this.handleWsMessage(data));
      this.ws.on("close", (code, reason) => this.handleWsClose(code, reason));
      this.ws.on("error", (err) => this.handleWsError(err));
    });
  }

  private handleWsMessage(data: WebSocket.RawData): void {
    try {
      const event = JSON.parse(data.toString()) as RuntimeEvent;
      const handlers = this.handlers.get(event.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            // Swallow async errors from handlers — don't crash the connection
            if (result instanceof Promise) {
              result.catch(() => {});
            }
          } catch {
            // Swallow sync errors from handlers
          }
        }
      }

      // Also emit to wildcard handlers
      const wildcardHandlers = this.handlers.get("*");
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            const result = handler(event);
            if (result instanceof Promise) result.catch(() => {});
          } catch {
            // Swallow
          }
        }
      }
    } catch {
      // Ignore non-JSON messages (e.g., pong frames)
    }
  }

  private handleWsClose(_code: number, _reason: Buffer): void {
    this.ws = null;
    if (!this.intentionalClose) {
      this.attemptReconnect();
    }
  }

  private handleWsError(_err: Error): void {
    // WebSocket errors are followed by close events — reconnect happens there
  }

  // ============================================================
  //  Reconnection Logic
  // ============================================================

  private attemptReconnect(): void {
    const settings = { ...DEFAULT_RECONNECT, ...this.config.reconnect };

    if (this.reconnectAttempts >= settings.maxRetries) {
      this.setState("disconnected");
      this.emitEvent({
        type: "connection.state",
        timestamp: new Date().toISOString(),
        data: { state: "failed", reason: "max retries exceeded" },
      });
      return;
    }

    this.setState("reconnecting");
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      settings.initialDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      settings.maxDelayMs,
    ) + Math.random() * 1000;

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Re-establish the full connection
        const result = await this.request<ConnectResult>("POST", "/v1/runtime/connect");
        this._sessionId = result.sessionId;

        const ticket = await this.request<{ ticket: string }>("POST", "/v1/ws/ticket");
        await this.openWebSocket(ticket.ticket);

        this.reconnectAttempts = 0;
        this.startHeartbeat();

        // Re-subscribe to channels after reconnect
        try {
          const channelData = await this.request<{ channels: Array<{ id: string; isMember: boolean }> }>(
            "GET", "/v1/channels?limit=50",
          );
          for (const ch of channelData.channels ?? []) {
            if (ch.isMember) {
              this.sendWs({ type: "channel.subscribe", channelId: ch.id });
            }
          }
        } catch { /* non-fatal */ }

        this.setState("connected");
      } catch {
        this.attemptReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============================================================
  //  Heartbeat
  // ============================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    // Send heartbeat over WebSocket if connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() }));
    }
  }

  // ============================================================
  //  State Management
  // ============================================================

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* swallow */ }
    }
  }

  private emitEvent(event: RuntimeEvent): void {
    this.handleWsMessage(Buffer.from(JSON.stringify(event)));
  }
}
