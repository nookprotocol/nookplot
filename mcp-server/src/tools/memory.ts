/**
 * Agent memory and email tools.
 *
 * @module tools/memory
 */

import type { ToolDef } from "./index.js";

export const memoryTools: ToolDef[] = [
  // ── Agent Memory ──
  {
    name: "nookplot_store_memory",
    description:
      "Store a memory (episodic, semantic, procedural, or self_model) to the agent's persistent memory",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Memory type: episodic, semantic, procedural, or self_model (default: semantic)",
        },
        content: { type: "string", description: "Memory content to store" },
        importance: {
          type: "number",
          description: "Importance score from 0 to 1",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        source: { type: "string", description: "Source of the memory" },
      },
      required: ["content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agent-memory/store", {
        type: args.type ?? "semantic",
        content: args.content,
        importance: args.importance,
        tags: args.tags,
        source: args.source,
      }),
  },
  {
    name: "nookplot_recall_memory",
    description: "Semantic search across your agent memories",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        type: {
          type: "string",
          description:
            "Optional memory type filter: episodic, semantic, procedural, or self_model",
        },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agent-memory/recall", {
        query: args.query,
        // Gateway expects "types" (plural array), not "type" (singular string)
        types: args.type ? [args.type] : undefined,
        limit: args.limit ?? 10,
      }),
  },
  {
    name: "nookplot_list_memories",
    description: "List memories by type",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Optional memory type filter: episodic, semantic, procedural, or self_model",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.type) params.set("type", args.type);
      return ctx.get(`/v1/agent-memory/list?${params}`);
    },
  },
  {
    name: "nookplot_memory_stats",
    description: "Get memory capacity and usage stats",
    category: "memory",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/agent-memory/stats"),
  },
  {
    name: "nookplot_export_memories",
    description: "Export all memories as a portable memory pack",
    category: "memory",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.post("/v1/agent-memory/export", {}),
  },
  {
    name: "nookplot_import_memories",
    description: "Import a previously exported memory pack",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        pack: { type: "object", description: "Memory pack object (with memories array and packHash)" },
      },
      required: ["pack"],
    },
    handler: async (args, ctx) =>
      // Gateway expects MemoryPack at top level, not wrapped in { pack }
      ctx.post("/v1/agent-memory/import", args.pack),
  },
];

export const emailTools: ToolDef[] = [
  // ── Email (@agent.nookplot.com) ──
  {
    name: "nookplot_create_email_inbox",
    description: "Create an email inbox to get a @agent.nookplot.com email address",
    category: "email",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Desired username (will become username@agent.nookplot.com)" },
        displayName: { type: "string", description: "Display name for the inbox" },
        autoReply: { type: "string", description: "Optional auto-reply message for incoming emails" },
      },
      required: ["username"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/email/inbox", {
        username: args.username,
        displayName: args.displayName,
        autoReply: args.autoReply,
      }),
  },
  {
    name: "nookplot_send_email",
    description: "Send an email from your @agent.nookplot.com inbox",
    category: "email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        bodyText: { type: "string", description: "Email body (plain text)" },
        bodyHtml: { type: "string", description: "Optional HTML body" },
        cc: { type: "string", description: "Optional CC email address" },
      },
      required: ["to", "subject", "bodyText"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/email/send", {
        to: args.to,
        subject: args.subject,
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        cc: args.cc,
      }),
  },
  {
    name: "nookplot_reply_email",
    description: "Reply to a received email",
    category: "email",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "ID of the email to reply to" },
        bodyText: { type: "string", description: "Reply body (plain text)" },
        bodyHtml: { type: "string", description: "Optional HTML body" },
      },
      required: ["messageId", "bodyText"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/email/${enc(args.messageId)}/reply`, {
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
      }),
  },
  {
    name: "nookplot_check_email",
    description: "Check your email inbox for messages",
    category: "email",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", description: "Filter: inbound or outbound" },
        status: { type: "string", description: "Filter: unread or read" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.direction) params.set("direction", args.direction);
      if (args.status) params.set("status", args.status);
      if (args.limit) params.set("limit", String(args.limit));
      return ctx.get(`/v1/email/messages?${params}`);
    },
  },
  {
    name: "nookplot_get_email_inbox",
    description: "Get your email inbox details and settings",
    category: "email",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/email/inbox"),
  },
];

function enc(s: string): string {
  return encodeURIComponent(s);
}
