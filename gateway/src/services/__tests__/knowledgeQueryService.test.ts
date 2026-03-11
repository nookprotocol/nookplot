import { describe, it, expect, vi, beforeEach } from "vitest";
import { KnowledgeQueryService, type KnowledgeQueryServiceConfig } from "../knowledgeQueryService.js";

// ============================================================
//  Mock factories
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockEmbeddingService() {
  return {
    embed: vi.fn(),
    embedBatch: vi.fn(),
    embedAndStore: vi.fn(),
    hasPgvector: vi.fn().mockResolvedValue(true),
    getEmbeddingCount: vi.fn().mockResolvedValue(100),
    getEmbeddingCountsByType: vi.fn().mockResolvedValue({ bundle: 50, project: 30, paper: 20 }),
  } as any;
}

function createMockSearchService() {
  return {
    search: vi.fn().mockResolvedValue({
      results: [],
      total: 0,
      limit: 20,
      offset: 0,
      query: "",
    }),
  } as any;
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balanceCredits: 5000 }),
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 4950 }),
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 100 }),
  } as any;
}

const TEST_CONFIG: KnowledgeQueryServiceConfig = {
  costCredits: 50,         // 0.50 display
  revenueShareCredits: 25, // 0.25 display
  maxResults: 20,
  rateLimitPerHour: 30,
};

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ============================================================
//  Helpers
// ============================================================

/**
 * Set up pool.query mocks using SQL-text matching for robust
 * handling of parallel/interleaved queries.
 */
function setupQueryMocks(
  pool: ReturnType<typeof createMockPool>,
  overrides: {
    accountAge?: Date;
    rateCount?: string;
    bundleCreator?: string;
    agentAddress?: string;
    agentName?: string;
  } = {},
) {
  pool.query.mockImplementation((sql: string, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : "";

    // Account age check
    if (text.includes("SELECT created_at FROM agents")) {
      return { rows: [{ created_at: overrides.accountAge ?? new Date(Date.now() - 7 * 86400000) }] };
    }

    // Stats — queries today count (must come before rate limit check)
    if (text.includes("knowledge_queries") && text.includes("COUNT") && text.includes("24 hours")) {
      return { rows: [{ count: "42" }] };
    }

    // Rate limit check
    if (text.includes("knowledge_queries") && text.includes("COUNT")) {
      return { rows: [{ count: overrides.rateCount ?? "0" }] };
    }

    // Semantic search (knowledge_embeddings)
    if (text.includes("knowledge_embeddings") && text.includes("similarity")) {
      return {
        rows: [
          { content_type: "bundle", content_id: "1", content_text: "Agent coordination framework", similarity: "0.85" },
          { content_type: "project", content_id: "proj-1", content_text: "Decentralized identity", similarity: "0.72" },
        ],
      };
    }

    // Creator resolution: bundle
    if (text.includes("idx_knowledge_bundles") && text.includes("creator_id")) {
      return { rows: [{ creator_id: overrides.bundleCreator ?? "0xCreator1" }] };
    }

    // Creator resolution: project
    if (text.includes("projects p JOIN agents a") && text.includes("project_id")) {
      return { rows: [{ agent_id: "creator-agent-1", address: "0xProjectOwner", display_name: "ProjectBot" }] };
    }

    // Agent resolution by address
    if (text.includes("LOWER(address)") && text.includes("display_name")) {
      return { rows: [{ id: "creator-agent-1", display_name: overrides.agentName ?? "BundleBot" }] };
    }

    // Title resolution
    if (text.includes("idx_knowledge_bundles") && text.includes("SELECT name")) {
      return { rows: [{ name: "AI Coordination Bundle" }] };
    }
    if (text.includes("projects") && text.includes("SELECT name FROM")) {
      return { rows: [{ name: "Identity Project" }] };
    }

    // Insert knowledge_queries
    if (text.includes("INSERT INTO knowledge_queries")) {
      return { rowCount: 1 };
    }

    // Insert attributions
    if (text.includes("INSERT INTO knowledge_query_attributions")) {
      return { rowCount: 1 };
    }

    // Topic map read
    if (text.includes("agent_query_topics") && text.includes("ORDER BY query_count")) {
      return { rows: [{ topic_keywords: "agent coordination", query_count: 5, last_queried_at: new Date() }] };
    }

    // Topic map upsert
    if (text.includes("agent_query_topics")) {
      return { rowCount: 1 };
    }

    // Query history
    if (text.includes("knowledge_queries") && text.includes("ORDER BY created_at")) {
      return {
        rows: [
          { id: "q1", query_text: "test", result_count: 3, cost_credits: "50", duration_ms: 120, filters: {}, created_at: new Date() },
        ],
      };
    }

    // Earnings
    if (text.includes("knowledge_query_attributions") && text.includes("SUM(credits_earned)")) {
      if (text.includes("GROUP BY")) {
        return { rows: [{ content_type: "bundle", content_id: "1", total_earned: "500", query_count: "10" }] };
      }
      return { rows: [{ total: "500", count: "10" }] };
    }

    return { rows: [] };
  });
}

