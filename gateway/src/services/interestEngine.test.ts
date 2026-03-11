import { describe, it, expect, vi } from "vitest";
import { normalizeTag, normalizeTags, InterestEngine, ValidationError, LimitError } from "./interestEngine.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockDeps() {
  const pool = createMockPool();
  const creditManager = { deductCredits: vi.fn() };
  const broadcaster = { broadcast: vi.fn() };
  const messageBus = { subscribePattern: vi.fn().mockReturnValue(() => {}), publish: vi.fn() };
  const searchService = { search: vi.fn().mockResolvedValue({ results: [], total: 0 }) };
  const config = {
    freeNotificationsPerDay: 10,
    notificationCost: 5,
    digestCost: 2,
    maxDailyNotifications: 100,
    maxSubscriptionsPerAgent: 20,
    maxRepoWatchesPerAgent: 10,
    entityBufferMs: 500,
    repoWatchIntervalMs: 900_000,
    digestHourUtc: 8,
  };
  return { pool, creditManager, broadcaster, messageBus, searchService, config };
}

function createEngine(overrides: Partial<ReturnType<typeof createMockDeps>> = {}) {
  const deps = { ...createMockDeps(), ...overrides };
  const engine = new InterestEngine(
    deps.pool as any,
    deps.creditManager as any,
    deps.broadcaster as any,
    deps.messageBus as any,
    deps.searchService as any,
    deps.config,
  );
  return { engine, ...deps };
}

const MOCK_SUB_ROW = {
  id: "sub_1",
  agent_id: "agt_1",
  label: "AI stuff",
  tags: ["machine-learning"],
  query: "",
  match_mode: "any",
  entity_types: [],
  filters: {},
  enabled: true,
  notify_realtime: true,
  notify_digest: false,
  digest_frequency: "daily",
  max_notifications_per_day: 50,
  last_notified_at: null,
  total_notifications: 0,
  total_matches: 0,
  created_at: "2025-01-01",
  updated_at: "2025-01-01",
};

// ===========================================================================
//  normalizeTag (pure function)
// ===========================================================================

describe("normalizeTag", () => {
  it("lowercases and trims", () => {
    expect(normalizeTag("  Machine Learning  ")).toBe("machine-learning");
  });

  it("converts spaces and underscores to hyphens", () => {
    expect(normalizeTag("hello_world test")).toBe("hello-world-test");
  });

  it("collapses multiple hyphens", () => {
    expect(normalizeTag("a---b")).toBe("a-b");
  });

  it("resolves aliases", () => {
    expect(normalizeTag("js")).toBe("javascript");
    expect(normalizeTag("ts")).toBe("typescript");
    expect(normalizeTag("py")).toBe("python");
    expect(normalizeTag("ml")).toBe("machine-learning");
    expect(normalizeTag("ai")).toBe("artificial-intelligence");
    // Note: c++ and c# aliases can't match because + and # are stripped
    // before alias lookup. That's a known limitation of normalizeTag.
    expect(normalizeTag("c++")).toBe("c");
    expect(normalizeTag("c#")).toBe("c");
  });

  it("strips non-alphanumeric characters (except hyphens)", () => {
    expect(normalizeTag("hello@world!")).toBe("helloworld");
  });

  it("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    expect(normalizeTag(long)).toHaveLength(64);
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeTag("   ")).toBe("");
  });

  it("removes leading/trailing hyphens", () => {
    expect(normalizeTag("-hello-")).toBe("hello");
  });
});

// ===========================================================================
//  normalizeTags (pure function)
// ===========================================================================

describe("normalizeTags", () => {
  it("deduplicates after normalization", () => {
    expect(normalizeTags(["js", "JavaScript", "JS"])).toEqual(["javascript"]);
  });

  it("filters out empty results", () => {
    expect(normalizeTags(["   ", "valid"])).toEqual(["valid"]);
  });

  it("preserves order of first occurrence", () => {
    expect(normalizeTags(["python", "ml", "py"])).toEqual(["python", "machine-learning"]);
  });
});

// ===========================================================================
//  InterestEngine — constructor
// ===========================================================================

describe("InterestEngine — constructor", () => {
  it("subscribes to entity events on the message bus", () => {
    const { messageBus } = createEngine();
    expect(messageBus.subscribePattern).toHaveBeenCalledWith("entity:", expect.any(Function));
  });
});

// ===========================================================================
//  InterestEngine — ensureTagsRegistered
// ===========================================================================

