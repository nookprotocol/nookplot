/**
 * MCP tool tests.
 *
 * Covers the dispatch layer for `nookplot_apply_insight` post-extension:
 *   - Tool registration shape (name, category, required-args)
 *   - POST endpoint + body shape against the apply-insight route
 *   - `outcome` enum → numeric `outcomeScore` translation
 *   - Legacy `application` arg falls back to `context`
 *   - `builtOn` pass-through (consumed server-side; tool ships now)
 *
 * Deliberately no mocking of the network response shape — anti-abuse
 * gates are validated server-side. These
 * tests assert only the REQUEST.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeTools } from "../tools/write.js";
import type { ToolContext } from "../tools/index.js";

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    address: "0xCaller00000000000000000000000000000000000",
    apiKey: "nk_test_key",
    gatewayUrl: "https://gateway.nookplot.com",
    scopedAgentAddress: undefined,
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ application: { id: "app-uuid-1" } }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    prepareSignRelay: vi.fn(),
    preparePermitStakeRelay: vi.fn(),
  } as ToolContext;
}

function getTool(name: string) {
  const tool = writeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not in writeTools`);
  return tool;
}

const INSIGHT_ID = "5d4f1c8e-1234-4567-8901-abcdefabcdef";
const SUBSTANTIVE_CONTEXT =
  "Applied the verification heuristic to my own submission; matched on 4/5 dimensions and pushed the rejection through quorum.";

// ---------------------------------------------------------------------------
//  Registration
// ---------------------------------------------------------------------------

describe("nookplot_apply_insight registration", () => {
  it("is exported from writeTools", () => {
    expect(writeTools.find((t) => t.name === "nookplot_apply_insight")).toBeDefined();
  });

  it("lives in the 'tools' category", () => {
    expect(getTool("nookplot_apply_insight").category).toBe("tools");
  });

  it("requires only insightId (everything else optional)", () => {
    expect(getTool("nookplot_apply_insight").inputSchema.required).toEqual(["insightId"]);
  });

  it("declares the arg surface: context, outcomeScore, outcome, builtOn, plus legacy application", () => {
    const props = getTool("nookplot_apply_insight").inputSchema.properties ?? {};
    // All five optional args must be declared so the codegen surfaces them in
    // the runtime/python catalogs + tool-manifest.json.
    expect(Object.keys(props).sort()).toEqual(
      ["application", "builtOn", "context", "insightId", "outcome", "outcomeScore"].sort(),
    );
  });

  it("`outcome` is an enum restricted to success/failure/partial", () => {
    const props = getTool("nookplot_apply_insight").inputSchema.properties as Record<string, any>;
    expect(props.outcome.enum).toEqual(["success", "failure", "partial"]);
  });
});

// ---------------------------------------------------------------------------
//  Dispatch shape
// ---------------------------------------------------------------------------

describe("nookplot_apply_insight dispatch", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("POSTs to /v1/insights/:id/apply with insightId path-encoded", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ insightId: INSIGHT_ID }, ctx);

    expect(ctx.post).toHaveBeenCalledWith(
      `/v1/insights/${INSIGHT_ID}/apply`,
      expect.any(Object),
    );
  });

  it("bare-minimum call (insightId only) sends no context/outcome — provenance ping that skips the gate", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ insightId: INSIGHT_ID }, ctx);

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.context).toBeUndefined();
    expect(body.outcomeScore).toBeUndefined();
    expect(body.builtOn).toBeUndefined();
  });

  it("throws when insightId is missing (matches the existing nookplot_cite_insight shape)", async () => {
    const tool = getTool("nookplot_apply_insight");
    await expect(tool.handler({}, ctx)).rejects.toThrow(/insightId is required/);
  });

  it("accepts `id` as a fallback for insightId (pre-existing alias)", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ id: INSIGHT_ID }, ctx);

    const [path] = (ctx.post as any).mock.calls[0];
    expect(path).toBe(`/v1/insights/${INSIGHT_ID}/apply`);
  });
});

// ---------------------------------------------------------------------------
//  context / application aliasing (route rename backward-compat)
// ---------------------------------------------------------------------------

describe("nookplot_apply_insight context resolution", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("forwards explicit `context` to the gateway body field of the same name", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT }, ctx);

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.context).toBe(SUBSTANTIVE_CONTEXT);
  });

  it("falls back to legacy `application` when `context` is unset (back-compat for older LLMs)", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ insightId: INSIGHT_ID, application: SUBSTANTIVE_CONTEXT }, ctx);

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.context).toBe(SUBSTANTIVE_CONTEXT);
  });

  it("`context` wins when both are supplied", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      { insightId: INSIGHT_ID, context: "primary", application: "secondary" },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.context).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
//  outcomeScore + outcome enum
// ---------------------------------------------------------------------------

describe("nookplot_apply_insight outcome translation", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("forwards numeric `outcomeScore` untouched", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler({ insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT, outcomeScore: 0.75 }, ctx);

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.outcomeScore).toBe(0.75);
  });

  it.each([
    ["success", 1.0],
    ["failure", 0.0],
    ["partial", 0.5],
  ])("maps outcome=%s → outcomeScore=%s", async (outcome, expected) => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      { insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT, outcome },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.outcomeScore).toBe(expected);
  });

  it("explicit `outcomeScore` wins over `outcome` enum when both supplied", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      {
        insightId: INSIGHT_ID,
        context: SUBSTANTIVE_CONTEXT,
        outcomeScore: 0.42,
        outcome: "success",
      },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.outcomeScore).toBe(0.42);
  });

  it("unknown `outcome` value falls through with outcomeScore undefined (no silent default)", async () => {
    // We never want to invent a score the caller didn't ask for. Better to send
    // nothing (skip the gate, no insight_attempts row) than to silently coerce
    // to 0 or 0.5 and trigger the manual-attempt path.
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      { insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT, outcome: "maybe" },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.outcomeScore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  builtOn pass-through (declared-citation forward-compat)
// ---------------------------------------------------------------------------

describe("nookplot_apply_insight builtOn pass-through", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("forwards builtOn=true so the gateway can create a declared-edge", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      { insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT, builtOn: true },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.builtOn).toBe(true);
  });

  it("forwards builtOn=false (explicit denial — different from omitted)", async () => {
    const tool = getTool("nookplot_apply_insight");
    await tool.handler(
      { insightId: INSIGHT_ID, context: SUBSTANTIVE_CONTEXT, builtOn: false },
      ctx,
    );

    const body = (ctx.post as any).mock.calls[0][1];
    expect(body.builtOn).toBe(false);
  });
});
