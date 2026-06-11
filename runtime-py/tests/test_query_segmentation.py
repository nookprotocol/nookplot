"""Tests for query_segmentation -- multi-granularity query expansion.

Mirrors the TypeScript runtime's query-segmentation test suite.
Pure-function tests -- no mocks needed.
"""
from __future__ import annotations

from nookplot_runtime.query_segmentation import (
    SegmentedQuery,
    segment_query,
    queries_from_segmented,
    segment_task_for_query,
)


class TestSegmentQuery:
    def test_preserves_full_trimmed_task(self):
        s = segment_query("  review the audit findings  ")
        assert s.full == "review the audit findings"

    def test_no_segments_for_short_tasks(self):
        s = segment_query("review this code for security issues please")
        assert s.segments == []

    def test_emits_segments_for_long_tasks(self):
        task = (
            "one two three four five six seven eight nine ten "
            "eleven twelve thirteen fourteen fifteen"
        )
        s = segment_query(task)
        assert len(s.segments) >= 1
        assert s.segments[0] == task

    def test_caps_segments_at_max_segments_default(self):
        task = " ".join(f"word{i}" for i in range(40))
        s = segment_query(task)
        assert len(s.segments) <= 3

    def test_caps_segments_at_custom_max(self):
        task = " ".join(f"word{i}" for i in range(40))
        s = segment_query(task, max_segments=2)
        assert len(s.segments) <= 2

    def test_extracts_hashtags(self):
        s = segment_query("discussing #latentspace and #mining topics")
        assert "#latentspace" in s.entities
        assert "#mining" in s.entities

    def test_extracts_mentions(self):
        s = segment_query("responding to @alice about the spec")
        assert "@alice" in s.entities

    def test_extracts_capitalized_phrases(self):
        s = segment_query("Vector Search cites Hashmap in comparison")
        assert "Vector Search" in s.entities
        # Hashmap is a single word so it's NOT captured by the multi-word regex
        assert "Hashmap" not in s.entities

    def test_caps_entities_at_two(self):
        s = segment_query("#a #b #c #d Latent Space Embedding Exchange")
        assert len(s.entities) <= 2

    def test_extracts_what_is_questions(self):
        s = segment_query("what is a knowledge bundle in Nookplot")
        assert len(s.questions) >= 1
        assert "knowledge bundle" in s.questions[0]

    def test_extracts_how_to_questions(self):
        s = segment_query("how to claim a mining reward safely")
        assert len(s.questions) >= 1

    def test_no_questions_for_imperative(self):
        s = segment_query("refactor the authentication middleware")
        assert s.questions == []

    def test_handles_empty_input(self):
        s = segment_query("")
        assert s.full == ""
        assert s.segments == []
        assert s.entities == []
        assert s.questions == []

    def test_handles_whitespace_only_input(self):
        s = segment_query("   \n\t  ")
        assert s.full == ""
        assert s.segments == []


class TestQueriesFromSegmented:
    def test_full_query_first(self):
        s = segment_query("Vector Search explains attention")
        q = queries_from_segmented(s)
        assert q[0] == "Vector Search explains attention"

    def test_deduplicates(self):
        s = SegmentedQuery(
            full="same query",
            segments=["same query"],
            entities=["same query"],
            questions=[],
        )
        q = queries_from_segmented(s)
        assert len(q) == 1
        assert q[0] == "same query"

    def test_drops_too_short_strings(self):
        s = SegmentedQuery(
            full="real query",
            segments=[],
            entities=["a", "x"],
            questions=[],
        )
        q = queries_from_segmented(s)
        assert q == ["real query"]

    def test_enforces_hard_cap_default_4(self):
        s = SegmentedQuery(
            full="full",
            segments=["seg1", "seg2", "seg3"],
            entities=["#one", "#two"],
            questions=["q1"],
        )
        q = queries_from_segmented(s)
        assert len(q) <= 4
        assert q[0] == "full"

    def test_respects_custom_max(self):
        s = SegmentedQuery(
            full="full",
            segments=["seg1", "seg2"],
            entities=["#one"],
            questions=["q1"],
        )
        q = queries_from_segmented(s, max_count=2)
        assert len(q) == 2

    def test_returns_only_full_when_empty(self):
        s = SegmentedQuery(full="just the task", segments=[], entities=[], questions=[])
        assert queries_from_segmented(s) == ["just the task"]

    def test_preserves_order(self):
        s = SegmentedQuery(
            full="full task",
            segments=["seg-one", "seg-two"],
            entities=["#ent"],
            questions=["q1"],
        )
        q = queries_from_segmented(s)
        # Default cap 4 → questions["q1"] gets dropped
        assert q == ["full task", "seg-one", "seg-two", "#ent"]

    def test_includes_question_when_under_cap(self):
        s = SegmentedQuery(
            full="full task",
            segments=[],
            entities=[],
            questions=["question phrase"],
        )
        assert queries_from_segmented(s) == ["full task", "question phrase"]


class TestSegmentTaskForQuery:
    def test_collapses_to_single_element_for_short_task(self):
        assert segment_task_for_query("review the PR") == ["review the PR"]

    def test_expands_for_long_tasks(self):
        task = (
            "review the Vector Search spec changes against our current "
            "Hashmap implementation carefully"
        )
        q = segment_task_for_query(task)
        assert q[0] == task
        assert 1 <= len(q) <= 4

    def test_enforces_gateway_4_query_cap(self):
        words = " ".join(f"word{i}" for i in range(60))
        task = f"{words} #tag1 #tag2 what is a Knowledge Bundle thing"
        q = segment_task_for_query(task)
        assert len(q) <= 4

    def test_empty_string_returns_empty_list(self):
        # full is "" → length 0 → filtered by >= 2 check
        assert segment_task_for_query("") == []

    def test_whitespace_only_returns_empty_list(self):
        assert segment_task_for_query("   ") == []
