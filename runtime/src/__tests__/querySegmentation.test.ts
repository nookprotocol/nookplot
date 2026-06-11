/**
 * Tests for query segmentation — multi-granularity query expansion for
 * WakeUpStack L2 retrieval.
 *
 * segmentQuery is a pure string function — no I/O, no mocks needed. Each test
 * asserts a specific invariant of the segmentation contract that the gateway's
 * multi-query search path depends on.
 */
import { describe, it, expect } from "vitest";
import {
  segmentQuery,
  queriesFromSegmented,
  segmentTaskForQuery,
} from "../querySegmentation.js";

describe("segmentQuery", () => {
  it("preserves the full trimmed task as .full", () => {
    const s = segmentQuery("  review the audit findings  ");
    expect(s.full).toBe("review the audit findings");
  });

  it("emits no sliding-window segments for short tasks (< 10 words)", () => {
    const s = segmentQuery("review this code for security issues please");
    expect(s.segments).toEqual([]);
  });

  it("emits sliding-window segments for long tasks (≥ 10 words)", () => {
    // 15 words — produces at least one window of 15 words
    const task =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const s = segmentQuery(task);
    expect(s.segments.length).toBeGreaterThanOrEqual(1);
    // First segment should contain the first 15 words
    expect(s.segments[0]).toBe(task);
  });

  it("caps sliding-window segments at maxSegments", () => {
    // 40 words with stride 8 + window 15 → up to 4 windows, capped at 3 by default
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const s = segmentQuery(words);
    expect(s.segments.length).toBeLessThanOrEqual(3);
  });

  it("caps at custom maxSegments", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const s = segmentQuery(words, 2);
    expect(s.segments.length).toBeLessThanOrEqual(2);
  });

  it("extracts hashtags as entities", () => {
    const s = segmentQuery("discussing #latentspace and #mining topics");
    expect(s.entities).toContain("#latentspace");
    expect(s.entities).toContain("#mining");
  });

  it("extracts @mentions as entities", () => {
    const s = segmentQuery("responding to @alice about the spec");
    expect(s.entities).toContain("@alice");
  });

  it("extracts capitalized multi-word phrases as entities", () => {
    const s = segmentQuery("Vector Search cites Hashmap in the comparison");
    expect(s.entities).toContain("Vector Search");
    expect(s.entities).not.toContain("Hashmap"); // single word — not captured
  });

  it("caps entities at 2", () => {
    const s = segmentQuery("#a #b #c #d Latent Space Embedding Exchange");
    expect(s.entities.length).toBeLessThanOrEqual(2);
  });

  it("extracts 'what is X' question spans", () => {
    const s = segmentQuery("what is a knowledge bundle in Nookplot");
    expect(s.questions.length).toBeGreaterThanOrEqual(1);
    // The extracted phrase drops the "what is" prefix
    expect(s.questions[0]).toContain("knowledge bundle");
  });

  it("extracts 'how to X' question spans", () => {
    const s = segmentQuery("how to claim a mining reward safely");
    expect(s.questions.length).toBeGreaterThanOrEqual(1);
  });

  it("emits no questions for non-question queries", () => {
    const s = segmentQuery("refactor the authentication middleware");
    expect(s.questions).toEqual([]);
  });

  it("handles empty input without throwing", () => {
    const s = segmentQuery("");
    expect(s.full).toBe("");
    expect(s.segments).toEqual([]);
    expect(s.entities).toEqual([]);
    expect(s.questions).toEqual([]);
  });

  it("handles whitespace-only input without throwing", () => {
    const s = segmentQuery("   \n\t  ");
    expect(s.full).toBe("");
    expect(s.segments).toEqual([]);
  });
});

describe("queriesFromSegmented", () => {
  it("always places full query first (preserves single-query baseline)", () => {
    const s = segmentQuery("Vector Search explains attention");
    const q = queriesFromSegmented(s);
    expect(q[0]).toBe("Vector Search explains attention");
  });

  it("deduplicates repeated strings", () => {
    const s = {
      full: "same query",
      segments: ["same query"],
      entities: ["same query"],
      questions: [],
    };
    const q = queriesFromSegmented(s);
    expect(q.length).toBe(1);
    expect(q[0]).toBe("same query");
  });

  it("drops strings shorter than 2 chars", () => {
    const s = {
      full: "real query",
      segments: [],
      entities: ["a", "x"],
      questions: [],
    };
    const q = queriesFromSegmented(s);
    expect(q).toEqual(["real query"]);
  });

  it("enforces hard cap at max (default 4)", () => {
    const s = {
      full: "full",
      segments: ["seg1", "seg2", "seg3"],
      entities: ["#one", "#two"],
      questions: ["q1"],
    };
    const q = queriesFromSegmented(s);
    expect(q.length).toBeLessThanOrEqual(4);
    expect(q[0]).toBe("full");
  });

  it("respects custom max", () => {
    const s = {
      full: "full",
      segments: ["seg1", "seg2"],
      entities: ["#one"],
      questions: ["q1"],
    };
    const q = queriesFromSegmented(s, 2);
    expect(q.length).toBe(2);
  });

  it("returns only full when everything else is empty", () => {
    const s = { full: "just the task", segments: [], entities: [], questions: [] };
    expect(queriesFromSegmented(s)).toEqual(["just the task"]);
  });

  it("preserves order: full, segments, entities, questions", () => {
    const s = {
      full: "full task",
      segments: ["seg-one", "seg-two"],
      entities: ["#ent"],
      questions: ["q1"],
    };
    const q = queriesFromSegmented(s);
    // Default max=4 → questions["q1"] gets truncated
    expect(q).toEqual(["full task", "seg-one", "seg-two", "#ent"]);
  });

  it("includes question when under cap", () => {
    const s = {
      full: "full task",
      segments: [],
      entities: [],
      questions: ["question phrase"],
    };
    const q = queriesFromSegmented(s);
    expect(q).toEqual(["full task", "question phrase"]);
  });
});

describe("segmentTaskForQuery", () => {
  it("collapses to a single-element array for short/simple tasks", () => {
    const q = segmentTaskForQuery("review the PR");
    expect(q).toEqual(["review the PR"]);
  });

  it("expands multi-segment for long queries with entities", () => {
    const task =
      "review the Vector Search spec changes against our current Hashmap implementation carefully";
    const q = segmentTaskForQuery(task);
    // Must have at least the full query; likely picks up "Vector Search" as entity
    expect(q[0]).toBe(task);
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q.length).toBeLessThanOrEqual(4);
  });

  it("enforces 4-query hard cap matching gateway", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const task = `${words} #tag1 #tag2 what is a Knowledge Bundle thing`;
    const q = segmentTaskForQuery(task);
    expect(q.length).toBeLessThanOrEqual(4);
  });

  it("returns [] for an empty string (guarded by length >= 2 filter)", () => {
    // full is "" → length 0 → dropped by the >= 2 filter → empty result
    const q = segmentTaskForQuery("");
    expect(q).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    const q = segmentTaskForQuery("   ");
    expect(q).toEqual([]);
  });
});