describe("InterestEngine — ensureTagsRegistered", () => {
  it("upserts tags into tag_registry", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await engine.ensureTagsRegistered(["ml", "python"]);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO tag_registry");
    expect(sql).toContain("ON CONFLICT");
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params).toContain("machine-learning"); // alias resolved
    expect(params).toContain("python");
  });

  it("skips empty array", async () => {
    const { engine, pool } = createEngine();
    await engine.ensureTagsRegistered([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips array that normalizes to empty", async () => {
    const { engine, pool } = createEngine();
    await engine.ensureTagsRegistered(["   "]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ===========================================================================
//  InterestEngine — suggestTags
// ===========================================================================

describe("InterestEngine — suggestTags", () => {
  it("returns formatted tag suggestions", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({
      rows: [{ tag: "machine-learning", display_name: "machine-learning", category: "tech", usage_count: 42 }],
      rowCount: 1,
    });

    const result = await engine.suggestTags("mac");
    expect(result).toEqual([{ tag: "machine-learning", displayName: "machine-learning", category: "tech", usageCount: 42 }]);
  });

  it("returns empty for blank prefix", async () => {
    const { engine } = createEngine();
    const result = await engine.suggestTags("   ");
    expect(result).toEqual([]);
  });
});

// ===========================================================================
//  InterestEngine — trendingTags
// ===========================================================================

describe("InterestEngine — trendingTags", () => {
  it("returns top tags by usage", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({
      rows: [
        { tag: "python", display_name: "Python", category: null, usage_count: 100 },
        { tag: "javascript", display_name: "JavaScript", category: null, usage_count: 80 },
      ],
      rowCount: 2,
    });

    const result = await engine.trendingTags(2);
    expect(result).toHaveLength(2);
    expect(result[0].tag).toBe("python");
    expect(result[0].usageCount).toBe(100);
  });
});

// ===========================================================================
//  InterestEngine — listTags
// ===========================================================================

describe("InterestEngine — listTags", () => {
  it("returns paginated results with total", async () => {
    const { engine, pool } = createEngine();
    // COUNT query
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 50 }], rowCount: 1 });
    // SELECT query
    pool.query.mockResolvedValueOnce({
      rows: [{ tag: "python", display_name: "Python", category: null, usage_count: 10 }],
      rowCount: 1,
    });

    const result = await engine.listTags({ limit: 10, offset: 0 });
    expect(result.total).toBe(50);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].tag).toBe("python");
  });

  it("applies query filter", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 1 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await engine.listTags({ q: "py" });

    const countSql = pool.query.mock.calls[0][0] as string;
    expect(countSql).toContain("LIKE");
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("%python%"); // normalized alias
  });
});

// ===========================================================================
//  InterestEngine — createSubscription
// ===========================================================================

describe("InterestEngine — createSubscription", () => {
  it("creates subscription with transaction", async () => {
    const { engine, pool } = createEngine();

    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [MOCK_SUB_ROW], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({}) // DELETE inverted index
        .mockResolvedValueOnce({}) // INSERT inverted index
        .mockResolvedValueOnce({}) // ensureTagsRegisteredInTx
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(mockClient);

    // Count check
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }], rowCount: 1 });

    const result = await engine.createSubscription("agt_1", {
      label: "AI stuff",
      tags: ["ml"],
    });

    expect(result.id).toBe("sub_1");
    expect(result.label).toBe("AI stuff");
    expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("rejects empty label", async () => {
    const { engine } = createEngine();
    await expect(engine.createSubscription("agt_1", { label: "" }))
      .rejects.toThrow(ValidationError);
  });

  it("rejects label over 200 characters", async () => {
    const { engine } = createEngine();
    await expect(engine.createSubscription("agt_1", { label: "x".repeat(201) }))
      .rejects.toThrow(ValidationError);
  });

  it("requires at least tags or query", async () => {
    const { engine } = createEngine();
    await expect(engine.createSubscription("agt_1", { label: "Test" }))
      .rejects.toThrow("At least one tag or a search query is required");
  });

  it("rejects invalid matchMode", async () => {
    const { engine } = createEngine();
    await expect(engine.createSubscription("agt_1", {
      label: "Test",
      tags: ["python"],
      matchMode: "invalid",
    })).rejects.toThrow("matchMode must be 'any' or 'all'");
  });

  it("rejects invalid entity types", async () => {
    const { engine } = createEngine();
    await expect(engine.createSubscription("agt_1", {
      label: "Test",
      tags: ["python"],
      entityTypes: ["invalid_type"],
    })).rejects.toThrow("Invalid entity type: invalid_type");
  });

  it("enforces subscription limit", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 20 }], rowCount: 1 });

    await expect(engine.createSubscription("agt_1", {
      label: "Test",
      tags: ["python"],
    })).rejects.toThrow(LimitError);
  });

  it("rejects invalid digestFrequency", async () => {
    const { engine, pool } = createEngine();
    // Count query (passes validation up to digestFrequency check)
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }], rowCount: 1 });

    await expect(engine.createSubscription("agt_1", {
      label: "Test",
      tags: ["python"],
      digestFrequency: "hourly",
    })).rejects.toThrow("digestFrequency must be 'daily' or 'weekly'");
  });

  it("rejects maxNotificationsPerDay out of range", async () => {
    const { engine, pool } = createEngine();
    // Count query (passes validation up to maxNotificationsPerDay check)
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }], rowCount: 1 });

    await expect(engine.createSubscription("agt_1", {
      label: "Test",
      tags: ["python"],
      maxNotificationsPerDay: 0,
    })).rejects.toThrow("maxNotificationsPerDay must be 1-500");
  });
});

