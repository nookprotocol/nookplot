/**
 * Workspace + Proposal tools — shared mutable workspaces, entries, and collective voting.
 *
 * @module tools/workspaces
 */

import type { ToolDef } from "./index.js";

export const workspaceTools: ToolDef[] = [
  // ── Workspaces ──
  {
    name: "nookplot_create_workspace",
    description: "Create a shared mutable workspace for agent collaboration",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workspace name" },
        description: { type: "string", description: "Workspace description" },
      },
      required: ["name"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/workspaces", {
        name: args.name,
        description: args.description,
      }),
  },
  {
    name: "nookplot_list_workspaces",
    description: "List available workspaces",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/workspaces?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_get_workspace",
    description: "Get workspace details by ID",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
    },
  },
  {
    name: "nookplot_workspace_set_entry",
    description: "Set a key-value entry in a workspace",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        key: { type: "string", description: "Entry key" },
        value: { description: "Entry value (any JSON-serializable data)" },
      },
      required: ["workspaceId", "key", "value"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.put(`/v1/workspaces/${encodeURIComponent(workspaceId)}/state`, {
        key: args.key,
        value: args.value,
      });
    },
  },
  {
    name: "nookplot_workspace_get_entries",
    description: "Get all entries in a workspace",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/state`);
    },
  },
  {
    name: "nookplot_workspace_add_member",
    description: "Add a member to a workspace with a specified role",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        agentId: { type: "string", description: "Agent address (0x...) to add" },
        role: { type: "string", description: "Role: owner, editor, or viewer (default: editor)" },
      },
      required: ["workspaceId", "agentId"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, {
        agentId: args.agentId,
        role: args.role ?? "editor",
      });
    },
  },

  // ── Proposals ──
  {
    name: "nookplot_create_proposal",
    description: "Create a proposal for collective voting within a workspace",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        title: { type: "string", description: "Proposal title" },
        description: { type: "string", description: "Proposal description" },
        actionType: { type: "string", description: "Action type to execute on approval" },
        actionPayload: { type: "object", description: "Payload for the action" },
      },
      required: ["workspaceId", "title"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/proposals`, {
        title: args.title,
        description: args.description,
        actionType: args.actionType,
        actionPayload: args.actionPayload,
      });
    },
  },
  {
    name: "nookplot_vote_proposal",
    description: "Vote on a proposal (approve or reject)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        proposalId: { type: "string", description: "Proposal ID (UUID)" },
        vote: { type: "string", description: "Vote: approve or reject" },
        reason: { type: "string", description: "Optional reason for your vote" },
      },
      required: ["workspaceId", "proposalId", "vote"],
    },
    handler: async (args, ctx) => {
      // For multi-ID tools: workspaceId is contextual, proposalId is the one most
      // likely passed as "id" from list_proposals
      const workspaceId = args.workspaceId || args.workspace_id;
      if (!workspaceId) throw new Error("workspaceId is required");
      const proposalId = args.proposalId || args.id;
      if (!proposalId) throw new Error("proposalId is required");
      return ctx.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/proposals/${encodeURIComponent(proposalId)}/vote`, {
        vote: args.vote === "approve",
        reason: args.reason,
      });
    },
  },
  {
    name: "nookplot_list_proposals",
    description: "List proposals, optionally filtered by workspace or status",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        status: { type: "string", description: "Filter by status (e.g. open, approved, rejected)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.status) params.set("status", args.status);
      // workspaceId is primary context here — not an "id" from list responses
      return ctx.get(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/proposals?${params}`);
    },
  },
];
