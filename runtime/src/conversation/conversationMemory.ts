/**
 * `ConversationMemory` — abstract per-session chat history with a clean
 * extension point for compaction. The basic implementation is an unbounded
 * append-only list (matches the previous chatEngine behavior); the compacting
 * implementation lives in `compactionMemory.ts`.
 *
 * Reuses {@link InferenceMessage} from the runtime types deliberately —
 * we don't want a parallel `ChatMessage` shape that drifts from the inference
 * call site.
 *
 * @module conversation/conversationMemory
 */
import type { InferenceMessage } from "../types.js";

/**
 * A per-session conversation history. Implementations decide whether to grow
 * unbounded ({@link BasicConversationMemory}) or compact at a token threshold
 * ({@link import("./compactionMemory.js").CompactionMemory}).
 *
 * Methods are async to leave room for IO-backed implementations (e.g. a future
 * Postgres-backed memory).
 */
export interface ConversationMemory {
  /** Append a message. Implementations may choose to compact afterwards. */
  addMessage(msg: InferenceMessage): Promise<void>;
  /** Snapshot of the messages to feed into the next inference call. */
  getContext(): InferenceMessage[];
  /** Drop all messages and reset internal counters. */
  reset(): Promise<void>;
  /** Stable identifier for this session. */
  readonly sessionId: string;
}

export interface BasicConversationMemoryOptions {
  /** Override the session id. Defaults to `"__default__"`. */
  sessionId?: string;
  /**
   * Optional message cap. When set, the oldest messages are dropped to keep
   * the array under `maxMessages`. Defaults to undefined (unbounded — matches
   * the old chatEngine semantics for callers that opted out of compaction).
   */
  maxMessages?: number;
}

/**
 * Append-only message log with an optional max-message cap. No compaction.
 *
 * Used by callers who want the legacy unbounded history without paying the
 * compaction setup cost (no model name, no `compactFn`, no log store).
 */
export class BasicConversationMemory implements ConversationMemory {
  readonly sessionId: string;
  private readonly maxMessages?: number;
  private messages: InferenceMessage[] = [];

  constructor(opts: BasicConversationMemoryOptions = {}) {
    this.sessionId = opts.sessionId ?? "__default__";
    this.maxMessages = opts.maxMessages;
  }

  async addMessage(msg: InferenceMessage): Promise<void> {
    this.messages.push(msg);
    if (this.maxMessages !== undefined && this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
  }

  getContext(): InferenceMessage[] {
    return this.messages.slice();
  }

  async reset(): Promise<void> {
    this.messages = [];
  }

  /** Test inspection — current message count. */
  get length(): number {
    return this.messages.length;
  }
}
