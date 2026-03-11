import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTagsRouter } from "./tags.js";
import { createTestApp } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockInterestEngine() {
  return {
    trendingTags: vi.fn(),
    suggestTags: vi.fn(),
    listTags: vi.fn(),
  };
}

function buildApp(engine?: ReturnType<typeof createMockInterestEngine>) {
  const ie = engine ?? createMockInterestEngine();
  const router = createTagsRouter(ie as any);
  return { app: createTestApp(router), ie };
}

// ---------------------------------------------------------------------------
//  GET /v1/tags/trending — Top tags by usage
// ---------------------------------------------------------------------------

describe("GET /v1/tags/trending", () => {
  it("returns trending tags", async () => {
    const ie = createMockInterestEngine();
    ie.trendingTags.mockResolvedValueOnce([
      { tag: "python", displayName: "Python", category: null, usageCount: 100 },
    ]);
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags/trending");

    expect(res.status).toBe(200);
    expect(res.body.tags).toHaveLength(1);
    expect(res.body.tags[0].tag).toBe("python");
  });

  it("respects limit param", async () => {
    const ie = createMockInterestEngine();
    ie.trendingTags.mockResolvedValueOnce([]);
    const { app } = buildApp(ie);

    await request(app).get("/v1/tags/trending?limit=5");

    expect(ie.trendingTags).toHaveBeenCalledWith(5);
  });

  it("clamps limit to 100", async () => {
    const ie = createMockInterestEngine();
    ie.trendingTags.mockResolvedValueOnce([]);
    const { app } = buildApp(ie);

    await request(app).get("/v1/tags/trending?limit=500");

    expect(ie.trendingTags).toHaveBeenCalledWith(100);
  });

  it("returns 500 on engine failure", async () => {
    const ie = createMockInterestEngine();
    ie.trendingTags.mockRejectedValueOnce(new Error("DB error"));
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags/trending");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("trending");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/tags/suggest — Autocomplete
// ---------------------------------------------------------------------------

describe("GET /v1/tags/suggest", () => {
  it("returns suggestions for a prefix", async () => {
    const ie = createMockInterestEngine();
    ie.suggestTags.mockResolvedValueOnce([
      { tag: "python", displayName: "Python", category: null, usageCount: 50 },
    ]);
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags/suggest?prefix=py");

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
  });

  it("rejects missing prefix", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/tags/suggest");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("prefix");
  });

  it("returns 500 on engine failure", async () => {
    const ie = createMockInterestEngine();
    ie.suggestTags.mockRejectedValueOnce(new Error("DB error"));
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags/suggest?prefix=py");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/tags — List/search tags
// ---------------------------------------------------------------------------

describe("GET /v1/tags", () => {
  it("returns paginated tags", async () => {
    const ie = createMockInterestEngine();
    ie.listTags.mockResolvedValueOnce({
      tags: [{ tag: "python", displayName: "Python", category: null, usageCount: 10 }],
      total: 50,
    });
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags");

    expect(res.status).toBe(200);
    expect(res.body.tags).toHaveLength(1);
    expect(res.body.total).toBe(50);
  });

  it("passes query params to engine", async () => {
    const ie = createMockInterestEngine();
    ie.listTags.mockResolvedValueOnce({ tags: [], total: 0 });
    const { app } = buildApp(ie);

    await request(app).get("/v1/tags?q=py&category=language&limit=10&offset=5");

    expect(ie.listTags).toHaveBeenCalledWith({
      q: "py",
      category: "language",
      limit: 10,
      offset: 5,
    });
  });

  it("returns 500 on engine failure", async () => {
    const ie = createMockInterestEngine();
    ie.listTags.mockRejectedValueOnce(new Error("DB error"));
    const { app } = buildApp(ie);

    const res = await request(app).get("/v1/tags");

    expect(res.status).toBe(500);
  });
});
