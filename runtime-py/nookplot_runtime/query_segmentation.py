"""Query Segmentation -- multi-granularity query expansion for WakeUpStack L2.

The core observation is that on hard, multi-hypothesis queries,
a single pooled query embedding (the standard RAG pattern) produces a
"center of mass" vector that doesn't match any single relevant item well --
individual concepts inside the task get averaged away.

This module approximates a per-position attention query
approach using portable, cross-model content-layer primitives: split the
task into multiple sub-queries (full, sliding-window segments, named
entities, question-anchored spans) and let the gateway take MAX similarity
across all of them.

Pure string manipulation -- no NLP dependency. Mirrors the TypeScript
runtime's query-segmentation module exactly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class SegmentedQuery:
    """Decomposed task query with multiple granularities."""

    #: Complete task string (primary query).
    full: str
    #: Sliding-window substrings of the task (only emitted for long tasks).
    segments: list[str] = field(default_factory=list)
    #: Extracted entities: #hashtags, @mentions, Capitalized Multi-Word phrases.
    entities: list[str] = field(default_factory=list)
    #: Noun phrases extracted from question anchors ("what is X" -> "X").
    questions: list[str] = field(default_factory=list)


# Precompiled for hot path
_HASHTAG_RE = re.compile(r"[#@]\w+")
_CAP_PHRASE_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+")
_QUESTION_RE = re.compile(
    r"(?:what is|how do i|how to|why does|when should)\s+([a-z\s]{3,40})",
    re.IGNORECASE,
)


def segment_query(task: str, max_segments: int = 3) -> SegmentedQuery:
    """Decompose a task description into multiple query granularities.

    Args:
        task: The task/query text to segment.
        max_segments: Cap on sliding-window segments (default 3). Kept low
            because the gateway only embeds up to 4 query vectors total.

    Returns:
        A SegmentedQuery with full, segments, entities, and questions.
    """
    trimmed = task.strip()
    words = [w for w in trimmed.split() if w]

    # Sliding-window segments: only emit for tasks long enough to benefit.
    segments: list[str] = []
    if len(words) >= 10:
        window_size = 15
        stride = 8
        i = 0
        while i + window_size <= len(words) and len(segments) < max_segments:
            segments.append(" ".join(words[i : i + window_size]))
            i += stride

    # Entities: hashtags/mentions + capitalized multi-word phrases.
    hashtag_matches = _HASHTAG_RE.findall(trimmed)
    cap_matches = _CAP_PHRASE_RE.findall(trimmed)
    seen: set[str] = set()
    entities: list[str] = []
    for ent in [*hashtag_matches, *cap_matches]:
        if ent not in seen:
            seen.add(ent)
            entities.append(ent)
        if len(entities) >= 2:
            break

    # Question spans: extract noun phrase from "what is X" etc.
    questions: list[str] = []
    q_match = _QUESTION_RE.search(trimmed)
    if q_match:
        phrase = q_match.group(1).strip()
        if len(phrase) >= 3:
            questions.append(phrase)

    return SegmentedQuery(
        full=trimmed,
        segments=segments,
        entities=entities,
        questions=questions,
    )


def queries_from_segmented(s: SegmentedQuery, max_count: int = 4) -> list[str]:
    """Flatten a SegmentedQuery into a deduplicated, length-capped query list.

    The full-string query is always first so the single-query backward-compat
    path keeps its exact behavior when segments/entities/questions are empty.

    Args:
        s: SegmentedQuery to flatten.
        max_count: Hard cap on the number of query strings returned (default 4).
            The gateway enforces the same cap server-side.
    """
    all_queries: list[str] = [s.full, *s.segments, *s.entities, *s.questions]
    seen: set[str] = set()
    deduped: list[str] = []
    for q in all_queries:
        if not q or len(q) < 2:
            continue
        if q in seen:
            continue
        seen.add(q)
        deduped.append(q)
        if len(deduped) >= max_count:
            break
    return deduped


def segment_task_for_query(task: str, max_count: int = 4) -> list[str]:
    """Convenience wrapper: segment a task and return the flattened query list.

    Shorthand for ``queries_from_segmented(segment_query(task), max_count)``.
    """
    return queries_from_segmented(segment_query(task), max_count)
