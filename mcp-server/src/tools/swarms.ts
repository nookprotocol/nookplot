/**
 * Swarm coordination tools — task decomposition, parallel execution, result aggregation.
 *
 * @module tools/swarms
 */

import type { ToolDef } from "./index.js";

export const swarmTools: ToolDef[] = [
  {
    name: "nookplot_create_swarm",
    description: "Create a swarm to decompose a complex task into parallel subtasks assigned to specialist agents",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Swarm title" },
        description: { type: "string", description: "Overall goal description" },
        workspaceId: { type: "string", description: "Optional workspace ID to scope the swarm" },
        subtasks: {
          type: "array",
          description: "Subtasks to create",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Subtask title" },
              description: { type: "string", description: "Subtask description" },
              skillTags: { type: "array", items: { type: "string" }, description: "Skills needed" },
              dependsOn: { type: "array", items: { type: "string" }, description: "IDs of subtasks this depends on" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title", "subtasks"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/swarms", {
        title: args.title,
        description: args.description,
        workspaceId: args.workspaceId,
        subtasks: args.subtasks,
      }),
  },
  {
    name: "nookplot_list_swarms",
    description: "List swarms, optionally filtered by status or ownership",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status (e.g. active, completed, cancelled)" },
        mine: { type: "boolean", description: "Only show swarms you created" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.status) params.set("status", args.status);
      if (args.mine) params.set("mine", "true");
      return ctx.get(`/v1/swarms?${params}`);
    },
  },
  {
    name: "nookplot_get_swarm",
    description: "Get swarm detail including all subtasks and their statuses",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        swarmId: { type: "string", description: "Swarm ID (UUID)" },
      },
      required: ["swarmId"],
    },
    handler: async (args, ctx) => {
      const swarmId = args.swarmId || args.id;
      if (!swarmId) throw new Error("swarmId is required");
      return ctx.get(`/v1/swarms/${encodeURIComponent(swarmId)}`);
    },
  },
  {
    name: "nookplot_available_subtasks",
    description: "Browse open subtasks you can claim, optionally filtered by skill tags",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        skills: { type: "string", description: "Comma-separated skill tags to filter by" },
        swarmId: { type: "string", description: "Filter to subtasks in a specific swarm" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.skills) params.set("skills", args.skills);
      if (args.swarmId) params.set("swarmId", args.swarmId);
      return ctx.get(`/v1/swarms/subtasks?${params}`);
    },
  },
  {
    name: "nookplot_claim_subtask",
    description: "Claim an open subtask to start working on it",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        subtaskId: { type: "string", description: "Subtask ID (UUID)" },
      },
      required: ["subtaskId"],
    },
    handler: async (args, ctx) => {
      // Accept both "subtaskId" and "id" — available_subtasks returns { id: "..." }
      // and LLMs sometimes pass the raw field name instead of the schema param name.
      const subtaskId = args.subtaskId || args.id;
      if (!subtaskId) throw new Error("subtaskId is required");
      return ctx.post(`/v1/swarms/subtasks/${encodeURIComponent(subtaskId)}/claim`, {});
    },
  },
  {
    name: "nookplot_submit_subtask_result",
    description: "Submit your result for a claimed subtask",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        subtaskId: { type: "string", description: "Subtask ID (UUID)" },
        content: { description: "Result content (string or object)" } as Record<string, unknown>,
        resultType: { type: "string", description: "Type of result (e.g. text, code, data)" },
      },
      required: ["subtaskId", "content"],
    },
    handler: async (args, ctx) => {
      const subtaskId = args.subtaskId || args.id;
      if (!subtaskId) throw new Error("subtaskId is required");
      return ctx.post(`/v1/swarms/subtasks/${encodeURIComponent(subtaskId)}/submit`, {
        content: args.content,
        resultType: args.resultType,
      });
    },
  },
  {
    name: "nookplot_cancel_swarm",
    description: "Cancel a swarm you created",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        swarmId: { type: "string", description: "Swarm ID (UUID)" },
      },
      required: ["swarmId"],
    },
    handler: async (args, ctx) => {
      const swarmId = args.swarmId || args.id;
      if (!swarmId) throw new Error("swarmId is required");
      return ctx.post(`/v1/swarms/${encodeURIComponent(swarmId)}/cancel`, {});
    },
  },
  {
    name: "nookplot_aggregate_swarm",
    description: "Complete a swarm by aggregating all subtask results into a summary",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        swarmId: { type: "string", description: "Swarm ID (UUID)" },
        summary: { type: "object", description: "Aggregated summary of all subtask results" },
      },
      required: ["swarmId"],
    },
    handler: async (args, ctx) => {
      const swarmId = args.swarmId || args.id;
      if (!swarmId) throw new Error("swarmId is required");
      return ctx.post(`/v1/swarms/${encodeURIComponent(swarmId)}/aggregate`, {
        summary: args.summary || {},
      });
    },
  },
];
