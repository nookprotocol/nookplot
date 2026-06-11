/**
 * Autoresearch MCP tool tests — parse, strategy, swarm launch, report, bundle.
 */

import { describe, it, expect, vi } from "vitest";
import { autoresearchTools } from "../tools/autoresearch.js";
import type { ToolContext } from "../tools/index.js";

// ── Sample TSV data ──

const SAMPLE_TSV = `commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription
abc12345\t1.234000\t4096\tbaseline\tBaseline run with default settings
def67890\t1.220000\t4100\tok\tReduced learning rate warmup from 200 to 100 steps
ghi11111\t1.250000\t4200\tok\tIncreased batch size with gradient accumulation
jkl22222\t1.210000\t3900\tok\tSwitched to RMSNorm with pre-norm placement
mno33333\t1.230000\t4500\tok\tAdded sliding window attention with window size 256
pqr44444\t1.195000\t3800\tok\tCombined RMSNorm + reduced warmup + smaller learning rate`;

const EMPTY_TSV = `commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription`;

// ── Helper to find tools by name ──

function findTool(name: string) {
  const tool = autoresearchTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ── Mock context ──

function mockCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    address: "0xTestAgent",
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

// ── Tests ──

describe("nookplot_autoresearch_parse", () => {
  const tool = findTool("nookplot_autoresearch_parse");

  it("parses valid TSV into structured experiments", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    expect(result.totalExperiments).toBe(6);
    expect(result.experiments).toHaveLength(6);
    expect(result.bestBpb).toBe(1.195);
  });

  it("classifies experiment categories correctly", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    const categories = result.experiments.map((e: any) => e.category);
    expect(categories).toContain("learning_rate"); // "learning rate warmup"
    expect(categories).toContain("normalization"); // "RMSNorm"
    expect(categories).toContain("attention"); // "sliding window attention"
    expect(categories).toContain("batch_size"); // "batch size"
  });

  it("detects improvements correctly", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    expect(result.improvements).toBeGreaterThan(0);
    const improvements = result.experiments.filter((e: any) => e.isImprovement);
    for (const imp of improvements) {
      expect(imp.improvement).toBeLessThan(0); // negative = better
    }
  });

  it("returns top improvements sorted by val_bpb", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    expect(result.topImprovements.length).toBeGreaterThan(0);
    for (let i = 1; i < result.topImprovements.length; i++) {
      expect(result.topImprovements[i].valBpb).toBeGreaterThanOrEqual(
        result.topImprovements[i - 1].valBpb,
      );
    }
  });

  it("handles empty TSV", async () => {
    const result = (await tool.handler({ tsvContent: EMPTY_TSV }, mockCtx())) as any;
    expect(result.totalExperiments).toBe(0);
    expect(result.experiments).toHaveLength(0);
    expect(result.bestBpb).toBeNull();
  });

  it("handles malformed rows gracefully", async () => {
    const bad = SAMPLE_TSV + "\nbadrow\twithout\tenough\tcolumns";
    const result = (await tool.handler({ tsvContent: bad }, mockCtx())) as any;
    // Should parse the good rows, skip the bad one
    expect(result.totalExperiments).toBe(6);
  });

  it("supports sinceCommit for incremental sync", async () => {
    const result = (await tool.handler(
      { tsvContent: SAMPLE_TSV, sinceCommit: "def67890" },
      mockCtx(),
    )) as any;
    // Should only include experiments after def67890
    expect(result.experiments.length).toBe(4); // ghi, jkl, mno, pqr
    expect(result.experiments[0].commit).toBe("ghi11111");
  });

  it("truncates commit hashes to 8 chars", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    for (const exp of result.experiments) {
      expect(exp.commit.length).toBeLessThanOrEqual(8);
    }
  });

  it("computes success rate as percentage string", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    expect(result.successRate).toMatch(/^\d+\.\d%$/);
  });

  it("builds category breakdown", async () => {
    const result = (await tool.handler({ tsvContent: SAMPLE_TSV }, mockCtx())) as any;
    expect(typeof result.categories).toBe("object");
    const total = Object.values(result.categories).reduce(
      (a: number, b: unknown) => a + (b as number),
      0,
    );
    expect(total).toBe(result.totalExperiments);
  });
});

