/**
 * Model-aware compaction thresholds + token estimator.
 *
 * Mirrors the gateway-side session-compaction logic. THIS file is now
 * the canonical source; the gateway's copy is kept in sync manually with
 * this implementation.
 *
 * The token estimator deliberately matches the gateway's heuristic
 * (`Math.ceil(content.length / 4)`) so both compactors agree on "when to
 * compact" — important so the two layers don't fight each other on the same
 * conversation viewed through different lenses.
 *
 * @module conversation/modelLimits
 */
import type { InferenceMessage } from "../types.js";

export interface ModelThreshold {
  /** Estimated token count that triggers compaction. */
  compactAt: number;
  /** Number of recent messages preserved uncompacted. */
  preserveRecent: number;
}

/**
 * Per-model compaction thresholds. Add new model IDs here as they become
 * supported on the platform; unknown models fall back to {@link DEFAULT_THRESHOLD}.
 */
export const MODEL_THRESHOLDS: Record<string, ModelThreshold> = {
  // Small models — compact early, preserve fewer messages
  "hermes3": { compactAt: 4800, preserveRecent: 4 },
  "hermes3:8b": { compactAt: 4800, preserveRecent: 4 },
  "hermes-3-llama-3.1-8b": { compactAt: 4800, preserveRecent: 4 },
  "llama3.2:8b": { compactAt: 4800, preserveRecent: 4 },
  "mistral:7b": { compactAt: 4800, preserveRecent: 4 },
  // Large models — more headroom
  "hermes-3-llama-3.1-405b": { compactAt: 12000, preserveRecent: 8 },
  "llama3.3:70b": { compactAt: 12000, preserveRecent: 8 },
  "qwen3:32b": { compactAt: 10000, preserveRecent: 6 },
  "deepseek-r1:32b": { compactAt: 10000, preserveRecent: 6 },
  // Advisor models — larger context windows
  "claude-3-5-sonnet-20241022": { compactAt: 24000, preserveRecent: 12 },
  "claude-sonnet-4-20250514": { compactAt: 24000, preserveRecent: 12 },
  "claude-opus-4-6": { compactAt: 24000, preserveRecent: 12 },
  "gpt-4o": { compactAt: 24000, preserveRecent: 12 },
  "deepseek-r1:70b": { compactAt: 16000, preserveRecent: 10 },
};

/** Fallback for any model not listed in {@link MODEL_THRESHOLDS}. */
export const DEFAULT_THRESHOLD: ModelThreshold = { compactAt: 6000, preserveRecent: 6 };

export function getModelThreshold(modelName: string): ModelThreshold {
  return MODEL_THRESHOLDS[modelName] ?? DEFAULT_THRESHOLD;
}

/**
 * Default token estimator: ceil(content.length / 4) per message.
 *
 * Matches the gateway-side compaction thresholds. Replace via
 * `CompactionConfig.estimateTokens` if you need a tokenizer-accurate count
 * (the heuristic over-counts code-heavy text and under-counts CJK).
 */
export function estimateTokens(messages: InferenceMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += Math.ceil(m.content.length / 4);
    }
  }
  return total;
}

/**
 * Default system preamble passed to the caller-supplied `compactFn`. Same shape
 * the gateway uses so summaries on either layer have the same structure.
 */
export const DEFAULT_COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Given a conversation history, produce a structured JSON summary that preserves ALL important context.

Output format (JSON only, no markdown):
{
  "activeGoals": ["goal 1", "goal 2"],
  "keyDecisions": ["decision 1"],
  "pendingActions": ["action 1"],
  "userPreferences": ["preference 1"],
  "importantFacts": ["fact 1"],
  "conversationTone": "brief description of the conversation dynamic"
}

Rules:
- Include EVERY active goal, pending action, and key decision
- Be specific — "deploy DeFi monitoring agent" not "deploy agent"
- Drop pleasantries, greetings, and meta-commentary about the conversation
- If user expressed preferences (model choice, budget, style), capture them
- Keep each array item under 20 words`;
