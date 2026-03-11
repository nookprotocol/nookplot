import { describe, it, expect, vi } from "vitest";
import { QualityScorer } from "./qualityScorer.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  computeWeightedReviewScores — no PageRank
// ---------------------------------------------------------------------------

describe("QualityScorer — computeWeightedReviewScores (no PageRank)", () => {
  it("computes equal-weight scores when no PageRank map", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reviewee_agent_id: "agt_1", reviewer_address: "0xA", rating: 4 },
        { reviewee_agent_id: "agt_1", reviewer_address: "0xB", rating: 5 },
      ],
      rowCount: 2,
    });

    const scorer = new QualityScorer(pool as any);
    const results = await scorer.computeWeightedReviewScores();

    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe("agt_1");
    expect(results[0].reviewCount).toBe(2);
    // avgRating = 4.5, weightedScore = 4.5 / 5 * 100 = 90
    expect(results[0].avgRating).toBe(4.5);
    expect(results[0].weightedScore).toBe(90);
  });

  it("returns empty array when no reviews exist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const scorer = new QualityScorer(pool as any);
    const results = await scorer.computeWeightedReviewScores();

    expect(results).toHaveLength(0);
  });

  it("groups reviews by reviewee agent", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reviewee_agent_id: "agt_1", reviewer_address: "0xA", rating: 3 },
        { reviewee_agent_id: "agt_2", reviewer_address: "0xB", rating: 5 },
        { reviewee_agent_id: "agt_2", reviewer_address: "0xC", rating: 4 },
      ],
      rowCount: 3,
    });

    const scorer = new QualityScorer(pool as any);
    const results = await scorer.computeWeightedReviewScores();

    expect(results).toHaveLength(2);
    const agt1 = results.find((r) => r.agentId === "agt_1");
    const agt2 = results.find((r) => r.agentId === "agt_2");
    expect(agt1?.reviewCount).toBe(1);
    expect(agt2?.reviewCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  computeWeightedReviewScores — with PageRank
// ---------------------------------------------------------------------------

describe("QualityScorer — computeWeightedReviewScores (with PageRank)", () => {
  it("weights reviews by reviewer PageRank", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reviewee_agent_id: "agt_1", reviewer_address: "0xHigh", rating: 5 },
        { reviewee_agent_id: "agt_1", reviewer_address: "0xLow", rating: 1 },
      ],
      rowCount: 2,
    });

    const pageRankMap = new Map<string, number>([
      ["0xhigh", 0.9], // note: lowercase
      ["0xlow", 0.1],
    ]);

    const scorer = new QualityScorer(pool as any);
    const results = await scorer.computeWeightedReviewScores(pageRankMap);

    expect(results).toHaveLength(1);
    // weightedSum = 0.9*5 + 0.1*1 = 4.6, totalWeight = 1.0
    // weightedScore = (4.6 / 1.0 / 5) * 100 = 92
    expect(results[0].weightedScore).toBe(92);
  });

  it("filters out reviewers below PageRank floor", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reviewee_agent_id: "agt_1", reviewer_address: "0xAbove", rating: 3 },
        { reviewee_agent_id: "agt_1", reviewer_address: "0xBelow", rating: 5 },
      ],
      rowCount: 2,
    });

    const pageRankMap = new Map<string, number>([
      ["0xabove", 0.5],
      ["0xbelow", 0.05],
    ]);

    const scorer = new QualityScorer(pool as any);
    const results = await scorer.computeWeightedReviewScores(pageRankMap, 0.1);

    expect(results).toHaveLength(1);
    // Only 0xAbove passes floor, rating=3
    // weightedScore = (0.5*3 / 0.5 / 5) * 100 = 60
    expect(results[0].weightedScore).toBe(60);
  });
});

// ---------------------------------------------------------------------------
//  assessContent
// ---------------------------------------------------------------------------

describe("QualityScorer — assessContent", () => {
  it("returns null when no inference proxy configured", async () => {
    const pool = createMockPool();
    const scorer = new QualityScorer(pool as any);
    const result = await scorer.assessContent("agt_1", "cid_1", "post", "Hello world");

    expect(result).toBeNull();
  });

  it("returns null when already assessed", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ quality_score: 75 }],
      rowCount: 1,
    });

    const mockInference = { chat: vi.fn() };
    const scorer = new QualityScorer(pool as any, mockInference as any);
    const result = await scorer.assessContent("agt_1", "cid_1", "post", "Hello");

    expect(result).toBeNull();
    expect(mockInference.chat).not.toHaveBeenCalled();
  });

  it("assesses content and stores result", async () => {
    const pool = createMockPool();
    // Check existing — none
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT assessment
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mockInference = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          relevance: 80,
          technicalDepth: 60,
          originality: 70,
          completeness: 90,
          summary: "Good content",
        }),
        model: "claude-haiku-4-5-20251001",
      }),
    };

    const scorer = new QualityScorer(pool as any, mockInference as any);
    const result = await scorer.assessContent("agt_1", "cid_1", "bounty_submission", "detailed submission");

    expect(result).not.toBeNull();
    expect(result!.qualityScore).toBe(75); // (80+60+70+90)/4
    expect(result!.contentType).toBe("bounty_submission");
    expect(result!.assessment.summary).toBe("Good content");
    expect(result!.modelUsed).toBe("claude-haiku-4-5-20251001");
  });

  it("returns null on inference error", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mockInference = {
      chat: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };

    const scorer = new QualityScorer(pool as any, mockInference as any);
    const result = await scorer.assessContent("agt_1", "cid_1", "post", "text");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getAgentQualityScore
// ---------------------------------------------------------------------------

describe("QualityScorer — getAgentQualityScore", () => {
  it("returns average quality score", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ avg_score: "72.5" }],
      rowCount: 1,
    });

    const scorer = new QualityScorer(pool as any);
    const score = await scorer.getAgentQualityScore("agt_1");

    expect(score).toBe(72.5);
  });

  it("returns null when no assessments", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ avg_score: null }],
      rowCount: 1,
    });

    const scorer = new QualityScorer(pool as any);
    const score = await scorer.getAgentQualityScore("agt_1");

    expect(score).toBeNull();
  });
});
