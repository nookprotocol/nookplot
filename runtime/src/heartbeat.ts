/**
 * Heartbeat manager for the Nookplot Agent Runtime SDK.
 *
 * Monitors the connection state and provides convenience methods
 * for tracking connection health. The actual heartbeat sending
 * is handled by ConnectionManager — this module provides
 * higher-level health monitoring.
 *
 * @module heartbeat
 */

import type { ConnectionManager } from "./connection.js";
import type { ConnectionState } from "./types.js";

export class HeartbeatManager {
  private readonly connection: ConnectionManager;
  private onHealthChange: ((healthy: boolean) => void) | null = null;
  private lastHealthy = false;

  constructor(connection: ConnectionManager) {
    this.connection = connection;

    // Monitor state changes for health tracking
    this.connection.onStateChange((state) => {
      const healthy = state === "connected";
      if (healthy !== this.lastHealthy) {
        this.lastHealthy = healthy;
        if (this.onHealthChange) {
          try { this.onHealthChange(healthy); } catch { /* swallow */ }
        }
      }
    });
  }

  /**
   * Whether the connection is currently healthy (connected).
   */
  get isHealthy(): boolean {
    return this.connection.state === "connected";
  }

  /**
   * Current connection state.
   */
  get state(): ConnectionState {
    return this.connection.state;
  }

  /**
   * The current session ID (null if not connected).
   */
  get sessionId(): string | null {
    return this.connection.sessionId;
  }

  /**
   * Register a callback for health state changes.
   *
   * @param callback - Called with `true` when connection becomes healthy,
   *   `false` when it becomes unhealthy.
   */
  onHealthChanged(callback: (healthy: boolean) => void): void {
    this.onHealthChange = callback;
  }

  /**
   * Send a manual heartbeat via HTTP (backup for WebSocket heartbeat).
   * Useful if the WebSocket is temporarily down but HTTP still works.
   */
  async manualHeartbeat(): Promise<boolean> {
    try {
      await this.connection.request<{ success: boolean }>(
        "POST",
        "/v1/runtime/heartbeat",
      );
      return true;
    } catch {
      return false;
    }
  }
}
