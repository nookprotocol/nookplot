/**
 * Doom-loop detector — catches stuck agents that call the same tool with
 * the same args 3+ times, or cycle through an `A,B,A,B`-style pattern.
 *
 * TypeScript parity with `runtime-py/nookplot_runtime/doom_loop.py`.
 *
 * Consumer-agnostic: callers pass either a list of OpenAI/litellm-shaped
 * messages (`{role, tool_calls: [{function: {name, arguments}}]}`) or a
 * pre-extracted list of `ToolCallSignature` values.
 *
 * The primary entry point is {@link checkForDoomLoop}. The goal loop uses
 * {@link checkForDoomLoopFromSignatures} directly since it tracks action
 * decisions, not raw LLM messages.
 *
 * Returned value is the offending tool name (string) or `null`. For repeating
 * patterns, the first tool in the repeating unit is returned.
 *
 * @module doomLoop
 */

import { createHash } from "node:crypto";

export const DEFAULT_LOOKBACK = 30;
export const IDENTICAL_THRESHOLD = 3;
export const MIN_PATTERN_LEN = 2;
export const MAX_PATTERN_LEN = 5;
export const MIN_PATTERN_REPS = 2;

export interface ToolCallSignature {
  readonly name: string;
  readonly argsHash: string;
}

function stableStringify(value: unknown): string {
  const replacer = (_key: string, v: unknown): unknown => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(value, replacer);
}

function hashArgs(args: unknown): string {
  let payload: string;
  if (typeof args === "string") {
    payload = args;
  } else {
    try {
      payload = stableStringify(args);
    } catch {
      payload = String(args);
    }
  }
  return createHash("md5").update(payload).digest("hex").slice(0, 12);
}

function get(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

function sigEquals(a: ToolCallSignature, b: ToolCallSignature): boolean {
  return a.name === b.name && a.argsHash === b.argsHash;
}

function sliceEquals(a: ToolCallSignature[], b: ToolCallSignature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sigEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

/**
 * Pull tool-call signatures out of the last `lookback` assistant messages.
 * Non-assistant messages and messages without `tool_calls` are skipped.
 */
export function extractRecentToolSignatures(
  messages: unknown[],
  lookback: number = DEFAULT_LOOKBACK,
): ToolCallSignature[] {
  const recent = messages.length > lookback ? messages.slice(-lookback) : messages;
  const signatures: ToolCallSignature[] = [];

  for (const msg of recent) {
    if (get(msg, "role") !== "assistant") continue;
    const toolCalls = get(msg, "tool_calls");
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

    for (const tc of toolCalls) {
      const fn = get(tc, "function");
      if (fn === undefined || fn === null) continue;
      const name = get(fn, "name");
      if (typeof name !== "string" || name.length === 0) continue;
      const args = get(fn, "arguments") ?? "";
      signatures.push({ name, argsHash: hashArgs(args) });
    }
  }

  return signatures;
}

/** Return the tool name if `threshold` or more identical consecutive calls exist. */
export function detectIdenticalConsecutive(
  signatures: ToolCallSignature[],
  threshold: number = IDENTICAL_THRESHOLD,
): string | null {
  if (signatures.length < threshold) return null;
  let count = 1;
  for (let i = 1; i < signatures.length; i++) {
    if (sigEquals(signatures[i]!, signatures[i - 1]!)) {
      count++;
      if (count >= threshold) return signatures[i]!.name;
    } else {
      count = 1;
    }
  }
  return null;
}

/**
 * Detect an `[A,B]`-style repeating unit at the tail with 2+ repetitions.
 * Scans unit lengths from 2 to 5. The smallest matching pattern wins.
 */
export function detectRepeatingSequence(
  signatures: ToolCallSignature[],
): ToolCallSignature[] | null {
  const n = signatures.length;
  for (let seqLen = MIN_PATTERN_LEN; seqLen <= MAX_PATTERN_LEN; seqLen++) {
    const minRequired = seqLen * MIN_PATTERN_REPS;
    if (n < minRequired) continue;
    const tail = signatures.slice(-minRequired);
    const pattern = tail.slice(0, seqLen);
    let reps = 0;
    for (let start = n - seqLen; start >= 0; start -= seqLen) {
      const chunk = signatures.slice(start, start + seqLen);
      if (sliceEquals(chunk, pattern)) {
        reps++;
      } else {
        break;
      }
    }
    if (reps >= MIN_PATTERN_REPS) return pattern;
  }
  return null;
}

/** Return the offending tool name, or `null` if no doom loop is present. */
export function checkForDoomLoopFromSignatures(
  signatures: ToolCallSignature[],
): string | null {
  if (signatures.length < IDENTICAL_THRESHOLD) return null;

  const offender = detectIdenticalConsecutive(signatures, IDENTICAL_THRESHOLD);
  if (offender) return offender;

  const pattern = detectRepeatingSequence(signatures);
  if (pattern) return pattern[0]!.name;

  return null;
}

/**
 * Check recent messages for a doom loop.
 * Returns the offending tool name, or `null` if no loop is detected.
 */
export function checkForDoomLoop(
  messages: unknown[],
  lookback: number = DEFAULT_LOOKBACK,
): string | null {
  const signatures = extractRecentToolSignatures(messages, lookback);
  return checkForDoomLoopFromSignatures(signatures);
}

/** Compose the system-inject message used after a doom loop is detected. */
export function buildCorrectivePrompt(offender: string): string {
  return (
    `⚠ Doom loop detected on '${offender}'. Change approach: either use a ` +
    `DIFFERENT tool, or if you must use '${offender}', call it with meaningfully ` +
    `different args. Otherwise declare noop or needs_capability.`
  );
}

/** Helper for callers that build their own signature list: hash args and construct. */
export function makeSignature(name: string, args: unknown): ToolCallSignature {
  return { name, argsHash: hashArgs(args) };
}
