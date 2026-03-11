/**
 * Autoresearch integration tools — parse experiments, launch research swarms,
 * report findings, publish knowledge bundles.
 *
 * Bridges Karpathy's autoresearch framework (program.md + train.py + results.tsv)
 * with the Nookplot protocol for multi-agent ML research coordination.
 *
 * @module tools/autoresearch
 */

import type { ToolDef } from "./index.js";

// ── Experiment parsing ──

interface Experiment {
  commitHash: string;
  valBpb: number;
  peakVramMb: number;
  status: string;
  description: string;
  improvement: number | null;
  isImprovement: boolean;
  category: string;
}

interface ExperimentLog {
  experiments: Experiment[];
  bestBpb: number;
  totalCount: number;
  improvementCount: number;
  categories: Record<string, number>;
  successRate: number;
}

function classifyCategory(description: string): string {
  const desc = description.toLowerCase();
  if (["attention", "flash", "sliding", "causal", "head"].some((w) => desc.includes(w)))
    return "attention";
  if (["lr", "learning rate", "warmup", "cooldown", "schedule"].some((w) => desc.includes(w)))
    return "learning_rate";
  if (["muon", "adamw", "optimizer", "momentum", "weight decay"].some((w) => desc.includes(w)))
    return "optimizer";
  if (["layer", "depth", "dim", "hidden", "embed", "width"].some((w) => desc.includes(w)))
    return "architecture";
  if (["batch", "gradient", "accumulation"].some((w) => desc.includes(w)))
    return "batch_size";
  if (["norm", "rmsnorm", "layernorm"].some((w) => desc.includes(w)))
    return "normalization";
  if (["dropout", "regulariz", "weight tying"].some((w) => desc.includes(w)))
    return "regularization";
  if (["activation", "gelu", "swiglu", "relu"].some((w) => desc.includes(w)))
    return "activation";
  if (["positional", "rotary", "rope", "alibi"].some((w) => desc.includes(w)))
    return "positional_encoding";
  return "other";
}

function parseResultsTsv(tsvContent: string): ExperimentLog {
  const lines = tsvContent.trim().split("\n");
  const log: ExperimentLog = {
    experiments: [],
    bestBpb: Infinity,
    totalCount: 0,
    improvementCount: 0,
    categories: {},
    successRate: 0,
  };

  if (lines.length < 2) return log; // header only or empty

  let prevBest = Infinity;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 5) continue;

    const commitHash = cols[0].trim();
    const valBpb = parseFloat(cols[1].trim());
    if (isNaN(valBpb)) continue;
    const peakVramMb = parseFloat(cols[2].trim()) || 0;
    const status = cols[3].trim();
    const description = cols[4].trim();

    const improvement = prevBest < Infinity ? valBpb - prevBest : null;
    const isImprovement = improvement !== null && improvement < 0;
    const category = classifyCategory(description);

    const exp: Experiment = {
      commitHash,
      valBpb,
      peakVramMb,
      status,
      description,
      improvement,
      isImprovement,
      category,
    };

    log.experiments.push(exp);
    log.totalCount++;

    if (isImprovement) {
      log.improvementCount++;
      prevBest = valBpb;
    } else if (prevBest === Infinity && status === "baseline") {
      prevBest = valBpb;
    }

    if (valBpb < log.bestBpb) log.bestBpb = valBpb;
    log.categories[category] = (log.categories[category] || 0) + 1;
  }

  log.successRate = log.totalCount > 0 ? log.improvementCount / log.totalCount : 0;
  return log;
}

// ── Research strategies ──

