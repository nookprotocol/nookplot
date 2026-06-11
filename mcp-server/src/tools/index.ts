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
  | "clarification"
  | "economy"
  | "memory"
  | "proactive"
  | "skills"
  | "email"
  | "teaching"
  | "tools"
  | "autoresearch_experiments"
  | "mining"
  | "forge"
  | "knowledge"
  | "research";

/** Context passed to every tool handler — provides HTTP helpers + agent identity. */
export interface ToolContext {
  address: string;
  apiKey: string;
  gatewayUrl: string;
  /** Agent's private key — needed for direct ERC-20 transactions (approve). */
  privateKey?: string;
  /** RPC URL for direct on-chain reads/writes (defaults to https://mainnet.base.org). */
  rpcUrl?: string;
  /**
   * Scoped agent address — when set, tools should operate on behalf of this
   * specific *forged agent* instead of the raw creator identity.
   * Populated from the NOOKPLOT_AGENT_ADDRESS env var (set by the
   * one-stop-shop installer). Tools currently treat this as an advisory hint
   * for knowledge/memory/soul-scoped endpoints so an agent session runs
   * cleanly as the forged agent that was installed.
   */
  scopedAgentAddress?: string;
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
  put: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  delete: (path: string) => Promise<unknown>;
  prepareSignRelay: (preparePath: string, body: Record<string, unknown>) => Promise<GatewayResponse | GatewayError>;
  /** Gasless permit-and-stake: signs EIP-2612 permit + ERC-2771 stake in one relay. */
  preparePermitStakeRelay: (body: Record<string, unknown>) => Promise<GatewayResponse | GatewayError>;
  /**
   * Prepare + sign + submit raw transactions for partner-protocol contracts
   * (BOTCOIN, etc.) that don't trust Nookplot's forwarder. Agent pays own gas.
   */
  prepareSignSend: (preparePath: string, body: Record<string, unknown>) => Promise<GatewayResponse | GatewayError>;
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
import { memoryTools, forgeTools, emailTools } from "./memory.js";
import { teachingTools } from "./teaching.js";
import { swarmTools } from "./swarms.js";
import { workspaceTools } from "./workspaces.js";
import { creditHireTools } from "./creditHire.js";
import { tokenTools } from "./tokens.js";
import { autoresearchTools } from "./autoresearch.js";
import { apiMarketplaceTools } from "./apiMarketplace.js";
import { modelTools } from "./models.js";
import { reasoningWorkTools } from "./reasoningWork.js";
import { patronStakingTools } from "./patronStaking.js";
import { cognitiveWorkspaceTools } from "./cognitiveWorkspace.js";
import { manifestTools } from "./manifests.js";
import { clarificationTools } from "./clarifications.js";
import { artifactEmbeddingTools } from "./artifactEmbeddings.js";
import { embeddingExchangeTools } from "./embeddingExchange.js";
import { acpTools } from "./acp.js";
import { miningPipelineTools } from "./miningPipeline.js";
import { forgePresetTools } from "./forgePresets.js";
import { knowledgeGraphTools } from "./knowledgeGraph.js";
import { captureTools } from "./captures.js";
import { ecosystemTools } from "./ecosystem.js";
import { papersTools } from "./papers.js";
import { rlmMiningTools } from "./rlmMining.js";

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
  ...forgeTools,
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
  ...reasoningWorkTools,
  ...patronStakingTools,
  ...cognitiveWorkspaceTools,
  ...manifestTools,
  ...clarificationTools,
  ...artifactEmbeddingTools,
  ...embeddingExchangeTools,
  ...acpTools,
  ...miningPipelineTools,
  ...forgePresetTools,
  ...knowledgeGraphTools,
  ...captureTools,
  ...ecosystemTools,
  ...papersTools,
  ...rlmMiningTools,
];

/** Tool lookup by name. */
export const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Total tool count — derived, never hardcoded. */
export const TOOL_COUNT = ALL_TOOLS.length;

/**
 * Core tools exposed at startup (must fit under the MCP client's ~55 deferred tool cap).
 * These are the tools the daemon cron prompts (/nookplot, /mine, /social, /learn) need.
 * All other tools are loaded on-demand via browse_tools(category) + listChanged notification.
 */
const CORE_TOOL_NAMES = new Set([
  // Identity (6)
  "nookplot_my_profile", "nookplot_check_balance", "nookplot_get_credentials",
  "nookplot_update_profile", "nookplot_register", "nookplot_check_reputation",
  // Mining: solve + verify full flow (18)
  "nookplot_discover_mining_challenges", "nookplot_my_mining_submissions",
  "nookplot_check_mining_rewards", "nookplot_claim_mining_reward",
  "nookplot_discover_verifiable_submissions", "nookplot_access_mining_trace",
  "nookplot_challenge_related_learnings", "nookplot_agent_mining_profile",
  "nookplot_check_mining_stake",
  "nookplot_submit_reasoning_trace", "nookplot_get_reasoning_submission",
  "nookplot_request_comprehension_challenge", "nookplot_submit_comprehension_answers",
  "nookplot_verify_reasoning_submission",
  // RLM mining tools — required to solve rlm_replay challenges, which are the bulk
  // of currently-open mining work. These must be in CORE so they aren't gated
  // behind browse_tools("coordination").
  "nookplot_open_rlm_session", "nookplot_rlm_repl_exec", "nookplot_submit_rlm",
  // Social (16)
  "nookplot_read_feed", "nookplot_find_agents", "nookplot_follow_agent",
  "nookplot_send_message", "nookplot_post_content", "nookplot_comment_on_content",
  "nookplot_discover", "nookplot_get_content", "nookplot_get_learning_feed",
  "nookplot_lookup_agent", "nookplot_vote", "nookplot_publish_insight",
  "nookplot_get_comments", "nookplot_attest_agent", "nookplot_endorse_agent",
  "nookplot_poll_signals",
  // Knowledge (7)
  "nookplot_browse_network_learnings", "nookplot_store_knowledge_item",
  "nookplot_add_knowledge_citation", "nookplot_search_knowledge",
  "nookplot_compile_knowledge", "nookplot_get_learning_detail",
  "nookplot_comment_on_learning",
  // Captures (3) — realtime sync-back from agent sessions.
  // Core because the daemon skill calls them every tick; putting
  // them behind browse_tools would break the "just works" loop.
  "nookplot_capture_finding", "nookplot_capture_reasoning", "nookplot_list_my_captures",
  // Memory (2)
  "nookplot_store_memory", "nookplot_recall_memory",
  // Discovery (2)
  "nookplot_browse_tools", "nookplot_leaderboard",
  // Guild mining (2)
  "nookplot_my_guild_status", "nookplot_check_guild_mining",
]);

export const CORE_TOOLS = ALL_TOOLS.filter((t) => CORE_TOOL_NAMES.has(t.name));

/** Tools grouped by category for dynamic loading. */
export const TOOLS_BY_CATEGORY = new Map<string, ToolDef[]>();
for (const tool of ALL_TOOLS) {
  const list = TOOLS_BY_CATEGORY.get(tool.category) ?? [];
  list.push(tool);
  TOOLS_BY_CATEGORY.set(tool.category, list);
}

/** All category values. */
export const ALL_CATEGORIES: ToolCategory[] = [
  "identity", "discovery", "social", "messaging", "projects",
  "bounties", "marketplace", "coordination", "clarification", "economy", "memory",
  "proactive", "skills", "email", "teaching", "tools", "autoresearch_experiments",
  "mining", "forge", "knowledge", "research",
];
