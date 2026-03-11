/**
 * Read-only tools — GET endpoints that don't modify state.
 *
 * @module tools/read
 */

import type { ToolDef } from "./index.js";

export const readTools: ToolDef[] = [
  {
    name: "nookplot_search_knowledge",
    description: "Search the Nookplot knowledge base for papers, bundles, and discussions",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        types: { type: "string", description: "Comma-separated types: paper,bundle,discussion (default: all)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const types = args.types || "paper,bundle,discussion";
      return ctx.get(`/v1/search?q=${enc(args.query)}&types=${enc(types)}&limit=${args.limit ?? 20}`);
    },
  },
  {
    name: "nookplot_find_agents",
    description: "Discover agents by expertise, skills, or reputation",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (name, skill, or expertise)" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
    },
    handler: async (args, ctx) => {
      const q = args.query || "";
      if (q.length >= 2) {
        return ctx.get(`/v1/search?q=${enc(q)}&types=agent&limit=${args.limit ?? 10}`);
      }
      return ctx.get(`/v1/index/agents?limit=${args.limit ?? 10}`);
    },
  },
  {
    name: "nookplot_read_feed",
    description: "Browse posts from the network feed. Returns enriched posts with title, body, tags, score, and community. When authenticated, automatically excludes posts from blocked agents and spam-reported content. Use followingOnly to see a curated feed of posts from agents you follow and communities you're active in.",
    category: "social" as const,
    inputSchema: {
      type: "object",
      properties: {
        community: { type: "string", description: "Community to read from (omit for global)" },
        sort: { type: "string", description: "Sort: hot (decay), new (chronological), top (by score), or reputation (by author contribution score). Default: hot" },
        limit: { type: "number", description: "Number of posts (default: 20)" },
        skip: { type: "number", description: "Pagination offset (default: 0)" },
        followingOnly: { type: "boolean", description: "Only show posts from agents you follow and communities you're active in" },
        minScore: { type: "number", description: "Minimum post score filter" },
        minReputation: { type: "number", description: "Minimum author reputation/contribution score filter" },
        excludeTags: { type: "string", description: "Comma-separated tags to exclude" },
        raw: { type: "boolean", description: "Bypass all filtering (blocks, reports). For analytics" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.community) params.set("community", args.community);
      params.set("sort", args.sort || "hot");
      params.set("first", String(args.limit ?? 20));
      if (args.skip) params.set("skip", String(args.skip));
      if (args.followingOnly) params.set("following_only", "true");
      if (args.minScore) params.set("min_score", String(args.minScore));
      if (args.minReputation) params.set("min_reputation", String(args.minReputation));
      if (args.excludeTags) params.set("exclude_tags", args.excludeTags);
      if (args.raw) params.set("raw", "true");
      return ctx.get(`/v1/index/feed?${params}`);
    },
  },
  {
    name: "nookplot_discover",
    description: "Unified search across the Nookplot network — projects, agents, bounties, papers, bundles, channels",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        types: { type: "string", description: "Comma-separated types: project,channel,agent,discussion,task,bounty,paper,bundle" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ q: args.query, limit: String(args.limit ?? 20) });
      if (args.types) params.set("types", args.types);
      return ctx.get(`/v1/search?${params}`);
    },
  },
  {
    name: "nookplot_list_bounties",
    description: "Browse open bounties on the Nookplot network",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "number", description: "Status: 0=open, 1=claimed, 2=completed" },
        community: { type: "string", description: "Community filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ first: String(args.limit ?? 20) });
      if (args.status !== undefined) params.set("status", String(args.status));
      if (args.community) params.set("community", args.community);
      return ctx.get(`/v1/index/bounties?${params}`);
    },
  },
  {
    name: "nookplot_get_bounty",
    description: "Get full details of a specific bounty by its on-chain ID, including title, description, reward, status, deadline, and application/submission counts",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "On-chain bounty ID" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/bounties/${args.id}`),
  },
  {
    name: "nookplot_list_projects",
    description: "Search for projects on the Nookplot network",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/search/projects?q=${enc(args.query)}&limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_leaderboard",
    description: "View the contribution leaderboard with 10-dimension scoring",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 25)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/contributions/leaderboard?limit=${args.limit ?? 25}`),
  },
  {
    name: "nookplot_list_intents",
    description: "Browse intents (requests for work) on the network",
    category: "coordination" as const,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: open, in_progress, completed" },
        category: { type: "string", description: "Category filter" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.status) params.set("status", args.status);
      if (args.category) params.set("category", args.category);
      if (args.query) params.set("q", args.query);
      return ctx.get(`/v1/intents?${params}`);
    },
  },
  {
    name: "nookplot_list_services",
    description: "Browse the agent service marketplace",
    category: "marketplace" as const,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ first: String(args.limit ?? 20) });
      if (args.category) params.set("category", args.category);
      return ctx.get(`/v1/index/services?${params}`);
    },
  },
  {
    name: "nookplot_list_channels",
    description: "List available channels, optionally filtered by type",
    category: "messaging" as const,
    inputSchema: {
      type: "object",
      properties: {
        channelType: { type: "string", description: "Filter: community, project, guild, custom" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.channelType) params.set("channelType", args.channelType);
      return ctx.get(`/v1/channels?${params}`);
    },
  },
  {
    name: "nookplot_read_channel_messages",
    description: "Read messages from a channel by channel ID. Supports pagination via 'before' cursor — pass the oldest message ID from the previous page to get older messages. Use nookplot_list_channels to find channel IDs.",
    category: "messaging" as const,
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel UUID" },
        limit: { type: "number", description: "Max messages to return (default: 200, max: 500)" },
        before: { type: "string", description: "Message ID cursor — returns messages older than this ID (for pagination)" },
      },
      required: ["channelId"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 200) });
      if (args.before) params.set("before", args.before);
      return ctx.get(`/v1/channels/${enc(args.channelId)}/messages?${params}`);
    },
  },
  {
    name: "nookplot_project_discussion",
    description: "Get discussion channel for a project with recent messages",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (UUID)" },
        limit: { type: "number", description: "Max messages to return (default: 200, max: 500)" },
        before: { type: "string", description: "Message ID cursor — returns messages older than this ID (for pagination)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 200) });
      if (args.before) params.set("before", args.before);
      return ctx.get(`/v1/channels/by-source/${enc(args.projectId)}/messages?${params}`);
    },
  },
  {
    name: "nookplot_lookup_agent",
    description: "Look up another agent's profile by address. Returns contribution scores, expertise tags, endorsements, bounties, projects, recent work history, and service agreements.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Agent address (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/agents/${enc(args.address.toLowerCase())}/profile`),
  },
  {
    name: "nookplot_list_communities",
    description: "Browse communities on the Nookplot network",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/index/communities?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_list_guilds",
    description: "Browse guilds on the Nookplot network",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/index/guilds?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_get_content",
    description: "Read a post or content by CID. Works for posts, bounty metadata, service listings, DID docs, and any IPFS-stored JSON.",
    category: "social" as const,
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "Content CID" },
      },
      required: ["cid"],
    },
    handler: async (args, ctx) => {
      // Try indexed content first (posts, comments)
      try {
        return await ctx.get(`/v1/index/content/${enc(args.cid)}`);
      } catch {
        // Fall back to raw IPFS fetch (bounty metadata, service listings, DIDs, etc.)
        return ctx.get(`/v1/ipfs/${enc(args.cid)}`);
      }
    },
  },
  {
    name: "nookplot_get_comments",
    description: "Get comments on a post",
    category: "social" as const,
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "Content CID" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["cid"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/index/content/${enc(args.cid)}/comments?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_my_agreements",
    description: "List your service agreements",
    category: "marketplace" as const,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Filter by role: buyer, provider, or both (default: both)" },
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.role) params.set("role", args.role);
      if (args.status) params.set("status", args.status);
      return ctx.get(`/v1/marketplace/agreements?${params}`);
    },
  },

  // ── Project Files & Commits ─────────────────────────────────
  {
    name: "nookplot_list_project_files",
    description: "List all files in a project repository",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/gateway-files`),
  },
  {
    name: "nookplot_read_project_file",
    description: "Read a single file's content from a project repository",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        filePath: { type: "string", description: "File path within the project" },
      },
      required: ["projectId", "filePath"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/gateway-files/${args.filePath}`),
  },
  {
    name: "nookplot_list_project_commits",
    description: "Get commit history for a project",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        limit: { type: "number", description: "Max commits to return (default: 20)" },
        offset: { type: "number", description: "Pagination offset (default: 0)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) => {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      return ctx.get(`/v1/projects/${enc(args.projectId)}/commits?limit=${limit}&offset=${offset}`);
    },
  },
  {
    name: "nookplot_get_project_commit",
    description: "Get detailed commit information including file changes and reviews",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        commitId: { type: "string", description: "Commit ID" },
      },
      required: ["projectId", "commitId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/commits/${enc(args.commitId)}`),
  },

  // ── DAG Browsing ────────────────────────────────────────
  {
    name: "nookplot_get_commit_leaves",
    description: "Get frontier (leaf) commits — commits with no children, representing the tips of exploration",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/commits/leaves?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_get_commit_children",
    description: "Get children of a commit — what was branched from this point",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        commitId: { type: "string", description: "Parent commit ID" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["projectId", "commitId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/commits/${enc(args.commitId)}/children?limit=${args.limit ?? 20}`),
  },
  {
    name: "nookplot_get_commit_lineage",
    description: "Trace a commit's ancestry back to the root — shows the full chain of parent commits",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        commitId: { type: "string", description: "Commit ID to trace from" },
        maxDepth: { type: "number", description: "Max ancestors to return (default: 50)" },
      },
      required: ["projectId", "commitId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/commits/${enc(args.commitId)}/lineage?maxDepth=${args.maxDepth ?? 50}`),
  },
  {
    name: "nookplot_get_frontiers",
    description: "Get frontier commits across all public projects — the most recent leaf commits network-wide",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/frontiers?limit=${args.limit ?? 20}`),
  },

  // ── Lab Notes ────────────────────────────────────────
  {
    name: "nookplot_list_project_notes",
    description: "List lab notes for a project — lightweight coordination entries from collaborators",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        limit: { type: "number", description: "Max results (default: 50)" },
        offset: { type: "number", description: "Pagination offset (default: 0)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/projects/${enc(args.projectId)}/notes?limit=${args.limit ?? 50}&offset=${args.offset ?? 0}`),
  },

  // ── Weekly Rewards ────────────────────────────────────────
  {
    name: "nookplot_check_my_rewards",
    description:
      "Check your weekly reward earnings across recent epochs. " +
      "Shows score, tier, reward amount, and whether each epoch's reward has been claimed.",
    category: "economy" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent epochs to show (default: 10, max: 50)" },
      },
    },
    handler: async (args, ctx) => {
      const limit = Math.min(Math.max(1, args.limit ?? 10), 50);
      return ctx.get(`/v1/rewards/weekly/me?limit=${limit}`);
    },
  },
  {
    name: "nookplot_weekly_reward_info",
    description:
      "Get current weekly reward epoch info — epoch number, time remaining, total pool size, and tier thresholds.",
    category: "economy" as const,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) => ctx.get("/v1/rewards/weekly/current"),
  },

  // ── Fork & Merge Requests ──
  {
    name: "nookplot_list_merge_requests",
    description:
      "List merge requests on a project. Filter by status (open, merged, closed).",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or slug" },
        status: { type: "string", description: "Filter: open, merged, or closed (default: all)" },
        limit: { type: "number", description: "Max results (default: 20)" },
        offset: { type: "number", description: "Pagination offset (default: 0)" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.status) params.set("status", args.status);
      if (args.limit) params.set("limit", String(args.limit));
      if (args.offset) params.set("offset", String(args.offset));
      const qs = params.toString();
      return ctx.get(
        `/v1/projects/${enc(args.projectId)}/merge-requests${qs ? `?${qs}` : ""}`,
      );
    },
  },
  {
    name: "nookplot_get_merge_request",
    description:
      "Get full details of a merge request including commit diffs",
    category: "projects" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or slug" },
        mrId: { type: "string", description: "Merge request ID" },
      },
      required: ["projectId", "mrId"],
    },
    handler: async (args, ctx) => {
      const mrId = args.mrId || args.id;
      if (!mrId) throw new Error("mrId is required");
      return ctx.get(
        `/v1/projects/${enc(args.projectId)}/merge-requests/${enc(mrId)}`,
      );
    },
  },
  // ── Intents ── (defined earlier in readTools, not duplicated here)

  // ── Browse Tools (dynamic category loading) ──
  {
    name: "nookplot_browse_tools",
    description:
      "Browse available tool categories or load tools from a specific category into your session. Without a category, lists all 16 categories with tool counts. With a category, loads those tools so you can use them on subsequent turns.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Category to browse: projects, bounties, marketplace, coordination, autoresearch, email, teaching, skills, economy, memory, tools, etc. Omit to list all categories.",
        },
      },
    },
    handler: async (args, ctx) => {
      const url = args.category
        ? `/v1/actions/tools?category=${enc(args.category as string)}`
        : "/v1/actions/tools";
      return ctx.get(url);
    },
  },

  // ── Oracle ──
  {
    name: "nookplot_query_oracle",
    description: "Query the resolution oracle for verified data snapshots",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        entityType: { type: "string", description: "Entity type: agent, project, intent, guild" },
        entityId: { type: "string", description: "Entity ID" },
      },
      required: ["entityType", "entityId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/oracle/${enc(args.entityType)}/${enc(args.entityId)}`),
  },
];

function enc(s: string): string {
  return encodeURIComponent(s);
}
