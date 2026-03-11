import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createSearchRouter } from "./search.js";
import { createTestApp, createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockSearchService() {
  return {
    search: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    scopedSearch: vi.fn().mockResolvedValue({ results: [], total: 0 }),
  };
}

function buildApp(svc?: ReturnType<typeof createMockSearchService>) {
  const pool = createMockPool();
  const searchService = svc ?? createMockSearchService();
  const router = createSearchRouter(pool as any, searchService as any);
  return { app: createTestApp(router), searchService };
}

// ---------------------------------------------------------------------------
//  GET /v1/search — Unified search
// ---------------------------------------------------------------------------

describe("GET /v1/search", () => {
  it("returns search results", async () => {
    const svc = createMockSearchService();
    svc.search.mockResolvedValue({ results: [{ type: "agent", id: "a1" }], total: 1 });
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search?q=test+query");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(svc.search).toHaveBeenCalledWith("test query", undefined, 20, 0, undefined);
  });

  it("rejects query shorter than 2 characters", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/v1/search?q=a");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("2-200");
  });

  it("rejects empty query", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/v1/search?q=");
    expect(res.status).toBe(400);
  });

  it("rejects query longer than 200 characters", async () => {
    const { app } = buildApp();
    const longQuery = "a".repeat(201);
    const res = await request(app).get(`/v1/search?q=${longQuery}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("2-200");
  });

  it("passes limit and offset to service", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&limit=10&offset=5");

    expect(svc.search).toHaveBeenCalledWith("test query", undefined, 10, 5, undefined);
  });

  it("clamps limit to 100", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&limit=500");

    expect(svc.search).toHaveBeenCalledWith("test query", undefined, 100, 0, undefined);
  });

  it("defaults invalid limit to 20", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&limit=abc");

    expect(svc.search).toHaveBeenCalledWith("test query", undefined, 20, 0, undefined);
  });

  it("defaults negative offset to 0", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&offset=-5");

    expect(svc.search).toHaveBeenCalledWith("test query", undefined, 20, 0, undefined);
  });

  it("filters by valid types", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&types=agent,project");

    expect(svc.search).toHaveBeenCalledWith(
      "test query",
      expect.arrayContaining(["agent", "project"]),
      20,
      0,
      undefined,
    );
  });

  it("rejects when all types are invalid", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/search?q=test+query&types=invalid,bogus");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No valid types");
  });

  it("strips control characters from query", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    // Send query with embedded null byte and control chars
    await request(app).get("/v1/search?q=test%00query%01here");

    expect(svc.search).toHaveBeenCalledWith("testqueryhere", undefined, 20, 0, undefined);
  });

  it("returns 500 on service error", async () => {
    const svc = createMockSearchService();
    svc.search.mockRejectedValue(new Error("DB down"));
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search?q=test+query");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Search failed");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search/projects — Projects only
// ---------------------------------------------------------------------------

describe("GET /v1/search/projects", () => {
  it("calls search with project type filter", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search/projects?q=my+project");

    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith("my project", ["project"], 20, 0);
  });

  it("validates query length", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/v1/search/projects?q=x");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search/channels — Channels only
// ---------------------------------------------------------------------------

describe("GET /v1/search/channels", () => {
  it("calls search with channel type filter", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search/channels?q=dev+chat");

    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith("dev chat", ["channel"], 20, 0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search/agents — Agents only
// ---------------------------------------------------------------------------

describe("GET /v1/search/agents", () => {
  it("calls search with agent type filter", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search/agents?q=agent+alpha");

    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith("agent alpha", ["agent"], 20, 0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search/papers — Papers only
// ---------------------------------------------------------------------------

describe("GET /v1/search/papers", () => {
  it("calls search with paper type filter", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search/papers?q=transformer+architecture");

    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith("transformer architecture", ["paper"], 20, 0);
  });

  it("returns 500 on service error", async () => {
    const svc = createMockSearchService();
    svc.search.mockRejectedValue(new Error("timeout"));
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search/papers?q=test+query");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search — Scoped search params
// ---------------------------------------------------------------------------

describe("GET /v1/search — scoped search", () => {
  it("calls scopedSearch when scope and scopeId are provided", async () => {
    const svc = createMockSearchService();
    svc.scopedSearch.mockResolvedValue({ results: [{ type: "task", id: "t1" }], total: 1 });
    const { app } = buildApp(svc);

    const res = await request(app).get("/v1/search?q=test+query&scope=project&scopeId=my-proj");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(svc.scopedSearch).toHaveBeenCalledWith(
      "test query",
      { type: "project", id: "my-proj" },
      undefined,
      20,
      0,
      undefined,
    );
    expect(svc.search).not.toHaveBeenCalled();
  });

  it("calls scopedSearch with guild scope", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&scope=guild&scopeId=5");

    expect(svc.scopedSearch).toHaveBeenCalledWith(
      "test query",
      { type: "guild", id: "5" },
      undefined,
      20,
      0,
      undefined,
    );
  });

  it("rejects invalid scope value", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/search?q=test+query&scope=invalid&scopeId=123");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scope");
  });

  it("rejects scope without scopeId", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/search?q=test+query&scope=project");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scopeId");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/search — Bundle filter params
// ---------------------------------------------------------------------------

describe("GET /v1/search — bundle filters", () => {
  it("passes bundleType filter to search service", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&bundleType=curation");

    expect(svc.search).toHaveBeenCalledWith(
      "test query",
      undefined,
      20,
      0,
      expect.objectContaining({ bundleType: "curation" }),
    );
  });

  it("passes tags filter to search service", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&tags=ml,ai");

    expect(svc.search).toHaveBeenCalledWith(
      "test query",
      undefined,
      20,
      0,
      expect.objectContaining({ tags: ["ml", "ai"] }),
    );
  });

  it("rejects bundleType longer than 64 characters", async () => {
    const { app } = buildApp();
    const longType = "a".repeat(65);

    const res = await request(app).get(`/v1/search?q=test+query&bundleType=${longType}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bundleType");
  });

  it("passes bundle filters through to scopedSearch", async () => {
    const svc = createMockSearchService();
    const { app } = buildApp(svc);

    await request(app).get("/v1/search?q=test+query&scope=project&scopeId=proj-1&bundleType=dataset");

    expect(svc.scopedSearch).toHaveBeenCalledWith(
      "test query",
      { type: "project", id: "proj-1" },
      undefined,
      20,
      0,
      expect.objectContaining({ bundleType: "dataset" }),
    );
  });
});
