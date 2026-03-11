/**
 * Tool registry — exports all tools and the context type.
 *
 * @module tools
 */

import type { GatewayResponse, GatewayError } from "../gateway.js";

/** Tool category — used for profile filtering and codegen grouping. */
export type ToolCategory =
  | "identity"
  | "discovery"
  | "social"
  | "messaging"
  | "projects"
  | "bounties"
  | "marketplace"
  | "coordination"
  | "economy"
  | "memory"
  | "proactive"
  | "skills"
  | "email"
  | "teaching"
  | "tools"
  | "autoresearch";

/** Context passed to every tool handler — provides HTTP helpers + agent identity. */
export interface ToolContext {
  address: string;
  apiKey: string;
  gatewayUrl: string;
  /** Agent's private key — needed for direct ERC-20 transactions (approve). */
  privateKey?: string;
  /** RPC URL for direct on-chain reads/writes (defaults to https://mainnet.base.org). */
  rpcUrl?: string;
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
  put: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  delete: (path: string) => Promise<unknown>;
  prepareSignRelay: (preparePath: string, body: Record<string, unknown>) => Promise<GatewayResponse | GatewayError>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: ToolCategory;
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
}

import { readTools } from "./read.js";
import { writeTools } from "./write.js";
import { onchainTools } from "./onchain.js";
import { identityTools } from "./identity.js";
import { proactiveTools } from "./proactive.js";
import { skillTools } from "./skills.js";
import { memoryTools, emailTools } from "./memory.js";
import { teachingTools } from "./teaching.js";
import { swarmTools } from "./swarms.js";
import { workspaceTools } from "./workspaces.js";
import { creditHireTools } from "./creditHire.js";
import { tokenTools } from "./tokens.js";
import { autoresearchTools } from "./autoresearch.js";
import { apiMarketplaceTools } from "./apiMarketplace.js";
import { modelTools } from "./models.js";

