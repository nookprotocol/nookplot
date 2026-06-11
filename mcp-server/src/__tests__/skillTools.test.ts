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
    preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
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
    it("exports exactly 7 tools", () => {
      expect(skillTools).toHaveLength(7);
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
      expect(names).toContain("nookplot_load_skill");
      expect(names).toContain("nookplot_install_skill");
      expect(names).toContain("nookplot_publish_skill");
      expect(names).toContain("nookplot_rate_skill");
      expect(names).toContain("nookplot_my_skills");
      expect(names).toContain("nookplot_trending_skills");
    });
  });

  // ─── nookplot_search_skills (upgraded — hybrid retrieval) ────

  describe("nookplot_search_skills", () => {
    it("hits the hybrid /search endpoint with q and k", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");

      await tool.handler({ query: "embed text", k: 5 }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("/v1/skills/registry/search");
      expect(url).toContain("q=embed");
      expect(url).toContain("k=5");
    });

    it("defaults k to 10 when omitted", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");
      await tool.handler({ query: "anything" }, ctx);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("k=10");
    });

    it("passes kinds as comma-separated when provided", async () => {
      const ctx = createMockCtx();
      const tool = getTool("nookplot_search_skills");
      await tool.handler({ query: "x", kinds: ["mcp_tool", "protocol_skill"] }, ctx);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("kinds=mcp_tool%2Cprotocol_skill");
    });

    it("requires query parameter", () => {
      const tool = getTool("nookplot_search_skills");
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("query");
    });
  });

  // ─── nookplot_load_skill ────────────────────────────────────

  describe("nookplot_load_skill", () => {
    it("hits /tool/:tool_name for mcp_tool kind", async () => {
      const ctx = createMockCtx();
      ctx.get.mockResolvedValue({ kind: "mcp_tool", description: "x", input_schema: {}, parameter_docs: "y", category: "z" });
      const tool = getTool("nookplot_load_skill");
      await tool.handler({ name: "nookplot_create_post", kind: "mcp_tool" }, ctx);
      expect(ctx.get).toHaveBeenCalledWith("/v1/skills/registry/tool/nookplot_create_post");
    });

    it("hits /load/:kind/:name for protocol_skill kind and forwards the discriminated load shape", async () => {
      // the load endpoint resolves slug-OR-name and returns
      // the discriminated LoadResult directly. The MCP handler is now a thin
      // pass-through (no skill-unwrap step), so the gateway shape reaches the
      // agent unchanged.
      const ctx = createMockCtx();
      ctx.get.mockResolvedValue({
        kind: "protocol_skill",
        canonical_ref: "00000000-0000-0000-0000-000000000001",
        content: "# Body",
        pattern_boundaries: "use other-skill",
      });
      const tool = getTool("nookplot_load_skill");
      const result = await tool.handler({ name: "nookplot-mining", kind: "protocol_skill" }, ctx) as any;
      expect(ctx.get).toHaveBeenCalledWith("/v1/skills/registry/load/protocol_skill/nookplot-mining");
      expect(result.kind).toBe("protocol_skill");
      expect(result.content).toBe("# Body");
      expect(result.pattern_boundaries).toContain("other-skill");
    });

    it("name parameter accepts the human name (not just slug) — gateway resolves", async () => {
      // The gateway's load() method runs `WHERE slug = $1 OR name = $1`, so
      // search results that surface name="mining" can be passed straight
      // through here without the agent needing to know the reserved slug.
      const ctx = createMockCtx();
      ctx.get.mockResolvedValue({
        kind: "community",
        canonical_ref: "11111111-1111-1111-1111-111111111111",
        content: "x",
        install_command: null,
        github_url: null,
        pattern_boundaries: null,
      });
      const tool = getTool("nookplot_load_skill");
      await tool.handler({ name: "mining", kind: "community" }, ctx);
      expect(ctx.get).toHaveBeenCalledWith("/v1/skills/registry/load/community/mining");
    });

    it("does NOT write to disk (distinct from nookplot_install_skill)", async () => {
      const ctx = createMockCtx();
      ctx.get.mockResolvedValue({ kind: "mcp_tool", description: "x", input_schema: {}, parameter_docs: "y", category: "z" });
      const tool = getTool("nookplot_load_skill");
      await tool.handler({ name: "nookplot_create_post", kind: "mcp_tool" }, ctx);
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("requires name and kind", () => {
      const tool = getTool("nookplot_load_skill");
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("name");
      expect(required).toContain("kind");
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
