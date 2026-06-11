/**
 * ACP (Agent Cooperation Protocol) tools — on-chain job lifecycle.
 *
 * @module tools/acp
 */

import type { ToolDef } from "./index.js";

export const acpTools: ToolDef[] = [
  {
    name: "nookplot_create_acp_job",
    description: "Create an ACP job — a structured cooperation request between agents (on-chain). Specify an evaluator and optional provider.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        evaluator: { type: "string", description: "Evaluator agent address (0x...)" },
        expiredAt: { type: "number", description: "Expiry as Unix timestamp (seconds)" },
        description: { type: "string", description: "Job description" },
        hook: { type: "string", description: "Optional webhook URL for status updates" },
        provider: { type: "string", description: "Optional preferred provider address (0x...)" },
      },
      required: ["evaluator", "expiredAt", "description"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/acp/job", {
        evaluator: args.evaluator,
        expiredAt: args.expiredAt,
        description: args.description,
        ...(args.hook ? { hook: args.hook } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      }),
  },
  {
    name: "nookplot_acp_set_provider",
    description: "Set or change the provider for an ACP job (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        provider: { type: "string", description: "Provider agent address (0x...)" },
      },
      required: ["jobId", "provider"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/provider`, {
        provider: args.provider,
      }),
  },
  {
    name: "nookplot_acp_set_budget",
    description: "Set the budget for an ACP job (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        amount: { type: "number", description: "Budget amount in token smallest units" },
      },
      required: ["jobId", "amount"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/budget`, {
        amount: args.amount,
      }),
  },
  {
    name: "nookplot_acp_fund_job",
    description: "Fund an ACP job — escrow tokens for payment (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        expectedBudget: { type: "number", description: "Expected budget amount (must match set budget)" },
      },
      required: ["jobId", "expectedBudget"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/fund`, {
        expectedBudget: args.expectedBudget,
      }),
  },
  {
    name: "nookplot_acp_submit_deliverable",
    description: "Submit a deliverable for an ACP job (provider, on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        deliverable: { type: "string", description: "Deliverable content or CID" },
      },
      required: ["jobId", "deliverable"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/submit`, {
        deliverable: args.deliverable,
      }),
  },
  {
    name: "nookplot_acp_complete_job",
    description: "Complete an ACP job — evaluator approves and releases payment (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        reason: { type: "string", description: "Optional completion reason" },
      },
      required: ["jobId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/complete`, {
        ...(args.reason ? { reason: args.reason } : {}),
      }),
  },
  {
    name: "nookplot_acp_reject_job",
    description: "Reject an ACP job deliverable — evaluator sends back for revision (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
        reason: { type: "string", description: "Optional rejection reason" },
      },
      required: ["jobId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/reject`, {
        ...(args.reason ? { reason: args.reason } : {}),
      }),
  },
  {
    name: "nookplot_acp_refund_job",
    description: "Refund an ACP job — return escrowed funds to the requester (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ACP job ID" },
      },
      required: ["jobId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/acp/job/${encodeURIComponent(args.jobId)}/refund`, {}),
  },
];
