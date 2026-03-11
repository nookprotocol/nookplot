import { describe, it, expect, vi } from "vitest";
import { SearchService } from "./searchService.js";
import { createMockPool } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeSearchRow(overrides?: Record<string, unknown>) {
  return {
    project_id: "proj-1",
    name: "Test Project",
    snippet: "A <b>test</b> project",
    relevance: "0.85",
    status: "active",
    languages: ["TypeScript"],
    tags: ["test"],
    created_at: new Date("2025-06-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  search — unified
// ---------------------------------------------------------------------------

describe("SearchService — search", () => {
  it("returns results from a single type", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [makeSearchRow()],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("test", ["project"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe("project");
    expect(result.results[0].title).toBe("Test Project");
    expect(result.results[0].relevance).toBe(0.85);
    expect(result.query).toBe("test");
  });

  it("merges results from multiple types sorted by relevance", async () => {
    const pool = createMockPool();
    // Project query (2 queries: project rows + readme rows)
    pool.query.mockResolvedValueOnce({
      rows: [makeSearchRow({ relevance: "0.50" })],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // readme fan-out
    // Channel query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "ch-1",
        name: "Test Channel",
        slug: "test-ch",
        snippet: "A channel",
        relevance: "0.90",
        channel_type: "custom",
        is_public: true,
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("test", ["project", "channel"]);

    expect(result.results).toHaveLength(2);
    // Higher relevance first
    expect(result.results[0].type).toBe("channel");
    expect(result.results[1].type).toBe("project");
    expect(result.total).toBe(2);
  });

  it("returns empty for invalid types", async () => {
    const pool = createMockPool();
    const svc = new SearchService(pool as any);
    const result = await svc.search("test", ["invalid_type" as any]);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("searches all types when none specified", async () => {
    const pool = createMockPool();
    // 10 queries: project (2: rows + readme fan-out) + channel + agent + discussion + task + bounty + paper + bundle + teaching
    for (let i = 0; i < 10; i++) {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }

    const svc = new SearchService(pool as any);
    const result = await svc.search("test");

    expect(result.results).toHaveLength(0);
    expect(pool.query).toHaveBeenCalledTimes(10);
  });

  it("respects offset and limit", async () => {
    const pool = createMockPool();
    // perTypeLimit = limit + offset = 2 + 1 = 3, so searchProjects returns at most 3
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeSearchRow({ project_id: `proj-${i}`, relevance: String(0.9 - i * 0.1) }),
    );
    pool.query.mockResolvedValueOnce({ rows, rowCount: 3 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // readme fan-out

    const svc = new SearchService(pool as any);
    const result = await svc.search("test", ["project"], 2, 1);

    expect(result.results).toHaveLength(2);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(2);
    expect(result.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  Per-type search result mapping
// ---------------------------------------------------------------------------

describe("SearchService — agent search", () => {
  it("maps agent rows correctly", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "agt_1",
        address: "0xabc",
        display_name: "Agent A",
        snippet: "An agent",
        relevance: "0.75",
        capabilities: ["chat"],
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("agent", ["agent"]);

    expect(result.results[0].type).toBe("agent");
    expect(result.results[0].id).toBe("0xabc");
    expect(result.results[0].title).toBe("Agent A");
    expect(result.results[0].metadata).toHaveProperty("capabilities");
  });
});

describe("SearchService — task search", () => {
  it("maps task rows correctly", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "task-1",
        title: "Fix bug",
        project_id: "proj-1",
        snippet: "Fix the login <b>bug</b>",
        relevance: "0.65",
        status: "open",
        priority: "high",
        labels: ["bug"],
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("bug", ["task"]);

    expect(result.results[0].type).toBe("task");
    expect(result.results[0].title).toBe("Fix bug");
    expect(result.results[0].metadata).toHaveProperty("projectId", "proj-1");
  });
});

describe("SearchService — bounty search", () => {
  it("maps bounty rows correctly", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "bounty-1",
        title: "Implement feature",
        project_id: "proj-1",
        snippet: "Implement a <b>feature</b>",
        relevance: "0.70",
        status: "open",
        reward_amount: "100",
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("feature", ["bounty"]);

    expect(result.results[0].type).toBe("bounty");
    expect(result.results[0].metadata).toHaveProperty("reward", "100");
  });
});

describe("SearchService — paper search", () => {
  it("maps paper rows correctly", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        arxiv_id: "2301.12345",
        title: "AI Paper",
        snippet: "An <b>AI</b> paper",
        relevance: "0.80",
        authors: ["Author A"],
        categories: ["cs.AI"],
        citation_count: 42,
        published_date: new Date("2025-01-01"),
        ingested_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("AI", ["paper"]);

    expect(result.results[0].type).toBe("paper");
    expect(result.results[0].id).toBe("2301.12345");
    expect(result.results[0].metadata).toHaveProperty("citationCount", 42);
  });
});

// ---------------------------------------------------------------------------
//  scopedSearch — project scope
// ---------------------------------------------------------------------------

describe("SearchService — scopedSearch (project)", () => {
  it("returns empty when project not found", async () => {
    const pool = createMockPool();
    // Resolve project — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SearchService(pool as any);
    const result = await svc.scopedSearch("test", { type: "project", id: "missing" }, ["task"]);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("searches tasks scoped to a project", async () => {
    const pool = createMockPool();
    // Resolve project
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xAAA" }],
      rowCount: 1,
    });
    // Scoped task search
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "task-1",
        title: "Fix bug",
        project_id: "proj-uuid-1",
        snippet: "Fix the <b>bug</b>",
        relevance: "0.75",
        status: "open",
        priority: "high",
        labels: ["bug"],
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.scopedSearch("bug", { type: "project", id: "proj-1" }, ["task"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe("task");
    expect(result.results[0].title).toBe("Fix bug");
  });

  it("filters out types not valid for project scope", async () => {
    const pool = createMockPool();
    // Resolve project
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xAAA" }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    // "project" and "channel" are not valid project-scoped types
    const result = await svc.scopedSearch("test", { type: "project", id: "proj-1" }, ["project", "channel"]);

    expect(result.results).toHaveLength(0);
    // No queries for invalid types
  });
});

// ---------------------------------------------------------------------------
//  scopedSearch — guild scope
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Bundle search — metadata enrichment + filtering
// ---------------------------------------------------------------------------

describe("SearchService — bundle search", () => {
  it("maps bundle rows with metadata fields", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundle_id: "1",
        name: "ML Curation",
        cid_count: 5,
        contributor_count: 2,
        creator_id: "0xabc",
        created_at: "1700000000",
        bundle_type: "curation",
        tags: ["machine-learning", "transformers"],
        domain: "artificial-intelligence",
        snippet: "ML <b>curation</b>",
        relevance: "0.90",
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("curation", ["bundle"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe("bundle");
    expect(result.results[0].metadata).toEqual(
      expect.objectContaining({
        bundleType: "curation",
        tags: ["machine-learning", "transformers"],
        domain: "artificial-intelligence",
      }),
    );
  });

  it("returns null metadata for bundles without metadata", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundle_id: "2",
        name: "Old Bundle",
        cid_count: 1,
        contributor_count: 1,
        creator_id: "0xdef",
        created_at: "1700000000",
        bundle_type: null,
        tags: null,
        domain: null,
        snippet: "Old",
        relevance: "0.50",
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.search("old", ["bundle"]);

    expect(result.results[0].metadata.bundleType).toBeNull();
    expect(result.results[0].metadata.tags).toEqual([]);
    expect(result.results[0].metadata.domain).toBeNull();
  });

  it("passes bundle filters through search()", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SearchService(pool as any);
    await svc.search("test", ["bundle"], 20, 0, { bundleType: "curation", tags: ["ml"] });

    // Verify the query includes filter params ($3 = bundleType, $4 = tags)
    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[1]).toContain("curation");
    expect(queryCall[1]).toContainEqual(["ml"]);
  });
});

describe("SearchService — scopedSearch (guild)", () => {
  it("returns empty when guild not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new SearchService(pool as any);
    const result = await svc.scopedSearch("test", { type: "guild", id: "999" }, ["project"]);

    expect(result.results).toHaveLength(0);
  });

  it("searches projects scoped to a guild", async () => {
    const pool = createMockPool();
    // Resolve guild
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", clique_id: "1" }],
      rowCount: 1,
    });
    // Scoped project search
    pool.query.mockResolvedValueOnce({
      rows: [makeSearchRow({ relevance: "0.80" })],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.scopedSearch("test", { type: "guild", id: "1" }, ["project"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe("project");
  });

  it("searches agents scoped to guild members", async () => {
    const pool = createMockPool();
    // Resolve guild
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", clique_id: "1" }],
      rowCount: 1,
    });
    // Scoped agent search
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "agt_1",
        address: "0xabc",
        display_name: "Agent A",
        snippet: "An agent",
        relevance: "0.70",
        capabilities: ["chat"],
        created_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const svc = new SearchService(pool as any);
    const result = await svc.scopedSearch("agent", { type: "guild", id: "1" }, ["agent"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe("agent");
    expect(result.results[0].id).toBe("0xabc");
  });
});
