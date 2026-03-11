import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArxivIngestionService } from "./arxivIngestionService.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../config.js", () => ({
  gatewayConfig: {
    pinataJwt: "test-pinata-jwt",
    ipfsReadGateway: "https://ipfs.example.com/ipfs",
  },
}));

// ---------------------------------------------------------------------------
//  Global fetch mock
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockS2Client() {
  return {
    getPaper: vi.fn().mockResolvedValue({
      paperId: "s2-paper-001",
      title: "Attention Is All You Need",
      authors: [
        { name: "Ashish Vaswani", authorId: "auth-001" },
        { name: "Noam Shazeer", authorId: "auth-002" },
      ],
      citationCount: 50000,
      year: 2017,
      externalIds: { ArXiv: "1706.03762", DOI: "10.1234/test" },
      references: [
        { paperId: "s2-ref-001", title: "Some Reference" },
      ],
    }),
  };
}

function createMockQualityScorer(total = 75) {
  return {
    scorePaper: vi.fn().mockReturnValue({
      total,
      breakdown: { citations: 30, recency: 20, influence: 15, authors: 10 },
    }),
    meetsThreshold: vi.fn().mockReturnValue(total >= 40 ? "accept" : "reject"),
  };
}

function createMockGrokipediaClient(score = 15) {
  return {
    getInfluenceScore: vi.fn().mockResolvedValue({ score, found: score > 0 }),
  };
}

function createService(opts?: {
  pool?: ReturnType<typeof createMockPool>;
  s2Client?: ReturnType<typeof createMockS2Client>;
  qualityScorer?: ReturnType<typeof createMockQualityScorer>;
  grokipediaClient?: ReturnType<typeof createMockGrokipediaClient>;
}) {
  const pool = opts?.pool ?? createMockPool();
  const s2Client = opts?.s2Client ?? createMockS2Client();
  const qualityScorer = opts?.qualityScorer ?? createMockQualityScorer();
  const grokipediaClient = opts?.grokipediaClient ?? createMockGrokipediaClient();
  const service = new ArxivIngestionService(
    pool as any,
    s2Client as any,
    qualityScorer as any,
    grokipediaClient as any,
  );
  return { service, pool, s2Client, qualityScorer, grokipediaClient };
}

const SAMPLE_RSS = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <item>
    <title>Paper One: A Great Discovery</title>
    <link>https://arxiv.org/abs/2301.12345</link>
    <description>This is an interesting paper about AI.</description>
  </item>
  <item>
    <title>Paper Two: Another Finding</title>
    <link>https://arxiv.org/abs/2301.67890v2</link>
    <description>More research on transformers.</description>
  </item>
