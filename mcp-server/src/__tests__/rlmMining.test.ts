/**
 * RLM mining MCP tool tests.
 *
 * Covers the thin dispatch layer for the 3 solver-facing tools introduced in
 * `rlmMining.ts`:
 *
 *   - nookplot_discover_rlm     (list / fetch by id)
 *   - nookplot_open_rlm_session (POST /v1/workspaces/rlm)
 *   - nookplot_submit_rlm       (POST /repl/finalize, then return next-step note
 *                               until the /submit-solution polymorphic
 *                               handler ships)
 *
 * Tests assert:
 *   - Tool registration shape (count, names, category, required args).
 *   - Endpoint + body shape for every ctx.get / ctx.post call.
 *   - Query-string composition for the discover browse mode (filters omitted
 *     when undefined, encoded when present).
 *   - Detail-mode dispatch when challengeId is set.
 *
 * Mirrors the captures.test.ts pattern: NO mocking of network responses — we
 * assert the REQUEST shape only. Server-side behavior is covered separately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rlmMiningTools } from "../tools/rlmMining.js";
import type { ToolContext } from "../tools/index.js";

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

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

function getTool(name: string) {
  const tool = rlmMiningTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not in rlmMiningTools`);
  return tool;
}

// ---------------------------------------------------------------------------
//  Registration
// ---------------------------------------------------------------------------

describe("rlmMiningTools registration", () => {
  it("exports exactly 8 tools", () => {
    expect(rlmMiningTools).toHaveLength(8);
  });

  it("names match the documented tool spec", () => {
    const names = rlmMiningTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "nookplot_discover_rlm",
      "nookplot_open_rlm_session",
      "nookplot_rlm_invite_collaborator",
      "nookplot_rlm_provider_poll",
      "nookplot_rlm_repl_exec",
      "nookplot_rlm_repl_finalize",
      "nookplot_rlm_repl_llm_query",
      "nookplot_submit_rlm",
    ]);
  });

  it("all tools are in the 'coordination' category", () => {
    // Gates the signal_action_map propagation through `mining_opportunity` —
    // signalActionMap.ts:181 expects coordination-category dispatch.
    for (const tool of rlmMiningTools) {
      expect(tool.category).toBe("coordination");
    }
  });

  it("discover_rlm has no required args (browse mode is default)", () => {
    const tool = getTool("nookplot_discover_rlm");
    expect((tool.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  it("open_rlm_session requires challengeId", () => {
    const tool = getTool("nookplot_open_rlm_session");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(["challengeId"]);
  });

  it("submit_rlm requires challengeId + workspaceId + finalAnswer + reasoning", () => {
    const tool = getTool("nookplot_submit_rlm");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual([
      "challengeId",
      "workspaceId",
      "finalAnswer",
      "reasoning",
    ]);
  });

  // Regression: missing `type` on finalAnswer caused MCP clients to
  // coerce JSON-object inputs to JSON-strings on the wire, so the
  // gateway's `structured_answer` / `exact_answer` scorer saw a
  // string when an object/number was expected. Schema must allow the
  // full set of JSON value types.
  it("submit_rlm finalAnswer schema accepts every JSON value type", () => {
    const tool = getTool("nookplot_submit_rlm");
    const props = (tool.inputSchema as { properties: Record<string, { type?: unknown }> })
      .properties;
    const type = props.finalAnswer.type;
    expect(Array.isArray(type)).toBe(true);
    expect(new Set(type as string[])).toEqual(
      new Set(["string", "number", "boolean", "object", "array"]),
    );
  });

  it("rlm_repl_finalize finalAnswer schema accepts every JSON value type", () => {
    const tool = getTool("nookplot_rlm_repl_finalize");
    const props = (tool.inputSchema as { properties: Record<string, { type?: unknown }> })
      .properties;
    const type = props.finalAnswer.type;
    expect(Array.isArray(type)).toBe(true);
    expect(new Set(type as string[])).toEqual(
      new Set(["string", "number", "boolean", "object", "array"]),
    );
  });
});

// ---------------------------------------------------------------------------
//  nookplot_discover_rlm
// ---------------------------------------------------------------------------

describe("nookplot_discover_rlm — browse mode", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("GETs /v1/mining/rlm-challenges with no querystring when no filters set", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({}, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges");
  });

  it("appends difficulty filter as querystring param", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ difficulty: "medium" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges?difficulty=medium");
  });

  it("appends domain filter", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ domain: "biology" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges?domain=biology");
  });

  it("composes multiple filters in a deterministic order", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler(
      {
        difficulty: "medium",
        domain: "biology",
        minCorpusSize: 10000,
        maxCorpusSize: 5_000_000,
        limit: 25,
      },
      ctx,
    );
    // URLSearchParams.toString() preserves insertion order — the handler
    // appends in: difficulty, domain, minCorpusSize, maxCorpusSize, limit.
    expect(ctx.get).toHaveBeenCalledWith(
      "/v1/mining/rlm-challenges?difficulty=medium&domain=biology&minCorpusSize=10000&maxCorpusSize=5000000&limit=25",
    );
  });

  it("omits filters whose values are undefined (no spurious empty params)", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ difficulty: "easy", domain: undefined, limit: undefined }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges?difficulty=easy");
  });

  it("URL-encodes domain values containing spaces / special chars", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ domain: "machine learning & AI" }, ctx);
    // URLSearchParams encodes space as '+' and '&' as '%26'.
    expect(ctx.get).toHaveBeenCalledWith(
      "/v1/mining/rlm-challenges?domain=machine+learning+%26+AI",
    );
  });

  it("ignores non-string challengeId (browse mode), keeps using filters", async () => {
    // The handler guards on `typeof args.challengeId === "string"` AND
    // length > 0 — defensive against a caller passing { challengeId: null }.
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ challengeId: undefined as unknown as string }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges");
  });
});

describe("nookplot_discover_rlm — detail mode", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("GETs /v1/mining/rlm-challenges/:id when challengeId is a non-empty string", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ challengeId: "abc-123-uuid" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges/abc-123-uuid");
  });

  it("URL-encodes the challengeId path segment", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ challengeId: "weird id/with slashes" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith(
      "/v1/mining/rlm-challenges/weird%20id%2Fwith%20slashes",
    );
  });

  it("ignores filter args when in detail mode", async () => {
    // Detail mode short-circuits before the querystring is built, so filters
    // are silently dropped — agents shouldn't expect them to compose.
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler(
      { challengeId: "uuid-1", difficulty: "easy", domain: "biology" },
      ctx,
    );
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges/uuid-1");
    expect(ctx.get).toHaveBeenCalledTimes(1);
  });

  it("treats empty-string challengeId as browse mode (not a 404'ing detail call)", async () => {
    const tool = getTool("nookplot_discover_rlm");
    await tool.handler({ challengeId: "" }, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-challenges");
  });
});

// ---------------------------------------------------------------------------
//  nookplot_open_rlm_session
// ---------------------------------------------------------------------------

describe("nookplot_open_rlm_session", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("POSTs to /v1/workspaces/rlm with challengeId", async () => {
    const tool = getTool("nookplot_open_rlm_session");
    await tool.handler({ challengeId: "uuid-xyz" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/workspaces/rlm", {
      challengeId: "uuid-xyz",
      baseModel: undefined,
    });
  });

  it("forwards baseModel disclosure when supplied", async () => {
    const tool = getTool("nookplot_open_rlm_session");
    await tool.handler(
      { challengeId: "uuid-xyz", baseModel: "claude-opus-4-7" },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith("/v1/workspaces/rlm", {
      challengeId: "uuid-xyz",
      baseModel: "claude-opus-4-7",
    });
  });

  it("returns the gateway response shape unmodified", async () => {
    const expected = {
      workspaceId: "ws-uuid-1",
      replEndpoint: "/v1/workspaces/ws-uuid-1/repl",
      trajectoryId: "traj-uuid-1",
    };
    ctx = createMockCtx({ post: vi.fn().mockResolvedValue(expected) });
    const tool = getTool("nookplot_open_rlm_session");
    const result = await tool.handler({ challengeId: "uuid-xyz" }, ctx);
    expect(result).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
//  nookplot_submit_rlm
// ---------------------------------------------------------------------------

describe("nookplot_submit_rlm", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = createMockCtx({
      post: vi.fn().mockResolvedValue({
        archived: true,
        finalActivityId: "act-uuid-1",
      }),
    });
  });

  it("POSTs to /v1/workspaces/:id/repl/finalize with the final answer", async () => {
    const tool = getTool("nookplot_submit_rlm");
    await tool.handler(
      { workspaceId: "ws-uuid-1", finalAnswer: { answer: "42" } },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/ws-uuid-1/repl/finalize",
      { finalAnswer: { answer: "42" } },
    );
  });

  it("URL-encodes the workspaceId path segment", async () => {
    const tool = getTool("nookplot_submit_rlm");
    await tool.handler(
      { workspaceId: "ws/with weird id", finalAnswer: { x: 1 } },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/ws%2Fwith%20weird%20id/repl/finalize",
      { finalAnswer: { x: 1 } },
    );
  });

  it("accepts string final answers", async () => {
    // The challenge eval protocol may declare a string answer (e.g. exact_answer-
    // shaped trajectories). The tool must not coerce/wrap.
    const tool = getTool("nookplot_submit_rlm");
    await tool.handler(
      { workspaceId: "ws-uuid-1", finalAnswer: "the answer" },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/ws-uuid-1/repl/finalize",
      { finalAnswer: "the answer" },
    );
  });

  it("returns both finalize and submission results from the two-step flow", async () => {
    // The polymorphic submit-solution handler; the tool now
    // chains /repl/finalize → /submit-solution and returns BOTH responses
    // so callers can introspect the structural verifier outcome.
    const tool = getTool("nookplot_submit_rlm");
    const result = (await tool.handler(
      {
        challengeId: "ch-uuid-1",
        workspaceId: "ws-uuid-1",
        finalAnswer: { answer: "42" },
        reasoning: "Sliced corpus into 4 chunks, summarized each, then synthesized.",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      finalize: expect.objectContaining({ archived: true, finalActivityId: "act-uuid-1" }),
      submission: expect.any(Object),
    });
    expect(ctx.post).toHaveBeenCalledTimes(2);
    expect(ctx.post).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/ws-uuid-1/repl/finalize",
      { finalAnswer: { answer: "42" } },
    );
    expect(ctx.post).toHaveBeenNthCalledWith(
      2,
      "/v1/mining/challenges/ch-uuid-1/submit-solution",
      expect.objectContaining({
        artifactType: "rlm_trajectory_json",
        artifact: expect.objectContaining({
          workspace_id: "ws-uuid-1",
          final_answer: { answer: "42" },
        }),
        reasoning: "Sliced corpus into 4 chunks, summarized each, then synthesized.",
      }),
    );
  });

  it("forwards baseModel / citations / guildId on the second submit call", async () => {
    const tool = getTool("nookplot_submit_rlm");
    await tool.handler(
      {
        challengeId: "ch-uuid-1",
        workspaceId: "ws-uuid-1",
        finalAnswer: { answer: "42" },
        baseModel: "claude-opus-4-7",
        reasoning: "Sliced corpus into 4 chunks, summarized each, then synthesized.",
        citations: ["cid-1", "cid-2"],
        guildId: "guild-uuid-1",
      },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledTimes(2);
    expect(ctx.post).toHaveBeenNthCalledWith(
      2,
      "/v1/mining/challenges/ch-uuid-1/submit-solution",
      expect.objectContaining({
        artifactType: "rlm_trajectory_json",
        artifact: expect.objectContaining({
          workspace_id: "ws-uuid-1",
          base_model: "claude-opus-4-7",
          final_answer: { answer: "42" },
        }),
        reasoning: "Sliced corpus into 4 chunks, summarized each, then synthesized.",
        citations: ["cid-1", "cid-2"],
        guildId: "guild-uuid-1",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
//  REPL tools
// ---------------------------------------------------------------------------

describe("nookplot_rlm_repl_exec", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("requires workspaceId + code", () => {
    const tool = getTool("nookplot_rlm_repl_exec");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(["workspaceId", "code"]);
  });

  it("POSTs /v1/workspaces/:id/repl/exec with body", async () => {
    const tool = getTool("nookplot_rlm_repl_exec");
    await tool.handler(
      {
        workspaceId: "ws-uuid-1",
        code: "x = 1\nprint(x)",
        expectedSideEffects: ["x"],
        timeoutMs: 30000,
      },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/ws-uuid-1/repl/exec",
      {
        code: "x = 1\nprint(x)",
        expectedSideEffects: ["x"],
        timeoutMs: 30000,
      },
    );
  });

  it("URL-encodes workspaceId path segment", async () => {
    const tool = getTool("nookplot_rlm_repl_exec");
    await tool.handler({ workspaceId: "weird id/x", code: "1" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/weird%20id%2Fx/repl/exec",
      expect.any(Object),
    );
  });

  it("omits expectedSideEffects when not an array", async () => {
    const tool = getTool("nookplot_rlm_repl_exec");
    await tool.handler({ workspaceId: "w1", code: "1", expectedSideEffects: "not-array" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w1/repl/exec",
      expect.objectContaining({ expectedSideEffects: undefined }),
    );
  });
});

describe("nookplot_rlm_repl_llm_query", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("requires workspaceId + prompt + providerKind", () => {
    const tool = getTool("nookplot_rlm_repl_llm_query");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual([
      "workspaceId",
      "prompt",
      "providerKind",
    ]);
  });

  it("POSTs /v1/workspaces/:id/repl/llm-query with passthrough body", async () => {
    const tool = getTool("nookplot_rlm_repl_llm_query");
    await tool.handler(
      {
        workspaceId: "w1",
        prompt: "summarize this slice",
        providerKind: "nookplot_agent",
        providerAddress: "0xabcd",
        model: "claude-opus-4-7",
        timeoutMs: 60000,
        estimatedCost: 100,
        parentCallIndex: 2,
      },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w1/repl/llm-query",
      {
        prompt: "summarize this slice",
        providerKind: "nookplot_agent",
        providerAddress: "0xabcd",
        model: "claude-opus-4-7",
        timeoutMs: 60000,
        estimatedCost: 100,
        parentCallIndex: 2,
      },
    );
  });
});

describe("nookplot_rlm_repl_finalize", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("requires workspaceId + finalAnswer", () => {
    const tool = getTool("nookplot_rlm_repl_finalize");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual([
      "workspaceId",
      "finalAnswer",
    ]);
  });

  it("POSTs /v1/workspaces/:id/repl/finalize with finalAnswer", async () => {
    const tool = getTool("nookplot_rlm_repl_finalize");
    await tool.handler({ workspaceId: "w1", finalAnswer: { answer: "42" } }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w1/repl/finalize",
      { finalAnswer: { answer: "42" } },
    );
  });
});

describe("nookplot_rlm_provider_poll", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("has no required args", () => {
    const tool = getTool("nookplot_rlm_provider_poll");
    expect((tool.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  it("GETs /v1/mining/rlm-subcalls/poll with no querystring when no args", async () => {
    const tool = getTool("nookplot_rlm_provider_poll");
    await tool.handler({}, ctx);
    expect(ctx.get).toHaveBeenCalledWith("/v1/mining/rlm-subcalls/poll");
  });

  it("appends since + limit filters", async () => {
    const tool = getTool("nookplot_rlm_provider_poll");
    await tool.handler({ since: "2026-05-02T00:00:00Z", limit: 3 }, ctx);
    expect(ctx.get).toHaveBeenCalledWith(
      "/v1/mining/rlm-subcalls/poll?since=2026-05-02T00%3A00%3A00Z&limit=3",
    );
  });
});

// ---------------------------------------------------------------------------
//  nookplot_rlm_invite_collaborator
// ---------------------------------------------------------------------------

describe("nookplot_rlm_invite_collaborator", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = createMockCtx(); });

  it("requires workspaceId + inviteeAddress", () => {
    const tool = getTool("nookplot_rlm_invite_collaborator");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual([
      "workspaceId",
      "inviteeAddress",
    ]);
  });

  it("POSTs to /v1/workspaces/:id/repl/invite with the invitee address", async () => {
    const tool = getTool("nookplot_rlm_invite_collaborator");
    await tool.handler({ workspaceId: "w1", inviteeAddress: "0xb" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w1/repl/invite",
      { inviteeAddress: "0xb" },
    );
  });

  it("forwards optional role parameter when supplied", async () => {
    const tool = getTool("nookplot_rlm_invite_collaborator");
    await tool.handler(
      { workspaceId: "w1", inviteeAddress: "0xb", role: 0 },
      ctx,
    );
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w1/repl/invite",
      { inviteeAddress: "0xb", role: 0 },
    );
  });

  it("URL-encodes the workspaceId path segment", async () => {
    const tool = getTool("nookplot_rlm_invite_collaborator");
    await tool.handler({ workspaceId: "w 1/x", inviteeAddress: "0xb" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/workspaces/w%201%2Fx/repl/invite",
      { inviteeAddress: "0xb" },
    );
  });
});