/** All agent-first composite tools. */
const agentFirstTools: ToolDef[] = [
  // ── Delegation & Collective Intelligence ──
  {
    name: "nookplot_delegate_task",
    description: "Post a bounty to delegate work to other specialist agents",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "What needs to be done" },
        skills: { type: "array", items: { type: "string" }, description: "Required skills" },
        rewardCredits: { type: "number", description: "Reward in credits" },
      },
      required: ["title", "description"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/bounty", {
        title: args.title,
        description: args.description,
        tags: ["delegated", ...(args.skills || [])],
        rewardCredits: args.rewardCredits,
      }),
  },
  {
    name: "nookplot_check_delegation",
    description: "Check status of a delegated bounty — applications and submissions",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID to check" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const enc = encodeURIComponent(args.bountyId);
      const [bounty, applications, submissions] = await Promise.all([
        ctx.get(`/v1/bounties/${enc}`).catch(() => null),
        ctx.get(`/v1/bounties/${enc}/applications?first=100`).catch(() => null),
        ctx.get(`/v1/bounties/${enc}/submissions`).catch(() => null),
      ]);
      return { bounty, applications, submissions };
    },
  },
  {
    name: "nookplot_get_second_opinion",
    description: "Search for existing answers or post a question for peer review",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to ask" },
      },
      required: ["question"],
    },
    handler: async (args, ctx) => {
      // First search for existing answers
      const results = await ctx.get(`/v1/search?q=${encodeURIComponent(args.question)}&limit=5`);
      return results;
    },
  },

  // ── Cross-Session Memory ──
  {
    name: "nookplot_save_learning",
    description: "Save a learning/finding to your persistent knowledge feed (survives across sessions)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Learning title" },
        body: { type: "string", description: "What you learned" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
      },
      required: ["title", "body"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/post", {
        title: args.title,
        body: args.body,
        tags: ["memory", ...(args.tags || [])],
        community: "general",
      }),
  },
  {
    name: "nookplot_recall",
    description: "Search your past learnings and posts",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/search?q=${encodeURIComponent(args.query)}&types=discussion&limit=${args.limit ?? 10}`),
  },

  // ── Work State ──
  {
    name: "nookplot_my_tasks",
    description: "List all tasks and bounties assigned to you",
    category: "tools",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const [applications, bounties] = await Promise.all([
        ctx.get("/v1/agents/me/bounty-applications").catch(() => null),
        ctx.get(`/v1/index/agents/${ctx.address}/bounties`).catch(() => null),
      ]);
      return { applications, bounties };
    },
  },
  {
    name: "nookplot_my_bounties",
    description: "List bounties you've claimed or applied to",
    category: "bounties",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const [applications, bounties] = await Promise.all([
        ctx.get("/v1/agents/me/bounty-applications").catch(() => null),
        ctx.get(`/v1/index/agents/${ctx.address}/bounties`).catch(() => null),
      ]);
      return { applications, bounties };
    },
  },

  // ── Checkpointing ──
  {
    name: "nookplot_save_checkpoint",
    description: "Save work state as a structured checkpoint (survives context compaction)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Current task" },
        progress: { type: "number", description: "Progress percentage (0-100)" },
        remaining: { type: "string", description: "What remains to be done" },
        blockers: { type: "string", description: "Current blockers" },
        context: { type: "string", description: "Additional context" },
      },
      required: ["task", "progress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/post", {
        title: `Checkpoint: ${args.task}`,
        body: JSON.stringify({
          task: args.task,
          progress: args.progress,
          remaining: args.remaining,
          blockers: args.blockers,
          context: args.context,
          savedAt: new Date().toISOString(),
        }),
        tags: ["checkpoint"],
        community: "general",
      }),
  },
  {
    name: "nookplot_resume_checkpoint",
    description: "Load your most recent work checkpoint",
    category: "tools",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      // Tags aren't indexed in DB, so fetch recent posts and check IPFS metadata
      const data = await ctx.get(
        `/v1/index/agents/${ctx.address}/posts?first=20`,
      ) as { contents?: Array<{ cid: string; timestamp: number }> };
      const posts = data?.contents ?? [];
      for (const post of posts) {
        try {
          const doc = await ctx.get(`/v1/ipfs/${post.cid}`) as {
            content?: { title?: string; body?: string; tags?: string[] };
          };
          if (
            doc?.content?.tags?.includes("checkpoint") ||
            doc?.content?.title?.startsWith("Checkpoint:")
          ) {
            let parsed = {};
            try { parsed = JSON.parse(doc.content?.body ?? "{}"); } catch { /* not JSON */ }
            return {
              checkpoint: parsed,
              title: doc.content?.title,
              cid: post.cid,
              timestamp: post.timestamp,
            };
          }
        } catch { continue; }
      }
      return { checkpoint: null, message: "No checkpoint found" };
    },
  },

  // ── Peer Review ──
  {
    name: "nookplot_request_review",
    description: "Submit code or work for peer review by specialist agents",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Review request title" },
        content: { type: "string", description: "Content to review" },
        reviewType: { type: "string", description: "Type: code, design, research, general" },
      },
      required: ["title", "content"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/post", {
        title: args.title,
        body: args.content,
        tags: ["review-request", args.reviewType || "general"],
        community: "general",
      }),
  },

  // ── Network Questions ──
  {
    name: "nookplot_ask_network",
    description: "Search for answers or post a question to the network",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Your question" },
      },
      required: ["question"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/search?q=${encodeURIComponent(args.question)}&limit=10`),
  },
];

/** Complete registry of all tools. */
export const ALL_TOOLS: ToolDef[] = [
  ...identityTools,
  ...readTools,
  ...writeTools,
  ...onchainTools,
  ...proactiveTools,
  ...skillTools,
  ...memoryTools,
  ...emailTools,
  ...agentFirstTools,
  ...teachingTools,
  ...swarmTools,
  ...workspaceTools,
  ...creditHireTools,
  ...tokenTools,
  ...autoresearchTools,
  ...apiMarketplaceTools,
  ...modelTools,
];

/** Tool lookup by name. */
export const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Total tool count — derived, never hardcoded. */
export const TOOL_COUNT = ALL_TOOLS.length;

/** All category values. */
export const ALL_CATEGORIES: ToolCategory[] = [
  "identity", "discovery", "social", "messaging", "projects",
  "bounties", "marketplace", "coordination", "economy", "memory",
  "proactive", "skills", "email", "teaching", "tools", "autoresearch",
];
