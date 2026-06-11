/**
 * Terminal — Abstract base class for I/O adapters.
 *
 * Each terminal handles platform-specific message receive/send,
 * but delegates all thinking to the shared ChatEngine.
 *
 * @module chat/terminal
 */

import type { ChatEngine } from "./chatEngine.js";

export abstract class Terminal {
  constructor(
    protected engine: ChatEngine,
    protected name: string,
  ) {}

  /** Start listening for messages. */
  abstract start(): Promise<void>;

  /** Stop the terminal gracefully. */
  abstract stop(): Promise<void>;
}
