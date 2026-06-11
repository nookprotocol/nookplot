/**
 * typed-feedback read tools.
 *
 * Covers the 3 verdict read tools added to `tools/read.ts`:
 *   - nookplot_get_verdict_summary
 *   - nookplot_get_recent_verdicts
 *   - nookplot_get_bounty_verdict
 *
 * Asserts registration shape + request URL composition. Server-side behavior
 * is covered separately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readTools } from "../tools/read.js";
import type { ToolContext } from "../tools/index.js";

const CALLER = "0xCaller0000000000000000000000000000000000";

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    address: CALLER,
    apiKey: "nk_test_key",
    gatewayUrl: "https://gateway.nookplot.com",
    scopedAgentAddress: undefined,
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    prepareSignRelay: vi.fn(),
    preparePermitStakeRelay: vi.fn(),
    ...overrides,
  } as ToolContext;
}

function getTool(name: string) {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not in readTools`);
  return tool;
}

describe("verdict read tools — registration", () => {
  it("registers all three verdict tools under the 'bounties' category", () => {
    for (const name of [
      "nookplot_get_verdict_summary",
      "nookplot_get_recent_verdicts",
      "nookplot_get_bounty_verdict",
    ]) {
      const tool = getTool(name);
      expect(tool.category).toBe("bounties");
    }
  });

  it("get_bounty_verdict requires bountyId; the two agent-scoped tools do not", () => {
    expect(
      (getTool("nookplot_get_bounty_verdict").inputSchema as { required?: string[] }).required,
    ).toEqual(["bountyId"]);
    expect(
      (getTool("nookplot_get_verdict_summary").inputSchema as { required?: string[] }).required ?? [],
    ).toEqual([]);
    expect(
      (getTool("nookplot_get_recent_verdicts").inputSchema as { required?: string[] }).required ?? [],
    ).toEqual([]);
  });
});

describe("nookplot_get_verdict_summary", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = createMockCtx();
  });

  it("defaults to the calling agent when address is omitted", async () => {
    await getTool("nookplot_get_verdict_summary").handler({}, ctx);
    expect(ctx.get).toHaveBeenCalledWith(`/v1/agents/${CALLER}/verdict-summary`);
  });

  it("uses the provided address when supplied", async () => {
    const worker = "0xWorker0000000000000000000000000000000000";
    await getTool("nookplot_get_verdict_summary").handler({ address: worker }, ctx);
    expect(ctx.get).toHaveBeenCalledWith(`/v1/agents/${worker}/verdict-summary`);
  });

  it("composes contractType + sinceDays as query params", async () => {
    await getTool("nookplot_get_verdict_summary").handler(
      { contractType: "bounty", sinceDays: 30 },
      ctx,
    );
    expect(ctx.get).toHaveBeenCalledWith(
      `/v1/agents/${CALLER}/verdict-summary?contractType=bounty&sinceDays=30`,
    );
  });
});

describe("nookplot_get_recent_verdicts", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = createMockCtx();
  });

  it("always sets includeList=true so the gateway returns the underlying rows", async () => {
    await getTool("nookplot_get_recent_verdicts").handler({}, ctx);
    const url = (ctx.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("includeList=true");
  });

  it("caps limit at 200 even when caller asks for more", async () => {
    await getTool("nookplot_get_recent_verdicts").handler({ limit: 5000 }, ctx);
    const url = (ctx.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("listLimit=200");
  });

  it("uses the provided limit when under the cap", async () => {
    await getTool("nookplot_get_recent_verdicts").handler({ limit: 25 }, ctx);
    const url = (ctx.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("listLimit=25");
  });

  it("falls back to the caller address when none is supplied", async () => {
    await getTool("nookplot_get_recent_verdicts").handler({}, ctx);
    const url = (ctx.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain(`/v1/agents/${CALLER}/verdict-summary`);
  });
});

describe("nookplot_get_bounty_verdict", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = createMockCtx();
  });

  it("defaults contractType to 'bounty'", async () => {
    await getTool("nookplot_get_bounty_verdict").handler({ bountyId: 42 }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/index/verdicts/bounty/42");
  });

  it("supports the marketplace contract type for agreements", async () => {
    await getTool("nookplot_get_bounty_verdict").handler(
      { bountyId: 7, contractType: "marketplace" },
      ctx,
    );
    expect(ctx.get).toHaveBeenCalledWith("/v1/index/verdicts/marketplace/7");
  });
});
