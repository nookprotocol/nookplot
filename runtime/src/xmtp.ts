/**
 * XMTP bridge — optional cross-protocol messaging transport.
 *
 * Dynamic imports of `@xmtp/agent-sdk` so the feature gracefully degrades
 * when the package isn't installed. All incoming XMTP messages are sanitized
 * via `sanitizeForPrompt()` before being forwarded.
 *
 * Rate limits: 60/min per conversation, 300/min total.
 *
 * @module xmtp
 */

import { sanitizeForPrompt } from "./contentSafety.js";

// ── Types ─────────────────────────────────────────────────────

export interface XmtpConfig {
  /** Agent's private key (hex, 0x-prefixed) for XMTP identity */
  privateKey: string;
  /** XMTP environment: "production" | "dev" (default: "production") */
  env?: "production" | "dev";
  /** Forward incoming XMTP messages to gateway inbox (default: true) */
  bridgeToGateway?: boolean;
  /** Max messages per conversation per minute (default: 60) */
  perConversationRateLimit?: number;
  /** Max total messages per minute (default: 300) */
  totalRateLimit?: number;
}

export interface XmtpMessage {
  /** Sender's XMTP address */
  senderAddress: string;
  /** Message content (sanitized) */
  content: string;
  /** XMTP conversation ID */
  conversationId: string;
  /** Original timestamp */
  timestamp: Date;
}

export type XmtpMessageHandler = (message: XmtpMessage) => void | Promise<void>;

// ── Rate limiter ──────────────────────────────────────────────

class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private maxPerWindow: number,
    private windowMs: number = 60_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key) || [];
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.maxPerWindow) {
      this.windows.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return true;
  }

  /** Prune stale entries to prevent memory growth */
  prune(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, active);
      }
    }
  }
}

// ── XmtpManager ───────────────────────────────────────────────

/**
 * Manages XMTP messaging with rate limiting and content safety.
 *
 * Uses dynamic imports for `@xmtp/agent-sdk` — the module is only
 * loaded when `start()` is called, so missing the dependency doesn't
 * break other functionality.
 */
export class XmtpManager {
  private config: XmtpConfig;
  private client: unknown = null;
  private handlers: XmtpMessageHandler[] = [];
  private running = false;
  private conversationLimiter: SlidingWindowRateLimiter;
  private totalLimiter: SlidingWindowRateLimiter;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private log: (msg: string) => void;

  constructor(config: XmtpConfig, log?: (msg: string) => void) {
    this.config = {
      env: "production",
      bridgeToGateway: true,
      perConversationRateLimit: 60,
      totalRateLimit: 300,
      ...config,
    };
    this.log = log || (() => {});
    this.conversationLimiter = new SlidingWindowRateLimiter(
      this.config.perConversationRateLimit!,
    );
    this.totalLimiter = new SlidingWindowRateLimiter(
      this.config.totalRateLimit!,
    );
  }

  /**
   * Start the XMTP client and begin listening for messages.
   * Throws if `@xmtp/agent-sdk` is not installed.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Dynamic import — will throw if not installed
    let xmtpModule: {
      Client: {
        create: (signer: unknown, options?: Record<string, unknown>) => Promise<unknown>;
      };
    };

    try {
      xmtpModule = await import("@xmtp/agent-sdk") as typeof xmtpModule;
    } catch {
      throw new Error(
        "XMTP bridge requires @xmtp/agent-sdk. Install it with: npm install @xmtp/agent-sdk",
      );
    }

    // Create XMTP client from private key
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(this.config.privateKey);

    this.log(`Starting XMTP client for ${wallet.address}...`);

    try {
      this.client = await xmtpModule.Client.create(wallet, {
        env: this.config.env,
      });
    } catch (err) {
      throw new Error(
        `Failed to create XMTP client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.running = true;
    this.log(`XMTP client started (env: ${this.config.env})`);

    // Prune rate limiter windows every 5 minutes
    this.pruneInterval = setInterval(() => {
      this.conversationLimiter.prune();
      this.totalLimiter.prune();
    }, 5 * 60_000);

    // Start message stream
    this.startMessageStream().catch((err) => {
      this.log(`XMTP message stream error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Stop the XMTP client and clean up.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    this.client = null;
    this.log("XMTP client stopped");
  }

  /**
   * Send a message to an XMTP address.
   */
  async send(to: string, content: string): Promise<void> {
    if (!this.client) {
      throw new Error("XMTP client not started. Call start() first.");
    }

    // Rate limit outgoing too
    if (!this.totalLimiter.allow("_outgoing_total")) {
      this.log(`XMTP send rate limited (total)`);
      return;
    }

    try {
      const client = this.client as {
        conversations: {
          newConversation: (address: string) => Promise<{
            send: (content: string) => Promise<void>;
          }>;
        };
      };
      const conversation = await client.conversations.newConversation(to);
      await conversation.send(content);
      this.log(`XMTP sent to ${to.slice(0, 10)}...`);
    } catch (err) {
      this.log(`XMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Check if an address is reachable on the XMTP network.
   */
  async isReachable(address: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      const client = this.client as {
        canMessage: (address: string) => Promise<boolean>;
      };
      return await client.canMessage(address);
    } catch {
      return false;
    }
  }

  /**
   * Register a handler for incoming XMTP messages.
   */
  onMessage(handler: XmtpMessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Remove a message handler.
   */
  offMessage(handler: XmtpMessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** Whether the client is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Internal ──────────────────────────────────────────────

  private async startMessageStream(): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const client = this.client as {
        conversations: {
          streamAllMessages: () => AsyncIterable<{
            senderAddress: string;
            content: string;
            conversationId?: string;
            id?: string;
            sent: Date;
          }>;
        };
      };

      const stream = client.conversations.streamAllMessages();

      for await (const message of stream) {
        if (!this.running) break;

        // Skip own messages
        const clientAddr = (this.client as { address?: string }).address;
        if (message.senderAddress === clientAddr) continue;

        const conversationId = message.conversationId || message.id || "unknown";

        // Rate limit
        if (!this.totalLimiter.allow("_incoming_total")) {
          this.log(`XMTP rate limited (total) — dropping message from ${message.senderAddress.slice(0, 10)}...`);
          continue;
        }
        if (!this.conversationLimiter.allow(conversationId)) {
          this.log(`XMTP rate limited (conversation ${conversationId.slice(0, 8)}...) — dropping`);
          continue;
        }

        // Content safety
        const sanitizedContent = sanitizeForPrompt(
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        );

        const xmtpMsg: XmtpMessage = {
          senderAddress: message.senderAddress,
          content: sanitizedContent,
          conversationId,
          timestamp: message.sent || new Date(),
        };

        // Notify handlers
        for (const handler of this.handlers) {
          try {
            await handler(xmtpMsg);
          } catch (err) {
            this.log(`XMTP handler error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      if (this.running) {
        this.log(`XMTP stream error: ${err instanceof Error ? err.message : String(err)}`);
        // Retry after delay
        await new Promise((resolve) => setTimeout(resolve, 5000));
        if (this.running) {
          this.startMessageStream().catch(() => {});
        }
      }
    }
  }
}

/**
 * Check if `@xmtp/agent-sdk` is available for import.
 */
export async function isXmtpAvailable(): Promise<boolean> {
  try {
    await import("@xmtp/agent-sdk");
    return true;
  } catch {
    return false;
  }
}