</rdf:RDF>`;

// ---------------------------------------------------------------------------
//  pollCategory
// ---------------------------------------------------------------------------

describe("ArxivIngestionService.pollCategory", () => {
  it("fetches RSS feed, parses items, and processes papers", async () => {
    const pool = createMockPool();
    const { service, s2Client, qualityScorer, grokipediaClient } = createService({ pool });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_RSS),
    });

    // For each paper processItem does:
    // 1. Check existing (SELECT)
    // 2. After S2+quality: INSERT into arxiv_content_map
    // 3. createUnclaimedCreditsForAuthors: INSERT per author
    // 4. storePendingCitations: SELECT + INSERT per reference
    // 5. resolvePendingCitations: SELECT
    // 6. recordIngestionRun at end

    // Paper 1 - not existing, passes quality
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT arxiv_content_map
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // unclaimed credits auth-001
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // unclaimed credits auth-002
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // storePendingCitations: check ref exists
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // storePendingCitations: INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolvePendingCitations arxivId
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolvePendingCitations doi
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolvePendingCitations s2Id

    // Paper 2 - not existing, passes quality
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // unclaimed credits auth-001
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // unclaimed credits auth-002
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ref check
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // ref insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolve arxivId
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolve doi
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolve s2Id

    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");

    expect(result.category).toBe("cs.AI");
    expect(result.papersFound).toBe(2);
    expect(result.papersPassed).toBe(2);
    expect(result.papersFailed).toBe(0);

    // Verify fetch was called with correct URL
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain("export.arxiv.org/rss/cs.AI");
  });

  it("skips already existing papers", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    const rss = `<rdf:RDF><item><title>Existing Paper</title><link>https://arxiv.org/abs/2301.11111</link><description>Already ingested</description></item></rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // Paper already exists
    pool.query.mockResolvedValueOnce({ rows: [{ arxiv_id: "2301.11111" }], rowCount: 1 });
    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");

    expect(result.papersFound).toBe(1);
    expect(result.papersPassed).toBe(0); // skipped
  });

  it("handles HTTP error on RSS fetch", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");

    expect(result.papersFound).toBe(0);
  });

  it("handles network error on RSS fetch", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failure"));

    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");
    expect(result.papersFound).toBe(0);
  });

  it("rejects papers below quality threshold", async () => {
    const pool = createMockPool();
    const qualityScorer = createMockQualityScorer(20);
    qualityScorer.meetsThreshold.mockReturnValue("reject");
    const { service } = createService({ pool, qualityScorer });

    const rss = `<rdf:RDF><item><title>Low Quality Paper</title><link>https://arxiv.org/abs/2301.99999</link><description>Bad paper</description></item></rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // not existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");

    expect(result.papersFound).toBe(1);
    expect(result.papersPassed).toBe(0); // rejected
  });

  it("counts failed papers when processItem throws", async () => {
    const pool = createMockPool();
    const s2Client = createMockS2Client();
    s2Client.getPaper.mockRejectedValue(new Error("S2 API down"));
    const { service } = createService({ pool, s2Client });

    const rss = `<rdf:RDF><item><title>Paper</title><link>https://arxiv.org/abs/2301.55555</link><description>test</description></item></rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // not existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // recordIngestionRun
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.pollCategory("cs.AI");

    expect(result.papersFound).toBe(1);
    expect(result.papersFailed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  resolvePendingCitations
// ---------------------------------------------------------------------------

describe("ArxivIngestionService.resolvePendingCitations", () => {
  it("resolves pending citations for a given external ID", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    // SELECT pending citations
    pool.query.mockResolvedValueOnce({
      rows: [{ source_cid: "cid-source-1" }, { source_cid: "cid-source-2" }],
      rowCount: 2,
    });
    // UPDATE each citation
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const resolved = await service.resolvePendingCitations("1706.03762", "cid-target");

    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual({ sourceCid: "cid-source-1", resolvedCid: "cid-target" });
    expect(resolved[1]).toEqual({ sourceCid: "cid-source-2", resolvedCid: "cid-target" });
  });

  it("returns empty array when no pending citations", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const resolved = await service.resolvePendingCitations("unknown-id", "cid");
    expect(resolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  ingestHistoricalPaper
// ---------------------------------------------------------------------------

describe("ArxivIngestionService.ingestHistoricalPaper", () => {
  it("ingests a paper via Semantic Scholar lookup", async () => {
    const pool = createMockPool();
    const { service, s2Client } = createService({ pool });

    // Check existing — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT arxiv_content_map
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Unclaimed credits for 2 authors
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // storePendingCitations: check ref + insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // resolvePendingCitations for arxivId, doi, s2Id
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const ingested = await service.ingestHistoricalPaper("1706.03762");

    expect(ingested).toBe(true);
    expect(s2Client.getPaper).toHaveBeenCalledWith("1706.03762");
  });

  it("returns false when paper already exists", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    pool.query.mockResolvedValueOnce({ rows: [{ arxiv_id: "1706.03762" }], rowCount: 1 });

    const ingested = await service.ingestHistoricalPaper("1706.03762");
    expect(ingested).toBe(false);
  });

  it("returns false when S2 lookup returns null", async () => {
    const pool = createMockPool();
    const s2Client = createMockS2Client();
    s2Client.getPaper.mockResolvedValue(null);
    const { service } = createService({ pool, s2Client });

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const ingested = await service.ingestHistoricalPaper("0000.00000");
    expect(ingested).toBe(false);
  });

  it("returns false when quality threshold not met", async () => {
    const pool = createMockPool();
    const qualityScorer = createMockQualityScorer(20);
    qualityScorer.meetsThreshold.mockReturnValue("reject");
    const { service } = createService({ pool, qualityScorer });

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const ingested = await service.ingestHistoricalPaper("1706.03762");
    expect(ingested).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getIngestionStats
// ---------------------------------------------------------------------------

describe("ArxivIngestionService.getIngestionStats", () => {
  it("returns aggregate statistics", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    // Total papers
    pool.query.mockResolvedValueOnce({ rows: [{ count: "150" }], rowCount: 1 });
    // Pending citations
    pool.query.mockResolvedValueOnce({ rows: [{ count: "30" }], rowCount: 1 });
    // Recent runs
    pool.query.mockResolvedValueOnce({
      rows: [
        { category: "cs.AI", papers_found: 20, papers_passed: 15, started_at: new Date("2025-06-01") },
        { category: "cs.LG", papers_found: 30, papers_passed: 22, started_at: new Date("2025-06-01") },
      ],
      rowCount: 2,
    });

    const stats = await service.getIngestionStats();

    expect(stats.totalPapers).toBe(150);
    expect(stats.pendingCitations).toBe(30);
    expect(stats.recentRuns).toHaveLength(2);
    expect(stats.recentRuns[0].category).toBe("cs.AI");
    expect(stats.recentRuns[0].papersPassed).toBe(15);
  });
});

// ---------------------------------------------------------------------------
//  RSS parsing (tested indirectly via pollCategory)
// ---------------------------------------------------------------------------

describe("ArxivIngestionService — RSS parsing edge cases", () => {
  it("strips version suffixes from arXiv IDs", async () => {
    const pool = createMockPool();
    const s2Client = createMockS2Client();
    const { service } = createService({ pool, s2Client });

    const rss = `<rdf:RDF><item><title>Versioned Paper</title><link>https://arxiv.org/abs/2301.12345v3</link><description>test</description></item></rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // not existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT + subsequent queries
    for (let i = 0; i < 10; i++) {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }

    await service.pollCategory("cs.AI");

    // S2 should be called with version-stripped ID
    expect(s2Client.getPaper).toHaveBeenCalledWith("2301.12345");
  });

  it("handles HTML entities in titles", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    const rss = `<rdf:RDF><item><title>Foo &amp; Bar &lt;Baz&gt;</title><link>https://arxiv.org/abs/2301.11111</link><description>test</description></item></rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // Already exists — skip processing but verify parsing
    pool.query.mockResolvedValueOnce({ rows: [{ arxiv_id: "2301.11111" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // recordIngestionRun

    const result = await service.pollCategory("cs.AI");
    expect(result.papersFound).toBe(1);
  });

  it("skips items without valid arXiv links", async () => {
    const pool = createMockPool();
    const { service } = createService({ pool });

    const rss = `<rdf:RDF>
      <item><title>No Link Item</title><link>https://example.com/not-arxiv</link><description>bad</description></item>
      <item><title>Valid Item</title><link>https://arxiv.org/abs/2301.44444</link><description>good</description></item>
    </rdf:RDF>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rss),
    });

    // Only the valid item should be processed
    pool.query.mockResolvedValueOnce({ rows: [{ arxiv_id: "2301.44444" }], rowCount: 1 }); // existing check
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // recordIngestionRun

    const result = await service.pollCategory("cs.AI");
    expect(result.papersFound).toBe(1); // only 1 valid item
  });
});
