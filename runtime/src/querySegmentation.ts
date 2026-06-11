/**
 * Query Segmentation — multi-granularity query expansion for WakeUpStack L2.
 *
 * The core observation is that on hard, multi-hypothesis queries,
 * a single pooled query embedding (the standard RAG pattern) produces a
 * "center of mass" vector that doesn't match any single relevant item well —
 * individual concepts inside the task get averaged away.
 *
 * This module approximates a per-position attention query
 * approach using portable, cross-model content-layer primitives: split the
 * task into multiple sub-queries (full, sliding-window segments, named
 * entities, question-anchored spans) and let the gateway take `MAX` similarity
 * across all of them.
 *
 * Pure string manipulation — no NLP dependency. A proper entity extractor
 * would improve recall marginally but isn't worth the dependency for v1.
 *
 * @module querySegmentation
 */

export interface SegmentedQuery {
  /** Complete task string, kept as the primary query (preserves baseline). */
  full: string;
  /** Sliding-window substrings of the task (only emitted for long tasks). */
  segments: string[];
  /** Extracted entities — #hashtags, @mentions, capitalized multi-word phrases. */
  entities: string[];
  /** Noun phrases extracted from question-word anchors ("what is X" → "X"). */
  questions: string[];
}

/**
 * Decompose a task description into multiple query granularities.
 *
 * @param task - The task/query text to segment.
 * @param maxSegments - Cap on sliding-window segments (default 3). Kept low
 *   because the gateway only embeds up to 4 query vectors total per call.
 */
export function segmentQuery(task: string, maxSegments = 3): SegmentedQuery {
  const trimmed = task.trim();
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);

  // ── Sliding-window segments ──
  // Only emit segments for tasks long enough to benefit — short queries go
  // through as a single full-string embedding and don't need segmentation.
  const segments: string[] = [];
  if (words.length >= 10) {
    const windowSize = 15;
    const stride = 8;
    for (
      let i = 0;
      i + windowSize <= words.length && segments.length < maxSegments;
      i += stride
    ) {
      segments.push(words.slice(i, i + windowSize).join(" "));
    }
  }

  // ── Entity extraction ──
  // Three cheap signals:
  //   1. #hashtags / @mentions (explicit tagging)
  //   2. Capitalized multi-word phrases ("Vector Search", "Bounty Escrow")
  const hashtagMatches = Array.from(trimmed.matchAll(/[#@]\w+/g)).map((m) => m[0]);
  const capMatches = Array.from(
    trimmed.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g),
  ).map((m) => m[0]);
  const entities = Array.from(new Set([...hashtagMatches, ...capMatches])).slice(0, 2);

  // ── Question spans ──
  // "what is X", "how do I Y", etc. — extract the target noun phrase.
  const questions: string[] = [];
  const qMatch = trimmed.match(
    /(?:what is|how do i|how to|why does|when should)\s+([a-z\s]{3,40})/i,
  );
  if (qMatch?.[1]) {
    const phrase = qMatch[1].trim();
    if (phrase.length >= 3) questions.push(phrase);
  }

  return { full: trimmed, segments, entities, questions };
}

/**
 * Flatten a `SegmentedQuery` into a deduplicated, length-capped list of
 * query strings suitable for passing to the gateway's multi-query
 * `searchKnowledge` endpoint. The full-string query is always first so
 * the single-query/backward-compat path keeps its exact behavior when
 * segments/entities/questions are empty.
 *
 * @param max - Hard cap on the number of query strings returned (default 4).
 *   The gateway enforces the same cap server-side.
 */
export function queriesFromSegmented(s: SegmentedQuery, max = 4): string[] {
  const all = [s.full, ...s.segments, ...s.entities, ...s.questions].filter(
    (q) => q && q.length >= 2,
  );
  return Array.from(new Set(all)).slice(0, max);
}

/**
 * Convenience wrapper: segment a task and return the flattened query list in
 * one call. Shorthand for `queriesFromSegmented(segmentQuery(task), max)`.
 */
export function segmentTaskForQuery(task: string, max = 4): string[] {
  return queriesFromSegmented(segmentQuery(task), max);
}
