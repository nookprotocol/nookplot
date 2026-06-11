/**
 * HookRegistry — local, in-process event bus for runtime-internal lifecycle.
 *
 * This is a SEPARATE concern from `EventManager` (which routes gateway-emitted
 * WebSocket events like `proactive.signal`). Hooks are agent-local — they fire
 * inside the runtime process when actions start/end, signals arrive, and chat
 * turns complete. Use them to attach cross-cutting concerns (tracing, episodic
 * memory writes, mining-trace capture, latency metrics) without inlining the
 * logic at every call site.
 *
 * @example
 * ```ts
 * runtime.hooks.register("action_end", ({ actionType, durationMs }) => {
 *   metrics.histogram("action_duration_ms", durationMs, { type: actionType });
 * });
 * ```
 *
 * @module hooks
 */
import type { SignalEvent } from "./autonomous.js";

// ── Event names + payload shapes ─────────────────────────────

/** Per-action lifecycle: emitted by `handleActionRequest` in autonomous.ts. */
export interface ActionStartPayload {
  actionType: string;
  args: Record<string, unknown>;
  actionId?: string;
  agentAddress?: string;
}

export interface ActionEndPayload {
  actionType: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  actionId?: string;
  txHash?: string;
}

export interface ActionErrorPayload {
  actionType: string;
  args: Record<string, unknown>;
  error: Error;
  durationMs: number;
  actionId?: string;
}

/** Approval gate denied the action. NOT an error. */
export interface ActionRejectedPayload {
  actionType: string;
  args: Record<string, unknown>;
  reason: string;
  actionId?: string;
}

/** Tool-input/output hooks fired by guardrails wrapper. */
export interface ToolInputPayload {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolOutputPayload {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Chat turn finished (final assistant message produced). */
export interface ChatTurnCompletePayload {
  sender: string;
  platform: string;
  message: string;
  response: string;
  toolsUsed: boolean;
  toolCallCount: number;
  senderId?: string | null;
  channelId?: string | null;
  /** Agent display name (from chat-engine soul). Used by the episodic hook
   *  to format the stored line as `[platform] sender: msg\nAgent: response`. */
  agentName?: string;
  /** Whether the engine that emitted this had memory enabled. The default
   *  episodic hook respects this so disabling memory at the engine level
   *  still suppresses writes even if the hook is installed. */
  enableMemory?: boolean;
}

/** CompactionMemory fires this after a successful summarize-and-prune. */
export interface MemoryCompactedPayload {
  sessionId: string;
  compactionNumber: number;
  messagesCompacted: number;
  summaryTokens: number;
}

/**
 * CompactionMemory fires this when `compactFn` throws. The conversation
 * is left untouched and will attempt compaction again on the next `addMessage`.
 * Operators can register a handler to alert when compaction is broken — without
 * this hook, a downed summarizer would silently let context grow unbounded.
 */
export interface CompactionFailedPayload {
  sessionId: string;
  error: unknown;
  /** How many messages were about to be compacted when the failure occurred. */
  attemptedMessages?: number;
}

/** Doom-loop detector tripped — same tool+args 3+ times, or A,B,A,B cycle. */
export interface DoomLoopDetectedPayload {
  /** Tool name responsible for the loop. */
  offender: string;
  /** Number of triggers accumulated for this agent (resets after a forced abort). */
  triggers: number;
  /** The action type whose dispatch tripped the detector. */
  actionType: string;
}

/** Map from event name → payload shape. Keep in lockstep with Python. */
export interface HookEventMap {
  action_start: ActionStartPayload;
  action_end: ActionEndPayload;
  action_error: ActionErrorPayload;
  action_rejected: ActionRejectedPayload;
  signal_received: SignalEvent;
  tool_input: ToolInputPayload;
  tool_output: ToolOutputPayload;
  chat_turn_complete: ChatTurnCompletePayload;
  memory_compacted: MemoryCompactedPayload;
  compaction_failed: CompactionFailedPayload;
  doom_loop_detected: DoomLoopDetectedPayload;
}

export type HookEvent = keyof HookEventMap;

export type HookCallback<E extends HookEvent = HookEvent> = (
  payload: HookEventMap[E],
) => void | Promise<void>;

export interface RegisterOptions {
  /** Insert at the front of the callback list instead of the end. */
  prepend?: boolean;
}

// ── Registry implementation ──────────────────────────────────

/**
 * Ordered, in-process callback registry. Each event name has its own list of
 * callbacks; `emit()` runs them via `Promise.allSettled` so one throwing
 * callback doesn't prevent the rest from running.
 *
 * Two emit modes:
 *  - `emit(event, payload)` — awaits all callbacks. Use when the caller wants
 *    to know when side-effects have completed.
 *  - `emitFireAndForget(event, payload)` — schedules via `Promise.resolve()`,
 *    returns synchronously. Use in hot paths (chat response, action dispatch)
 *    where blocking on observers would degrade UX.
 */
export class HookRegistry {
  private listeners = new Map<HookEvent, HookCallback[]>();

  /**
   * Register a callback for an event. Returns a disposer that removes only
   * this callback (safer than calling `deregister` with the same reference
   * since it survives renames + closures).
   */
  register<E extends HookEvent>(
    event: E,
    cb: HookCallback<E>,
    opts: RegisterOptions = {},
  ): () => void {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    if (opts.prepend) list.unshift(cb as HookCallback);
    else list.push(cb as HookCallback);

    return () => this.deregister(event, cb);
  }

  /** Remove the first matching callback for an event. Idempotent. */
  deregister<E extends HookEvent>(event: E, cb: HookCallback<E>): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(cb as HookCallback);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.listeners.delete(event);
  }

  /**
   * Emit and await all callbacks. Resolves once every callback has settled
   * (either resolved or rejected). One throwing callback never prevents the
   * others from running. Errors are logged via `console.error` so operators
   * can observe silent hook failures (episodic write, metrics, etc.).
   */
  async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;
    // Snapshot so callbacks that mutate the list mid-emit don't affect this run.
    const snapshot = list.slice();
    await Promise.allSettled(
      snapshot.map(async (cb) => {
        try {
          await cb(payload);
        } catch (err) {
          console.error(`[hooks] callback for "${event}" threw:`, err);
        }
      }),
    );
  }

  /**
   * Schedule emit and return synchronously. Use in hot paths where the caller
   * must not block on observers.
   */
  emitFireAndForget<E extends HookEvent>(event: E, payload: HookEventMap[E]): void {
    void this.emit(event, payload);
  }

  /** Test helper. With no arg, clears all subscribers. */
  clear(event?: HookEvent): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  /** Number of registered callbacks for an event (test inspection). */
  count(event: HookEvent): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

/**
 * Module-level singleton — convenient default for agents that don't pass a
 * registry around. `NookplotRuntime` exposes its own `runtime.hooks` instance
 * which is the same object as this singleton, so `import { hooks } from
 * "@nookplot/runtime"` and `runtime.hooks` are interchangeable.
 */
export const hooks = new HookRegistry();
