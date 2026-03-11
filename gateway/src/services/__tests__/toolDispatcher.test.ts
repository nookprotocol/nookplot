/**
 * Tests for ToolDispatcher — unified tool dispatch using MCP handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolDispatcher } from "../toolDispatcher.js";
import type { ToolDef, ToolContext } from "@nookplot/mcp/tools";

// Helper: build a minimal ToolDef
function makeTool(
  name: string,
  handler: ToolDef["handler"],
  category = "discovery",
): ToolDef {
  return {
    name,
    description: `Test tool: ${name}`,
    category: category as ToolDef["category"],
    inputSchema: { type: "object", properties: {} },
    handler,
  };
}

describe("ToolDispatcher", () => {
  let dispatcher: ToolDispatcher;
  let toolMap: Map<string, ToolDef>;

  beforeEach(() => {
    toolMap = new Map();
    dispatcher = new ToolDispatcher(toolMap, 4022);
  });

  // ---- Core dispatch ----

  it("returns error for unknown tool", async () => {
    const result = await dispatcher.dispatch(
      "nookplot_nonexistent",
      {},
      "0xABC",
      "test-key",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Unknown tool");
    }
  });

  it("returns client_side_required for approve_token", async () => {
    const result = await dispatcher.dispatch(
      "nookplot_approve_token",
      { tokenAddress: "0x123", spenderAddress: "0x456", amount: "max" },
      "0xABC",
      "test-key",
    );
    expect(result.status).toBe("client_side_required");
    if (result.status === "client_side_required") {
      expect(result.action).toBe("nookplot_approve_token");
      expect(result.params.tokenAddress).toBe("0x123");
    }
  });

  it("returns client_side_required for install_skill", async () => {
    const result = await dispatcher.dispatch(
      "nookplot_install_skill",
      { skillId: "abc-123" },
      "0xABC",
      "test-key",
    );
    expect(result.status).toBe("client_side_required");
    if (result.status === "client_side_required") {
      expect(result.action).toBe("nookplot_install_skill");
    }
  });

  it("dispatches a simple GET tool and returns completed", async () => {
    const mockResult = { posts: [{ title: "Hello" }] };
    const handler = vi.fn(async (_args: Record<string, unknown>, ctx: ToolContext) => {
      return ctx.get("/v1/index/feed?limit=10");
    });

    toolMap.set("nookplot_read_feed", makeTool("nookplot_read_feed", handler));

    // Mock fetch globally for the internal HTTP call
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );

    const result = await dispatcher.dispatch(
      "nookplot_read_feed",
      { limit: 10 },
      "0xABC",
      "test-api-key",
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toEqual(mockResult);
    }

    // Verify internal call went to localhost:4022
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:4022/v1/index/feed?limit=10",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-key",
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("dispatches a POST tool and returns completed", async () => {
    const mockResult = { id: "msg-1", status: "sent" };
    const handler = vi.fn(async (args: Record<string, unknown>, ctx: ToolContext) => {
      return ctx.post("/v1/inbox/send", { to: args.to, content: args.content });
    });

    toolMap.set("nookplot_send_message", makeTool("nookplot_send_message", handler, "messaging"));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );

    const result = await dispatcher.dispatch(
      "nookplot_send_message",
      { to: "0xDEF", content: "Hello!" },
      "0xABC",
      "test-api-key",
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toEqual(mockResult);
    }

    // Verify POST body was sent
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:4022/v1/inbox/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ to: "0xDEF", content: "Hello!" }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("dispatches on-chain tool and returns sign_required", async () => {
    const prepareResult = {
      forwardRequest: { from: "0xABC", to: "0x123", data: "0x..." },
      domain: { name: "Nookplot" },
      types: { ForwardRequest: [] },
    };

    const handler = vi.fn(async (args: Record<string, unknown>, ctx: ToolContext) => {
      return ctx.prepareSignRelay("/v1/prepare/vote", {
        contentCid: args.contentCid,
        isUpvote: args.isUpvote,
      });
    });

    toolMap.set("nookplot_vote", makeTool("nookplot_vote", handler, "social"));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(prepareResult), { status: 200 }),
    );

    const result = await dispatcher.dispatch(
      "nookplot_vote",
      { contentCid: "bafk...", isUpvote: true },
      "0xABC",
      "test-api-key",
    );

    expect(result.status).toBe("sign_required");
    if (result.status === "sign_required") {
      expect(result.forwardRequest).toEqual(prepareResult.forwardRequest);
      expect(result.domain).toEqual(prepareResult.domain);
      expect(result.types).toEqual(prepareResult.types);
      expect(result.preparePath).toBe("/v1/prepare/vote");
    }

    fetchSpy.mockRestore();
  });

  it("returns error when handler throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("Something broke");
    });

    toolMap.set("nookplot_broken_tool", makeTool("nookplot_broken_tool", handler));

    const result = await dispatcher.dispatch(
      "nookplot_broken_tool",
      {},
      "0xABC",
      "test-key",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("Something broke");
    }
  });

  it("returns error when internal HTTP call fails", async () => {
    const handler = vi.fn(async (_args: Record<string, unknown>, ctx: ToolContext) => {
      return ctx.get("/v1/some-endpoint");
    });

    toolMap.set("nookplot_failing_tool", makeTool("nookplot_failing_tool", handler));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const result = await dispatcher.dispatch(
      "nookplot_failing_tool",
      {},
      "0xABC",
      "test-key",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("Not found");
    }

    fetchSpy.mockRestore();
  });

  // ---- Tool listing ----

  it("lists all tools without handlers", () => {
    toolMap.set("nookplot_a", makeTool("nookplot_a", vi.fn(), "discovery"));
    toolMap.set("nookplot_b", makeTool("nookplot_b", vi.fn(), "messaging"));
    toolMap.set("nookplot_c", makeTool("nookplot_c", vi.fn(), "discovery"));

    const all = dispatcher.listTools();
    expect(all).toHaveLength(3);
    expect(all[0]).not.toHaveProperty("handler");
    expect(all.map((t) => t.name)).toEqual(["nookplot_a", "nookplot_b", "nookplot_c"]);
  });

  it("filters tools by category", () => {
    toolMap.set("nookplot_a", makeTool("nookplot_a", vi.fn(), "discovery"));
    toolMap.set("nookplot_b", makeTool("nookplot_b", vi.fn(), "messaging"));

    const discovery = dispatcher.listTools("discovery");
    expect(discovery).toHaveLength(1);
    expect(discovery[0].name).toBe("nookplot_a");
  });

  // ---- Metadata ----

  it("reports correct size", () => {
    toolMap.set("nookplot_a", makeTool("nookplot_a", vi.fn()));
    toolMap.set("nookplot_b", makeTool("nookplot_b", vi.fn()));
    expect(dispatcher.size).toBe(2);
  });

  it("checks tool existence", () => {
    toolMap.set("nookplot_a", makeTool("nookplot_a", vi.fn()));
    expect(dispatcher.has("nookplot_a")).toBe(true);
    expect(dispatcher.has("nookplot_b")).toBe(false);
  });

  it("returns tool names", () => {
    toolMap.set("nookplot_a", makeTool("nookplot_a", vi.fn()));
    toolMap.set("nookplot_b", makeTool("nookplot_b", vi.fn()));
    expect(dispatcher.getToolNames()).toEqual(["nookplot_a", "nookplot_b"]);
  });
});
