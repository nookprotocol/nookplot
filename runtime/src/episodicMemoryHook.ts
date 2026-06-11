/**
 * episodicMemoryHook — installs a `chat_turn_complete` listener that persists
 * each turn into the agent's episodic memory tier.
 *
 * Replaces the inlined `runtime.memory.storeMemory("episodic", …)` call that
 * previously lived in `chat/chatEngine.ts`. Behavior is byte-for-byte
 * preserved when the engine emits `enableMemory: true` — see the
 * `chatEngine.episodicHook.test.ts` regression suite for proof.
 *
 * Auto-installed by `NookplotRuntime.connect()` unless the runtime was
 * constructed with `{ autoInstallHooks: false }`. Opt-out, not opt-in —
 * existing agents get the prior behavior for free.
 *
 * @example
 * ```ts
 * const dispose = installEpisodicMemoryHook(runtime, { tagPrefix: "myagent" });
 * // ...later
 * dispose(); // stop the hook (also called automatically on runtime.disconnect)
 * ```
 *
 * @module episodicMemoryHook
 */

import type { NookplotRuntime } from "./index.js";
import type { ChatTurnCompletePayload, HookRegistry } from "./hooks.js";
import { hooks as defaultHooks } from "./hooks.js";

export interface EpisodicHookOptions {
  /** Override the registry the hook subscribes to. Defaults to `runtime.hooks`. */
  hooks?: HookRegistry;
  /** Extra tags appended to every stored entry (e.g. ["env:prod"]). */
  extraTags?: string[];
  /** Override the agent name used in the formatted line. Defaults to payload.agentName. */
  agentName?: string;
}

/**
 * Subscribe to `chat_turn_complete` and write each turn to episodic memory.
 *
 * Returns a disposer that removes the listener.
 */
export function installEpisodicMemoryHook(
  runtime: NookplotRuntime,
  opts: EpisodicHookOptions = {},
): () => void {
  const hooks = opts.hooks ?? runtime.hooks ?? defaultHooks;

  const listener = (payload: ChatTurnCompletePayload): void => {
    // Respect the engine's enableMemory flag — when memory is disabled at
    // the engine level, suppress writes regardless of hook registration.
    if (payload.enableMemory === false) return;

    const { platform, sender, message, response, toolsUsed, toolCallCount, senderId, channelId } =
      payload;
    const agentName = opts.agentName ?? payload.agentName ?? "Agent";
    const extraTags = opts.extraTags ?? [];

    runtime.memory
      .storeMemory(
        "episodic",
        `[${platform}] ${sender}: ${message}\n${agentName}: ${response}`,
        {
          tags: ["conversation", platform, ...(toolsUsed ? ["tool_use"] : []), ...extraTags],
          metadata: {
            platform,
            senderId: senderId ?? null,
            senderName: sender ?? null,
            channelId: channelId ?? null,
            toolsUsed,
            toolCallCount,
            messageLength: message.length,
            responseLength: response.length,
            timestamp: new Date().toISOString(),
          },
        },
      )
      .catch(() => { /* best-effort — fire-and-forget */ });
  };

  return hooks.register("chat_turn_complete", listener);
}
