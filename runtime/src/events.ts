/**
 * Event manager for the Nookplot Agent Runtime SDK.
 *
 * Provides a typed event subscription interface on top of the
 * ConnectionManager's WebSocket. Agents subscribe to event types
 * and receive callbacks when matching events arrive.
 *
 * @module events
 */

import type { ConnectionManager } from "./connection.js";
import type { RuntimeEventType, RuntimeEvent, EventHandler } from "./types.js";

export class EventManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * Subscribe to a specific event type.
   *
   * @param eventType - The event type to listen for.
   * @param handler - Callback invoked when matching events arrive.
   */
  subscribe(eventType: RuntimeEventType | "*", handler: EventHandler): void {
    this.connection.on(eventType, handler);
  }

  /**
   * Unsubscribe from a specific event type.
   *
   * @param eventType - The event type to stop listening for.
   * @param handler - The specific handler to remove. If omitted, removes all handlers for this type.
   */
  unsubscribe(eventType: RuntimeEventType | "*", handler?: EventHandler): void {
    this.connection.off(eventType, handler);
  }

  /**
   * Subscribe to all events (wildcard).
   *
   * @param handler - Callback invoked for every event.
   */
  subscribeAll(handler: EventHandler): void {
    this.connection.on("*", handler);
  }

  /**
   * Unsubscribe from the wildcard handler.
   *
   * @param handler - The specific wildcard handler to remove.
   */
  unsubscribeAll(handler?: EventHandler): void {
    this.connection.off("*", handler);
  }

  /**
   * Create a one-time event listener that auto-removes after firing.
   *
   * @param eventType - The event type to listen for.
   * @param handler - Callback invoked once when the event fires.
   */
  once(eventType: RuntimeEventType, handler: EventHandler): void {
    const wrapper: EventHandler = (event: RuntimeEvent) => {
      this.connection.off(eventType, wrapper);
      return handler(event);
    };
    this.connection.on(eventType, wrapper);
  }

  /**
   * Wait for a specific event type with a timeout.
   *
   * @param eventType - The event type to wait for.
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 30000).
   * @returns The event that was received.
   * @throws If the timeout is reached before an event arrives.
   */
  waitFor(eventType: RuntimeEventType, timeoutMs = 30000): Promise<RuntimeEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connection.off(eventType, handler);
        // MEDIUM-9: Don't leak event type names in unhandled rejections
        reject(new Error("Timeout waiting for runtime event"));
      }, timeoutMs);

      const handler: EventHandler = (event: RuntimeEvent) => {
        clearTimeout(timer);
        this.connection.off(eventType, handler);
        resolve(event);
      };

      this.connection.on(eventType, handler);
    });
  }
}
