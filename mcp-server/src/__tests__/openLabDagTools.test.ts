/**
 * Open Lab + DAG tools tests — validates handler URL construction,
 * query parameter serialization, and request body construction
 * for the 7 new tools (5 read, 2 write).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readTools } from "../tools/read.js";
import { writeTools } from "../tools/write.js";

// ─── Mock Context Factory ────────────────────────────────────────────────────

function createMockCtx(overrides: Partial<Record<string, any>> = {}) {
  return {
    address: "0xAGENT",
    apiKey: "nk_test_key",
    gatewayUrl: "https://gateway.nookplot.com",
    get: vi.fn().mockResolvedValue({ ok: true }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({ ok: true }),
    patch: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    prepareSignRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    ...overrides,
  } as any;
}

// ─── Tool Lookup ─────────────────────────────────────────────────────────────

function getReadTool(name: string) {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Read tool ${name} not found`);
  return tool;
}

function getWriteTool(name: string) {
  const tool = writeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Write tool ${name} not found`);
  return tool;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Open Lab + DAG Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // READ TOOLS (5)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── nookplot_get_commit_leaves ───────────────────────────────

  describe("nookplot_get_commit_leaves", () => {
    const tool = getReadTool("nookplot_get_commit_leaves");

    it("exists in readTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
    });

    it("calls GET with correct URL and default limit", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project" }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/projects/my-project/commits/leaves?limit=20");
    });

    it("uses custom limit when provided", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project", limit: 5 }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/projects/my-project/commits/leaves?limit=5");
    });

    it("encodes projectId with special characters", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "project with spaces" }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("project%20with%20spaces");
      expect(url).toContain("/commits/leaves?limit=20");
    });
  });

  // ─── nookplot_get_commit_children ─────────────────────────────

  describe("nookplot_get_commit_children", () => {
    const tool = getReadTool("nookplot_get_commit_children");

    it("exists in readTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId and commitId", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
      expect(required).toContain("commitId");
    });

    it("calls GET with correct URL and default limit", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project", commitId: "abc123" }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe(
        "/v1/projects/my-project/commits/abc123/children?limit=20",
      );
    });

    it("uses custom limit when provided", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "my-project", commitId: "abc123", limit: 50 },
        ctx,
      );

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe(
        "/v1/projects/my-project/commits/abc123/children?limit=50",
      );
    });

    it("encodes both projectId and commitId", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "my project", commitId: "commit/ref" },
        ctx,
      );

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("my%20project");
      expect(url).toContain("commit%2Fref");
    });
  });

  // ─── nookplot_get_commit_lineage ──────────────────────────────

  describe("nookplot_get_commit_lineage", () => {
    const tool = getReadTool("nookplot_get_commit_lineage");

    it("exists in readTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId and commitId", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
      expect(required).toContain("commitId");
    });

    it("calls GET with correct URL and default maxDepth", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project", commitId: "abc123" }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe(
        "/v1/projects/my-project/commits/abc123/lineage?maxDepth=50",
      );
    });

    it("uses custom maxDepth when provided", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "my-project", commitId: "abc123", maxDepth: 10 },
        ctx,
      );

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe(
        "/v1/projects/my-project/commits/abc123/lineage?maxDepth=10",
      );
    });

    it("encodes both projectId and commitId", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "test project", commitId: "sha#1" },
        ctx,
      );

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("test%20project");
      expect(url).toContain("sha%231");
    });

    it("has maxDepth property in schema", () => {
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.maxDepth).toBeDefined();
      expect(props.maxDepth.type).toBe("number");
    });
  });

  // ─── nookplot_get_frontiers ───────────────────────────────────

  describe("nookplot_get_frontiers", () => {
    const tool = getReadTool("nookplot_get_frontiers");

    it("exists in readTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("does not require any parameters", () => {
      const required = tool.inputSchema.required as string[] | undefined;
      expect(required).toBeUndefined();
    });

    it("calls GET with correct URL and default limit", async () => {
      const ctx = createMockCtx();
      await tool.handler({}, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/frontiers?limit=20");
    });

    it("uses custom limit when provided", async () => {
      const ctx = createMockCtx();
      await tool.handler({ limit: 100 }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/frontiers?limit=100");
    });

    it("is a network-wide endpoint (no projectId)", () => {
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.projectId).toBeUndefined();
    });
  });

  // ─── nookplot_list_project_notes ──────────────────────────────

  describe("nookplot_list_project_notes", () => {
    const tool = getReadTool("nookplot_list_project_notes");

    it("exists in readTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
    });

    it("calls GET with correct URL and default limit/offset", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "lab-notebook" }, ctx);

      expect(ctx.get).toHaveBeenCalledTimes(1);
      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/projects/lab-notebook/notes?limit=50&offset=0");
    });

    it("uses custom limit and offset", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "lab-notebook", limit: 10, offset: 20 },
        ctx,
      );

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toBe("/v1/projects/lab-notebook/notes?limit=10&offset=20");
    });

    it("defaults offset to 0 when only limit is provided", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "lab-notebook", limit: 5 }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("offset=0");
      expect(url).toContain("limit=5");
    });

    it("encodes projectId with special characters", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my lab" }, ctx);

      const url = ctx.get.mock.calls[0][0] as string;
      expect(url).toContain("my%20lab");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE TOOLS (2)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── nookplot_create_project_note ─────────────────────────────

  describe("nookplot_create_project_note", () => {
    const tool = getWriteTool("nookplot_create_project_note");

    it("exists in writeTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId and text", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
      expect(required).toContain("text");
    });

    it("calls POST with correct URL and body", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "my-project", text: "Found a bug in the tokenizer" },
        ctx,
      );

      expect(ctx.post).toHaveBeenCalledTimes(1);
      expect(ctx.post).toHaveBeenCalledWith(
        "/v1/projects/my-project/notes",
        {
          text: "Found a bug in the tokenizer",
          commitRef: undefined,
        },
      );
    });

    it("includes commitRef when provided", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        {
          projectId: "my-project",
          text: "This commit fixed the issue",
          commitRef: "abc123def",
        },
        ctx,
      );

      expect(ctx.post).toHaveBeenCalledWith(
        "/v1/projects/my-project/notes",
        {
          text: "This commit fixed the issue",
          commitRef: "abc123def",
        },
      );
    });

    it("encodes projectId in URL", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "project with spaces", text: "note text" },
        ctx,
      );

      const url = ctx.post.mock.calls[0][0] as string;
      expect(url).toContain("project%20with%20spaces");
    });

    it("has schema for text with max 2000 chars description", () => {
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.text).toBeDefined();
      expect(props.text.type).toBe("string");
      expect(props.text.description).toContain("2000");
    });

    it("has optional commitRef in schema", () => {
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.commitRef).toBeDefined();
      expect(props.commitRef.type).toBe("string");
      const required = tool.inputSchema.required as string[];
      expect(required).not.toContain("commitRef");
    });
  });

  // ─── nookplot_set_collaboration_mode ──────────────────────────

  describe("nookplot_set_collaboration_mode", () => {
    const tool = getWriteTool("nookplot_set_collaboration_mode");

    it("exists in writeTools with correct category", () => {
      expect(tool).toBeDefined();
      expect(tool.category).toBe("projects");
    });

    it("requires projectId and mode", () => {
      const required = tool.inputSchema.required as string[];
      expect(required).toContain("projectId");
      expect(required).toContain("mode");
    });

    it('calls PATCH with mode "open"', async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project", mode: "open" }, ctx);

      expect(ctx.patch).toHaveBeenCalledTimes(1);
      expect(ctx.patch).toHaveBeenCalledWith(
        "/v1/projects/my-project/collaboration-mode",
        { mode: "open" },
      );
    });

    it('calls PATCH with mode "standard"', async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "my-project", mode: "standard" }, ctx);

      expect(ctx.patch).toHaveBeenCalledWith(
        "/v1/projects/my-project/collaboration-mode",
        { mode: "standard" },
      );
    });

    it("encodes projectId in URL", async () => {
      const ctx = createMockCtx();
      await tool.handler(
        { projectId: "project/with/slashes", mode: "open" },
        ctx,
      );

      const url = ctx.patch.mock.calls[0][0] as string;
      expect(url).toContain("project%2Fwith%2Fslashes");
    });

    it('has enum constraint for mode: ["standard", "open"]', () => {
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.mode.enum).toEqual(["standard", "open"]);
    });

    it("uses PATCH not POST", async () => {
      const ctx = createMockCtx();
      await tool.handler({ projectId: "p1", mode: "open" }, ctx);

      expect(ctx.patch).toHaveBeenCalledTimes(1);
      expect(ctx.post).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-CUTTING CONCERNS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("all 7 tools are registered", () => {
    const expectedNames = [
      "nookplot_get_commit_leaves",
      "nookplot_get_commit_children",
      "nookplot_get_commit_lineage",
      "nookplot_get_frontiers",
      "nookplot_list_project_notes",
      "nookplot_create_project_note",
      "nookplot_set_collaboration_mode",
    ];

    it("all 5 read tools exist", () => {
      const readNames = readTools.map((t) => t.name);
      expect(readNames).toContain("nookplot_get_commit_leaves");
      expect(readNames).toContain("nookplot_get_commit_children");
      expect(readNames).toContain("nookplot_get_commit_lineage");
      expect(readNames).toContain("nookplot_get_frontiers");
      expect(readNames).toContain("nookplot_list_project_notes");
    });

    it("all 2 write tools exist", () => {
      const writeNames = writeTools.map((t) => t.name);
      expect(writeNames).toContain("nookplot_create_project_note");
      expect(writeNames).toContain("nookplot_set_collaboration_mode");
    });

    it("all 7 tools have valid descriptions", () => {
      for (const name of expectedNames) {
        const tool =
          readTools.find((t) => t.name === name) ??
          writeTools.find((t) => t.name === name);
        expect(tool, `${name} should exist`).toBeDefined();
        expect(tool!.description.length).toBeGreaterThan(10);
      }
    });

    it("all 7 tools have handler functions", () => {
      for (const name of expectedNames) {
        const tool =
          readTools.find((t) => t.name === name) ??
          writeTools.find((t) => t.name === name);
        expect(typeof tool!.handler).toBe("function");
      }
    });

    it("all 7 tools have projects category", () => {
      for (const name of expectedNames) {
        const tool =
          readTools.find((t) => t.name === name) ??
          writeTools.find((t) => t.name === name);
        expect(tool!.category).toBe("projects");
      }
    });
  });
});
