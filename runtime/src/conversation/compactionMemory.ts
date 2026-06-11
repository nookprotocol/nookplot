/**
 * `CompactionMemory` — turn-boundary-aware conversation memory with optional
 * JSONL persistence.
 *
 * **Why turn boundaries.** When you compact mid-turn, you risk leaving an
 * orphaned `role: "tool"` reply in the preserved tail without its calling
 * `assistant` message in the prefix — which most LLMs will reject. We track
 * three unit kinds (a turn-boundary compaction pattern):
 *
 *   - **Unit A**: a single `role: "user"` message.
 *   - **Unit B**: an `assistant` message with N `toolCalls`, followed by all N
 *     matching `role: "tool"` replies.
 *   - **Unit C**: an `assistant` message with no `toolCalls` (final answer).
 *
 * Compaction only fires when `pendingToolCalls === 0` AND the message stream
 * has at least one closed unit boundary that we can roll up.
 *
 * **Compaction output.** The replaced prefix is collapsed into a single
 * `role: "system"` message whose content is `"[Conversation Summary]\n" +
 * sanitizeForPrompt(summary)` — same shape the gateway-side compaction
 * emits, so downstream prompt-assembly code doesn't have to branch.
 *
 * **Persistence.** Every `addMessage` and every compaction writes a single
 * JSONL line via the configured `ConversationLogStore`. Restart-recovery is
 * exposed as `CompactionMemory.restoreFromLog(sessionId, store, cfg)`.
 *
 * **Hook integration.** Successful compactions emit a fire-and-forget
 * `memory_compacted` event via the configured `HookRegistry` (defaults to the
 * runtime singleton). Slow subscribers don't delay the next `addMessage`.
 *
 * @module conversation/compactionMemory
 */
import { randomUUID } from "node:crypto";
import { sanitizeForPrompt } from "../contentSafety.js";
import { hooks as defaultHooks, HookRegistry } from "../hooks.js";
import type { InferenceMessage } from "../types.js";
import type { ConversationMemory } from "./conversationMemory.js";
import type { ConversationLogStore, LogEntry } from "./conversationLogStore.js";
import {
  DEFAULT_COMPACTION_SYSTEM_PROMPT,
  estimateTokens as defaultEstimateTokens,
  getModelThreshold,
  type ModelThreshold,
} from "./modelLimits.js";

/** Caller-supplied summarizer. We do NOT pin a model dependency. */
export type CompactFn = (
  messages: InferenceMessage[],
  systemPrompt: string,
) => Promise<string>;

export interface CompactionConfig {
  /** Looked up in `MODEL_THRESHOLDS`; unknown models fall back to the default. */
  modelName: string;
  /** Trigger compaction at `safetyRatio × compactAt` tokens. Default 0.8. */
  safetyRatio?: number;
  /** Override the threshold's `preserveRecent` count. */
  preserveRecent?: number;
  /** Prepended to the compaction request. Default from `modelLimits.ts`. */
  systemPromptPreamble?: string;
  /** Where to persist messages. Omit for purely in-memory operation. */
  store?: ConversationLogStore;
  /** Stable session id. Auto-generated when omitted. */
  sessionId?: string;
  /** Whether `buildTools()` returns search/read tool defs. Default true. */
  enableMemoryTools?: boolean;
  /** Hook registry for `memory_compacted` events. Defaults to runtime singleton. */
  hooks?: HookRegistry;
  /** How to summarize. Caller injects so the SDK doesn't pull in an LLM dep. */
  compactFn: CompactFn;
  /** Override the token estimator. Defaults to gateway-parity heuristic. */
  estimateTokens?: (messages: InferenceMessage[]) => number;
  /** Maximum chars stored per summary. Default 2000 (matches gateway). */
  maxSummaryChars?: number;
}

/** Runtime-observable counters. */
export interface CompactionStats {
  messageCount: number;
  pendingToolCalls: number;
  compactionCount: number;
  estimatedTokens: number;
}

/**
 * Lightweight tool-definition shape returned by `buildTools()`. We don't reuse
 * the registry's `ToolDefinition` because these tools live entirely inside the
 * agent process — they have no cost, no rate limit, no autonomy bracket.
 */
