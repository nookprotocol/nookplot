/**
 * Agent memory, forge, and email tools.
 *
 * @module tools/memory
 */

import type { ToolDef } from "./index.js";

export const memoryTools: ToolDef[] = [
  // ── Agent Memory ──
  {
    name: "nookplot_store_memory",
    description:
      "Store a memory (episodic, semantic, procedural, or self_model) to the agent's persistent memory. Use metadata for coordination state, latent space context, or swarm data.",
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
        decayRate: {
          type: "number",
          description: "Decay rate (lambda) for exponential decay. Lower = slower decay. Default: 0.1",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization. Tags 'autoresearch', 'experiment', 'insights' trigger IPFS archival",
        },
        source: { type: "string", description: "Source of the memory" },
        parentMemoryId: {
          type: "string",
          description: "UUID of a parent memory for lineage tracking (consolidation chains)",
        },
        metadata: {
          type: "object",
          description: "Arbitrary JSON metadata — coordination state, swarm context, latent space data. Preserved in IPFS archives.",
        },
      },
      required: ["content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agent-memory/store", {
        type: args.type ?? "semantic",
        content: args.content,
        importance: args.importance,
        decayRate: args.decayRate,
        tags: args.tags,
        source: args.source,
        parentMemoryId: args.parentMemoryId,
        metadata: args.metadata,
      }),
  },
  {
    name: "nookplot_recall_memory",
    description: "Semantic search across your agent memories. Response includes archivesAvailable count if you have IPFS archives.",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional memory type filter(s): episodic, semantic, procedural, self_model. Pass one or more.",
        },
        limit: { type: "number", description: "Max results (default: 10)" },
        minImportance: { type: "number", description: "Only return memories with importance >= this threshold (0-1)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agent-memory/recall", {
        query: args.query,
        types: args.types,
        limit: args.limit ?? 10,
        minImportance: args.minImportance,
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
  // ── Archive Operations ──
  {
    name: "nookplot_archive_memories",
    description: "Archive valuable memories to IPFS cold storage (0.50 credits). Frees Postgres space for new memories.",
    category: "memory",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.post("/v1/agent-memory/archive", {}),
  },
  {
    name: "nookplot_list_memory_archives",
    description: "List your IPFS memory archives (free). Returns CIDs, memory counts, and types for each archive pack.",
    category: "memory",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/agent-memory/archives"),
  },
  {
    name: "nookplot_fetch_memory_archive",
    description: "Fetch a specific memory archive pack from IPFS by CID (0.25 credits). Returns the full memory pack with all preserved context.",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "IPFS CID of the archive to fetch" },
      },
      required: ["cid"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/agent-memory/archives/${enc(args.cid)}`),
  },
  {
    name: "nookplot_prove_memory",
    description: "Get a SHA-256 cryptographic proof of a memory's content and creation time (free). Useful for verifying memory integrity.",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "UUID of the memory to prove" },
      },
      required: ["memoryId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/agent-memory/proof/${enc(args.memoryId)}`),
  },
  {
    name: "nookplot_delete_memory",
    description: "Soft-delete a memory (free). The memory becomes invisible to recall/list but is never permanently destroyed.",
    category: "memory",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "UUID of the memory to delete" },
      },
      required: ["memoryId"],
    },
    handler: async (args, ctx) =>
      ctx.delete(`/v1/agent-memory/${enc(args.memoryId)}`),
  },
];

// Every input enforces a bound that
// matches what the gateway already validates. The CID pattern covers both v0
// (Qm... base58, 46 chars) and v1 (b... base32, 59+ chars). The numeric-
// string pattern keeps `deploymentFee` from carrying a non-numeric payload
// into the prepare/relay flow.
const FORGE_ETH_ADDR_PATTERN = "^0x[a-fA-F0-9]{40}$";
const FORGE_IPFS_CID_PATTERN =
  "^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$";
const FORGE_NUMERIC_STRING_PATTERN = "^[0-9]+$";

export const forgeTools: ToolDef[] = [
  // ── Forge (on-chain agent deployment) ──
  {
    name: "nookplot_forge_deploy",
    description: "Deploy a new agent from a knowledge bundle (on-chain via prepare/sign/relay)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: {
          type: "number",
          description: "Knowledge bundle ID to deploy from (non-negative integer)",
          minimum: 0,
        },
        agentAddress: {
          type: "string",
          description: "Ethereum address of the agent being deployed (0x...)",
          pattern: FORGE_ETH_ADDR_PATTERN,
          maxLength: 42,
        },
        soulCid: {
          type: "string",
          description: "IPFS CID of the soul document (v0 Qm... or v1 b...)",
          pattern: FORGE_IPFS_CID_PATTERN,
          minLength: 46,
          maxLength: 100,
        },
        deploymentFee: {
          type: "string",
          description: "Optional deployment fee in wei (default: '0')",
          pattern: FORGE_NUMERIC_STRING_PATTERN,
          minLength: 1,
          maxLength: 40,
        },
      },
      required: ["bundleId", "agentAddress", "soulCid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/forge", {
        bundleId: args.bundleId,
        agentAddress: args.agentAddress,
        soulCid: args.soulCid,
        deploymentFee: args.deploymentFee ?? "0",
      }),
  },
  {
    name: "nookplot_forge_spawn",
    description: "Spawn a child agent from a parent agent (on-chain via prepare/sign/relay)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: {
          type: "number",
          description: "Knowledge bundle ID (non-negative integer)",
          minimum: 0,
        },
        childAddress: {
          type: "string",
          description: "Ethereum address of the child agent (0x...)",
          pattern: FORGE_ETH_ADDR_PATTERN,
          maxLength: 42,
        },
        soulCid: {
          type: "string",
          description: "IPFS CID of the child's soul document (v0 Qm... or v1 b...)",
          pattern: FORGE_IPFS_CID_PATTERN,
          minLength: 46,
          maxLength: 100,
        },
        deploymentFee: {
          type: "string",
          description: "Optional deployment fee in wei (default: '0')",
          pattern: FORGE_NUMERIC_STRING_PATTERN,
          minLength: 1,
          maxLength: 40,
        },
      },
      required: ["bundleId", "childAddress", "soulCid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/forge/spawn", {
        bundleId: args.bundleId,
        childAddress: args.childAddress,
        soulCid: args.soulCid,
        deploymentFee: args.deploymentFee ?? "0",
      }),
  },
  {
    name: "nookplot_forge_update_soul",
    description: "Update the soul document of a deployed agent (on-chain via prepare/sign/relay)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: {
          type: "string",
          description: "Deployment ID (numeric string)",
          pattern: FORGE_NUMERIC_STRING_PATTERN,
          minLength: 1,
          maxLength: 20,
        },
        soulCid: {
          type: "string",
          description: "New IPFS CID of the soul document (v0 Qm... or v1 b...)",
          pattern: FORGE_IPFS_CID_PATTERN,
          minLength: 46,
          maxLength: 100,
        },
      },
      required: ["deploymentId", "soulCid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/forge/${enc(args.deploymentId)}/soul`, {
        soulCid: args.soulCid,
      }),
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
