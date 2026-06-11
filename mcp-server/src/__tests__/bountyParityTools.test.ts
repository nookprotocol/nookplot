/**
 * MCP tool parity tests for `nookplot_list_bounty_applications`,
 * `nookplot_list_bounty_submissions`, and `nookplot_approve_bounty_application`
 * — added to close the reverse gaps surfaced by the bounty MCP↔CLI audit.
 *
 * These tools are thin dispatch over gateway endpoints; tests assert the
 * REQUEST shape (method + path + body), not the response handling.
 */

import { describe, it, expect, vi } from "vitest";
import { readTools } from "../tools/read.js";
import { writeTools } from "../tools/write.js";
import type { ToolContext } from "../tools/index.js";

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    address: "0xCreator000000000000000000000000000000000",
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

function readTool(name: string) {
  const t = readTools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not in readTools`);
  return t;
}

function writeTool(name: string) {
  const t = writeTools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not in writeTools`);
  return t;
}

describe("nookplot_list_bounty_applications", () => {
  const tool = readTool("nookplot_list_bounty_applications");

  it("is in the bounties category and requires bountyId", () => {
    expect(tool.category).toBe("bounties");
    expect(tool.inputSchema.required).toEqual(["bountyId"]);
  });

  it("GETs /v1/bounties/:id/applications with default paging", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "42" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/bounties/42/applications?first=20&skip=0");
  });

  it("forwards --first and --skip with clamping", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "42", first: 500, skip: 10 }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/bounties/42/applications?first=100&skip=10");
  });

  it("clamps first below 1 to 1", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "42", first: 0 }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/bounties/42/applications?first=20&skip=0");
  });
});

describe("nookplot_list_bounty_submissions", () => {
  const tool = readTool("nookplot_list_bounty_submissions");

  it("is in the bounties category and requires bountyId", () => {
    expect(tool.category).toBe("bounties");
    expect(tool.inputSchema.required).toEqual(["bountyId"]);
  });

  it("GETs /v1/bounties/:id/submissions with default paging", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "7" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/bounties/7/submissions?first=20&skip=0");
  });

  it("forwards --first / --skip with clamp", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "7", first: 50, skip: 5 }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/bounties/7/submissions?first=50&skip=5");
  });
});

describe("nookplot_approve_bounty_application", () => {
  const tool = writeTool("nookplot_approve_bounty_application");

  it("is in the bounties category and requires bountyId + applicationId", () => {
    expect(tool.category).toBe("bounties");
    expect(tool.inputSchema.required).toEqual(["bountyId", "applicationId"]);
  });

  it("POSTs /v1/bounties/:id/applications/:appId/approve with empty body", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "12", applicationId: "app-uuid-1" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/bounties/12/applications/app-uuid-1/approve",
      {},
    );
  });

  it("accepts the alias `id` for applicationId", async () => {
    const ctx = createMockCtx();
    await tool.handler({ bountyId: "12", id: "app-uuid-1" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/bounties/12/applications/app-uuid-1/approve",
      {},
    );
  });

  it("throws if applicationId is missing", async () => {
    const ctx = createMockCtx();
    await expect(tool.handler({ bountyId: "12" }, ctx)).rejects.toThrow(/applicationId/i);
  });
});