export interface MemoryToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments (LLM-facing). */
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; minimum?: number }>;
    required?: string[];
  };
  /** Local handler. The session id is captured in the closure — never an LLM arg. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const DEFAULT_SAFETY_RATIO = 0.8;
const DEFAULT_MAX_SUMMARY_CHARS = 2000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

export class CompactionMemory implements ConversationMemory {
  readonly sessionId: string;
  private readonly threshold: ModelThreshold;
  private readonly safetyRatio: number;
  private readonly preserveRecent: number;
  private readonly preamble: string;
  private readonly store: ConversationLogStore | undefined;
  private readonly hooks: HookRegistry;
  private readonly compactFn: CompactFn;
  private readonly estimateTokensFn: (messages: InferenceMessage[]) => number;
  private readonly enableMemoryTools: boolean;
  private readonly maxSummaryChars: number;

  // Live state ──────────────────────────────────────────────
  /** Linear list of messages that will be sent to the LLM next call. */
  private messages: InferenceMessage[] = [];
  /** Indices into `messages` immediately AFTER each closed unit. */
  private unitBoundaries: number[] = [];
  /** Outstanding tool calls awaiting their replies. */
  private pendingToolCalls = 0;
  /** Monotonic counter, used in `LogEntry.compactionNumber`. */
  private compactionCount = 0;
  /**
   * Number of original messages that have been collapsed away by all prior
   * compactions. Used to project log-store indices into the live array.
   */
  private removedFromHead = 0;
  /** Serializes `_autoCompact` so two near-simultaneous calls don't double-compact. */
  private compactionInFlight: Promise<void> | null = null;

  constructor(config: CompactionConfig) {
    this.sessionId = config.sessionId ?? randomUUID();
    this.threshold = getModelThreshold(config.modelName);
    this.safetyRatio = config.safetyRatio ?? DEFAULT_SAFETY_RATIO;
    this.preserveRecent = config.preserveRecent ?? this.threshold.preserveRecent;
    this.preamble = config.systemPromptPreamble ?? DEFAULT_COMPACTION_SYSTEM_PROMPT;
    this.store = config.store;
    this.hooks = config.hooks ?? defaultHooks;
    this.compactFn = config.compactFn;
    this.estimateTokensFn = config.estimateTokens ?? defaultEstimateTokens;
    this.enableMemoryTools = config.enableMemoryTools ?? true;
    this.maxSummaryChars = config.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  }

  // ── ConversationMemory ──────────────────────────────────

  async addMessage(msg: InferenceMessage): Promise<void> {
    this.messages.push(msg);
    this.updateUnitState(msg);

    if (this.store) {
      await this.store.append(this.sessionId, {
        kind: "message",
        ts: new Date().toISOString(),
        msg,
      });
    }

    // Compaction is only safe at a closed-unit boundary. Defer otherwise.
    if (this.pendingToolCalls === 0 && this.shouldCompact()) {
      await this.runCompactionOnce();
    }
  }

  getContext(): InferenceMessage[] {
    return this.messages.slice();
  }

  async reset(): Promise<void> {
    this.messages = [];
    this.unitBoundaries = [];
    this.pendingToolCalls = 0;
    this.compactionCount = 0;
    this.removedFromHead = 0;
    if (this.store) {
      await this.store.append(this.sessionId, { kind: "reset", ts: new Date().toISOString() });
    }
  }

  stats(): CompactionStats {
    return {
      messageCount: this.messages.length,
      pendingToolCalls: this.pendingToolCalls,
      compactionCount: this.compactionCount,
      estimatedTokens: this.estimateTokensFn(this.messages),
    };
  }

  // ── Restore ─────────────────────────────────────────────

  /**
   * Reconstruct a `CompactionMemory` from its persisted JSONL log.
   *
   * Algorithm: replay entries in append order, maintaining the live message
   * array. A `message` entry appends. A `compaction` entry replaces the head
   * `messagesCompacted` messages with the summary system message. A `reset`
   * entry clears the array. Truncated tail lines are skipped by `store.read`.
   *
   * This walk-and-fold approach preserves the invariant that messages added
   * BETWEEN the last addMessage that triggered compaction and the compaction
   * write itself stay in the tail — exactly mirroring the in-memory state
   * after `_autoCompact`.
   */
  static async restoreFromLog(
    sessionId: string,
    store: ConversationLogStore,
    config: Omit<CompactionConfig, "sessionId" | "store">,
  ): Promise<CompactionMemory> {
    const memory = new CompactionMemory({ ...config, sessionId, store });
    if (!(await store.exists(sessionId))) return memory;
    const entries = await store.read(sessionId);

    for (const entry of entries) {
      if (entry.kind === "reset") {
        memory.messages = [];
        memory.compactionCount = 0;
        memory.removedFromHead = 0;
        continue;
      }
      if (entry.kind === "message") {
        memory.messages.push(entry.msg);
        continue;
      }
      // compaction
      const drop = Math.min(entry.messagesCompacted, memory.messages.length);
      const tail = memory.messages.slice(drop);
      memory.messages = [
        { role: "system", content: `[Conversation Summary]\n${entry.summary}` },
        ...tail,
      ];
      memory.compactionCount = entry.compactionNumber;
      memory.removedFromHead = entry.replacedRange[1];
    }

    // Re-derive turn-boundary state from the restored messages.
    memory.replayUnitState();
    return memory;
  }

  // ── Tool exposure (agent-internal) ──────────────────────

  /**
   * Tool definitions the caller can hand to the LLM so the agent can recover
   * detail the summary dropped. The session id is captured in the closure —
   * the LLM never supplies it. Returns `[]` when `enableMemoryTools: false`
   * or no `store` is configured (no log → nothing to search).
   */
  buildTools(): MemoryToolDefinition[] {
    if (!this.enableMemoryTools || !this.store) return [];
    const store = this.store;
    const sessionId = this.sessionId;

    const search: MemoryToolDefinition = {
      name: "search_conversation_log",
      description:
        "Substring search across the current conversation's archived messages " +
        "(including those collapsed by an earlier summary). Returns the most " +
        "recent matches first.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to look for (case-insensitive)." },
          maxResults: {
            type: "number",
            description: "Cap on returned matches (default 5, max 20).",
            minimum: 1,
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const query = typeof args.query === "string" ? args.query : "";
        let cap = typeof args.maxResults === "number" ? Math.floor(args.maxResults) : DEFAULT_SEARCH_LIMIT;
        if (!Number.isFinite(cap) || cap < 1) cap = DEFAULT_SEARCH_LIMIT;
        if (cap > MAX_SEARCH_LIMIT) cap = MAX_SEARCH_LIMIT;
        // sessionId is closure-captured. Any `sessionId` arg from the LLM is
        // silently ignored — defense-in-depth against tool-arg poisoning.
        return await store.searchMessages(sessionId, query, cap);
      },
    };

    const read: MemoryToolDefinition = {
      name: "read_compaction_summary",
      description:
        "Return the summary text produced by a past compaction of the current " +
        "session, by 1-indexed compaction number.",
      inputSchema: {
        type: "object",
        properties: {
          compactionNumber: {
            type: "number",
            description: "1-indexed; matches the counter exposed by stats().compactionCount.",
            minimum: 1,
          },
        },
        required: ["compactionNumber"],
      },
      handler: async (args) => {
        const num =
          typeof args.compactionNumber === "number" ? Math.floor(args.compactionNumber) : 0;
        if (!Number.isFinite(num) || num < 1) {
          throw new Error("compactionNumber must be a positive integer");
        }
        const entries = await store.read(sessionId);
        const match = entries.find((e) => e.kind === "compaction" && e.compactionNumber === num);
        if (!match) {
          throw new Error(`compaction ${num} not found for session`);
        }
        return match;
      },
    };

    return [search, read];
  }

  // ── Internals ───────────────────────────────────────────

  private updateUnitState(msg: InferenceMessage): void {
    const idx = this.messages.length; // index AFTER the just-pushed msg
    if (msg.role === "assistant") {
      const calls = msg.toolCalls?.length ?? 0;
      if (calls > 0) {
        this.pendingToolCalls += calls;
      } else {
        // Closes a Unit C immediately.
        this.unitBoundaries.push(idx);
      }
    } else if (msg.role === "tool") {
      // Decrement, clamping at zero in case of orphan tool results.
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
      if (this.pendingToolCalls === 0) {
        this.unitBoundaries.push(idx);
      }
    } else if (msg.role === "user") {
      // The unit BEFORE this user message is already closed (Unit C closed it
      // at the prior assistant message, OR Unit B closed it at the last tool
      // reply). Record the user message; compaction check happens after.
      this.unitBoundaries.push(idx);
    }
    // role: "system" never closes a unit. Typically used for the compaction
    // summary itself or for a static system prompt — neither is a turn boundary.
  }

  private shouldCompact(): boolean {
    const triggerAt = Math.floor(this.threshold.compactAt * this.safetyRatio);
    return this.estimateTokensFn(this.messages) >= triggerAt;
  }

  private async runCompactionOnce(): Promise<void> {
    if (this.compactionInFlight) {
      await this.compactionInFlight;
      return;
    }
    this.compactionInFlight = this._autoCompact().finally(() => {
      this.compactionInFlight = null;
    });
    await this.compactionInFlight;
  }

  /**
   * Pick the latest closed unit boundary that leaves at least `preserveRecent`
   * messages in the tail, summarize everything before it, and replace the
   * collapsed prefix with one `role: "system"` summary message.
   */
  private async _autoCompact(): Promise<void> {
    const tailReserve = this.preserveRecent;
    if (this.messages.length <= tailReserve + 1) return;

    // Pick the largest boundary ≤ messages.length - tailReserve.
    const cutoffMax = this.messages.length - tailReserve;
    let boundary = -1;
    for (const b of this.unitBoundaries) {
      if (b <= cutoffMax && b > boundary) boundary = b;
    }
    if (boundary <= 0) return; // nothing closed yet

    // Don't bother if the first message is already a system summary AND no real
    // progress can be made (boundary would replace just that summary).
    if (boundary === 1 && this.messages[0].role === "system") return;

    const toCompact = this.messages.slice(0, boundary);
    const tail = this.messages.slice(boundary);

    let summary: string;
    try {
      summary = await this.compactFn(toCompact, this.preamble);
    } catch (err) {
      // Compaction failure is non-fatal — leave the messages in place and try
      // again on the next addMessage. Mirrors gateway behavior. Emit a
      // `compaction_failed` hook so operators can alert on a downed summarizer
      // instead of silently watching context grow unbounded.
      this.hooks.emitFireAndForget("compaction_failed", {
        sessionId: this.sessionId,
        error: err,
        attemptedMessages: toCompact.length,
      });
      return;
    }
    const sanitized = sanitizeForPrompt(summary, this.maxSummaryChars);
    const summaryMessage: InferenceMessage = {
      role: "system",
      content: `[Conversation Summary]\n${sanitized}`,
    };

    const replacedFrom = this.removedFromHead;
    const replacedTo = this.removedFromHead + boundary;
    const messagesCompacted = boundary;
    const summaryTokens = Math.ceil(sanitized.length / 4);

    this.compactionCount += 1;
    this.messages = [summaryMessage, ...tail];
    this.removedFromHead += boundary;

    // Recompute boundaries against the new `messages` array. The summary
    // message itself is `system` (no boundary); reapply unit logic for the
    // preserved tail so future compactions still know where to cut.
    this.replayUnitState();

    if (this.store) {
      await this.store.append(this.sessionId, {
        kind: "compaction",
        ts: new Date().toISOString(),
        compactionNumber: this.compactionCount,
        replacedRange: [replacedFrom, replacedTo],
        messagesCompacted,
        summary: sanitized,
        summaryTokens,
        model: "n/a", // caller's compactFn knows the actual model; we don't need it here
      });
    }

    this.hooks.emitFireAndForget("memory_compacted", {
      sessionId: this.sessionId,
      compactionNumber: this.compactionCount,
      messagesCompacted,
      summaryTokens,
    });
  }

  /** Recompute unitBoundaries + pendingToolCalls from `this.messages` in place. */
  private replayUnitState(): void {
    this.unitBoundaries = [];
    this.pendingToolCalls = 0;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const idxAfter = i + 1;
      if (m.role === "assistant") {
        const calls = m.toolCalls?.length ?? 0;
        if (calls > 0) {
          this.pendingToolCalls += calls;
        } else {
          this.unitBoundaries.push(idxAfter);
        }
      } else if (m.role === "tool") {
        this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
        if (this.pendingToolCalls === 0) this.unitBoundaries.push(idxAfter);
      } else if (m.role === "user") {
        this.unitBoundaries.push(idxAfter);
      }
    }
  }
}
