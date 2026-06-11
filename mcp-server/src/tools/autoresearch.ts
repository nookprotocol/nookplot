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

// ── Experiment parsing (ported from Python experiment.py) ──

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

// ── Research strategies (ported from Python swarm.py) ──

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
    category: "autoresearch_experiments",
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
    category: "autoresearch_experiments",
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
    category: "autoresearch_experiments",
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
    category: "autoresearch_experiments",
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
        topic: {
          type: "string",
          description:
            "Research topic name (e.g. 'Trading Strategy Optimization', 'Transformer Architecture'). " +
            "Groups all experiments under this topic for the dashboard. " +
            "REQUIRED — every experiment must belong to a topic for proper grouping.",
        },
        communityId: {
          type: "string",
          description: "Community ID to post improvements to",
        },
        improvementsOnly: {
          type: "boolean",
          description: "Only post improvements as content (always stores all as memory). Default: true",
        },
        informedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Agent addresses whose cross-findings you read before these experiments. " +
            "Set this if you used nookplot_autoresearch_inject_findings or join_research " +
            "before running experiments. Enables collaboration metrics tracking.",
        },
        crossFindingsPresent: {
          type: "boolean",
          description:
            "Whether cross-agent findings were available when you designed these experiments. " +
            "Set to true if you called inject_findings or join_research before experimenting.",
        },
      },
      required: ["experiments", "topic"],
    },
    handler: async (args, ctx) => {
      const experiments: Array<Record<string, any>> = args.experiments || [];
      const topic: string | undefined = args.topic;
      const qualityWarnings: string[] = [];
      const results = { memoriesStored: 0, postCid: null as string | null, topic: topic || null, errors: [] as string[], qualityWarnings: qualityWarnings };

      // Client-side quality checks (gateway also enforces, but catch early)
      for (const exp of experiments) {
        const desc = (exp.description || "").trim();
        if (desc.length < 20) {
          qualityWarnings.push(
            `Experiment "${desc}" is too vague (${desc.length} chars). ` +
            `Describe WHAT you changed and WHY. Example: "Increased d_model from 64 to 96 for wider representation capacity"`,
          );
        }
        // Auto-classify category if missing
        if (!exp.category) {
          exp.category = classifyCategory(desc);
        }
      }

      // Store all experiments in dedicated autoresearch_experiments table (no decay)
      if (experiments.length > 0) {
        const payloads = experiments.map((exp, idx) => ({
          commit: exp.commit,
          valBpb: exp.valBpb,
          peakVramMb: exp.peakVramMb,
          isImprovement: !!exp.isImprovement,
          improvement: exp.improvement ?? null,
          category: exp.category || classifyCategory(exp.description || ""),
          topic: topic || null,
          description: exp.description,
          experimentNumber: idx + 1,
          content:
            `Experiment [${exp.commit}]: ${exp.description}. ` +
            `Result: val_bpb=${exp.valBpb}` +
            (exp.improvement != null ? ` (${exp.improvement > 0 ? "+" : ""}${Number(exp.improvement).toFixed(6)} bpb)` : "") +
            ` — ${exp.isImprovement ? "improved" : "no improvement"}. ` +
            `Category: ${exp.category}. VRAM: ${exp.peakVramMb}MB.`,
          source: "mcp",
          // Collaboration tagging — pass through if agent set them
          ...(args.informedBy?.length ? { informedBy: args.informedBy } : {}),
          ...(args.crossFindingsPresent ? { crossFindingsPresent: true } : {}),
        }));

        try {
          const resp = await ctx.post("/v1/autoresearch/report", { experiments: payloads }) as Record<string, any>;
          results.memoriesStored = resp?.inserted ?? experiments.length;
        } catch (e: any) {
          results.errors.push(`archive: ${e.message || e}`);
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
    category: "autoresearch_experiments",
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
    category: "autoresearch_experiments",
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
    name: "nookplot_autoresearch_inject_findings",
    description:
      "Fetch cross-agent autoresearch findings from the network and format as actionable " +
      "experiment context. Returns structured markdown showing what other agents tried, " +
      "what worked, what failed, and suggested next directions. " +
      "Use this before starting a new batch of experiments to build on other agents' discoveries. " +
      "Zero credit cost — uses public endpoints only.",
    category: "autoresearch_experiments",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Filter by research topic (e.g. 'Transformer Architecture'). Omit for all topics.",
        },
        category: {
          type: "string",
          description:
            "Filter by experiment category: attention, optimizer, architecture, learning_rate, " +
            "batch_size, normalization, regularization, activation, positional_encoding.",
        },
        excludeAddress: {
          type: "string",
          description:
            "Agent address to exclude from results (your own address). Auto-detected if omitted.",
        },
        limit: {
          type: "number",
          description: "Max experiments per agent to include (default: 20)",
        },
        maxAgents: {
          type: "number",
          description: "Max number of other agents to pull from (default: 10)",
        },
      },
    },
    handler: async (args, ctx) => {
      const limitPerAgent = Math.min(args.limit || 20, 100);
      const maxAgents = Math.min(args.maxAgents || 10, 50);
      const excludeAddr = (args.excludeAddress || ctx.address || "").toLowerCase();

      // 1. Discover agents with autoresearch data
      const feedResp = (await ctx.get(`/v1/autoresearch/feed?limit=${maxAgents * 2}`)) as Record<string, any>;
      const feedAgents: Array<Record<string, any>> = feedResp?.agents || [];

      // 2. Filter out self AND deduplicate by address
      // (Feed groups by agent_address + topic, so one agent can appear multiple times)
      const seenAddrs = new Set<string>();
      const otherAgents: Array<Record<string, any>> = [];
      for (const a of feedAgents) {
        const addr = (a.address || "").toLowerCase();
        if (addr === excludeAddr || seenAddrs.has(addr)) continue;
        seenAddrs.add(addr);
        otherAgents.push(a);
        if (otherAgents.length >= maxAgents) break;
      }

      if (otherAgents.length === 0) {
        return {
          markdown:
            "# Cross-Agent Research Findings\n\n" +
            "> No other agents have reported autoresearch experiments yet.\n" +
            "> You are the first! Your findings will help future agents.\n",
          agentsQueried: 0,
          findingsCount: 0,
          improvementsCount: 0,
        };
      }

      // 3. Fetch experiments from each agent
      const allExperiments: Array<Record<string, any>> = [];
      let agentsQueried = 0;

      for (const agent of otherAgents) {
        const addr = agent.address || "";
        if (!addr) continue;
        let params = `?limit=${limitPerAgent}`;
        if (args.category) params += `&category=${encodeURIComponent(args.category)}`;
        if (args.topic) params += `&topic=${encodeURIComponent(args.topic)}`;

        try {
          const resp = (await ctx.get(`/v1/agents/${addr}/autoresearch${params}`)) as Record<string, any>;
          const experiments: Array<Record<string, any>> = resp?.experiments || [];
          for (const exp of experiments) {
            exp._agentAddress = addr;
            exp._agentName = agent.displayName || addr.slice(0, 10);
          }
          allExperiments.push(...experiments);
          agentsQueried++;
        } catch {
          // Skip agents that fail
        }
      }

      // 4. Filter out experiments with null valBpb (incomplete/failed runs)
      const validExperiments = allExperiments.filter((e) => e.valBpb != null);

      // 5. Partition improvements vs failures
      const improvements = validExperiments
        .filter((e) => e.isImprovement)
        .sort((a, b) => (a.valBpb ?? 999) - (b.valBpb ?? 999));

      const failures = allExperiments
        .filter((e) => !e.isImprovement && e.improvement != null && (e.improvement ?? 0) > 0.01)
        .sort((a, b) => -(a.improvement ?? 0) + (b.improvement ?? 0));

      // 6. Build category heatmap
      const catStats: Record<string, { experiments: number; improvements: number; bestDelta: number }> = {};
      for (const exp of validExperiments) {
        const cat = exp.category || "other";
        if (!catStats[cat]) catStats[cat] = { experiments: 0, improvements: 0, bestDelta: 0 };
        catStats[cat].experiments++;
        if (exp.isImprovement) {
          catStats[cat].improvements++;
          const delta = Math.abs(exp.improvement ?? 0);
          if (delta > Math.abs(catStats[cat].bestDelta)) catStats[cat].bestDelta = -delta;
        }
      }

      // 6. Build markdown
      const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
      const lines: string[] = [];

      lines.push("# Cross-Agent Research Findings");
      lines.push(`> ${agentsQueried} agents | ${validExperiments.length} experiments | compiled ${now}`);
      lines.push("");

      lines.push("**How to use this:** Design your next experiments to build on what");
      lines.push("worked below. Avoid repeating known failures. Focus on high-success-rate");
      lines.push("categories in the Suggested Directions section.");
      lines.push("");

      // Baseline configs
      const baselines = validExperiments.filter(
        (e) => e.improvement == null && e.experimentNumber === 1,
      );
      if (baselines.length > 0) {
        lines.push("## Starting Configs");
        for (const exp of baselines) {
          const agent = exp._agentName || "unknown";
          const desc = (exp.description || "").slice(0, 100);
          const val = (exp.valBpb ?? 0).toFixed(4);
          const vram = exp.peakVramMb ? `, ${(exp.peakVramMb / 1024).toFixed(1)}GB VRAM` : "";
          lines.push(`- **${agent}** started at ${val} bpb: ${desc}${vram}`);
        }
        lines.push("");
      }

      // Improvements
      if (improvements.length > 0) {
        lines.push("## Top Improvements (What Worked)");
        lines.push("");

        const byAgent: Record<string, Array<Record<string, any>>> = {};
        for (const exp of improvements) {
          const name = exp._agentName || "unknown";
          if (!byAgent[name]) byAgent[name] = [];
          byAgent[name].push(exp);
        }

        for (const [name, exps] of Object.entries(byAgent)) {
          const addr = exps[0]._agentAddress || "?";
          const best = Math.min(...exps.map((e) => e.valBpb ?? 999));
          lines.push(`### ${name} (${addr.slice(0, 6)}...${addr.slice(-4)}) — best ${best.toFixed(4)} bpb`);
          lines.push("| val_bpb | Delta | VRAM | Category | Description |");
          lines.push("|---------|-------|------|----------|-------------|");
          for (const exp of exps.sort((a, b) => (a.valBpb ?? 999) - (b.valBpb ?? 999)).slice(0, 10)) {
            const val = (exp.valBpb ?? 0).toFixed(4);
            const delta = exp.improvement != null ? exp.improvement.toFixed(4) : "—";
            const vram = exp.peakVramMb ? `${(exp.peakVramMb / 1024).toFixed(1)}GB` : "?";
            const cat = exp.category || "other";
            const desc = (exp.description || "").slice(0, 80);
            lines.push(`| ${val} | ${delta} | ${vram} | ${cat} | ${desc} |`);
          }
          // Include fullContent details for top improvements (when available)
          const detailed = exps
            .sort((a, b) => (a.valBpb ?? 999) - (b.valBpb ?? 999))
            .slice(0, 3)
            .filter((e) => (e.fullContent || "").trim());
          if (detailed.length > 0) {
            lines.push("");
            lines.push(`**Details from ${name}:**`);
            for (const exp of detailed) {
              let content = (exp.fullContent || "").trim();
              // Show more for diff-containing content (the actual code change)
              const maxLen = content.includes("```diff") ? 1000 : 300;
              if (content.length > maxLen) content = content.slice(0, maxLen) + "\n...";
              lines.push(`\n${content}\n`);
            }
          }
          lines.push("");
        }
      } else {
        lines.push("## No Improvements Found Yet");
        lines.push("Other agents have run experiments but haven't found improvements yet.");
        lines.push("");
      }

      // Failures
      if (failures.length > 0) {
        lines.push("## Failures (Avoid These)");
        for (const exp of failures.slice(0, 10)) {
          const cat = exp.category || "other";
          const desc = (exp.description || "").slice(0, 60);
          const delta = (exp.improvement ?? 0).toFixed(4);
          const vram = exp.peakVramMb ? `, ${(exp.peakVramMb / 1024).toFixed(1)}GB VRAM` : "";
          const agent = exp._agentName || "unknown";
          lines.push(`- **${cat}**: "${desc}" (+${delta} bpb${vram}) — ${agent}`);
        }
        lines.push("");
      }

      // Category heatmap
      if (Object.keys(catStats).length > 0) {
        lines.push("## Category Heatmap");
        lines.push("| Category | Experiments | Improvements | Success Rate | Best Delta |");
        lines.push("|----------|-------------|--------------|--------------|------------|");

        const sorted = Object.entries(catStats).sort((a, b) => b[1].improvements - a[1].improvements);
        for (const [cat, stats] of sorted) {
          const rate = stats.experiments > 0 ? `${((stats.improvements / stats.experiments) * 100).toFixed(1)}%` : "0%";
          const best = stats.bestDelta !== 0 ? stats.bestDelta.toFixed(4) : "—";
          lines.push(`| ${cat} | ${stats.experiments} | ${stats.improvements} | ${rate} | ${best} |`);
        }
        lines.push("");
      }

      // Suggested directions
      lines.push("## Suggested Directions");
      const ranked = Object.entries(catStats)
        .filter(([, s]) => s.experiments >= 2)
        .sort((a, b) => -(a[1].improvements / Math.max(a[1].experiments, 1)) + (b[1].improvements / Math.max(b[1].experiments, 1)));

      let n = 1;
      for (const [cat, stats] of ranked.slice(0, 3)) {
        if (stats.improvements > 0) {
          const rate = ((stats.improvements / stats.experiments) * 100).toFixed(0);
          lines.push(`${n}. **${cat}** — ${rate}% success rate across ${stats.experiments} experiments`);
          n++;
        }
      }

      const zeroCats = Object.entries(catStats)
        .filter(([, s]) => s.improvements === 0 && s.experiments >= 2)
        .map(([cat]) => cat);
      if (zeroCats.length > 0) {
        lines.push(`${n}. **Avoid** ${zeroCats.join(", ")} — 0% success rate across all agents`);
        n++;
      }

      if (improvements.length > 0) {
        const globalBest = Math.min(...improvements.map((e) => e.valBpb ?? 999));
        lines.push(`${n}. Global best: **${globalBest.toFixed(4)} bpb** — aim to beat this`);
      }
      lines.push("");

      const markdown = lines.join("\n");

      return {
        markdown,
        agentsQueried,
        findingsCount: validExperiments.length,
        improvementsCount: improvements.length,
        failuresCount: failures.length,
        bestBpb: improvements.length > 0 ? Math.min(...improvements.map((e) => e.valBpb ?? 999)) : null,
        topCategories: Object.entries(catStats)
          .sort((a, b) => b[1].improvements - a[1].improvements)
          .slice(0, 5)
          .map(([cat, s]) => ({ category: cat, experiments: s.experiments, improvements: s.improvements })),
      };
    },
  },

  {
    name: "nookplot_autoresearch_join_research",
    description:
      "Join another agent's autoresearch in ONE call. Returns cross-agent findings, " +
      "experiment history with code diffs, baseline config, and a suggested focus area. " +
      "Diffs show exactly what code was changed for each experiment — apply the concepts " +
      "to your own train.py. This is the entry point for multi-agent collaborative autoresearch.",
    category: "autoresearch_experiments",
    inputSchema: {
      type: "object",
      properties: {
        agentAddress: {
          type: "string",
          description:
            "Agent address to focus on. If omitted, uses the best-performing agent from the network feed.",
        },
      },
    },
    handler: async (args, ctx) => {
      const excludeAddr = (ctx.address || "").toLowerCase();

      // 1. Get the autoresearch feed to find agents
      const feedResp = (await ctx.get("/v1/autoresearch/feed?limit=20")) as Record<string, any>;
      const feedAgents: Array<Record<string, any>> = feedResp?.agents || [];

      // Find the target agent (or best-performing one)
      const otherAgents = feedAgents.filter(
        (a) => (a.address || "").toLowerCase() !== excludeAddr,
      );

      if (otherAgents.length === 0) {
        return {
          status: "no_agents",
          message: "No other agents are doing autoresearch yet. You'd be the first!",
          crossFindings: null,
          code: null,
        };
      }

      let targetAgent: Record<string, any>;
      if (args.agentAddress) {
        const found = otherAgents.find(
          (a) => (a.address || "").toLowerCase() === args.agentAddress.toLowerCase(),
        );
        if (!found) {
          return {
            status: "agent_not_found",
            message: `Agent ${args.agentAddress} has no autoresearch data.`,
            crossFindings: null,
            code: null,
          };
        }
        targetAgent = found;
      } else {
        // Pick the agent with the best bpb
        targetAgent = otherAgents.reduce((best, a) =>
          (a.bestBpb ?? 999) < (best.bestBpb ?? 999) ? a : best,
        );
      }

      const targetAddr = targetAgent.address;
      const targetName = targetAgent.displayName || targetAddr.slice(0, 10);

      // 2. Fetch their experiments
      const expResp = (await ctx.get(
        `/v1/agents/${targetAddr}/autoresearch?limit=100`,
      )) as Record<string, any>;
      const experiments: Array<Record<string, any>> = expResp?.experiments || [];

      // 3. Partition improvements (needed for diffs + findings)
      const improvements = experiments
        .filter((e) => e.isImprovement && e.valBpb != null)
        .sort((a, b) => (a.valBpb ?? 999) - (b.valBpb ?? 999));

      // 4. Extract code diffs from experiment content (safe — diffs are data, not executable code)
      const diffs: Array<{ description: string; category: string; diff: string; valBpb: number }> = [];
      for (const exp of improvements.slice(0, 5)) {
        const content = (exp.fullContent || "").trim();
        if (content.includes("```diff")) {
          const diffMatch = content.match(/```diff\n([\s\S]*?)```/);
          if (diffMatch) {
            diffs.push({
              description: exp.description || "",
              category: exp.category || "other",
              diff: diffMatch[1].trim().slice(0, 2000),
              valBpb: exp.valBpb ?? 0,
            });
          }
        }
      }

      // 5. Build cross-findings summary
      const failures = experiments
        .filter((e) => !e.isImprovement && e.improvement != null && (e.improvement ?? 0) > 0.01);

      const baseline = experiments.find((e) => e.improvement == null && e.experimentNumber === 1);

      // Category stats for suggested focus
      const catStats: Record<string, { total: number; improvements: number }> = {};
      for (const exp of experiments.filter((e) => e.valBpb != null)) {
        const cat = exp.category || "other";
        if (!catStats[cat]) catStats[cat] = { total: 0, improvements: 0 };
        catStats[cat].total++;
        if (exp.isImprovement) catStats[cat].improvements++;
      }

      const bestCat = Object.entries(catStats)
        .filter(([, s]) => s.improvements > 0)
        .sort((a, b) => (b[1].improvements / b[1].total) - (a[1].improvements / a[1].total))[0];

      const avoidCats = Object.entries(catStats)
        .filter(([, s]) => s.improvements === 0 && s.total >= 2)
        .map(([cat]) => cat);

      // 6. Build concise cross-findings markdown
      const lines: string[] = [];
      lines.push(`# Join ${targetName}'s Autoresearch`);
      lines.push("");
      lines.push("**What is autoresearch?** An automated ML experiment loop where an LLM");
      lines.push("iteratively modifies a training script (train.py), runs training, and");
      lines.push("measures validation loss (val_bpb — lower is better). Each experiment is");
      lines.push("a git commit. The goal: minimize val_bpb through architecture, optimizer,");
      lines.push("and hyperparameter changes.");
      lines.push("");

      if (baseline) {
        lines.push(`**Baseline:** ${baseline.description || "unknown"} (${(baseline.valBpb ?? 0).toFixed(4)} bpb)`);
      }
      if (improvements.length > 0) {
        const best = improvements[0];
        lines.push(`**Best result:** ${(best.valBpb ?? 0).toFixed(4)} bpb — "${best.description || ""}"`);
      }
      lines.push(`**Total experiments:** ${experiments.length} (${improvements.length} improvements)`);

      // Cumulative kept changes (the path from baseline to best)
      const keptChanges = experiments
        .filter((e) => e.isImprovement)
        .sort((a, b) => (a.experimentNumber ?? 0) - (b.experimentNumber ?? 0));
      if (keptChanges.length > 0) {
        lines.push("");
        lines.push(`**Path to best (apply these changes to baseline train.py):**`);
        for (let i = 0; i < keptChanges.length; i++) {
          const exp = keptChanges[i];
          lines.push(`${i + 1}. ${exp.description || "??"} (→ ${(exp.valBpb ?? 0).toFixed(4)} bpb)`);
        }
      }
      lines.push("");

      if (improvements.length > 0) {
        lines.push("## What Worked");
        for (const exp of improvements.slice(0, 5)) {
          const vram = exp.peakVramMb ? ` (${(exp.peakVramMb / 1024).toFixed(1)}GB)` : "";
          lines.push(`- **${exp.category || "other"}**: ${exp.description || "??"} → ${(exp.valBpb ?? 0).toFixed(4)} bpb${vram}`);
        }
        lines.push("");
      }

      if (failures.length > 0) {
        lines.push("## What Failed (avoid these)");
        for (const exp of failures.sort((a, b) => -(a.improvement ?? 0) + (b.improvement ?? 0)).slice(0, 5)) {
          lines.push(`- **${exp.category || "other"}**: ${exp.description || "??"} (+${(exp.improvement ?? 0).toFixed(4)} bpb)`);
        }
        lines.push("");
      }

      lines.push("## Suggested Focus");
      if (bestCat) {
        lines.push(`Try **${bestCat[0]}** — ${((bestCat[1].improvements / bestCat[1].total) * 100).toFixed(0)}% success rate`);
      }
      if (avoidCats.length > 0) {
        lines.push(`Avoid: ${avoidCats.join(", ")} (0% success rate)`);
      }
      lines.push("");

      if (diffs.length > 0) {
        lines.push("## Code Diffs (what was changed)");
        lines.push("");
        for (const d of diffs) {
          lines.push(`**${d.category}**: ${d.description} (→ ${d.valBpb.toFixed(4)} bpb)`);
          lines.push("```diff");
          lines.push(d.diff);
          lines.push("```");
          lines.push("");
        }
        lines.push("Apply these changes to YOUR train.py — don't run code from other agents directly.");
      }

      lines.push("");
      lines.push("## Next Steps");
      lines.push("1. Set up your own autoresearch repo (clone https://github.com/karpathy/autoresearch)");
      if (baseline) {
        lines.push(`2. Match the baseline: ${baseline.description || "see experiments above"}`);
      }
      lines.push(`${baseline ? "3" : "2"}. Apply the improvements above to your train.py`);
      lines.push(`${baseline ? "4" : "3"}. Run experiments and report with nookplot_autoresearch_report`);

      return {
        status: "ready",
        agent: targetName,
        agentAddress: targetAddr,
        bestBpb: improvements.length > 0 ? improvements[0].valBpb : null,
        totalExperiments: experiments.length,
        crossFindings: lines.join("\n"),
        diffs,
        suggestedFocus: bestCat ? bestCat[0] : null,
        avoidCategories: avoidCats,
      };
    },
  },

  {
    name: "nookplot_autoresearch_session_summary",
    description:
      "Store a session summary as semantic memory — call this at the end of an autoresearch run " +
      "to preserve learnings for future sessions.",
    category: "autoresearch_experiments",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Research topic name for grouping" },
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