describe("nookplot_autoresearch_strategies", () => {
  const tool = findTool("nookplot_autoresearch_strategies");

  it("lists all strategies when no arg given", async () => {
    const result = (await tool.handler({}, mockCtx())) as any;
    expect(result.strategies).toBeDefined();
    expect(result.strategies.length).toBe(3);
    const names = result.strategies.map((s: any) => s.name);
    expect(names).toContain("architecture_search");
    expect(names).toContain("optimizer_tuning");
    expect(names).toContain("full_sweep");
  });

  it("returns detail for a specific strategy", async () => {
    const result = (await tool.handler(
      { strategy: "architecture_search" },
      mockCtx(),
    )) as any;
    expect(result.name).toBe("architecture_search");
    expect(result.subtaskCount).toBe(4);
    expect(result.subtasks).toHaveLength(4);
    expect(result.subtasks[0].title).toBe("Attention pattern exploration");
  });

  it("returns error for unknown strategy", async () => {
    const result = (await tool.handler({ strategy: "nonexistent" }, mockCtx())) as any;
    expect(result.error).toBeDefined();
    expect(result.error).toContain("nonexistent");
  });

  it("each strategy has subtasks with skill tags", async () => {
    for (const name of ["architecture_search", "optimizer_tuning", "full_sweep"]) {
      const result = (await tool.handler({ strategy: name }, mockCtx())) as any;
      for (const st of result.subtasks) {
        expect(st.skills).toBeDefined();
        expect(st.skills.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("nookplot_autoresearch_launch_swarm", () => {
  const tool = findTool("nookplot_autoresearch_launch_swarm");

  it("creates swarm via gateway API with strategy subtasks", async () => {
    const ctx = mockCtx();
    await tool.handler({ strategy: "full_sweep" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/swarms", expect.objectContaining({
      title: "Autoresearch: Full Parameter Sweep",
      subtasks: expect.arrayContaining([
        expect.objectContaining({ title: "Architecture innovations" }),
      ]),
    }));
  });

  it("defaults to full_sweep strategy", async () => {
    const ctx = mockCtx();
    await tool.handler({}, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/swarms", expect.objectContaining({
      title: "Autoresearch: Full Parameter Sweep",
    }));
  });

  it("allows custom title override", async () => {
    const ctx = mockCtx();
    await tool.handler({ strategy: "optimizer_tuning", customTitle: "My Research" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/swarms", expect.objectContaining({
      title: "My Research",
    }));
  });

  it("returns error for unknown strategy", async () => {
    const result = (await tool.handler({ strategy: "bad" }, mockCtx())) as any;
    expect(result.error).toContain("bad");
  });

  it("passes workspace ID when provided", async () => {
    const ctx = mockCtx();
    await tool.handler({ strategy: "full_sweep", workspaceId: "ws_123" }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/swarms", expect.objectContaining({
      workspaceId: "ws_123",
    }));
  });
});

describe("nookplot_autoresearch_report", () => {
  const tool = findTool("nookplot_autoresearch_report");

  const experiments = [
    { commit: "abc12345", valBpb: 1.234, peakVramMb: 4096, status: "baseline", description: "Baseline", category: "other", improvement: null, isImprovement: false },
    { commit: "def67890", valBpb: 1.22, peakVramMb: 4100, status: "ok", description: "Reduced LR warmup", category: "learning_rate", improvement: -0.014, isImprovement: true },
    { commit: "ghi11111", valBpb: 1.25, peakVramMb: 4200, status: "ok", description: "More batch", category: "batch_size", improvement: 0.03, isImprovement: false },
  ];

  it("stores all experiments via autoresearch report endpoint", async () => {
    const ctx = mockCtx({
      post: vi.fn().mockResolvedValue({ inserted: 3 }),
    });
    const result = (await tool.handler({ experiments, topic: "test-topic" }, ctx)) as any;
    expect(result.memoriesStored).toBe(3);
    expect(ctx.post).toHaveBeenCalledWith("/v1/autoresearch/report", expect.objectContaining({
      experiments: expect.arrayContaining([
        expect.objectContaining({ commit: "abc12345", source: "mcp" }),
      ]),
    }));
  });

  it("creates a consolidated post for all experiments", async () => {
    const ctx = mockCtx({
      prepareSignRelay: vi.fn().mockResolvedValue({ cid: "QmTestPost" }),
      preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const result = (await tool.handler({ experiments }, ctx)) as any;
    expect(result.postCid).toBe("QmTestPost");
    // One consolidated post (not per-improvement)
    expect(ctx.prepareSignRelay).toHaveBeenCalledTimes(1);
    expect(ctx.prepareSignRelay).toHaveBeenCalledWith("/v1/prepare/post", expect.objectContaining({
      community: "general",
    }));
  });

  it("uses provided community ID in posts", async () => {
    const ctx = mockCtx();
    await tool.handler({ experiments, communityId: "ml-research" }, ctx);
    expect(ctx.prepareSignRelay).toHaveBeenCalledWith("/v1/prepare/post", expect.objectContaining({
      community: "ml-research",
    }));
  });
});

describe("nookplot_autoresearch_submit", () => {
  const tool = findTool("nookplot_autoresearch_submit");

  it("submits formatted results to subtask endpoint", async () => {
    const ctx = mockCtx();
    const experiments = [
      { commit: "abc", valBpb: 1.2, isImprovement: true, improvement: -0.05, description: "Test", category: "attention" },
    ];
    await tool.handler({ subtaskId: "st_123", experiments }, ctx);
    expect(ctx.post).toHaveBeenCalledWith(
      "/v1/swarms/subtasks/st_123/submit",
      expect.objectContaining({
        content: expect.objectContaining({
          total_experiments: 1,
          improvements_found: 1,
        }),
        resultType: "output",
      }),
    );
  });

  it("includes best experiment when improvements exist", async () => {
    const ctx = mockCtx();
    const experiments = [
      { commit: "a", valBpb: 1.3, isImprovement: false, improvement: 0.01, description: "Worse", category: "other" },
      { commit: "b", valBpb: 1.1, isImprovement: true, improvement: -0.1, description: "Better", category: "attention" },
    ];
    await tool.handler({ subtaskId: "st_456", experiments }, ctx);
    const call = (ctx.post as any).mock.calls[0];
    expect(call[1].content.best_experiment).toEqual(expect.objectContaining({
      commit: "b",
      val_bpb: 1.1,
    }));
  });
});

describe("nookplot_autoresearch_bundle", () => {
  const tool = findTool("nookplot_autoresearch_bundle");

  it("creates summary post then on-chain bundle", async () => {
    const ctx = mockCtx({
      prepareSignRelay: vi.fn()
        .mockResolvedValueOnce({ cid: "QmTestCid123" })  // prepare/post
        .mockResolvedValueOnce({ ok: true }),              // prepare/bundle
      preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const experiments = [
      { commit: "a", valBpb: 1.1, peakVramMb: 3000, status: "ok", description: "Test", category: "attention", improvement: -0.1, isImprovement: true },
    ];
    const result = (await tool.handler({ title: "My Bundle", experiments }, ctx)) as any;
    expect(result.published).toBe(true);
    expect(result.cids).toEqual(["QmTestCid123"]);
    expect(ctx.prepareSignRelay).toHaveBeenCalledWith("/v1/prepare/post", expect.objectContaining({
      title: "My Bundle",
    }));
    expect(ctx.prepareSignRelay).toHaveBeenCalledWith("/v1/prepare/bundle", expect.objectContaining({
      name: "My Bundle",
      cids: ["QmTestCid123"],
    }));
  });

  it("filters to improvements only by default", async () => {
    const ctx = mockCtx({
      prepareSignRelay: vi.fn()
        .mockResolvedValueOnce({ cid: "QmTestCid456" })  // prepare/post
        .mockResolvedValueOnce({ ok: true }),              // prepare/bundle
      preparePermitStakeRelay: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const experiments = [
      { commit: "a", valBpb: 1.1, isImprovement: true, description: "Good", category: "attention" },
      { commit: "b", valBpb: 1.5, isImprovement: false, description: "Bad", category: "other" },
    ];
    const result = (await tool.handler({ title: "Test", experiments }, ctx)) as any;
    expect(result.published).toBe(true);
    expect(result.experiments).toBe(1);
  });

  it("returns not published when no experiments after filter", async () => {
    const experiments = [
      { commit: "a", valBpb: 1.5, isImprovement: false, description: "Bad", category: "other" },
    ];
    const result = (await tool.handler({ title: "Test", experiments }, mockCtx())) as any;
    expect(result.published).toBe(false);
    expect(result.reason).toBe("no experiments to bundle");
  });
});

describe("nookplot_autoresearch_session_summary", () => {
  const tool = findTool("nookplot_autoresearch_session_summary");

  it("stores summary as semantic memory", async () => {
    const ctx = mockCtx();
    await tool.handler({
      totalExperiments: 50,
      improvements: 12,
      bestBpb: 1.195,
      categories: { attention: 15, optimizer: 20, architecture: 15 },
      topFindings: ["RMSNorm pre-norm is better", "Warmup 100 steps optimal"],
    }, ctx);
    expect(ctx.post).toHaveBeenCalledWith("/v1/agent-memory/store", expect.objectContaining({
      type: "semantic",
      importance: 0.9,
      source: "autoresearch",
    }));
    const content = (ctx.post as any).mock.calls[0][1].content;
    expect(content).toContain("50 experiments");
    expect(content).toContain("1.195000");
    expect(content).toContain("RMSNorm");
  });
});

describe("tool registration", () => {
  it("exports 9 autoresearch tools", () => {
    expect(autoresearchTools).toHaveLength(9);
  });

  it("all tools are prefixed nookplot_autoresearch_", () => {
    for (const tool of autoresearchTools) {
      expect(tool.name).toMatch(/^nookplot_autoresearch_/);
    }
  });

  it("all tools have handler functions", () => {
    for (const tool of autoresearchTools) {
      expect(typeof tool.handler).toBe("function");
    }
  });
});
