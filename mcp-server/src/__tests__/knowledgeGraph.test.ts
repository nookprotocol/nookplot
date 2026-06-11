/**
 * Knowledge Graph MCP tool tests — search, store, stats, citations, consolidation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeGraphTools } from "../tools/knowledgeGraph.js";

// ── Mock Context Factory ────────────────────────────────────────────────────

function createMockCtx(overrides: Partial<Record<string, any>> = {}) {
  return {
    address: "0xAGENT",
    apiKey: "nk_test",
    gatewayUrl: "https://gateway.nookplot.com",
    get: vi.fn().mockResolvedValue({ results: [], count: 0 }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    prepareSignRelay: vi.fn(),
    ...overrides,
  } as any;
}

function getTool(name: string) {
  const tool = knowledgeGraphTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found in knowledgeGraphTools`);
  return tool;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Knowledge Graph MCP Tools", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Registration ──────────────────────────────────────────

  describe("registration", () => {
    it("exports exactly 10 tools", () => {
      expect(knowledgeGraphTools).toHaveLength(10);
    });

    it("all tools are prefixed with nookplot_", () => {
      for (const tool of knowledgeGraphTools) {
        expect(tool.name).toMatch(/^nookplot_/);
      }
    });

    it("all tools have category 'knowledge'", () => {
      for (const tool of knowledgeGraphTools) {
        expect(tool.category).toBe("knowledge");
      }
    });

    it("all tools have valid input schemas", () => {
      for (const tool of knowledgeGraphTools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
      }
    });

    it("all tools have descriptions > 10 chars", () => {
      for (const tool of knowledgeGraphTools) {
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it("expected tool names are present", () => {
      const names = knowledgeGraphTools.map(t => t.name);
      expect(names).toContain("nookplot_search_knowledge");
      expect(names).toContain("nookplot_store_knowledge_item");
      expect(names).toContain("nookplot_browse_knowledge");
      expect(names).toContain("nookplot_get_knowledge_item");
      expect(names).toContain("nookplot_get_knowledge_stats");
      expect(names).toContain("nookplot_add_knowledge_citation");
      expect(names).toContain("nookplot_compile_knowledge");
      expect(names).toContain("nookplot_update_knowledge_item");
      expect(names).toContain("nookplot_archive_knowledge_item");
      expect(names).toContain("nookplot_get_network_wiki");
    });
  });

  // ── nookplot_search_knowledge ─────────────────────────────

  describe("nookplot_search_knowledge", () => {
    it("calls POST /v1/knowledge/unified with query", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_search_knowledge").handler({ query: "biology" }, ctx);

      expect(ctx.post).toHaveBeenCalledTimes(1);
      expect(ctx.post.mock.calls[0][0]).toBe("/v1/knowledge/unified");
      expect(ctx.post.mock.calls[0][1]).toMatchObject({
        query: "biology",
        scope: "all",
      });
    });

    it("passes all filter params", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_search_knowledge").handler({
        query: "crispr",
        scope: "personal",
        domain: "biology",
        types: ["bundle", "paper"],
        tags: "genomics,crispr",
        limit: 50,
      }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.query).toBe("crispr");
      expect(body.scope).toBe("personal");
      expect(body.domain).toBe("biology");
      expect(body.types).toEqual(["bundle", "paper"]);
      expect(body.tags).toEqual(["genomics", "crispr"]);
      expect(body.limit).toBe(50);
    });

    it("defaults scope to 'all' when not provided", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_search_knowledge").handler({ query: "test" }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.scope).toBe("all");
      expect(body.domain).toBeUndefined();
      expect(body.types).toBeUndefined();
      expect(body.tags).toBeUndefined();
    });

    it("requires query param", () => {
      const tool = getTool("nookplot_search_knowledge");
      expect(tool.inputSchema.required).toContain("query");
    });
  });

  // ── nookplot_store_knowledge_item ─────────────────────────

  describe("nookplot_store_knowledge_item", () => {
    it("calls POST with contentText", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_store_knowledge_item").handler({
        contentText: "CRISPR enables gene editing",
      }, ctx);

      expect(ctx.post).toHaveBeenCalledTimes(1);
      expect(ctx.post.mock.calls[0][0]).toBe("/v1/agents/me/knowledge");
      expect(ctx.post.mock.calls[0][1]).toMatchObject({
        contentText: "CRISPR enables gene editing",
        sourceType: "conversation",
      });
    });

    it("passes all optional fields", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_store_knowledge_item").handler({
        contentText: "fact",
        knowledgeType: "insight",
        sourceType: "mining",
        domain: "biology",
        tags: ["genomics"],
        importance: 0.9,
        confidence: 0.8,
      }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.knowledgeType).toBe("insight");
      expect(body.sourceType).toBe("mining");
      expect(body.domain).toBe("biology");
      expect(body.tags).toEqual(["genomics"]);
      expect(body.importance).toBe(0.9);
      expect(body.confidence).toBe(0.8);
    });

    it("defaults sourceType to 'conversation'", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_store_knowledge_item").handler({
        contentText: "test",
      }, ctx);

      expect(ctx.post.mock.calls[0][1].sourceType).toBe("conversation");
    });

    it("requires contentText", () => {
      const tool = getTool("nookplot_store_knowledge_item");
      expect(tool.inputSchema.required).toContain("contentText");
    });
  });

  // ── nookplot_get_knowledge_stats ──────────────────────────

  describe("nookplot_get_knowledge_stats", () => {
    it("defaults to own address", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_stats").handler({}, ctx);

      expect(ctx.get).toHaveBeenCalledWith("/v1/agents/0xAGENT/knowledge/stats");
    });

    it("uses provided agentAddress", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_stats").handler({
        agentAddress: "0xOTHER",
      }, ctx);

      expect(ctx.get).toHaveBeenCalledWith("/v1/agents/0xOTHER/knowledge/stats");
    });
  });

  // ── nookplot_get_knowledge_item ───────────────────────────

  describe("nookplot_get_knowledge_item", () => {
    it("calls GET with agent address and item ID", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_item").handler({
        itemId: "550e8400-e29b-41d4-a716-446655440000",
      }, ctx);

      expect(ctx.get).toHaveBeenCalledWith(
        "/v1/agents/0xAGENT/knowledge/550e8400-e29b-41d4-a716-446655440000",
      );
    });

    it("uses provided agentAddress", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_item").handler({
        agentAddress: "0xOTHER",
        itemId: "abc-123",
      }, ctx);

      expect(ctx.get).toHaveBeenCalledWith("/v1/agents/0xOTHER/knowledge/abc-123");
    });

    it("requires itemId", () => {
      const tool = getTool("nookplot_get_knowledge_item");
      expect(tool.inputSchema.required).toContain("itemId");
    });
  });

  // ── nookplot_get_knowledge_item — includeCitations flag ───
  // (Citations were folded into get_knowledge_item; the standalone
  // get_knowledge_citations tool was removed.)

  describe("nookplot_get_knowledge_item — includeCitations flag", () => {
    it("appends include_citations=true when requested", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_item").handler({
        itemId: "item-1",
        includeCitations: true,
      }, ctx);

      expect(ctx.get).toHaveBeenCalledWith(
        "/v1/agents/0xAGENT/knowledge/item-1?include_citations=true",
      );
    });

    it("omits include_citations when false/undefined", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_get_knowledge_item").handler({
        itemId: "item-1",
      }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).not.toContain("include_citations");
    });
  });

  // ── nookplot_add_knowledge_citation ───────────────────────

  describe("nookplot_add_knowledge_citation", () => {
    it("calls POST with source and target", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_add_knowledge_citation").handler({
        sourceItemId: "src-1",
        targetItemId: "tgt-1",
      }, ctx);

      expect(ctx.post).toHaveBeenCalledTimes(1);
      expect(ctx.post.mock.calls[0][0]).toBe("/v1/agents/me/knowledge/src-1/cite");
      expect(ctx.post.mock.calls[0][1]).toMatchObject({
        targetId: "tgt-1",
      });
    });

    it("passes optional citationType and strength", async () => {
      const ctx = createMockCtx();
      await getTool("nookplot_add_knowledge_citation").handler({
        sourceItemId: "src-1",
        targetItemId: "tgt-1",
        citationType: "contradicts",
        strength: 0.5,
      }, ctx);

      const body = ctx.post.mock.calls[0][1];
      expect(body.citationType).toBe("contradicts");
      expect(body.strength).toBe(0.5);
    });

    it("requires sourceItemId and targetItemId", () => {
      const tool = getTool("nookplot_add_knowledge_citation");
      expect(tool.inputSchema.required).toContain("sourceItemId");
      expect(tool.inputSchema.required).toContain("targetItemId");
    });
  });

  // ── nookplot_compile_knowledge ────────────────────────────
  // (Replaces the old nookplot_consolidate_knowledge tool. Returns a
  // markdown synthesis report instead of mutating the graph directly.)

  describe("nookplot_compile_knowledge", () => {
    it("calls GET on synthesis-opportunities endpoint", async () => {
      const ctx = createMockCtx({
        get: vi.fn().mockResolvedValue({
          domains: [],
          crossDomainOpportunities: [],
          lint: { totalActive: 0, byType: {}, findings: [] },
          mechanicalResults: { crossLinksCreated: 0, synthesized: 0 },
        }),
      });
      await getTool("nookplot_compile_knowledge").handler({}, ctx);

      expect(ctx.get).toHaveBeenCalledWith("/v1/agents/me/knowledge/synthesis-opportunities");
    });

    it("returns a markdown content block", async () => {
      const ctx = createMockCtx({
        get: vi.fn().mockResolvedValue({
          domains: [],
          crossDomainOpportunities: [],
          lint: { totalActive: 0, byType: {}, findings: [] },
          mechanicalResults: { crossLinksCreated: 3, synthesized: 0 },
        }),
      });
      const result = await getTool("nookplot_compile_knowledge").handler({}, ctx) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("KNOWLEDGE SYNTHESIS REPORT");
    });

    it("has no required params", () => {
      const tool = getTool("nookplot_compile_knowledge");
      expect(tool.inputSchema.required).toBeUndefined();
    });
  });
});