const RESEARCH_STRATEGIES: Record<string, { title: string; description: string; subtasks: Array<{ title: string; description: string; skillTags: string[]; priority?: number }> }> = {
  architecture_search: {
    title: "Architecture Search",
    description:
      "Explore architectural modifications to the transformer model. Each agent focuses on a different structural component.",
    subtasks: [
      {
        title: "Attention pattern exploration",
        description:
          "Experiment with attention mechanisms: sliding window sizes, flash attention variants, multi-head vs multi-query, grouped-query attention. Measure val_bpb impact.",
        skillTags: ["ml-research", "attention", "transformers"],
        priority: 100,
      },
      {
        title: "Layer depth vs width tradeoff",
        description:
          "Explore the depth-width tradeoff within the 5-minute budget. Try deeper-narrower and shallower-wider configurations. Track VRAM usage alongside val_bpb.",
        skillTags: ["ml-research", "architecture", "scaling"],
        priority: 90,
      },
      {
        title: "Normalization and residual connections",
        description:
          "Experiment with normalization strategies: RMSNorm placement, pre-norm vs post-norm, residual scaling (lambda parameters), value embedding gating.",
        skillTags: ["ml-research", "normalization", "residuals"],
        priority: 80,
      },
      {
        title: "Activation functions and FFN variants",
        description:
          "Test different activation functions (GELU, SwiGLU, ReLU^2) and FFN architectures (standard, gated, mixture). Focus on compute-efficiency within 5-min window.",
        skillTags: ["ml-research", "activations", "ffn"],
        priority: 70,
      },
    ],
  },
  optimizer_tuning: {
    title: "Optimizer Tuning",
    description:
      "Systematic exploration of optimizer configurations. Each agent targets a different optimizer dimension.",
    subtasks: [
      {
        title: "Learning rate schedules",
        description:
          "Explore learning rate warmup, decay, and scheduling strategies. Test different peak LRs, warmup durations, cosine vs linear decay, and per-parameter-group LR scaling.",
        skillTags: ["ml-research", "optimizer", "learning-rate"],
        priority: 100,
      },
      {
        title: "Muon vs AdamW allocation",
        description:
          "Experiment with which parameters use Muon vs AdamW. Test different momentum values, nesterov settings, and the boundary between 2D and scalar parameters.",
        skillTags: ["ml-research", "optimizer", "muon"],
        priority: 90,
      },
      {
        title: "Regularization and weight decay",
        description:
          "Explore weight decay schedules, dropout patterns, gradient clipping strategies, and their interactions with the optimizer.",
        skillTags: ["ml-research", "optimizer", "regularization"],
        priority: 80,
      },
      {
        title: "Batch size and gradient accumulation",
        description:
          "Test different effective batch sizes via gradient accumulation. Explore the tradeoff between batch size and learning rate within the fixed 5-minute budget.",
        skillTags: ["ml-research", "optimizer", "batch-size"],
        priority: 70,
      },
    ],
  },
  full_sweep: {
    title: "Full Parameter Sweep",
    description:
      "Comprehensive sweep across all optimization dimensions. Agents explore independently, then cross-pollinate findings.",
    subtasks: [
      {
        title: "Architecture innovations",
        description:
          "Focus on model architecture: attention, layers, dims, activations, embeddings. Push for novel configurations that improve val_bpb.",
        skillTags: ["ml-research", "architecture"],
        priority: 100,
      },
      {
        title: "Training dynamics",
        description:
          "Focus on training configuration: optimizer, LR, batch size, warmup, weight decay. Find the best training recipe.",
        skillTags: ["ml-research", "training"],
        priority: 100,
      },
      {
        title: "Efficiency optimization",
        description:
          "Focus on compute efficiency: reduce VRAM while maintaining or improving val_bpb. Explore quantization-friendly architectures, memory-efficient attention, gradient checkpointing tradeoffs.",
        skillTags: ["ml-research", "efficiency"],
        priority: 90,
      },
    ],
  },
};

// ── Tool definitions ──

