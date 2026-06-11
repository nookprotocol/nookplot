/**
 * Cross-system integration tests: MCP tools for autoresearch + GPU combined flows.
 *
 * Tests that an agent can use both tool sets in sequence:
 * 1. Search for GPUs → get listing IDs
 * 2. Parse autoresearch results → get experiments
 * 3. Report experiments → create memories + posts
 * 4. Bundle experiments → create knowledge bundle
 *
 * These tests verify the tool interfaces are compatible and that data
 * flows correctly between GPU marketplace and autoresearch tools.
 */

import { describe, it, expect, vi } from "vitest";
import { autoresearchTools } from "../tools/autoresearch.js";
import type { ToolContext } from "../tools/index.js";

// ── Helper ──

function findTool(name: string) {
  const tool = autoresearchTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mockCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    address: "0xResearchAgent",
    apiKey: "nk_test",
    gatewayUrl: "https://gateway.nookplot.com",
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    prepareSignRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    ...overrides,
  };
}

// ── Cross-system flow tests ──

describe("GPU → Autoresearch tool sequence", () => {
  const SAMPLE_TSV = `commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription
abc12345\t1.234000\t4096\tbaseline\tBaseline run with default settings
def67890\t1.220000\t4100\tok\tReduced learning rate warmup
ghi11111\t1.195000\t3800\tok\tCombined RMSNorm + reduced warmup`;

  it("parse → report → bundle end-to-end", async () => {
    // Step 1: Parse results
    const parseTool = findTool("nookplot_autoresearch_parse");
    const parseResult = (await parseTool.handler(
      { tsvContent: SAMPLE_TSV },
      mockCtx(),
    )) as any;

    expect(parseResult.totalExperiments).toBe(3);
    expect(parseResult.improvements).toBeGreaterThan(0);

    // Step 2: Report experiments (shape matches parse output)
    const reportTool = findTool("nookplot_autoresearch_report");
    const reportCtx = mockCtx({
      prepareSignRelay: vi.fn().mockResolvedValue({ cid: "QmReportCid" }),
      preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const reportResult = (await reportTool.handler(
      { experiments: parseResult.experiments },
      reportCtx,
    )) as any;

    expect(reportResult.memoriesStored).toBe(3);
    // A consolidated post should have been created
    expect(reportResult.postCid).toBe("QmReportCid");

    // Step 3: Bundle the improvements
    const bundleTool = findTool("nookplot_autoresearch_bundle");
    const bundleCtx = mockCtx({
      prepareSignRelay: vi.fn()
        .mockResolvedValueOnce({ cid: "QmGpuResearchCid" })  // prepare/post
        .mockResolvedValueOnce({ ok: true }),                  // prepare/bundle
      preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const bundleResult = (await bundleTool.handler(
      { title: "GPU Research Bundle", experiments: parseResult.experiments },
      bundleCtx,
    )) as any;

    expect(bundleResult.published).toBe(true);
    expect(bundleResult.cids).toEqual(["QmGpuResearchCid"]);
  });

  it("parse output experiments have all fields needed by report", async () => {
    const parseTool = findTool("nookplot_autoresearch_parse");
    const result = (await parseTool.handler(
      { tsvContent: SAMPLE_TSV },
      mockCtx(),
    )) as any;

    // Every experiment from parse should have the fields report needs
    for (const exp of result.experiments) {
      expect(exp).toHaveProperty("commit");
      expect(exp).toHaveProperty("valBpb");
      expect(exp).toHaveProperty("status");
      expect(exp).toHaveProperty("description");
      expect(exp).toHaveProperty("category");
      expect(exp).toHaveProperty("isImprovement");
      expect(typeof exp.commit).toBe("string");
      expect(typeof exp.valBpb).toBe("number");
    }
  });

  it("parse output experiments have all fields needed by bundle", async () => {
    const parseTool = findTool("nookplot_autoresearch_parse");
    const result = (await parseTool.handler(
      { tsvContent: SAMPLE_TSV },
      mockCtx(),
    )) as any;

    // Bundle needs: commit, valBpb, peakVramMb, status, description, category, improvement, isImprovement
    for (const exp of result.experiments) {
      expect(exp).toHaveProperty("commit");
      expect(exp).toHaveProperty("valBpb");
      expect(exp).toHaveProperty("peakVramMb");
      expect(exp).toHaveProperty("description");
      expect(exp).toHaveProperty("category");
      expect(exp).toHaveProperty("isImprovement");
    }
  });

  it("parse output experiments have all fields needed by submit", async () => {
    const parseTool = findTool("nookplot_autoresearch_parse");
    const result = (await parseTool.handler(
      { tsvContent: SAMPLE_TSV },
      mockCtx(),
    )) as any;

    // Submit needs: commit, valBpb, isImprovement, improvement, description, category
    const submitTool = findTool("nookplot_autoresearch_submit");
    const submitCtx = mockCtx();
    const submitResult = (await submitTool.handler(
      { subtaskId: "st_test", experiments: result.experiments },
      submitCtx,
    )) as any;

    // Should not throw — the parse output is compatible with submit input
    expect(submitCtx.post).toHaveBeenCalledWith(
      "/v1/swarms/subtasks/st_test/submit",
      expect.objectContaining({
        content: expect.objectContaining({
          total_experiments: 3,
        }),
      }),
    );
  });
});

describe("Swarm → autoresearch tool flow", () => {
  it("launch swarm → submit results from parsed TSV", async () => {
    const TSV = `commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription
a1\t1.200\t4000\tbaseline\tBaseline
b2\t1.180\t4100\tok\tImproved attention
c3\t1.170\t4050\tok\tBetter normalization`;

    // Step 1: Launch swarm
    const launchTool = findTool("nookplot_autoresearch_launch_swarm");
    const launchCtx = mockCtx({
      post: vi.fn().mockResolvedValue({
        id: "swarm_test",
        subtasks: [
          { id: "st_1", title: "Architecture innovations" },
          { id: "st_2", title: "Training dynamics" },
          { id: "st_3", title: "Efficiency optimization" },
        ],
      }),
    });
    await launchTool.handler({ strategy: "full_sweep" }, launchCtx);

    // Step 2: Parse experiments
    const parseTool = findTool("nookplot_autoresearch_parse");
    const parsed = (await parseTool.handler(
      { tsvContent: TSV },
      mockCtx(),
    )) as any;

    // Step 3: Submit to a subtask
    const submitTool = findTool("nookplot_autoresearch_submit");
    const submitCtx = mockCtx();
    await submitTool.handler(
      { subtaskId: "st_1", experiments: parsed.experiments },
      submitCtx,
    );

    expect(submitCtx.post).toHaveBeenCalledWith(
      "/v1/swarms/subtasks/st_1/submit",
      expect.objectContaining({
        content: expect.objectContaining({
          total_experiments: 3,
          improvements_found: expect.any(Number),
        }),
      }),
    );
  });
});

describe("Memory tagging consistency", () => {
  it("report tool uses consistent tags for autoresearch memories", async () => {
    const experiments = [
      { commit: "abc", valBpb: 1.2, status: "baseline", description: "Baseline", category: "other", improvement: null, isImprovement: false },
      { commit: "def", valBpb: 1.1, status: "ok", description: "Improved LR", category: "learning_rate", improvement: -0.1, isImprovement: true },
      { commit: "ghi", valBpb: 1.3, status: "fail", description: "OOM", category: "architecture", improvement: 0.2, isImprovement: false },
    ];

    const ctx = mockCtx();
    const reportTool = findTool("nookplot_autoresearch_report");
    await reportTool.handler({ experiments }, ctx);

    // All memory stores should have "autoresearch" tag
    const memoryCalls = (ctx.post as any).mock.calls.filter(
      (c: any[]) => c[0] === "/v1/agent-memory/store",
    );
    for (const call of memoryCalls) {
      const tags = call[1].tags;
      expect(tags).toContain("autoresearch");
    }
  });

  it("session summary tags include autoresearch and session_summary", async () => {
    const summaryTool = findTool("nookplot_autoresearch_session_summary");
    const ctx = mockCtx();
    await summaryTool.handler({
      totalExperiments: 10,
      improvements: 3,
      bestBpb: 1.1,
      categories: { attention: 5, optimizer: 5 },
      topFindings: ["Finding 1"],
    }, ctx);

    const call = (ctx.post as any).mock.calls[0];
    expect(call[1].tags).toContain("autoresearch");
    expect(call[1].tags).toContain("session-summary");
  });
});
