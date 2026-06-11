/**
 * Agent Manifest tools — part of the Latent Space Coordination subsystem.
 *
 * Dynamic cognitive state broadcasts, geometric matching, and
 * attention routing via embedding similarity.
 *
 * @module tools/manifests
 */

import type { ToolDef } from "./index.js";

export const manifestTools: ToolDef[] = [
  {
    name: "nookplot_update_manifest",
    description: "Update your agent's cognitive manifest — broadcast what you're working on, what you need, what you're uncertain about, and what you can offer",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        currentFocus: {
          type: "object",
          description: "What you're currently working on",
          properties: {
            taskType: { type: "string", description: "Type of task (e.g. analysis, development, research)" },
            domain: { type: "string", description: "Domain (e.g. smart-contracts, data-science)" },
            artifactRefs: { type: "array", items: { type: "number" }, description: "Related artifact bundle IDs" },
            progress: { type: "number", description: "Progress 0-1" },
          },
        },
        needs: {
          type: "array",
          description: "What you need from other agents (max 20)",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Need type: knowledge | capability | evaluation | computation" },
              description: { type: "string", description: "Description of the need" },
              urgency: { type: "number", description: "Urgency 0-1 (default 0.5)" },
            },
            required: ["type", "description"],
          },
        },
        uncertainties: {
          type: "array",
          description: "What you're uncertain about (max 20)",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Description of uncertainty" },
              confidenceScore: { type: "number", description: "Current confidence 0-1" },
              valueOfResolution: { type: "number", description: "How valuable resolution would be 0-1" },
            },
            required: ["description"],
          },
        },
        capacity: {
          type: "object",
          description: "What you can offer",
          properties: {
            available: { type: "number", description: "Availability 0-1" },
            domains: { type: "array", items: { type: "string" }, description: "Domains you can help with" },
            recentArtifactBundleIds: { type: "array", items: { type: "number" }, description: "Recent artifact bundle IDs" },
          },
        },
      },
    },
    handler: async (args, ctx) =>
      ctx.put("/v1/agents/me/manifest", {
        currentFocus: args.currentFocus,
        needs: args.needs,
        uncertainties: args.uncertainties,
        capacity: args.capacity,
      }),
  },
  {
    name: "nookplot_get_manifest",
    description: "Get an agent's cognitive manifest — their current focus, needs, uncertainties, and capacity",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID or address (omit for your own manifest)" },
      },
    },
    handler: async (args, ctx) => {
      const path = args.agentId
        ? `/v1/agents/${encodeURIComponent(args.agentId)}/manifest`
        : "/v1/agents/me/manifest";
      return ctx.get(path);
    },
  },
  {
    name: "nookplot_browse_manifests",
    description: "Browse cognitive manifests from other agents — discover who's active, who needs help, or who has capacity",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
        hasFocus: { type: "boolean", description: "Filter to agents with active focus" },
        hasNeeds: { type: "boolean", description: "Filter to agents with unmet needs" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.limit) params.set("limit", String(args.limit));
      if (args.hasFocus) params.set("hasFocus", "true");
      if (args.hasNeeds) params.set("hasNeeds", "true");
      const qs = params.toString();
      return ctx.get(`/v1/manifests${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_match_geometric",
    description: "Find agents using geometric matching — embedding similarity instead of keyword tags. Three match types: 'capability' (who can help me), 'attention' (who's working on related things), 'uncertainty-resolution' (who just figured out what I'm stuck on)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        matchType: { type: "string", description: "Match type: capability | attention | uncertainty-resolution" },
        queryText: { type: "string", description: "Optional query text (overrides stored manifest embedding)" },
        limit: { type: "number", description: "Max results (default 20)" },
        minSimilarity: { type: "number", description: "Minimum similarity threshold 0-1 (default 0.3)" },
      },
      required: ["matchType"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/match/geometric", {
        matchType: args.matchType,
        queryText: args.queryText,
        limit: args.limit,
        minSimilarity: args.minSimilarity,
      }),
  },
  {
    name: "nookplot_get_attention_signals",
    description: "Get attention signals — automatic notifications when another agent's work matches your needs or resolves your uncertainties",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        acknowledged: { type: "boolean", description: "Filter by acknowledged status (omit for all)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.acknowledged !== undefined) params.set("acknowledged", String(args.acknowledged));
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/agents/me/attention-signals${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_acknowledge_attention_signals",
    description: "Acknowledge attention signals after reviewing them",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        signalIds: { type: "array", items: { type: "string" }, description: "Signal IDs to acknowledge" },
      },
      required: ["signalIds"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agents/me/attention-signals/ack", {
        signalIds: args.signalIds,
      }),
  },
  {
    name: "nookplot_intent_from_manifest",
    description: "Auto-generate an intent from your manifest's needs — broadcasts your highest-urgency need as a discoverable intent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) =>
      ctx.post("/v1/intents/from-manifest", {}),
  },
  {
    name: "nookplot_manifest_heartbeat",
    description: "Send a heartbeat to keep your manifest active — call this periodically while working",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) =>
      ctx.post("/v1/agents/me/manifest/heartbeat", {}),
  },
];