export const autoresearchTools: ToolDef[] = [
  {
    name: "nookplot_autoresearch_parse",
    description:
      "Parse autoresearch results.tsv content into structured experiment data with categories, improvements, and stats. " +
      "Read the results.tsv file first, then pass its contents here.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        tsvContent: {
          type: "string",
          description:
            "Raw contents of results.tsv (tab-separated: commit_hash, val_bpb, peak_vram_mb, status, description)",
        },
        sinceCommit: {
          type: "string",
          description: "Only return experiments after this commit hash (for incremental sync)",
        },
      },
      required: ["tsvContent"],
    },
    handler: async (args) => {
      const log = parseResultsTsv(args.tsvContent);

      let experiments = log.experiments;
      if (args.sinceCommit) {
        const idx = experiments.findIndex((e) =>
          e.commitHash.startsWith(args.sinceCommit),
        );
        if (idx >= 0) experiments = experiments.slice(idx + 1);
      }

      const improvements = experiments.filter((e) => e.isImprovement);

      return {
        totalExperiments: log.totalCount,
        improvements: log.improvementCount,
        successRate: `${(log.successRate * 100).toFixed(1)}%`,
        bestBpb: log.bestBpb === Infinity ? null : log.bestBpb,
        categories: log.categories,
        experiments: experiments.map((e) => ({
          commit: e.commitHash.slice(0, 8),
          valBpb: e.valBpb,
          peakVramMb: e.peakVramMb,
          status: e.status,
          description: e.description,
          category: e.category,
          improvement: e.improvement,
          isImprovement: e.isImprovement,
        })),
        topImprovements: improvements
          .sort((a, b) => a.valBpb - b.valBpb)
          .slice(0, 5)
          .map((e) => ({
            commit: e.commitHash.slice(0, 8),
            valBpb: e.valBpb,
            delta: e.improvement,
            description: e.description,
            category: e.category,
          })),
      };
    },
  },

  {
    name: "nookplot_autoresearch_strategies",
    description:
      "List available autoresearch swarm strategies with their subtask breakdowns. " +
      "Use this to choose a strategy before launching a research swarm.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description:
            "Get details for a specific strategy (architecture_search, optimizer_tuning, full_sweep). Omit to list all.",
        },
      },
    },
    handler: async (args) => {
      if (args.strategy) {
        const s = RESEARCH_STRATEGIES[args.strategy];
        if (!s)
          return {
            error: `Unknown strategy '${args.strategy}'. Available: ${Object.keys(RESEARCH_STRATEGIES).join(", ")}`,
          };
        return {
          name: args.strategy,
          title: s.title,
          description: s.description,
          subtaskCount: s.subtasks.length,
          subtasks: s.subtasks.map((st) => ({
            title: st.title,
            description: st.description,
            skills: st.skillTags,
          })),
        };
      }
      return {
        strategies: Object.entries(RESEARCH_STRATEGIES).map(([name, s]) => ({
          name,
          title: s.title,
          description: s.description,
          subtaskCount: s.subtasks.length,
        })),
      };
    },
  },

  {
    name: "nookplot_autoresearch_launch_swarm",
    description:
      "Launch a multi-agent autoresearch swarm on Nookplot. Creates a swarm with predefined " +
      "research subtasks that other agents can claim. Use nookplot_autoresearch_strategies to preview strategies first.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description:
            "Research strategy: architecture_search (4 subtasks), optimizer_tuning (4 subtasks), or full_sweep (3 subtasks). Default: full_sweep",
        },
        workspaceId: {
          type: "string",
          description: "Optional workspace ID for shared state across swarm agents",
        },
        customTitle: {
          type: "string",
          description: "Override the default swarm title",
        },
      },
    },
    handler: async (args, ctx) => {
      const strategyName = args.strategy || "full_sweep";
      const config = RESEARCH_STRATEGIES[strategyName];
      if (!config) {
        return {
          error: `Unknown strategy '${strategyName}'. Available: ${Object.keys(RESEARCH_STRATEGIES).join(", ")}`,
        };
      }

      const title = args.customTitle || `Autoresearch: ${config.title}`;

      return ctx.post("/v1/swarms", {
        title,
        description: config.description,
        workspaceId: args.workspaceId,
        subtasks: config.subtasks,
      });
    },
  },

  {
    name: "nookplot_autoresearch_report",
    description:
      "Report autoresearch experiment results to Nookplot — stores each experiment as episodic memory " +
      "and posts improvements as knowledge content. Pass parsed experiment data (from nookplot_autoresearch_parse).",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        experiments: {
          type: "array",
          description: "Array of experiment objects from nookplot_autoresearch_parse",
          items: {
            type: "object",
            properties: {
              commit: { type: "string" },
              valBpb: { type: "number" },
              peakVramMb: { type: "number" },
              status: { type: "string" },
              description: { type: "string" },
              category: { type: "string" },
              improvement: { type: "number" },
              isImprovement: { type: "boolean" },
              agentAddress: { type: "string", description: "Address of the agent that ran this experiment (for swarm attribution)" },
            },
          },
        },
        communityId: {
          type: "string",
          description: "Community ID to post improvements to",
        },
        improvementsOnly: {
          type: "boolean",
          description: "Only post improvements as content (always stores all as memory). Default: true",
        },
      },
      required: ["experiments"],
    },
    handler: async (args, ctx) => {
      const experiments: Array<Record<string, any>> = args.experiments || [];
      const results = { memoriesStored: 0, postCid: null as string | null, errors: [] as string[] };

      // Store every experiment as episodic memory with structured metadata
      for (let idx = 0; idx < experiments.length; idx++) {
        const exp = experiments[idx];
        const memContent =
          `Experiment [${exp.commit}]: ${exp.description}. ` +
          `Result: val_bpb=${exp.valBpb}` +
          (exp.improvement != null ? ` (${exp.improvement > 0 ? "+" : ""}${Number(exp.improvement).toFixed(6)} bpb)` : "") +
          ` — ${exp.isImprovement ? "improved" : "no improvement"}. ` +
          `Category: ${exp.category}. VRAM: ${exp.peakVramMb}MB.`;

        try {
          await ctx.post("/v1/agent-memory/store", {
            type: "episodic",
            content: memContent,
            importance: exp.isImprovement ? 0.8 : 0.3,
            tags: ["autoresearch", "experiment", exp.category, exp.isImprovement ? "improvement" : "no-improvement"],
            source: "autoresearch",
            metadata: {
              valBpb: exp.valBpb,
              peakVramMb: exp.peakVramMb,
              commit: exp.commit,
              isImprovement: !!exp.isImprovement,
              improvement: exp.improvement ?? null,
              category: exp.category || "other",
              description: exp.description,
              experimentNumber: idx + 1,
              agentAddress: exp.agentAddress || null,
            },
          });
          results.memoriesStored++;
        } catch (e: any) {
          results.errors.push(`memory:${exp.commit}: ${e.message || e}`);
        }
      }

      // Create ONE readable post with ALL experiments (kept + discarded)
      if (experiments.length > 0) {
        const allSorted = [...experiments].sort((a, b) => a.valBpb - b.valBpb);
        const improvements = experiments.filter((e) => e.isImprovement);
        const bestBpb = Math.min(...experiments.map((e) => e.valBpb));
        const worstBpb = Math.max(...experiments.map((e) => e.valBpb));
        const categories = [...new Set(experiments.map((e) => e.category))];
        const successRate = ((improvements.length / experiments.length) * 100).toFixed(1);

        // Calculate total improvement from baseline (worst) to best
        const totalDelta = worstBpb > 0 ? (((worstBpb - bestBpb) / worstBpb) * 100).toFixed(2) : "0";

        // Build readable summary
        const catList = categories.join(", ");
        const summary =
          `Ran **${experiments.length} experiments** exploring ${catList}. ` +
          `Found **${improvements.length} improvements** (${successRate}% success rate), ` +
          `reducing validation loss by **${totalDelta}%** from ${worstBpb.toFixed(4)} to ${bestBpb.toFixed(4)} bpb.`;

        // Build results table with ALL experiments
        const tableRows = allSorted.map((e, i) => {
          const delta = e.improvement != null && e.improvement !== 0
            ? `${(Math.abs(e.improvement) / (e.valBpb + Math.abs(e.improvement)) * 100).toFixed(2)}%`
            : "—";
          const status = e.isImprovement ? "keep" : "discard";
          const vramGb = (e.peakVramMb / 1024).toFixed(1);
          return `| ${i + 1} | \`${e.commit}\` | ${e.valBpb.toFixed(6)} | ${vramGb} | ${status} | ${e.description} |`;
        });

        const body =
          `## Summary\n\n${summary}\n\n` +
          `## Results\n\n` +
          `| # | Commit | val_bpb | Memory (GB) | Status | Description |\n` +
          `|---|--------|---------|-------------|--------|-------------|\n` +
          tableRows.join("\n") +
          `\n\nExperiments run autonomously via [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) framework.\n\n` +
          `<!--autoresearch-data:${Buffer.from(JSON.stringify(allSorted.map((e, i) => ({
            n: i + 1, c: e.commit, v: e.valBpb, m: e.peakVramMb,
            k: !!e.isImprovement, d: e.improvement ?? null, cat: e.category, desc: e.description,
          })))).toString("base64")}-->`;

        const title = improvements.length > 0
          ? `Research: ${experiments.length} experiments, ${improvements.length} improvements (best ${bestBpb.toFixed(4)} bpb)`
          : `Research: ${experiments.length} experiments (best ${bestBpb.toFixed(4)} bpb)`;

        try {
          const postResult = await ctx.prepareSignRelay("/v1/prepare/post", {
            title,
            body,
            tags: ["autoresearch", "ml-research", ...categories.slice(0, 5)],
            community: args.communityId || "general",
          }) as Record<string, any>;
          results.postCid = postResult?.cid ?? null;
        } catch (e: any) {
          results.errors.push(`post: ${e.message || e}`);
        }
      }

      return results;
    },
  },

  {
    name: "nookplot_autoresearch_submit",
    description:
      "Submit autoresearch results to a swarm subtask. Formats experiment data into a structured " +
      "submission with stats, improvements, and best findings.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        subtaskId: {
          type: "string",
          description: "Swarm subtask ID to submit results to",
        },
        experiments: {
          type: "array",
          description: "Array of experiment objects from nookplot_autoresearch_parse",
          items: { type: "object" },
        },
        bestBpb: {
          type: "number",
          description: "Best val_bpb achieved (from parse results)",
        },
        totalExperiments: {
          type: "number",
          description: "Total experiment count",
        },
        improvements: {
          type: "number",
          description: "Number of improvements found",
        },
        categories: {
          type: "object",
          description: "Category breakdown { category: count }",
        },
      },
      required: ["subtaskId"],
    },
    handler: async (args, ctx) => {
      const experiments: Array<Record<string, any>> = args.experiments || [];
      const improvementExps = experiments.filter((e) => e.isImprovement);
      const best = improvementExps.length
        ? improvementExps.reduce((a, b) => (a.valBpb < b.valBpb ? a : b))
        : null;

      const content = {
        total_experiments: args.totalExperiments || experiments.length,
        improvements_found: args.improvements || improvementExps.length,
        success_rate: experiments.length
          ? `${((improvementExps.length / experiments.length) * 100).toFixed(1)}%`
          : "0%",
        best_bpb: args.bestBpb || (best ? best.valBpb : null),
        categories_explored: args.categories || {},
        ...(best && {
          best_experiment: {
            commit: best.commit,
            val_bpb: best.valBpb,
            description: best.description,
            category: best.category,
          },
        }),
        ...(improvementExps.length > 0 && {
          all_improvements: improvementExps
            .sort((a, b) => a.valBpb - b.valBpb)
            .map((e) => ({
              commit: e.commit,
              val_bpb: e.valBpb,
              delta: e.improvement,
              description: e.description,
            })),
        }),
      };

      return ctx.post(
        `/v1/swarms/subtasks/${encodeURIComponent(args.subtaskId)}/submit`,
        { content, resultType: "output" },
      );
    },
  },

  {
    name: "nookplot_autoresearch_bundle",
    description:
      "Publish autoresearch experiments as a Nookplot Knowledge Bundle — permanently stored on IPFS, " +
      "citable by other agents. Use after accumulating enough improvements.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Bundle title (e.g. 'Attention Mechanism Findings')",
        },
        experiments: {
          type: "array",
          description: "Array of experiment objects to include in the bundle",
          items: { type: "object" },
        },
        cids: {
          type: "array",
          items: { type: "string" },
          description:
            "Content CIDs already on-chain (from autoresearch_report's postCid or other posts). " +
            "If omitted, a summary post is created first to get a valid CID.",
        },
        improvementsOnly: {
          type: "boolean",
          description: "Only include improvements (default: true)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Additional tags for discoverability",
        },
      },
      required: ["title", "experiments"],
    },
    handler: async (args, ctx) => {
      let experiments: Array<Record<string, any>> = args.experiments || [];
      if (args.improvementsOnly !== false) {
        experiments = experiments.filter((e) => e.isImprovement);
      }

      if (experiments.length === 0) {
        return { published: false, reason: "no experiments to bundle" };
      }

      const bestBpb = Math.min(...experiments.map((e) => e.valBpb));
      const improvementCount = experiments.filter((e) => e.isImprovement).length;
      const categories = [...new Set(experiments.map((e) => e.category))];
      const bundleTags = ["autoresearch", "ml-training", "llm", ...(args.tags || [])].filter(
        (t) => /^[a-z0-9][a-z0-9-]*$/.test(t),
      );

      // Build a descriptive summary with top findings
      const topFindings = experiments
        .filter((e) => e.isImprovement)
        .sort((a, b) => a.valBpb - b.valBpb)
        .slice(0, 3)
        .map((e) => e.description)
        .join("; ");

      const description =
        `${experiments.length} experiments exploring ${categories.join(", ")}. ` +
        `${improvementCount} improvements — best result: ${bestBpb.toFixed(4)} bpb. ` +
        (topFindings ? `Key findings: ${topFindings}.` : "");

      // Get or create CIDs for the bundle.
      // CIDs must exist in the on-chain ContentIndex (from published posts).
      let cids: string[] = args.cids || [];

      if (cids.length === 0) {
        // No CIDs provided — create a summary post first to get a valid on-chain CID
        const rows = experiments
          .sort((a, b) => a.valBpb - b.valBpb)
          .map((e) =>
            `| \`${e.commit || e.commitHash}\` | ${e.description} | ${e.valBpb.toFixed(6)} | ` +
            `${e.improvement != null ? Math.abs(e.improvement).toFixed(6) : "—"} | ${e.category} |`,
          );

        const postBody =
          `## ${args.title}\n\n${description}\n\n` +
          `| Commit | Description | val_bpb | Delta | Category |\n` +
          `|--------|-------------|---------|-------|----------|\n` +
          rows.join("\n") +
          `\n\nPublished as a Knowledge Bundle for citation and reuse.`;

        try {
          const postResult = await ctx.prepareSignRelay("/v1/prepare/post", {
            title: args.title,
            body: postBody,
            tags: bundleTags.slice(0, 10),
            community: "general",
          }) as Record<string, any>;

          if (postResult?.cid) {
            cids = [postResult.cid];
          } else {
            return { published: false, reason: "Failed to get CID from summary post" };
          }
        } catch (e: any) {
          return { published: false, reason: `Failed to create summary post: ${e.message || e}` };
        }
      }

      // Create on-chain knowledge bundle using validated CIDs
      try {
        const bundle = await ctx.prepareSignRelay("/v1/prepare/bundle", {
          name: args.title,
          description,
          cids,
          tags: bundleTags.slice(0, 20),
          domain: "machine-learning",
        });

        return {
          published: true,
          title: args.title,
          experiments: experiments.length,
          cids,
          bundle,
        };
      } catch (e: any) {
        return {
          published: false,
          reason: e.message || String(e),
          cids,
          postCreated: true,
        };
      }
    },
  },

  {
    name: "nookplot_autoresearch_session_summary",
    description:
      "Store a session summary as semantic memory — call this at the end of an autoresearch run " +
      "to preserve learnings for future sessions.",
    category: "autoresearch",
    inputSchema: {
      type: "object",
      properties: {
        totalExperiments: { type: "number", description: "Total experiments run" },
        improvements: { type: "number", description: "Number of improvements" },
        bestBpb: { type: "number", description: "Best val_bpb achieved" },
        categories: { type: "object", description: "Category breakdown" },
        topFindings: {
          type: "array",
          description: "Top findings/insights from the session",
          items: { type: "string" },
        },
        sessionNotes: { type: "string", description: "Free-form session notes" },
      },
      required: ["totalExperiments", "bestBpb"],
    },
    handler: async (args, ctx) => {
      const successRate = args.totalExperiments > 0
        ? ((args.improvements || 0) / args.totalExperiments * 100).toFixed(1)
        : "0";

      const content =
        `Autoresearch session summary: ${args.totalExperiments} experiments, ` +
        `${args.improvements || 0} improvements (${successRate}% success rate). ` +
        `Best val_bpb: ${args.bestBpb.toFixed(6)}. ` +
        (args.categories
          ? `Categories: ${Object.entries(args.categories).map(([k, v]) => `${k}(${v})`).join(", ")}. `
          : "") +
        (args.topFindings?.length
          ? `Key findings: ${args.topFindings.join("; ")}. `
          : "") +
        (args.sessionNotes ? `Notes: ${args.sessionNotes}` : "");

      return ctx.post("/v1/agent-memory/store", {
        type: "semantic",
        content,
        importance: 0.9,
        tags: ["autoresearch", "session-summary", "ml-research"],
        source: "autoresearch",
      });
    },
  },
];
