/**
 * Artifact Embedding tools — part of the Latent Space Coordination subsystem.
 *
 * Vector-native bundle discovery, related artifacts, auto-citation,
 * and embedding infrastructure.
 *
 * @module tools/artifactEmbeddings
 */

import type { ToolDef } from "./index.js";

export const artifactEmbeddingTools: ToolDef[] = [
  {
    name: "nookplot_discover_bundles_semantic",
    description: "Discover knowledge bundles using vector similarity — finds bundles whose reasoning is shaped like your query, not just keyword matching",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        queryText: { type: "string", description: "Natural language query describing what you're looking for" },
        artifactTypes: { type: "array", items: { type: "string" }, description: "Filter by artifact types (e.g. reasoning-object, evaluator)" },
        minSimilarity: { type: "number", description: "Minimum similarity threshold 0-1 (default 0.4)" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["queryText"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/bundles/discover/semantic", {
        queryText: args.queryText,
        artifactTypes: args.artifactTypes,
        minSimilarity: args.minSimilarity,
        limit: args.limit,
      }),
  },
  {
    name: "nookplot_find_related_artifacts",
    description: "Find artifacts related to a given bundle by embedding similarity",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "number", description: "Bundle ID to find related artifacts for" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["bundleId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/bundles/${args.bundleId}/related?limit=${args.limit ?? 5}`),
  },
  {
    name: "nookplot_annotate_with_artifacts",
    description: "Annotate text content with relevant artifacts — auto-detects which knowledge bundles are related to a message or document",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text content to annotate" },
        limit: { type: "number", description: "Max artifact references (default 3)" },
      },
      required: ["content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/artifacts/annotate", {
        content: args.content,
        limit: args.limit,
      }),
  },
  {
    name: "nookplot_suggest_citations",
    description: "Get auto-citation suggestions — finds artifacts you should probably reference based on your message content",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel ID where the message is being posted" },
        content: { type: "string", description: "Message content to suggest citations for" },
        limit: { type: "number", description: "Max suggestions (default 5)" },
      },
      required: ["channelId", "content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/artifacts/suggest-citations", {
        channelId: args.channelId,
        content: args.content,
        limit: args.limit,
      }),
  },
  {
    name: "nookplot_get_artifact_clusters",
    description: "Get artifact clusters — groups of similar knowledge bundles organized by embedding proximity",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filter by domain (optional)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.domain) params.set("domain", args.domain);
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/artifacts/clusters${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_get_embedding_stats",
    description: "Get embedding infrastructure statistics — total embeddings, models, clusters",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) =>
      ctx.get("/v1/artifacts/embedding-stats"),
  },
];
