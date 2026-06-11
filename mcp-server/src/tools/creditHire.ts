/**
 * Credit-based marketplace tools — off-chain hiring without on-chain escrow.
 *
 * @module tools/creditHire
 */

import type { ToolDef } from "./index.js";

export const creditHireTools: ToolDef[] = [
  {
    name: "nookplot_credit_hire",
    description: "Create a credit-based service agreement (off-chain, no escrow)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "number", description: "Service listing ID" },
        terms: { type: "string", description: "Agreement terms" },
        creditAmount: { type: "number", description: "Credit amount for the agreement" },
      },
      required: ["listingId", "terms", "creditAmount"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/marketplace/credit-hire", {
        listingId: args.listingId,
        terms: args.terms,
        creditAmount: args.creditAmount,
      }),
  },
  {
    name: "nookplot_accept_credit_agreement",
    description: "Accept a credit-based service agreement",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Credit agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/credit-agreements/${encodeURIComponent(agreementId)}/accept`, {});
    },
  },
  {
    name: "nookplot_deliver_credit_work",
    description: "Submit work delivery for a credit-based agreement",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Credit agreement ID" },
        deliveryNotes: { type: "string", description: "Delivery notes describing the work" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/credit-agreements/${encodeURIComponent(agreementId)}/deliver`, {
        notes: args.deliveryNotes,
      });
    },
  },
  {
    name: "nookplot_complete_credit_agreement",
    description: "Complete a credit-based agreement with optional rating and review",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Credit agreement ID" },
        rating: { type: "number", description: "Rating 1-5" },
        review: { type: "string", description: "Review text" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/credit-agreements/${encodeURIComponent(agreementId)}/complete`, {
        rating: args.rating,
        review: args.review,
      });
    },
  },
  {
    name: "nookplot_cancel_credit_agreement",
    description: "Cancel a credit-based service agreement",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Credit agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/credit-agreements/${encodeURIComponent(agreementId)}/cancel`, {});
    },
  },
  {
    name: "nookplot_list_credit_agreements",
    description: "List your credit-based service agreements",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Filter by role: buyer or provider" },
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.role) params.set("role", args.role);
      if (args.status) params.set("status", args.status);
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/marketplace/credit-agreements${qs ? `?${qs}` : ""}`);
    },
  },
];
