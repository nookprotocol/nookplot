/**
 * Clarification primitive — MCP tool dispatch tests.
 *
 * Mirrors the captures.test.ts pattern: focus on the thin tool-dispatch
 * layer (correct endpoint paths, body shape, query-param handling) and
 * defer service-level validation to server-side tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { clarificationTools } from "../tools/clarifications.js";
import type { ToolContext } from "../tools/index.js";
import { ALL_CATEGORIES } from "../tools/index.js";

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    address: "0xRequester0000000000000000000000000000000",
    apiKey: "nk_test_key",
    gatewayUrl: "https://gateway.nookplot.com",
    scopedAgentAddress: undefined,
    get: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    post: vi.fn().mockResolvedValue({ id: "clr_1", status: "open" }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    prepareSignRelay: vi.fn(),
    preparePermitStakeRelay: vi.fn(),
    prepareSignSend: vi.fn(),
    ...overrides,
  } as ToolContext;
}

function getTool(name: string) {
  const tool = clarificationTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not in clarificationTools`);
  return tool;
}

describe("clarification tools — registration", () => {
  it("exports five tools with the clarification category", () => {
    expect(clarificationTools).toHaveLength(5);
    for (const tool of clarificationTools) {
      expect(tool.category).toBe("clarification");
      expect(tool.name).toMatch(/^nookplot_/);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("registers 'clarification' in ALL_CATEGORIES so browse_tools can list it", () => {
    // Regression: the runtime ALL_CATEGORIES array must include every category
    // that any tool actually uses. Without this, browse_tools won't surface
    // the clarification primitive for discovery.
    expect(ALL_CATEGORIES).toContain("clarification");
  });

  it("each tool has the required arg keys declared", () => {
    expect(getTool("nookplot_request_clarification").inputSchema).toMatchObject({
      required: ["context"],
    });
    expect(getTool("nookplot_offer_clarification").inputSchema).toMatchObject({
      required: ["requestId", "responseText"],
    });
    expect(getTool("nookplot_resolve_clarification").inputSchema).toMatchObject({
      required: ["requestId", "offerId", "quality"],
    });
    expect(getTool("nookplot_cancel_clarification").inputSchema).toMatchObject({
      required: ["requestId"],
    });
  });
});

describe("nookplot_request_clarification", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("POSTs to /v1/clarifications/request with addressed body", async () => {
    const tool = getTool("nookplot_request_clarification");
    await tool.handler(
      {
        targetId: "agt_target",
        context: "Need to know how X behaves",
        contextRef: { type: "artifact", id: "art_1" },
        deadline: "2026-04-30T00:00:00Z",
      },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith("/v1/clarifications/request", {
      targetId: "agt_target",
      context: "Need to know how X behaves",
      contextRef: { type: "artifact", id: "art_1" },
      deadline: "2026-04-30T00:00:00Z",
    });
  });

  it("forwards undefined targetId for broadcast", async () => {
    const tool = getTool("nookplot_request_clarification");
    await tool.handler(
      { context: "Broadcast clarification need", contextRef: { type: "agreement", id: "ag_7" } },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/clarifications/request",
      expect.objectContaining({ targetId: undefined }),
    );
  });
});

describe("nookplot_offer_clarification", () => {
  it("POSTs to /v1/clarifications/:id/offer with URL-encoded id", async () => {
    const ctx = createMockCtx();
    const tool = getTool("nookplot_offer_clarification");
    await tool.handler(
      { requestId: "clr 1", responseText: "answer", metadata: { source: "kg" } },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/clarifications/clr%201/offer",
      { responseText: "answer", metadata: { source: "kg" } },
    );
  });
});

describe("nookplot_resolve_clarification", () => {
  it("POSTs to /v1/clarifications/:id/resolve with offer + quality", async () => {
    const ctx = createMockCtx();
    const tool = getTool("nookplot_resolve_clarification");
    await tool.handler(
      { requestId: "clr_1", offerId: "off_1", quality: "useful" },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/clarifications/clr_1/resolve",
      { offerId: "off_1", quality: "useful" },
    );
  });
});

describe("nookplot_cancel_clarification", () => {
  it("POSTs to /v1/clarifications/:id/cancel", async () => {
    const ctx = createMockCtx();
    const tool = getTool("nookplot_cancel_clarification");
    await tool.handler({ requestId: "clr_1" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/clarifications/clr_1/cancel", {});
  });
});

describe("nookplot_browse_clarification_needs", () => {
  it("uses the 'me' sentinel for targetingMe — NOT ctx.address", async () => {
    // Regression for the bug where ctx.address (wallet hex) was passed as
    // targetId, but agent_clarification_requests.target_id is a UUID. The
    // gateway resolves "me" → agent.id server-side.
    const ctx = createMockCtx();
    const tool = getTool("nookplot_browse_clarification_needs");
    await tool.handler({ targetingMe: true }, ctx);
    const calledWith = (ctx.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledWith).toContain("targetId=me");
    expect(calledWith).not.toContain(ctx.address);
  });

  it("filters broadcastOnly client-side after fetching", async () => {
    const ctx = createMockCtx({
      get: vi.fn().mockResolvedValue({
        items: [
          { id: "broadcast", target_id: null },
          { id: "addressed", target_id: "agt_other" },
        ],
        total: 2,
      }),
    });
    const tool = getTool("nookplot_browse_clarification_needs");
    const result = (await tool.handler(
      { broadcastOnly: true },
      ctx,
    )) as { items: Array<{ id: string }>; total: number };
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("broadcast");
    expect(result.total).toBe(1);
  });

  it("forwards maxAgeHours and limit query params", async () => {
    const ctx = createMockCtx();
    const tool = getTool("nookplot_browse_clarification_needs");
    await tool.handler({ maxAgeHours: 6, limit: 10 }, ctx);
    const calledWith = (ctx.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledWith).toContain("ageHours=6");
    expect(calledWith).toContain("limit=10");
    expect(calledWith).toContain("status=open");
  });
});
