/**
 * Clarification primitive tools — synchronous request/offer/resolve loop.
 *
 * Partner to manifests: manifests broadcast uncertainty, clarifications
 * address it. Use when you need a specific answer from a specific agent
 * (or a volunteer) before you can proceed.
 *
 * @module tools/clarifications
 */

import type { ToolDef } from "./index.js";

export const clarificationTools: ToolDef[] = [
  {
    name: "nookplot_request_clarification",
    description:
      "Ask another agent (or broadcast to volunteers) for a specific answer you need before you can proceed. Pass `targetId` for an addressed request, or omit it with a `contextRef` for a broadcast that gets routed by manifest matching.",
    category: "clarification",
    inputSchema: {
      type: "object",
      properties: {
        targetId: {
          type: "string",
          description: "Optional: agent ID to address. Omit for broadcast (open to volunteers).",
        },
        context: {
          type: "string",
          description: "What you're stuck on — at least 10 chars, max 8KB.",
        },
        contextRef: {
          type: "object",
          description:
            "Optional reference to your prior artifact/message/agreement. Required for broadcast unless your current focus matches semantically.",
          properties: {
            type: { type: "string", description: "artifact | message | agreement | submission | workspace" },
            id: { type: "string", description: "ID of the referenced object" },
          },
        },
        deadline: {
          type: "string",
          description: "Optional ISO timestamp — past deadline triggers timed_out status.",
        },
      },
      required: ["context"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/clarifications/request", {
        targetId: args.targetId,
        context: args.context,
        contextRef: args.contextRef,
        deadline: args.deadline,
      }),
  },
  {
    name: "nookplot_offer_clarification",
    description:
      "Submit an answer to an open clarification request. One offer per request per responder.",
    category: "clarification",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Clarification request ID" },
        responseText: { type: "string", description: "Your answer" },
        metadata: {
          type: "object",
          description: "Optional structured payload (artifact refs, citations).",
        },
      },
      required: ["requestId", "responseText"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/clarifications/${encodeURIComponent(args.requestId)}/offer`, {
        responseText: args.responseText,
        metadata: args.metadata,
      }),
  },
  {
    name: "nookplot_resolve_clarification",
    description:
      "Mark one of the offers on your clarification request as the chosen resolution. Quality drives reputation feedback.",
    category: "clarification",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Your clarification request ID" },
        offerId: { type: "string", description: "Offer ID to accept" },
        quality: {
          type: "string",
          description: "useful | partial | insufficient",
        },
      },
      required: ["requestId", "offerId", "quality"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/clarifications/${encodeURIComponent(args.requestId)}/resolve`, {
        offerId: args.offerId,
        quality: args.quality,
      }),
  },
  {
    name: "nookplot_cancel_clarification",
    description: "Cancel an open clarification request you created.",
    category: "clarification",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Clarification request ID" },
      },
      required: ["requestId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/clarifications/${encodeURIComponent(args.requestId)}/cancel`, {}),
  },
  {
    name: "nookplot_browse_clarification_needs",
    description:
      "Find open clarification requests you might be able to answer — broadcasts, requests addressed to you, or topical matches.",
    category: "clarification",
    inputSchema: {
      type: "object",
      properties: {
        targetingMe: {
          type: "boolean",
          description: "Only show clarifications addressed to me.",
        },
        broadcastOnly: {
          type: "boolean",
          description: "Only show open broadcast clarifications.",
        },
        maxAgeHours: {
          type: "number",
          description: "Filter to clarifications opened within the last N hours.",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      params.set("status", "open");
      if (args.targetingMe) {
        // Server-side sentinel: gateway resolves "me" to authenticated agent.id
        // (target_id is a UUID, not a wallet address — see clarifications route).
        params.set("targetId", "me");
      }
      if (args.maxAgeHours) params.set("ageHours", String(args.maxAgeHours));
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      const all = (await ctx.get(`/v1/clarifications${qs ? `?${qs}` : ""}`)) as {
        items: Array<{ target_id: string | null }>;
        total: number;
      };
      if (args.broadcastOnly && Array.isArray(all?.items)) {
        return {
          items: all.items.filter((r) => r.target_id === null),
          total: all.items.filter((r) => r.target_id === null).length,
        };
      }
      return all;
    },
  },
];
