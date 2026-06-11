"""Model-aware compaction thresholds + token estimator.

Mirrors the TypeScript runtime's model-limits module. The TypeScript file is
the canonical source; this Python file is kept in sync manually with the
gateway implementation.

The token estimator deliberately matches the gateway heuristic
(``ceil(len(content) / 4)``) so both compactors agree on "when to compact" —
important so the two layers don't fight each other on the same conversation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Mapping


@dataclass(frozen=True)
class ModelThreshold:
    """Compaction parameters for a single model."""

    compact_at: int
    """Estimated token count that triggers compaction."""
    preserve_recent: int
    """Number of recent messages preserved uncompacted."""


MODEL_THRESHOLDS: dict[str, ModelThreshold] = {
    # Small models — compact early, preserve fewer messages
    "hermes3": ModelThreshold(4800, 4),
    "hermes3:8b": ModelThreshold(4800, 4),
    "hermes-3-llama-3.1-8b": ModelThreshold(4800, 4),
    "llama3.2:8b": ModelThreshold(4800, 4),
    "mistral:7b": ModelThreshold(4800, 4),
    # Large models — more headroom
    "hermes-3-llama-3.1-405b": ModelThreshold(12000, 8),
    "llama3.3:70b": ModelThreshold(12000, 8),
    "qwen3:32b": ModelThreshold(10000, 6),
    "deepseek-r1:32b": ModelThreshold(10000, 6),
    # Advisor models — larger context windows
    "claude-3-5-sonnet-20241022": ModelThreshold(24000, 12),
    "claude-sonnet-4-20250514": ModelThreshold(24000, 12),
    "claude-opus-4-6": ModelThreshold(24000, 12),
    "gpt-4o": ModelThreshold(24000, 12),
    "deepseek-r1:70b": ModelThreshold(16000, 10),
}

DEFAULT_THRESHOLD = ModelThreshold(6000, 6)


def get_model_threshold(model_name: str) -> ModelThreshold:
    """Return the threshold for ``model_name`` or ``DEFAULT_THRESHOLD``."""
    return MODEL_THRESHOLDS.get(model_name, DEFAULT_THRESHOLD)


def estimate_tokens(messages: Iterable[Mapping[str, object]]) -> int:
    """Default heuristic: ``ceil(len(content) / 4)`` per message.

    Matches the gateway-side compaction thresholds. Replace via
    ``CompactionConfig.estimate_tokens`` for tokenizer-accurate counts.
    """
    total = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            total += math.ceil(len(content) / 4)
    return total


DEFAULT_COMPACTION_SYSTEM_PROMPT = """You are a conversation summarizer. Given a conversation history, produce a structured JSON summary that preserves ALL important context.

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
- Keep each array item under 20 words"""
