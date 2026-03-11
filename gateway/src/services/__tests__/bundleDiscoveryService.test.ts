import { describe, it, expect, vi, beforeEach } from "vitest";
import { BundleDiscoveryService } from "../bundleDiscoveryService.js";

function createMockPool() {
  return {
    query: vi.fn(),
  } as any;
}

function createMockSearchService() {
  return {
    search: vi.fn().mockResolvedValue({
      results: [],
      total: 0,
      limit: 5,
      offset: 0,
      query: "",
    }),
  } as any;
}

describe("BundleDiscoveryService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let searchService: ReturnType<typeof createMockSearchService>;
  let service: BundleDiscoveryService;

  beforeEach(() => {
    pool = createMockPool();
    searchService = createMockSearchService();
    service = new BundleDiscoveryService(pool, searchService);
  });

  it("discovers bundles by keywords using SearchService", async () => {
    searchService.search.mockResolvedValueOnce({
      results: [
        {
          type: "bundle",
          id: "42",
          title: "ML Fundamentals",
          snippet: "Machine learning basics",
          relevance: 0.9,
          metadata: { domain: "ai", tags: ["ml"], creatorAddress: "0xabc" },
          createdAt: "2025-01-01",
        },
      ],
      total: 1,
      limit: 5,
      offset: 0,
      query: "machine learning",
    });

    const bundles = await service.discover({ keywords: "machine learning" });

    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleId).toBe(42);
    expect(bundles[0].name).toBe("ML Fundamentals");
    expect(bundles[0].score).toBeCloseTo(0.63); // 0.9 * 0.7
    expect(searchService.search).toHaveBeenCalledWith(
      "machine learning",
      ["bundle"],
      5,
      0,
    );
  });

  it("discovers bundles for a project channel", async () => {
    // Channel lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ channel_type: "project", source_id: "proj-123" }],
    });

    // Collaborator lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xaaa" }, { address: "0xbbb" }],
    });

    // Bundle lookup
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: "10",
          name: "Project Knowledge",
          summary: "Knowledge for the project",
          domain: "code",
          tags: ["typescript"],
          creator_id: "0xaaa",
        },
      ],
    });

    const bundles = await service.discoverForChannel("channel-1", 5);

    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleId).toBe(10);
    expect(bundles[0].score).toBe(1.0);
  });

  it("falls back to keyword search for custom channels", async () => {
    // Channel lookup — custom type, no source_id
    pool.query.mockResolvedValueOnce({
      rows: [{ channel_type: "custom", source_id: null }],
    });

    // Recent messages
    pool.query.mockResolvedValueOnce({
      rows: [
        { content: "Let's discuss AI safety" },
        { content: "Neural network architectures" },
      ],
    });

    // SearchService will be called
    searchService.search.mockResolvedValueOnce({
      results: [],
      total: 0,
      limit: 5,
      offset: 0,
      query: "",
    });

    const bundles = await service.discoverForChannel("channel-2", 5);

    expect(searchService.search).toHaveBeenCalled();
    expect(bundles).toHaveLength(0);
  });

  it("returns empty array on error", async () => {
    pool.query.mockRejectedValueOnce(new Error("DB error"));

    const bundles = await service.discover({ channelId: "bad-channel" });

    expect(bundles).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    searchService.search.mockResolvedValueOnce({
      results: Array.from({ length: 10 }, (_, i) => ({
        type: "bundle",
        id: String(i),
        title: `Bundle ${i}`,
        snippet: "",
        relevance: 1 - i * 0.1,
        metadata: {},
        createdAt: "2025-01-01",
      })),
      total: 10,
      limit: 20,
      offset: 0,
      query: "test",
    });

    const bundles = await service.discover({ keywords: "test", limit: 3 });

    expect(bundles.length).toBeLessThanOrEqual(3);
  });

  it("discovers bundles by faculty", async () => {
    // Faculty query — matches bundles with model resources of that faculty
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: "55",
          name: "LLM Collection",
          summary: "Top language models",
          domain: "ai",
          tags: ["llm"],
          creator_id: "0xccc",
          model_count: "5",
        },
      ],
    });

    const bundles = await service.discover({ faculty: "language" });

    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleId).toBe(55);
    expect(bundles[0].score).toBeCloseTo(0.9);
  });

  it("deduplicates bundles across strategies", async () => {
    // Keywords search returns bundle 42
    searchService.search.mockResolvedValueOnce({
      results: [
        {
          type: "bundle",
          id: "42",
          title: "ML Bundle",
          snippet: "test",
          relevance: 0.5,
          metadata: {},
          createdAt: "2025-01-01",
        },
      ],
      total: 1,
      limit: 5,
      offset: 0,
      query: "ml",
    });

    // Guild also returns bundle 42 with higher score
    pool.query.mockResolvedValueOnce({
      rows: [{ member_id: "0xaaa" }],
    });
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: "42",
          name: "ML Bundle",
          summary: "test",
          domain: "ai",
          tags: [],
          creator_id: "0xaaa",
        },
      ],
    });

    const bundles = await service.discover({
      keywords: "ml",
      guildId: "guild-1",
    });

    // Should be deduplicated — only one entry for bundle 42
    const ids = bundles.map((b) => b.bundleId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