// ============================================================
//  Tests
// ============================================================

describe("KnowledgeQueryService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;
  let searchService: ReturnType<typeof createMockSearchService>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let service: KnowledgeQueryService;

  beforeEach(() => {
    pool = createMockPool();
    embeddingService = createMockEmbeddingService();
    searchService = createMockSearchService();
    creditManager = createMockCreditManager();
    service = new KnowledgeQueryService(pool, embeddingService, searchService, creditManager, TEST_CONFIG);
  });

  // ---- Hybrid search ----

  it("should execute hybrid search and return ranked results", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    const result = await service.query(AGENT_ID, { query: "agent coordination" });

    expect(result.mode).toBe("hybrid");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.costCredits).toBe(0.5);
    expect(embeddingService.embed).toHaveBeenCalledWith("agent coordination");
    expect(creditManager.deductCredits).toHaveBeenCalledWith(AGENT_ID, 50, expect.any(String), "knowledge_query");
  });

  // ---- FTS fallback ----

  it("should fall back to FTS-only when embedding fails", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockRejectedValue(new Error("API key invalid"));

    // Make FTS return something so we have results
    searchService.search.mockResolvedValue({
      results: [
        { type: "bundle", id: "1", title: "Test Bundle", snippet: "test snippet", relevance: 0.8, metadata: {}, createdAt: new Date().toISOString() },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      query: "agent coordination",
    });

    const result = await service.query(AGENT_ID, { query: "agent coordination" });

    expect(result.mode).toBe("fts_only");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("should work in FTS-only mode when embeddingService is null", async () => {
    const ftsOnlyService = new KnowledgeQueryService(pool, null, searchService, creditManager, TEST_CONFIG);
    setupQueryMocks(pool);

    searchService.search.mockResolvedValue({
      results: [
        { type: "project", id: "p1", title: "Test Project", snippet: "desc", relevance: 0.6, metadata: {}, createdAt: new Date().toISOString() },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      query: "test",
    });

    const result = await ftsOnlyService.query(AGENT_ID, { query: "test query" });

    expect(result.mode).toBe("fts_only");
    expect(result.results.length).toBe(1);
  });

  // ---- Credit deduction ----

  it("should deduct credits on successful query", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    await service.query(AGENT_ID, { query: "test query" });

    expect(creditManager.deductCredits).toHaveBeenCalledWith(AGENT_ID, 50, expect.any(String), "knowledge_query");
  });

  it("should reject when insufficient credits", async () => {
    setupQueryMocks(pool);
    creditManager.getBalance.mockResolvedValue({ balance: 10 });

    await expect(
      service.query(AGENT_ID, { query: "test query" }),
    ).rejects.toThrow("INSUFFICIENT_CREDITS");
  });

  // ---- Revenue attribution ----

  it("should distribute revenue to creators of top results", async () => {
    setupQueryMocks(pool, { bundleCreator: "0xCreatorAddr" });
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    await service.query(AGENT_ID, { query: "agent coordination" });

    // Should have called addCredits for creators
    expect(creditManager.addCredits).toHaveBeenCalled();
    const addCall = creditManager.addCredits.mock.calls[0];
    expect(addCall[2]).toBe("knowledge_query_revenue");
  });

  it("should skip self-dealing (querier === creator)", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    // Override creator resolution to return same agent ID
    pool.query.mockImplementation((sql: string) => {
      const text = typeof sql === "string" ? sql : "";

      if (text.includes("SELECT created_at FROM agents")) return { rows: [{ created_at: new Date(Date.now() - 7 * 86400000) }] };
      if (text.includes("knowledge_queries") && text.includes("COUNT")) return { rows: [{ count: "0" }] };
      if (text.includes("knowledge_embeddings") && text.includes("similarity")) {
        return { rows: [{ content_type: "bundle", content_id: "1", content_text: "Self content", similarity: "0.9" }] };
      }
      if (text.includes("LOWER(address)")) return { rows: [{ id: AGENT_ID, display_name: "SelfBot" }] };
      if (text.includes("creator_id") && text.includes("idx_knowledge_bundles")) return { rows: [{ creator_id: "0xSelf" }] };
      if (text.includes("SELECT name FROM idx_knowledge_bundles")) return { rows: [{ name: "Self Bundle" }] };
      if (text.includes("INSERT INTO knowledge_queries")) return { rowCount: 1 };
      if (text.includes("agent_query_topics")) return { rowCount: 1 };
      return { rows: [] };
    });

    await service.query(AGENT_ID, { query: "my own content" });

    // Should NOT have called addCredits (self-dealing)
    expect(creditManager.addCredits).not.toHaveBeenCalled();
  });

  // ---- Rate limiting ----

  it("should reject when rate limit exceeded", async () => {
    setupQueryMocks(pool, { rateCount: "30" });

    await expect(
      service.query(AGENT_ID, { query: "test" }),
    ).rejects.toThrow("RATE_LIMIT_EXCEEDED");
  });

  // ---- Validation ----

  it("should reject short queries", async () => {
    await expect(
      service.query(AGENT_ID, { query: "a" }),
    ).rejects.toThrow("VALIDATION");
  });

  it("should reject empty queries", async () => {
    await expect(
      service.query(AGENT_ID, { query: "" }),
    ).rejects.toThrow("VALIDATION");
  });

  it("should reject very long queries", async () => {
    const longQuery = "a".repeat(501);
    await expect(
      service.query(AGENT_ID, { query: longQuery }),
    ).rejects.toThrow("VALIDATION");
  });

  // ---- Anti-abuse ----

  it("should reject accounts less than 1 day old", async () => {
    setupQueryMocks(pool, { accountAge: new Date() }); // just created

    await expect(
      service.query(AGENT_ID, { query: "test query" }),
    ).rejects.toThrow("ACCOUNT_TOO_NEW");
  });

  // ---- Query history ----

  it("should return paginated query history", async () => {
    setupQueryMocks(pool);

    const result = await service.getQueryHistory(AGENT_ID, 20, 0);

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].queryText).toBe("test");
    expect(result.queries[0].costCredits).toBe(0.5);
  });

  // ---- Earnings ----

  it("should return attribution earnings", async () => {
    setupQueryMocks(pool);

    const result = await service.getEarnings(AGENT_ID, 30);

    expect(result.totalEarned).toBe(5);
    expect(result.attributionCount).toBe(10);
    expect(result.topContent).toHaveLength(1);
  });

  // ---- Topic map ----

  it("should return topic map", async () => {
    setupQueryMocks(pool);

    const result = await service.getTopicMap(AGENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("agent coordination");
    expect(result[0].queryCount).toBe(5);
  });

  // ---- Stats ----

  it("should return public stats", async () => {
    setupQueryMocks(pool);

    const result = await service.getStats(embeddingService);

    expect(result.embeddingCount).toBe(100);
    expect(result.embeddingsByType).toEqual({ bundle: 50, project: 30, paper: 20 });
    expect(result.queriesToday).toBe(42);
    expect(result.topTopics).toContain("agent coordination");
  });

  it("should handle stats with null embeddingService", async () => {
    setupQueryMocks(pool);

    const result = await service.getStats(null);

    expect(result.embeddingCount).toBe(0);
    expect(result.embeddingsByType).toEqual({});
  });

  // ---- Merge + rank ----

  it("should merge semantic and FTS results by content key", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    // FTS returns an overlapping result
    searchService.search.mockResolvedValue({
      results: [
        { type: "bundle", id: "1", title: "Bundle from FTS", snippet: "fts snippet", relevance: 0.9, metadata: {}, createdAt: new Date().toISOString() },
        { type: "task", id: "t1", title: "A task", snippet: "task desc", relevance: 0.5, metadata: {}, createdAt: new Date().toISOString() },
      ],
      total: 2,
      limit: 20,
      offset: 0,
      query: "agent coordination",
    });

    const result = await service.query(AGENT_ID, { query: "agent coordination" });

    // bundle:1 should appear once (merged) with both semantic + FTS scores
    const bundleResult = result.results.find((r) => r.contentType === "bundle" && r.contentId === "1");
    expect(bundleResult).toBeDefined();
    expect(bundleResult!.semanticScore).toBeGreaterThan(0);
    expect(bundleResult!.ftsScore).toBeGreaterThan(0);
  });

  // ---- Type filtering ----

  it("should filter by content types when specified", async () => {
    setupQueryMocks(pool);
    embeddingService.embed.mockResolvedValue(new Array(1536).fill(0.1));

    await service.query(AGENT_ID, { query: "test", types: ["bundle", "project"] });

    // Verify semantic search included type filter
    const semanticCall = pool.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("knowledge_embeddings") && (c[0] as string).includes("similarity"),
    );
    expect(semanticCall).toBeDefined();
  });
});
