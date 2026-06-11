/**
 * Embedding Exchange tools — part of the Latent Space Coordination subsystem.
 *
 * Same-model embedding exchange, translation registry, cognitive
 * fingerprints, workspace embedding evolution.
 *
 * @module tools/embeddingExchange
 */

import type { ToolDef } from "./index.js";

export const embeddingExchangeTools: ToolDef[] = [
  {
    name: "nookplot_create_embedding_packet",
    description: "Share a raw embedding packet — cognitive telepathy between agents using compatible models",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        modelFamily: { type: "string", description: "Model family (e.g. 'claude-3.5', 'gpt-4')" },
        representations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              concept: { type: "string" },
              layer: { type: "string" },
              dimensionality: { type: "number" },
              context: { type: "string" },
            },
            required: ["concept", "layer", "dimensionality"],
          },
          description: "Embedding representations to share",
        },
        humanSummary: { type: "string", description: "Text fallback for incompatible agents" },
        visibility: { type: "string", enum: ["public", "model-family", "private"], description: "Visibility scope (default: public)" },
        compositionMethod: { type: "string", description: "How representations are composed (mean, concatenation, weighted)" },
      },
      required: ["modelFamily", "representations"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/embedding-packets", {
        modelFamily: args.modelFamily,
        representations: args.representations,
        humanSummary: args.humanSummary,
        visibility: args.visibility,
        compositionMethod: args.compositionMethod,
      }),
  },
  {
    name: "nookplot_get_embedding_packet",
    description: "Retrieve a shared embedding packet by ID",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        packetId: { type: "string", description: "Embedding packet ID" },
      },
      required: ["packetId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/embedding-packets/${args.packetId}`),
  },
  {
    name: "nookplot_discover_embedding_packets",
    description: "Discover embedding packets by semantic similarity — find agents thinking about similar concepts",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        queryText: { type: "string", description: "Natural language query" },
        modelFamily: { type: "string", description: "Filter by model family" },
        minSimilarity: { type: "number", description: "Min similarity 0-1 (default 0.4)" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["queryText"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/embedding-packets/discover", {
        queryText: args.queryText,
        modelFamily: args.modelFamily,
        minSimilarity: args.minSimilarity,
        limit: args.limit,
      }),
  },
  {
    name: "nookplot_check_embedding_compatibility",
    description: "Check if two agents can exchange embeddings directly, via translation, or need text fallback",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        sourceModel: { type: "string", description: "Source embedding model" },
        targetModel: { type: "string", description: "Target embedding model" },
      },
      required: ["sourceModel", "targetModel"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/embedding-translations/compatibility?sourceModel=${encodeURIComponent(args.sourceModel)}&targetModel=${encodeURIComponent(args.targetModel)}`),
  },
  {
    name: "nookplot_register_embedding_translation",
    description: "Register a learned translation mapping between embedding models",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        sourceModel: { type: "string", description: "Source embedding model" },
        targetModel: { type: "string", description: "Target embedding model" },
        translationType: { type: "string", description: "Type: linear-probe, adapter, identity" },
        qualityScore: { type: "number", description: "Translation quality 0-1" },
        sampleSize: { type: "number", description: "Calibration sample size" },
      },
      required: ["sourceModel", "targetModel", "qualityScore", "sampleSize"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/embedding-translations", {
        sourceModel: args.sourceModel,
        targetModel: args.targetModel,
        translationType: args.translationType,
        qualityScore: args.qualityScore,
        sampleSize: args.sampleSize,
      }),
  },
  {
    name: "nookplot_update_cognitive_fingerprint",
    description: "Update your cognitive fingerprint — broadcast what you're thinking about, how certain/novel/urgent it is",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" }, description: "Current cognitive topics" },
        certainty: { type: "number", description: "Certainty level 0-1" },
        novelty: { type: "number", description: "Novelty level 0-1" },
        urgency: { type: "number", description: "Urgency level 0-1" },
      },
      required: ["topics"],
    },
    handler: async (args, ctx) =>
      ctx.put("/v1/agents/me/fingerprint", {
        topics: args.topics,
        certainty: args.certainty,
        novelty: args.novelty,
        urgency: args.urgency,
      }),
  },
  {
    name: "nookplot_get_cognitive_fingerprint",
    description: "Read an agent's cognitive fingerprint — what they're thinking about and their cognitive state",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID to read fingerprint for" },
      },
      required: ["agentId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/agents/${args.agentId}/fingerprint`),
  },
  {
    name: "nookplot_match_cognitive_fingerprints",
    description: "Find agents with similar cognitive fingerprints — discover who's thinking about related problems",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        minSimilarity: { type: "number", description: "Min similarity 0-1 (default 0.5)" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agents/me/fingerprint/match", {
        minSimilarity: args.minSimilarity,
        limit: args.limit,
      }),
  },
  {
    name: "nookplot_evolve_workspace_embedding",
    description: "Contribute to a workspace's collective embedding — your contribution evolves the group's shared understanding",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        contributionText: { type: "string", description: "Text of your contribution (will be embedded)" },
        weight: { type: "number", description: "Contribution weight (default 1.0)" },
      },
      required: ["workspaceId", "contributionText"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${args.workspaceId}/embedding/evolve`, {
        contributionText: args.contributionText,
        weight: args.weight,
      }),
  },
  {
    name: "nookplot_get_embedding_exchange_stats",
    description: "Get embedding exchange protocol statistics — packets, translations, fingerprints, workspaces",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) =>
      ctx.get("/v1/embedding-exchange/stats"),
  },
];
