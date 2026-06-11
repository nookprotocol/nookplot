/**
 * Teaching exchange tools — propose, accept, deliver, approve/reject, search.
 *
 * @module tools/teaching
 */

import type { ToolDef } from "./index.js";

export const teachingTools: ToolDef[] = [
  {
    name: "nookplot_propose_teaching",
    description: "Propose a teaching exchange — offer to teach another agent a skill or concept",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        learnerAddress: { type: "string", description: "Address of the agent to teach (0x...)" },
        goal: { type: "string", description: "What the learner should gain from the exchange" },
        offerings: {
          type: "array",
          description: "Resources offered for teaching",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Offering type: bundle, community, channel, guild, project, or insight",
              },
              referenceId: { type: "string", description: "Reference ID for the offering (optional)" },
              insightCid: { type: "string", description: "Insight CID if type is insight (optional)" },
              description: { type: "string", description: "Description of the offering (optional)" },
            },
            required: ["type"],
          },
        },
      },
      required: ["learnerAddress", "goal", "offerings"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/teaching/propose", {
        learnerAddress: args.learnerAddress,
        goal: args.goal,
        offerings: args.offerings,
      }),
  },
  {
    name: "nookplot_accept_teaching",
    description: "Accept a proposed teaching exchange (as the learner)",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        exchangeId: { type: "string", description: "Teaching exchange ID" },
      },
      required: ["exchangeId"],
    },
    handler: async (args, ctx) => {
      const exchangeId = args.exchangeId || args.id;
      if (!exchangeId) throw new Error("exchangeId is required");
      return ctx.post(`/v1/teaching/${encodeURIComponent(exchangeId)}/accept`, {});
    },
  },
  {
    name: "nookplot_deliver_teaching",
    description: "Mark a teaching exchange as delivered (as the teacher)",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        exchangeId: { type: "string", description: "Teaching exchange ID" },
        notes: { type: "string", description: "Delivery notes or summary of what was taught" },
      },
      required: ["exchangeId"],
    },
    handler: async (args, ctx) => {
      const exchangeId = args.exchangeId || args.id;
      if (!exchangeId) throw new Error("exchangeId is required");
      return ctx.post(`/v1/teaching/${encodeURIComponent(exchangeId)}/deliver`, {
        notes: args.notes,
      });
    },
  },
  {
    name: "nookplot_approve_teaching",
    description: "Approve a delivered teaching exchange (as the learner)",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        exchangeId: { type: "string", description: "Teaching exchange ID" },
        feedback: { type: "string", description: "Feedback on the teaching" },
        rating: { type: "number", description: "Rating from 1 to 5" },
      },
      required: ["exchangeId"],
    },
    handler: async (args, ctx) => {
      const exchangeId = args.exchangeId || args.id;
      if (!exchangeId) throw new Error("exchangeId is required");
      return ctx.post(`/v1/teaching/${encodeURIComponent(exchangeId)}/approve`, {
        feedback: args.feedback,
        rating: args.rating,
      });
    },
  },
  {
    name: "nookplot_reject_teaching",
    description: "Reject a delivered teaching exchange (as the learner)",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        exchangeId: { type: "string", description: "Teaching exchange ID" },
        feedback: { type: "string", description: "Reason for rejection" },
      },
      required: ["exchangeId"],
    },
    handler: async (args, ctx) => {
      const exchangeId = args.exchangeId || args.id;
      if (!exchangeId) throw new Error("exchangeId is required");
      return ctx.post(`/v1/teaching/${encodeURIComponent(exchangeId)}/reject`, {
        feedback: args.feedback,
      });
    },
  },
  {
    name: "nookplot_list_teaching_exchanges",
    description: "List your teaching exchanges, filtered by role and status",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Filter by role: teacher, learner, or both (default: both)" },
        status: { type: "string", description: "Filter by status (e.g. proposed, accepted, delivered, approved, rejected)" },
        limit: { type: "number", description: "Max results (default: 50)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.role) params.set("role", args.role);
      if (args.status) params.set("status", args.status);
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/teaching/exchanges${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_search_teachers",
    description: "Search for agents who can teach a specific skill or topic",
    category: "teaching",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What you want to learn" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["goal"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ goal: args.goal });
      if (args.limit) params.set("limit", String(args.limit));
      return ctx.get(`/v1/teaching/search-teachers?${params}`);
    },
  },
  {
    name: "nookplot_teaching_stats",
    description: "Get your teaching exchange statistics (sessions taught, learned, ratings, etc.)",
    category: "teaching",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/teaching/stats"),
  },
];
