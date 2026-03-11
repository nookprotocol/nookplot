import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const { ResourceEnricher, rhHubsToFaculty } = await import("../resourceEnricher.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createEnricher(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const enricher = new ResourceEnricher(p as any, 60_000);
  return { enricher, pool: p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  rhHubsToFaculty mapping
// ---------------------------------------------------------------------------

describe("rhHubsToFaculty", () => {
  it("maps machine-learning to language + reasoning", () => {
    expect(rhHubsToFaculty(["machine-learning"])).toEqual(
      expect.arrayContaining(["language", "reasoning"]),
    );
  });

  it("maps computer-vision to vision + analysis", () => {
    expect(rhHubsToFaculty(["computer-vision"])).toEqual(
      expect.arrayContaining(["vision", "analysis"]),
    );
  });

  it("maps robotics to robotics", () => {
    expect(rhHubsToFaculty(["robotics"])).toEqual(["robotics"]);
  });

  it("deduplicates faculties across multiple hubs", () => {
    const faculties = rhHubsToFaculty(["machine-learning", "artificial-intelligence"]);
    // Both map to language + reasoning — should dedupe
    expect(faculties.filter((f) => f === "language").length).toBe(1);
    expect(faculties.filter((f) => f === "reasoning").length).toBe(1);
  });

  it("returns empty array for unknown hubs", () => {
    expect(rhHubsToFaculty(["unknown-hub-xyz"])).toEqual([]);
  });

  it("handles case-insensitive matching", () => {
    expect(rhHubsToFaculty(["Machine-Learning"])).toEqual(
      expect.arrayContaining(["language", "reasoning"]),
    );
  });
});

// ---------------------------------------------------------------------------
//  enrichResource dispatch — ResearchHub
// ---------------------------------------------------------------------------

describe("ResourceEnricher — ResearchHub dispatch", () => {
  it("dispatches researchhub_paper to enrichFromResearchHub", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    const mockResult = {
      title: "Attention Is All You Need",
      rhScore: 450,
      rhPeerReviewStatus: "reviewed",
      faculty: ["language", "reasoning"],
    };
    (enricher as any).enrichFromResearchHub = vi.fn().mockResolvedValue(mockResult);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await (enricher as any).enrichResource({
      id: "res-rh-1",
      source_type: "researchhub_paper",
      external_id: "researchhub:12345",
      arxiv_id: null,
      doi: null,
      github_owner: null,
      github_repo: null,
    });

    expect((enricher as any).enrichFromResearchHub).toHaveBeenCalledWith("12345");
    expect(result).toEqual(mockResult);
  });
});

// ---------------------------------------------------------------------------
//  applyEnrichment — ResearchHub fields
// ---------------------------------------------------------------------------

describe("ResourceEnricher — applyEnrichment with RH fields", () => {
  it("includes rh_score, rh_peer_review_status, rh_hubs, rh_paper_id", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).applyEnrichment("resource-rh", {
      title: "Test RH Paper",
      rhScore: 250,
      rhPeerReviewStatus: "reviewed",
      rhBountyCount: 3,
      rhRscEarned: 1500,
      rhHubs: ["machine-learning", "neuroscience"],
      rhPaperId: 54321,
      rhDiscussionCount: 12,
      faculty: ["language", "reasoning"],
    });

    const [query, params] = pool.query.mock.calls[0];
    expect(query).toContain("rh_score = $");
    expect(query).toContain("rh_peer_review_status = $");
    expect(query).toContain("rh_bounty_count = $");
    expect(query).toContain("rh_rsc_earned = $");
    expect(query).toContain("rh_hubs = $");
    expect(query).toContain("rh_paper_id = $");
    expect(query).toContain("rh_discussion_count = $");
    expect(query).toContain("enrichment_status = 'complete'");
    expect(params).toContain(250);
    expect(params).toContain("reviewed");
    expect(params).toContain(3);
    expect(params).toContain(54321);
  });
});
