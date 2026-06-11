"""Unit tests for the doom-loop detector (Python parity with the TypeScript runtime's doom-loop suite)."""
from __future__ import annotations

import json

import pytest

from nookplot_runtime.doom_loop import (
    ToolCallSignature,
    _hash_args,
    build_corrective_prompt,
    check_for_doom_loop,
    check_for_doom_loop_from_signatures,
    detect_identical_consecutive,
    detect_repeating_sequence,
    extract_recent_tool_signatures,
)


def _msg(name: str, args: dict | None = None) -> dict:
    """Build an OpenAI-shaped assistant message with one tool call."""
    return {
        "role": "assistant",
        "tool_calls": [
            {"function": {"name": name, "arguments": json.dumps(args or {})}}
        ],
    }


def _sig(name: str, args: dict | None = None) -> ToolCallSignature:
    return ToolCallSignature(name=name, args_hash=_hash_args(args or {}))


# -----------------------------------------------------------------------------
#  Doom-loop detector spec
# -----------------------------------------------------------------------------


def test_three_identical_consecutive_returns_tool_name() -> None:
    msgs = [_msg("search_knowledge", {"q": "x"})] * 3
    assert check_for_doom_loop(msgs) == "search_knowledge"


def test_two_identical_returns_none() -> None:
    msgs = [_msg("search_knowledge", {"q": "x"})] * 2
    assert check_for_doom_loop(msgs) is None


def test_abab_returns_repeating_pattern_tool_name() -> None:
    msgs = [_msg("A"), _msg("B"), _msg("A"), _msg("B")]
    assert check_for_doom_loop(msgs) == "A"


def test_aba_returns_none() -> None:
    msgs = [_msg("A"), _msg("B"), _msg("A")]
    assert check_for_doom_loop(msgs) is None


def test_no_tool_calls_returns_none() -> None:
    msgs = [{"role": "assistant", "content": "just thinking"} for _ in range(5)]
    assert check_for_doom_loop(msgs) is None


# -----------------------------------------------------------------------------
#  Signature helpers
# -----------------------------------------------------------------------------


def test_hash_args_stable_across_key_order() -> None:
    # Same dict, different insertion order → same hash.
    a = _hash_args({"a": 1, "b": 2})
    b = _hash_args({"b": 2, "a": 1})
    assert a == b


def test_hash_args_changes_with_values() -> None:
    assert _hash_args({"q": "x"}) != _hash_args({"q": "y"})


def test_extract_skips_non_assistant_messages() -> None:
    msgs = [
        {"role": "user", "content": "go"},
        _msg("A"),
        {"role": "tool", "content": "result"},
        _msg("A"),
    ]
    sigs = extract_recent_tool_signatures(msgs)
    assert len(sigs) == 2
    assert sigs[0].name == "A"


def test_extract_honors_lookback() -> None:
    msgs = [_msg(f"tool_{i}") for i in range(50)]
    sigs = extract_recent_tool_signatures(msgs, lookback=5)
    assert len(sigs) == 5
    assert sigs[-1].name == "tool_49"


def test_extract_empty() -> None:
    assert extract_recent_tool_signatures([]) == []


# -----------------------------------------------------------------------------
#  Detection primitives
# -----------------------------------------------------------------------------


def test_detect_identical_consecutive_differs_on_args() -> None:
    # Same tool name, different args hash → not identical.
    sigs = [
        _sig("search", {"q": "a"}),
        _sig("search", {"q": "b"}),
        _sig("search", {"q": "c"}),
    ]
    assert detect_identical_consecutive(sigs, threshold=3) is None


def test_detect_identical_consecutive_three_rematch() -> None:
    sigs = [_sig("search", {"q": "x"})] * 3
    assert detect_identical_consecutive(sigs, threshold=3) == "search"


def test_detect_identical_consecutive_resets_on_different() -> None:
    # A, A, B, A, A — only 2 consecutive at any point, under threshold.
    sigs = [
        _sig("A"),
        _sig("A"),
        _sig("B"),
        _sig("A"),
        _sig("A"),
    ]
    assert detect_identical_consecutive(sigs, threshold=3) is None


def test_detect_identical_consecutive_threshold_four() -> None:
    sigs = [_sig("A")] * 4
    assert detect_identical_consecutive(sigs, threshold=4) == "A"
    sigs3 = [_sig("A")] * 3
    assert detect_identical_consecutive(sigs3, threshold=4) is None


def test_detect_repeating_sequence_abab() -> None:
    sigs = [_sig("A"), _sig("B"), _sig("A"), _sig("B")]
    pattern = detect_repeating_sequence(sigs)
    assert pattern is not None
    assert [s.name for s in pattern] == ["A", "B"]


def test_detect_repeating_sequence_abc_abc() -> None:
    sigs = [_sig(x) for x in ("A", "B", "C", "A", "B", "C")]
    pattern = detect_repeating_sequence(sigs)
    assert pattern is not None
    assert [s.name for s in pattern] == ["A", "B", "C"]


def test_detect_repeating_sequence_prefers_shortest_unit() -> None:
    # [A,A,A,A] also matches seq_len=2 ([A,A],[A,A]) which is the shortest match.
    sigs = [_sig("A")] * 4
    pattern = detect_repeating_sequence(sigs)
    assert pattern is not None
    assert len(pattern) == 2


def test_detect_repeating_sequence_no_pattern() -> None:
    sigs = [_sig(x) for x in ("A", "B", "C", "D", "E")]
    assert detect_repeating_sequence(sigs) is None


# -----------------------------------------------------------------------------
#  Signatures-path API (used by goal_loop)
# -----------------------------------------------------------------------------


def test_from_signatures_identical() -> None:
    sigs = [_sig("X")] * 3
    assert check_for_doom_loop_from_signatures(sigs) == "X"


def test_from_signatures_abab() -> None:
    sigs = [_sig("A"), _sig("B"), _sig("A"), _sig("B")]
    assert check_for_doom_loop_from_signatures(sigs) == "A"


def test_from_signatures_under_threshold() -> None:
    sigs = [_sig("A"), _sig("A")]
    assert check_for_doom_loop_from_signatures(sigs) is None


def test_from_signatures_empty() -> None:
    assert check_for_doom_loop_from_signatures([]) is None


def test_corrective_prompt_mentions_offender() -> None:
    msg = build_corrective_prompt("search_knowledge")
    assert "search_knowledge" in msg
    assert "Doom loop" in msg


# -----------------------------------------------------------------------------
#  Duck-typed input: object attributes instead of dict keys
# -----------------------------------------------------------------------------


class _Fn:
    def __init__(self, name: str, arguments: str) -> None:
        self.name = name
        self.arguments = arguments


class _Call:
    def __init__(self, name: str, arguments: str) -> None:
        self.function = _Fn(name, arguments)


class _Msg:
    def __init__(self, name: str, args: dict) -> None:
        self.role = "assistant"
        self.tool_calls = [_Call(name, json.dumps(args))]


def test_extract_works_with_attribute_objects() -> None:
    msgs = [_Msg("A", {"q": 1}) for _ in range(3)]
    assert check_for_doom_loop(msgs) == "A"
