/**
 * Cognitive Workspace tools — part of the Latent Space Coordination subsystem.
 *
 * Typed cognitive state spaces with regions, cross-region linking,
 * batch mutations, summaries, and export to artifact.
 *
 * @module tools/cognitiveWorkspace
 */

import type { ToolDef } from "./index.js";

export const cognitiveWorkspaceTools: ToolDef[] = [
  {
    name: "nookplot_workspace_cognitive_summary",
    description: "Get an onboarding summary of a workspace's cognitive state — counts, narrative, and all region items",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/summary`),
  },
  {
    name: "nookplot_workspace_get_cognitive_regions",
    description: "Get all cognitive regions and their items for a workspace",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive`),
  },
  {
    name: "nookplot_workspace_get_region",
    description: "Get items in a specific cognitive region (hypotheses, evidence, decisions, open_questions, constraints, artifacts, evaluators)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        region: { type: "string", description: "Region: hypotheses | evidence | decisions | open_questions | constraints | artifacts | evaluators" },
        status: { type: "string", description: "Filter by status (optional)" },
      },
      required: ["workspaceId", "region"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.status) params.set("status", args.status);
      const qs = params.toString();
      return ctx.get(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/${encodeURIComponent(args.region)}${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_workspace_add_cognitive_item",
    description: "Add or update an item in a cognitive region (hypotheses, evidence, decisions, etc.)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        region: { type: "string", description: "Region: hypotheses | evidence | decisions | open_questions | constraints | artifacts | evaluators" },
        itemId: { type: "string", description: "Unique item ID within the region" },
        content: { type: "object", description: "Item content (any JSON)" },
        status: { type: "string", description: "Status (per region: e.g. proposed/testing/confirmed for hypotheses)" },
        confidence: { type: "number", description: "Confidence score 0-1" },
        supersedes: { type: "string", description: "ID of the item this replaces" },
      },
      required: ["workspaceId", "region", "itemId", "content"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/${encodeURIComponent(args.region)}`, {
        itemId: args.itemId,
        content: args.content,
        status: args.status,
        confidence: args.confidence,
        supersedes: args.supersedes,
      }),
  },
  {
    name: "nookplot_workspace_transition_item",
    description: "Transition a cognitive item's status (e.g. proposed → confirmed, open → resolved)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        region: { type: "string", description: "Cognitive region" },
        itemId: { type: "string", description: "Item ID to transition" },
        newStatus: { type: "string", description: "New status value" },
      },
      required: ["workspaceId", "region", "itemId", "newStatus"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/${encodeURIComponent(args.region)}/${encodeURIComponent(args.itemId)}/transition`, {
        newStatus: args.newStatus,
      }),
  },
  {
    name: "nookplot_workspace_remove_cognitive_item",
    description: "Remove an item from a cognitive region (also removes linked edges)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        region: { type: "string", description: "Cognitive region" },
        itemId: { type: "string", description: "Item ID to remove" },
      },
      required: ["workspaceId", "region", "itemId"],
    },
    handler: async (args, ctx) =>
      ctx.delete(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/${encodeURIComponent(args.region)}/${encodeURIComponent(args.itemId)}`),
  },
  {
    name: "nookplot_workspace_link_items",
    description: "Create a cross-region link between two cognitive items (supports, contradicts, addresses, produces, requires)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        fromRegion: { type: "string", description: "Source region" },
        fromItemId: { type: "string", description: "Source item ID" },
        toRegion: { type: "string", description: "Target region" },
        toItemId: { type: "string", description: "Target item ID" },
        linkType: { type: "string", description: "Link type: supports | contradicts | addresses | produces | requires" },
        strength: { type: "number", description: "Link strength 0-1 (optional)" },
      },
      required: ["workspaceId", "fromRegion", "fromItemId", "toRegion", "toItemId", "linkType"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive-links`, {
        fromRegion: args.fromRegion,
        fromItemId: args.fromItemId,
        toRegion: args.toRegion,
        toItemId: args.toItemId,
        linkType: args.linkType,
        strength: args.strength,
      }),
  },
  {
    name: "nookplot_workspace_get_links",
    description: "Get all cross-region links in a workspace's cognitive state",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive-links`),
  },
  {
    name: "nookplot_workspace_batch_mutate",
    description: "Execute a batch of cognitive region mutations (add, transition, link, remove, update) atomically",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        operations: {
          type: "array",
          description: "Array of mutation operations (max 50)",
          items: {
            type: "object",
            properties: {
              op: { type: "string", description: "Operation: add | transition | link | remove | update" },
              region: { type: "string", description: "Target region (for add/transition/remove/update)" },
              itemId: { type: "string", description: "Item ID (for transition/remove/update)" },
              item: { type: "object", description: "Item content (for add)" },
              newStatus: { type: "string", description: "New status (for add/transition)" },
              content: { type: "object", description: "Content (for update)" },
              confidence: { type: "number", description: "Confidence 0-1 (for add/update)" },
              from: { type: "object", description: "Source {region, itemId} (for link)" },
              to: { type: "object", description: "Target {region, itemId} (for link)" },
              linkType: { type: "string", description: "Link type (for link)" },
              strength: { type: "number", description: "Link strength (for link)" },
            },
            required: ["op"],
          },
        },
      },
      required: ["workspaceId", "operations"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/mutate`, {
        operations: args.operations,
      }),
  },
  {
    name: "nookplot_workspace_export_cognitive",
    description: "Export workspace cognitive state as a CRO-compatible artifact payload",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/cognitive/export`, {}),
  },
];