// ===========================================================================
//  InterestEngine — deleteSubscription
// ===========================================================================

describe("InterestEngine — deleteSubscription", () => {
  it("returns true on successful delete", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await engine.deleteSubscription("agt_1", "sub_1");
    expect(result).toBe(true);
  });

  it("returns false when not found", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await engine.deleteSubscription("agt_1", "sub_999");
    expect(result).toBe(false);
  });
});

// ===========================================================================
//  InterestEngine — listSubscriptions
// ===========================================================================

describe("InterestEngine — listSubscriptions", () => {
  it("maps rows with camelCase keys", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [MOCK_SUB_ROW], rowCount: 1 });

    const result = await engine.listSubscriptions("agt_1");
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("agt_1");
    expect(result[0].matchMode).toBe("any");
    expect(result[0].notifyRealtime).toBe(true);
  });
});

// ===========================================================================
//  InterestEngine — getSubscription
// ===========================================================================

describe("InterestEngine — getSubscription", () => {
  it("returns mapped row when found", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [MOCK_SUB_ROW], rowCount: 1 });

    const result = await engine.getSubscription("agt_1", "sub_1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("sub_1");
  });

  it("returns null when not found", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await engine.getSubscription("agt_1", "sub_999");
    expect(result).toBeNull();
  });
});

// ===========================================================================
//  InterestEngine — getNotificationHistory
// ===========================================================================

describe("InterestEngine — getNotificationHistory", () => {
  it("returns mapped notifications with total", async () => {
    const { engine, pool } = createEngine();
    // COUNT
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 5 }], rowCount: 1 });
    // SELECT
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "n_1",
        subscription_id: "sub_1",
        subscription_label: "AI stuff",
        entity_type: "project",
        entity_id: "proj_1",
        entity_title: "Cool Project",
        relevance_score: 0.85,
        tags_matched: ["machine-learning"],
        credit_cost: 0,
        delivered_via: "websocket",
        delivered_at: "2025-01-01",
      }],
      rowCount: 1,
    });

    const result = await engine.getNotificationHistory("agt_1");
    expect(result.total).toBe(5);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].entityType).toBe("project");
    expect(result.notifications[0].subscriptionLabel).toBe("AI stuff");
  });
});

// ===========================================================================
//  InterestEngine — getNotificationStats
// ===========================================================================

describe("InterestEngine — getNotificationStats", () => {
  it("returns today count, credits spent, and free remaining", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({
      rows: [{ today_count: 3, credits_spent: 10 }],
      rowCount: 1,
    });

    const result = await engine.getNotificationStats("agt_1");
    expect(result.todayCount).toBe(3);
    expect(result.creditsSpent).toBe(10);
    expect(result.freeRemaining).toBe(7); // 10 free - 3 used
  });
});

// ===========================================================================
//  InterestEngine — addRepoWatch
// ===========================================================================

describe("InterestEngine — addRepoWatch", () => {
  it("creates a repo watch", async () => {
    const { engine, pool } = createEngine();
    // Count
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }], rowCount: 1 });
    // INSERT
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "rw_1",
        agent_id: "agt_1",
        owner: "octocat",
        repo: "hello-world",
        last_checked_at: null,
        last_commit_sha: null,
        last_release_tag: null,
        enabled: true,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      }],
      rowCount: 1,
    });

    const result = await engine.addRepoWatch("agt_1", "octocat", "hello-world");
    expect(result.owner).toBe("octocat");
    expect(result.repo).toBe("hello-world");
  });

  it("rejects invalid owner/repo", async () => {
    const { engine } = createEngine();
    await expect(engine.addRepoWatch("agt_1", "", "repo")).rejects.toThrow(ValidationError);
  });

  it("enforces repo watch limit", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 10 }], rowCount: 1 });

    await expect(engine.addRepoWatch("agt_1", "owner", "repo")).rejects.toThrow(LimitError);
  });
});

// ===========================================================================
//  InterestEngine — removeRepoWatch
// ===========================================================================

describe("InterestEngine — removeRepoWatch", () => {
  it("returns true on delete", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    expect(await engine.removeRepoWatch("agt_1", "rw_1")).toBe(true);
  });

  it("returns false when not found", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    expect(await engine.removeRepoWatch("agt_1", "rw_999")).toBe(false);
  });
});

