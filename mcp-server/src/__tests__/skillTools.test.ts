/**
 * Skill registry MCP tool tests — validates tool definitions and handler behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { skillTools } from "../tools/skills.js";

// ─── Mock fs/os before importing ─────────────────────────────────────────────

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { mkdirSync, writeFileSync } from "fs";

// ─── Mock Context Factory ────────────────────────────────────────────────────

function createMockCtx(overrides: Partial<Record<string, any>> = {}) {
  return {
    address: "0xAGENT",
    get: vi.fn().mockResolvedValue({ skills: [], total: 0 }),
    post: vi.fn().mockResolvedValue({ skill: { id: "s1", slug: "test-skill", name: "Test", version: "1.0.0", content: "# Test" } }),
    put: vi.fn(),
    patch: vi.fn(),
    prepareSignRelay: vi.fn(),
    ...overrides,
  } as any;
}

// ─── Tool Lookup ─────────────────────────────────────────────────────────────

function getTool(name: string) {
  const tool = skillTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Skill Registry MCP Tools", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Tool Registration ──────────────────────────────────────

  describe("registration", () => {
    it("exports exactly 6 tools", () => {
      expect(skillTools).toHaveLength(6);
    });

    it("all tools are prefixed with nookplot_", () => {
      for (const tool of skillTools) {
        expect(tool.name).toMatch(/^nookplot_/);
      }
    });

    it("all tools have valid input schemas", () => {
      for (const tool of skillTools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
      }
    });

    it("all tools have descriptions > 10 chars", () => {
      for (const tool of skillTools) {
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it("expected tool names are present", () => {
      const names = skillTools.map(t => t.name);
      expect(names).toContain("nookplot_search_skills");
      expect(names).toContain("nookplot_install_skill");
      expect(names).toContain("nookplot_publish_skill");
      expect(names).toContain("nookplot_rate_skill");
      expect(names).toContain("nookplot_my_skills");
      expect(names).toContain("nookplot_trending_skills");
    });
  });

  // ─── nookplot_search_skills ─────────────────────────────────

  describe("nookplot_search_skills", () => {
    it("calls GET with query params", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");

      await tool.handler({ query: "caching", category: "tools", limit: 10 }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("/v1/skills/registry");
      expect(url).toContain("q=caching");
      expect(url).toContain("category=tools");
      expect(url).toContain("limit=10");
    });

    it("uses default limit of 20", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");

      await tool.handler({}, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("limit=20");
    });

    it("omits empty query params", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");

      await tool.handler({}, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).not.toContain("q=");
      expect(url).not.toContain("category=");
    });
  });

  // ─── nookplot_install_skill ─────────────────────────────────

  describe("nookplot_install_skill", () => {
    it("calls POST install endpoint", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_install_skill");

      await tool.handler({ skillId: "abc-123" }, ctx);

      expect(ctx.post).toHaveBeenCalledWith(
        "/v1/skills/registry/abc-123/install",
        {},
      );
    });

    it("creates directory and writes SKILL.md + metadata.json", async () => {
      const ctx = createMockCtx({
        post: vi.fn().mockResolvedValue({
          skill: { id: "s1", slug: "my-skill", name: "My Skill", version: "2.0.0", content: "# My Skill\n\nContent here." },
        }),
      });
      const tool = getTool("nookplot_install_skill");

      const result = await tool.handler({ skillId: "s1" }, ctx) as any;

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("my-skill"),
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("SKILL.md"),
        "# My Skill\n\nContent here.",
        "utf-8",
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("metadata.json"),
        expect.stringContaining('"slug"'),
        "utf-8",
      );
      expect(result.installed).toBe(true);
      expect(result.path).toContain("my-skill");
    });

    it("skips writing SKILL.md when content is null", async () => {
      const ctx = createMockCtx({
        post: vi.fn().mockResolvedValue({
          skill: { id: "s1", slug: "no-content", name: "No Content", version: "1.0.0", content: null },
        }),
      });
      const tool = getTool("nookplot_install_skill");

      await tool.handler({ skillId: "s1" }, ctx);

      // mkdirSync called, but writeFileSync only for metadata.json
      expect(mkdirSync).toHaveBeenCalled();
      const writeFileCalls = (writeFileSync as any).mock.calls;
      const skillMdCalls = writeFileCalls.filter((c: any[]) => c[0].includes("SKILL.md"));
      expect(skillMdCalls).toHaveLength(0);
    });

    it("uses skillId as slug fallback", async () => {
      const ctx = createMockCtx({
        post: vi.fn().mockResolvedValue({ id: "fallback-id", version: "1.0.0" }),
      });
      const tool = getTool("nookplot_install_skill");

      const result = await tool.handler({ skillId: "fallback-id" }, ctx) as any;

      expect(result.metadata.slug).toBe("fallback-id");
    });

    it("requires skillId parameter", () => {
      const tool = getTool("nookplot_install_skill");
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("skillId");
    });
  });

  // ─── nookplot_publish_skill ─────────────────────────────────

  describe("nookplot_publish_skill", () => {
    it("calls POST with all fields", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_publish_skill");

      await tool.handler({
        name: "Cache Helper",
        description: "Caching utilities for agents",
        packageType: "skill_md",
        tags: ["caching", "performance"],
        category: "tools",
        content: "# Cache Helper",
      }, ctx);

      expect(ctx.post).toHaveBeenCalledWith("/v1/skills/registry", {
        name: "Cache Helper",
        description: "Caching utilities for agents",
        packageType: "skill_md",
        tags: ["caching", "performance"],
        category: "tools",
        content: "# Cache Helper",
      });
    });

    it("defaults tags to empty array", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_publish_skill");

      await tool.handler({
        name: "Test",
        description: "Test skill",
        packageType: "skill_md",
        content: "# Test",
      }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.tags).toEqual([]);
    });

    it("requires name, description, packageType, content", () => {
      const tool = getTool("nookplot_publish_skill");
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("name");
      expect(required).toContain("description");
      expect(required).toContain("packageType");
      expect(required).toContain("content");
    });
  });

  // ─── nookplot_rate_skill ────────────────────────────────────

  describe("nookplot_rate_skill", () => {
    it("calls POST review endpoint with rating and review", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_rate_skill");

      await tool.handler({ skillId: "s1", rating: 5, review: "Excellent!" }, ctx);

      expect(ctx.post).toHaveBeenCalledWith(
        "/v1/skills/registry/s1/review",
        { rating: 5, review: "Excellent!" },
      );
    });

    it("sends undefined review when not provided", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_rate_skill");

      await tool.handler({ skillId: "s1", rating: 3 }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.rating).toBe(3);
      expect(body.review).toBeUndefined();
    });

    it("requires skillId and rating", () => {
      const tool = getTool("nookplot_rate_skill");
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("skillId");
      expect(required).toContain("rating");
    });
  });

  // ─── nookplot_my_skills ─────────────────────────────────────

  describe("nookplot_my_skills", () => {
    it("calls GET with publisherId set to ctx.address", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_my_skills");

      await tool.handler({}, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("/v1/skills/registry");
      expect(url).toContain("publisherId=0xAGENT");
    });
  });

  // ─── nookplot_trending_skills ───────────────────────────────

  describe("nookplot_trending_skills", () => {
    it("calls GET trending endpoint with limit", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_trending_skills");

      await tool.handler({ limit: 10 }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/skills/registry/trending?limit=10");
    });

    it("defaults limit to 20", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_trending_skills");

      await tool.handler({}, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("limit=20");
    });
  });
});
