"""Doom-loop detector — catches stuck agents that call the same tool with
the same args 3+ times, or cycle through an ``A,B,A,B``-style pattern.

Consumer-agnostic: callers pass either a list of OpenAI/litellm-shaped
messages (``{role, tool_calls: [{function: {name, arguments}}]}``) or a
pre-extracted list of :class:`ToolCallSignature` instances.

The primary entry point is :func:`check_for_doom_loop`. The goal loop uses
:func:`check_for_doom_loop_from_signatures` directly since it tracks action
decisions, not raw LLM messages.

Returned value is the offending tool name (string) or ``None``. For repeating
patterns, the first tool in the repeating unit is returned — callers that
need richer detail can call the lower-level detectors.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any, Iterable

logger = logging.getLogger("nookplot.doom_loop")

DEFAULT_LOOKBACK = 30
IDENTICAL_THRESHOLD = 3
MIN_PATTERN_LEN = 2
MAX_PATTERN_LEN = 5
MIN_PATTERN_REPS = 2


@dataclass(frozen=True)
class ToolCallSignature:
    """Hashable (name, args-hash) pair identifying one tool call."""

    name: str
    args_hash: str


def _hash_args(args: Any) -> str:
    if isinstance(args, str):
        payload = args
    else:
        try:
            payload = json.dumps(args, sort_keys=True, default=str)
        except Exception:
            payload = str(args)
    return hashlib.md5(payload.encode("utf-8")).hexdigest()[:12]


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Duck-typed accessor: works on dicts, dataclass-ish objects, and plain objects."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def extract_recent_tool_signatures(
    messages: Iterable[Any], lookback: int = DEFAULT_LOOKBACK
) -> list[ToolCallSignature]:
    """Pull tool-call signatures out of the last ``lookback`` assistant messages.

    Accepts message-shaped objects or dicts: ``{role, tool_calls: [{function: {name, arguments}}]}``.
    Non-assistant messages and messages without ``tool_calls`` are skipped.
    """
    msgs = list(messages)
    recent = msgs[-lookback:] if len(msgs) > lookback else msgs

    signatures: list[ToolCallSignature] = []
    for msg in recent:
        if _get(msg, "role") != "assistant":
            continue
        tool_calls = _get(msg, "tool_calls")
        if not tool_calls:
            continue
        for tc in tool_calls:
            fn = _get(tc, "function")
            if fn is None:
                continue
            name = _get(fn, "name") or ""
            args = _get(fn, "arguments")
            if args is None:
                args = ""
            if not name:
                continue
            signatures.append(ToolCallSignature(name=name, args_hash=_hash_args(args)))
    return signatures


def detect_identical_consecutive(
    signatures: list[ToolCallSignature], threshold: int = IDENTICAL_THRESHOLD
) -> str | None:
    """Return the tool name if ``threshold`` or more identical consecutive calls exist."""
    if len(signatures) < threshold:
        return None
    count = 1
    for i in range(1, len(signatures)):
        if signatures[i] == signatures[i - 1]:
            count += 1
            if count >= threshold:
                return signatures[i].name
        else:
            count = 1
    return None


def detect_repeating_sequence(
    signatures: list[ToolCallSignature],
) -> list[ToolCallSignature] | None:
    """Detect an ``[A,B]``-style repeating unit at the tail with 2+ repetitions.

    Scans unit lengths from 2 to 5. The smallest matching pattern wins.
    """
    n = len(signatures)
    for seq_len in range(MIN_PATTERN_LEN, MAX_PATTERN_LEN + 1):
        min_required = seq_len * MIN_PATTERN_REPS
        if n < min_required:
            continue
        tail = signatures[-min_required:]
        pattern = tail[:seq_len]
        reps = 0
        for start in range(n - seq_len, -1, -seq_len):
            chunk = signatures[start : start + seq_len]
            if chunk == pattern:
                reps += 1
            else:
                break
        if reps >= MIN_PATTERN_REPS:
            return pattern
    return None


def check_for_doom_loop_from_signatures(
    signatures: list[ToolCallSignature],
) -> str | None:
    """Return the offending tool name, or ``None`` if no doom loop is present."""
    if len(signatures) < IDENTICAL_THRESHOLD:
        return None

    offender = detect_identical_consecutive(signatures, threshold=IDENTICAL_THRESHOLD)
    if offender:
        logger.warning("doom loop: %d+ identical consecutive calls to '%s'", IDENTICAL_THRESHOLD, offender)
        return offender

    pattern = detect_repeating_sequence(signatures)
    if pattern:
        pattern_desc = "->".join(s.name for s in pattern)
        logger.warning("doom loop: repeating pattern [%s]", pattern_desc)
        return pattern[0].name

    return None


def check_for_doom_loop(
    messages: Iterable[Any], lookback: int = DEFAULT_LOOKBACK
) -> str | None:
    """Check recent messages for a doom loop.

    Returns the offending tool name, or ``None`` if no loop is detected.
    """
    signatures = extract_recent_tool_signatures(messages, lookback=lookback)
    return check_for_doom_loop_from_signatures(signatures)


def build_corrective_prompt(offender: str) -> str:
    """Compose the system-inject message used after a doom loop is detected."""
    return (
        f"⚠ Doom loop detected on '{offender}'. Change approach: either use a "
        f"DIFFERENT tool, or if you must use '{offender}', call it with meaningfully "
        f"different args. Otherwise declare noop or needs_capability."
    )


__all__ = [
    "ToolCallSignature",
    "extract_recent_tool_signatures",
    "detect_identical_consecutive",
    "detect_repeating_sequence",
    "check_for_doom_loop",
    "check_for_doom_loop_from_signatures",
    "build_corrective_prompt",
]
