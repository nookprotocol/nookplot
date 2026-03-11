/**
 * Proactive tools — signals, approvals, config.
 *
 * @module tools/proactive
 */

import type { ToolDef } from "./index.js";

export const proactiveTools: ToolDef[] = [
  {
    name: "nookplot_get_pending_signals",
    description: "Get pending proactive actions awaiting your approval",
    category: "proactive",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/proactive/approvals"),
  },
  {
    name: "nookplot_poll_signals",
    description: "Poll for queued signals that were emitted while offline or between sessions. Returns signals that have not yet been acknowledged.",
    category: "proactive",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max signals to return (default 50, max 200)" },
      },
    },
    handler: async (args, ctx) => {
      const limit = args.limit ? `?limit=${args.limit}` : "";
      return ctx.get(`/v1/proactive/pending-signals${limit}`);
    },
  },
  {
    name: "nookplot_ack_signal",
    description: "Acknowledge a queued signal (mark as delivered/processed)",
    category: "proactive",
    inputSchema: {
      type: "object",
      properties: {
        signalId: { type: "string", description: "Signal ID to acknowledge" },
      },
      required: ["signalId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/proactive/signals/${encodeURIComponent(args.signalId)}/ack`, {}),
  },
  {
    name: "nookplot_approve_action",
    description: "Approve a pending proactive action",
    category: "proactive",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "Action ID to approve" },
      },
      required: ["actionId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/proactive/approvals/${encodeURIComponent(args.actionId)}/approve`, {}),
  },
  {
    name: "nookplot_reject_action",
    description: "Reject a pending proactive action",
    category: "proactive",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "Action ID to reject" },
        reason: { type: "string", description: "Rejection reason" },
      },
      required: ["actionId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/proactive/approvals/${encodeURIComponent(args.actionId)}/reject`, {
        reason: args.reason,
      }),
  },
  {
    name: "nookplot_configure_proactive",
    description: "Configure proactive scanning settings",
    category: "proactive",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Enable/disable proactive scanning" },
        scanIntervalMinutes: { type: "number", description: "Scan interval in minutes" },
        maxActionsPerDay: { type: "number", description: "Max actions per day" },
        callbackFormat: { type: "string", description: "Callback payload format: raw, agent-hook, openai, or generic" },
      },
    },
    handler: async (args, ctx) =>
      ctx.put("/v1/proactive/settings", {
        enabled: args.enabled,
        scanIntervalMinutes: args.scanIntervalMinutes,
        maxActionsPerDay: args.maxActionsPerDay,
        callbackFormat: args.callbackFormat,
      }),
  },
];
