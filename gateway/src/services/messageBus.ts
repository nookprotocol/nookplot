/**
 * Message bus abstraction for pub/sub event routing.
 *
 * InProcessMessageBus uses Node EventEmitter for single-instance deployments.
 * When REDIS_URL is set in the future, a RedisMessageBus can drop in with
 * zero changes to consumers.
 *
 * Channel naming conventions:
 * - `dm:{agentId}` — direct messages to a specific agent
 * - `ch:{channelId}` — channel (group) messages
 *
 * @module services/messageBus
 */

import { EventEmitter } from "events";

export interface BusMessage {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type BusHandler = (channel: string, message: BusMessage) => void;

/**
 * Abstract interface for the message bus.
 * Implementations can use in-process events, Redis pub/sub, NATS, etc.
 */
export interface MessageBus {
  /** Publish a message to a channel. */
  publish(channel: string, message: BusMessage): void;

  /** Subscribe to a channel. Returns an unsubscribe function. */
  subscribe(channel: string, handler: BusHandler): () => void;

  /** Subscribe to all channels matching a prefix (e.g. "dm:" or "ch:"). */
  subscribePattern(prefix: string, handler: BusHandler): () => void;

  /** Unsubscribe a specific handler from a channel. */
  unsubscribe(channel: string, handler: BusHandler): void;

  /** Shut down the bus and clean up resources. */
  shutdown(): void;
}

/**
 * In-process message bus using Node EventEmitter.
 *
 * Suitable for single-instance deployments. All pub/sub happens in the
 * same Node process. For horizontal scaling, swap in RedisMessageBus.
 */
export class InProcessMessageBus implements MessageBus {
  private readonly emitter = new EventEmitter();
  private readonly patternHandlers = new Map<string, Set<{ prefix: string; handler: BusHandler }>>();

  constructor() {
    // Allow many listeners for busy channels
    this.emitter.setMaxListeners(1000);
  }

  publish(channel: string, message: BusMessage): void {
    this.emitter.emit(channel, channel, message);

    // Fan out to pattern subscribers
    for (const [prefix, handlers] of this.patternHandlers) {
      if (channel.startsWith(prefix)) {
        for (const entry of handlers) {
          try {
            entry.handler(channel, message);
          } catch {
            // Don't let one handler crash others
          }
        }
      }
    }
  }

  subscribe(channel: string, handler: BusHandler): () => void {
    const wrappedHandler = (_ch: string, msg: BusMessage) => handler(channel, msg);
    this.emitter.on(channel, wrappedHandler);
    return () => this.emitter.off(channel, wrappedHandler);
  }

  subscribePattern(prefix: string, handler: BusHandler): () => void {
    if (!this.patternHandlers.has(prefix)) {
      this.patternHandlers.set(prefix, new Set());
    }
    const entry = { prefix, handler };
    this.patternHandlers.get(prefix)!.add(entry);
    return () => {
      this.patternHandlers.get(prefix)?.delete(entry);
      if (this.patternHandlers.get(prefix)?.size === 0) {
        this.patternHandlers.delete(prefix);
      }
    };
  }

  unsubscribe(channel: string, handler: BusHandler): void {
    this.emitter.off(channel, handler);
  }

  shutdown(): void {
    this.emitter.removeAllListeners();
    this.patternHandlers.clear();
  }
}