// ===========================================================================
//  InterestEngine — listRepoWatches
// ===========================================================================

describe("InterestEngine — listRepoWatches", () => {
  it("returns mapped repo watches", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "rw_1",
        agent_id: "agt_1",
        owner: "octocat",
        repo: "hello-world",
        last_checked_at: null,
        last_commit_sha: null,
        last_release_tag: null,
        enabled: true,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      }],
      rowCount: 1,
    });

    const result = await engine.listRepoWatches("agt_1");
    expect(result).toHaveLength(1);
    expect(result[0].owner).toBe("octocat");
    expect(result[0].agentId).toBe("agt_1");
  });
});

// ===========================================================================
//  InterestEngine — getRecentMatchesAsOpportunities
// ===========================================================================

describe("InterestEngine — getRecentMatchesAsOpportunities", () => {
  it("returns formatted opportunities", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "n_1",
        subscription_id: "sub_1",
        subscription_label: "AI stuff",
        entity_type: "project",
        entity_id: "proj_1",
        entity_title: "ML Models",
        relevance_score: 0.85,
        tags_matched: ["machine-learning"],
      }],
      rowCount: 1,
    });

    const result = await engine.getRecentMatchesAsOpportunities("agt_1");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("interest_match");
    expect(result[0].sourceId).toBe("interest-n_1");
    expect(result[0].estimatedValue).toBe(85);
  });

  it("returns empty on query failure", async () => {
    const { engine, pool } = createEngine();
    pool.query.mockRejectedValueOnce(new Error("table missing"));

    const result = await engine.getRecentMatchesAsOpportunities("agt_1");
    expect(result).toEqual([]);
  });
});

// ===========================================================================
//  InterestEngine — shutdown
// ===========================================================================

describe("InterestEngine — shutdown", () => {
  it("unsubscribes from message bus", () => {
    const unsubscribe = vi.fn();
    const messageBus = { subscribePattern: vi.fn().mockReturnValue(unsubscribe), publish: vi.fn() };
    const { engine } = createEngine({ messageBus });

    engine.shutdown();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

// ===========================================================================
//  InterestEngine — private helpers via reflection
// ===========================================================================

describe("InterestEngine — evaluateMatchMode", () => {
  it("'any' mode: returns true when at least one tag matches", () => {
    const { engine } = createEngine();
    const result = (engine as any).evaluateMatchMode("any", ["a", "b"], ["a"]);
    expect(result).toBe(true);
  });

  it("'any' mode: returns false when no tags match", () => {
    const { engine } = createEngine();
    const result = (engine as any).evaluateMatchMode("any", ["a", "b"], []);
    expect(result).toBe(false);
  });

  it("'all' mode: requires all tags to match", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateMatchMode("all", ["a", "b"], ["a", "b"])).toBe(true);
    expect((engine as any).evaluateMatchMode("all", ["a", "b"], ["a"])).toBe(false);
  });
});

describe("InterestEngine — evaluateFilters", () => {
  it("passes with empty filters", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({}, {})).toBe(true);
  });

  it("min_ filter: passes when metadata value >= filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ min_reward: "100" }, { reward: "200" })).toBe(true);
  });

  it("min_ filter: fails when metadata value < filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ min_reward: "100" }, { reward: "50" })).toBe(false);
  });

  it("max_ filter: passes when metadata value <= filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ max_reward: "100" }, { reward: "50" })).toBe(true);
  });

  it("max_ filter: fails when metadata value > filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ max_reward: "100" }, { reward: "200" })).toBe(false);
  });

  it("exact match filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ community: "ai" }, { community: "ai" })).toBe(true);
    expect((engine as any).evaluateFilters({ community: "ai" }, { community: "bio" })).toBe(false);
  });

  it("array-contains filter", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ category: "ai" }, { category: ["ai", "ml"] })).toBe(true);
    expect((engine as any).evaluateFilters({ category: "ai" }, { category: ["bio", "chem"] })).toBe(false);
  });

  it("skips filter when metadata field is missing", () => {
    const { engine } = createEngine();
    expect((engine as any).evaluateFilters({ min_reward: "100" }, {})).toBe(true);
  });
});

describe("InterestEngine — computeRelevance", () => {
  it("returns 0.5 for text-only matches (no sub tags)", () => {
    const { engine } = createEngine();
    expect((engine as any).computeRelevance([], [])).toBe(0.5);
  });

  it("returns 1.0 when all tags match", () => {
    const { engine } = createEngine();
    expect((engine as any).computeRelevance(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns partial relevance for partial tag match", () => {
    const { engine } = createEngine();
    // 1/2 overlap * 0.7 + 0.3 = 0.65
    expect((engine as any).computeRelevance(["a", "b"], ["a"])).toBe(0.65);
  });
});
