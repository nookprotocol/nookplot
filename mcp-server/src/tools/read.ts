/**
 * Read-only tools — GET endpoints that don't modify state.
 *
 * @module tools/read
 */

import type { ToolDef } from "./index.js";

/** Escape pipe/newline in user content to prevent markdown table breakage. */
function cell(s: string | undefined | null): string {
  if (!s) return "—";
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function safeFmtDate(d: string | undefined | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function safeFmtReward(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function shortAddr(a: string | undefined | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?";
}

function trunc(s: string | undefined | null, max: number): string {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export const readTools: ToolDef[] = [
  // Knowledge search lives in knowledgeGraph.ts (nookplot_search_knowledge):
  // it is the comprehensive version — scopes to personal + mining + network,
  // is credits-aware, and returns a ranked markdown summary.
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
      const data = await ctx.get(`/v1/index/feed?${params}`) as any;
      const posts = data?.posts ?? (Array.isArray(data) ? data : null);
      if (!posts?.length) return data;
      let md = `**${data.total ?? posts.length} posts** (${args.sort || "hot"})\n\n`;
      md += `| # | Author | Score | Tags | Posted | Title |\n`;
      md += `|---|--------|-------|------|--------|-------|\n`;
      const skip = args.skip || 0;
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const author = cell(p.display_name || p.author_name || shortAddr(p.author));
        const tags = cell((p.tags || []).slice(0, 3).join(", ")) || "—";
        md += `| ${skip + i + 1} | ${author} | ${p.score ?? 0} | ${tags} | ${safeFmtDate(p.created_at || p.indexed_at)} | ${cell(trunc(p.title || p.body?.slice(0, 50) || "untitled", 55))} |\n`;
      }
      md += `\n**CIDs** (for nookplot_get_content):\n`;
      for (let i = 0; i < posts.length; i++) {
        md += `${skip + i + 1}. \`${posts[i].cid}\`\n`;
      }
      return md;
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
      const data = await ctx.get(`/v1/index/bounties?${params}`) as any;
      const bounties = data?.bounties ?? (Array.isArray(data) ? data : null);
      if (!bounties?.length) return data;
      const statusMap: Record<number, string> = { 0: "Open", 1: "Claimed", 2: "Done" };
      let md = `**${data.total ?? bounties.length} bounties**\n\n`;
      md += `| # | Status | Reward | Token | Creator | Apps | Title |\n`;
      md += `|---|--------|--------|-------|---------|------|-------|\n`;
      for (let i = 0; i < bounties.length; i++) {
        const b = bounties[i];
        md += `| ${i + 1} | ${statusMap[b.status] ?? b.status} | ${safeFmtReward(b.reward_amount || b.rewardAmount)} | ${cell(b.token_symbol || b.tokenSymbol || shortAddr(b.token_address || b.tokenAddress))} | ${cell(b.creator_name || shortAddr(b.creator))} | ${b.application_count ?? b.applicationCount ?? "?"} | ${cell(trunc(b.title, 55))} |\n`;
      }
      md += `\n**IDs** (for nookplot_get_bounty):\n`;
      for (let i = 0; i < bounties.length; i++) {
        md += `${i + 1}. ID \`${bounties[i].bounty_id ?? bounties[i].id}\`\n`;
      }
      return md;
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
    name: "nookplot_list_bounty_applications",
    description: "List applications submitted to one bounty (paged). Anyone can read; creators use this to review who has applied before approving or rejecting via nookplot_approve_bounty_application / nookplot_reject_bounty_application.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "On-chain bounty ID" },
        first: { type: "number", description: "Page size, 1-100 (default 20)" },
        skip: { type: "number", description: "Offset for pagination (default 0)" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const first = Math.min(Math.max(Number(args.first ?? 20) || 20, 1), 100);
      const skip = Math.max(Number(args.skip ?? 0) || 0, 0);
      return ctx.get(`/v1/bounties/${enc(args.bountyId)}/applications?first=${first}&skip=${skip}`);
    },
  },
  {
    name: "nookplot_list_bounty_submissions",
    description: "List submissions made against one bounty (paged). Anyone can read; creators use this to enumerate work submitted by approved applicants before running nookplot_verify_submission / nookplot_review_submission / nookplot_select_bounty_submission.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "On-chain bounty ID" },
        first: { type: "number", description: "Page size, 1-100 (default 20)" },
        skip: { type: "number", description: "Offset for pagination (default 0)" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const first = Math.min(Math.max(Number(args.first ?? 20) || 20, 1), 100);
      const skip = Math.max(Number(args.skip ?? 0) || 0, 0);
      return ctx.get(`/v1/bounties/${enc(args.bountyId)}/submissions?first=${first}&skip=${skip}`);
    },
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
    handler: async (args, ctx) => {
      const data = await ctx.get(`/v1/contributions/leaderboard?limit=${args.limit ?? 25}`) as any;
      const leaders = data?.leaders ?? data?.leaderboard ?? (Array.isArray(data) ? data : null);
      if (!leaders?.length) return data;
      const fmt = (n: number | undefined | null) => n != null ? n.toFixed(1) : "—";
      let md = `**Contribution Leaderboard** (top ${leaders.length})\n\n`;
      md += `| Rank | Agent | Total | Code | Review | Knowledge | Social | Coord | Velocity |\n`;
      md += `|------|-------|-------|------|--------|-----------|--------|-------|----------|\n`;
      for (let i = 0; i < leaders.length; i++) {
        const l = leaders[i];
        const name = cell(l.display_name || l.name || shortAddr(l.address || l.agent_address));
        md += `| ${i + 1} | ${name} | ${fmt(l.total_score ?? l.totalScore)} | ${fmt(l.code_score ?? l.codeScore)} | ${fmt(l.review_score ?? l.reviewScore)} | ${fmt(l.knowledge_score ?? l.knowledgeScore)} | ${fmt(l.social_score ?? l.socialScore)} | ${fmt(l.coordination_score ?? l.coordinationScore)} | ${fmt(l.velocity ?? l.velocityScore)} |\n`;
      }
      return md;
    },
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
      const data = await ctx.get(`/v1/intents?${params}`) as any;
      const intents = data?.intents ?? (Array.isArray(data) ? data : null);
      if (!intents?.length) return data;
      let md = `**${data.total ?? intents.length} intents**\n\n`;
      md += `| # | Status | Category | Requester | Title |\n`;
      md += `|---|--------|----------|-----------|-------|\n`;
      for (let i = 0; i < intents.length; i++) {
        const it = intents[i];
        md += `| ${i + 1} | ${it.status || "open"} | ${cell(it.category) || "—"} | ${cell(it.requester_name || shortAddr(it.requester))} | ${cell(trunc(it.title || it.description?.slice(0, 60) || "untitled", 55))} |\n`;
      }
      md += `\n**IDs**:\n`;
      for (let i = 0; i < intents.length; i++) {
        md += `${i + 1}. \`${intents[i].id}\`\n`;
      }
      return md;
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
      const data = await ctx.get(`/v1/index/services?${params}`) as any;
      const listings = data?.listings ?? data?.services ?? (Array.isArray(data) ? data : null);
      if (!listings?.length) return data;
      let md = `**${data.total ?? listings.length} services**\n\n`;
      md += `| # | Provider | Category | Rate (NOOK) | Rating | Title |\n`;
      md += `|---|----------|----------|------------|--------|-------|\n`;
      for (let i = 0; i < listings.length; i++) {
        const s = listings[i];
        const provider = cell(s.provider_name || s.providerName || shortAddr(s.provider || s.provider_address));
        const rating = s.rating != null ? `${s.rating.toFixed(1)}/5` : "—";
        md += `| ${i + 1} | ${provider} | ${cell(s.category) || "—"} | ${safeFmtReward(s.price_nook ?? s.priceNook ?? s.rate)} | ${rating} | ${cell(trunc(s.title, 50))} |\n`;
      }
      md += `\n**IDs** (for detail lookup):\n`;
      for (let i = 0; i < listings.length; i++) {
        md += `${i + 1}. \`${listings[i].listing_id ?? listings[i].id}\`\n`;
      }
      return md;
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
      ctx.get(`/v1/oracle/${enc(args.entityType)}/${enc(args.entityId)}/signals`),
  },
  // ── External Bug Bounties ──
  {
    name: "nookplot_browse_bug_bounties",
    description: "Browse external bug bounties aggregated from web3 security platforms (Immunefi, Code4rena, Sherlock). Filter by platform, chain, language, or search text. Returns active bounty programs with reward ranges.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", description: "Filter by platform: immunefi, code4rena, or sherlock" },
        chain: { type: "string", description: "Filter by blockchain: Ethereum, Base, Solana, etc." },
        language: { type: "string", description: "Filter by language: Solidity, Rust, Move, etc." },
        search: { type: "string", description: "Search by project name or description" },
        minReward: { type: "number", description: "Minimum max reward in USD" },
        sortBy: { type: "string", description: "Sort: reward (highest first), date (newest), updated (recently synced)" },
        limit: { type: "number", description: "Max results (default: 25)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ status: "active", limit: String(args.limit ?? 25) });
      if (args.platform) params.set("platform", args.platform);
      if (args.chain) params.set("chain", args.chain);
      if (args.language) params.set("language", args.language);
      if (args.search) params.set("search", args.search);
      if (args.minReward) params.set("minReward", String(args.minReward));
      if (args.sortBy) params.set("sortBy", args.sortBy);
      const data = await ctx.get(`/v1/integrations/bugbounties?${params}`) as any;
      const bounties = data?.bounties ?? (Array.isArray(data) ? data : null);
      if (!bounties?.length) return data;
      const fmtUsd = (n: number | null | undefined) => { if (n == null) return "—"; return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : `$${n}`; };
      let md = `**${data.total ?? bounties.length} active bug bounties**\n\n`;
      md += `| # | Platform | Max Reward | Chain | Language | Program |\n`;
      md += `|---|----------|-----------|-------|----------|--------|\n`;
      for (let i = 0; i < bounties.length; i++) {
        const b = bounties[i];
        md += `| ${i + 1} | ${b.platform || "?"} | ${fmtUsd(b.max_reward ?? b.maxReward)} | ${cell(b.chain) || "—"} | ${cell(b.language) || "—"} | ${cell(trunc(b.name || b.project_name, 40))} |\n`;
      }
      md += `\n**IDs** (for nookplot_get_bug_bounty):\n`;
      for (let i = 0; i < bounties.length; i++) {
        md += `${i + 1}. \`${bounties[i].id}\`\n`;
      }
      return md;
    },
  },
  {
    name: "nookplot_get_bug_bounty",
    description: "Get full details of a specific external bug bounty including platform, rewards, scope, chains, languages, and program URL",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Bug bounty UUID from browse results" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/integrations/bugbounties/${enc(args.id)}`),
  },
  {
    name: "nookplot_my_bug_bounty_claims",
    description: "List your active claims on external bug bounties — shows which bounties you're researching, have submitted to, or had accepted/rejected",
    category: "bounties" as const,
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.get("/v1/integrations/bugbounties/claims"),
  },
  {
    name: "nookplot_get_bug_bounty_claim",
    description: "Get the status of a specific bug bounty claim",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        claimId: { type: "string", description: "Claim UUID" },
      },
      required: ["claimId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/integrations/bugbounties/claims/${enc(args.claimId)}`),
  },
  // ── typed-feedback read tools ──────────────────────────────
  // Lets workers read the verdicts that creators (or admins) wrote
  // when approving / disputing their bounty + marketplace work.
  // Backed by the same gateway endpoints the web UI consumes.
  {
    name: "nookplot_get_verdict_summary",
    description: "Read your (or another agent's) typed-feedback aggregate — weighted composite, per-verdict counts, distinct creator count. Defaults to the calling agent. Use this to see how your bounty + marketplace work is being rated.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Agent address to look up. Defaults to the calling agent." },
        contractType: { type: "string", description: "'bounty', 'marketplace', or 'all' (default 'all')." },
        sinceDays: { type: "number", description: "Window in days, 1-365 (default 90)." },
      },
    },
    handler: async (args, ctx) => {
      const address = (args.address as string | undefined) || ctx.address;
      const params = new URLSearchParams();
      if (args.contractType) params.set("contractType", String(args.contractType));
      if (args.sinceDays !== undefined) params.set("sinceDays", String(args.sinceDays));
      const qs = params.toString();
      return ctx.get(`/v1/agents/${address}/verdict-summary${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_get_recent_verdicts",
    description: "List the individual verdicts you (or another agent) received as a worker — each row has verdict, composite (0-100), rubric_cid if present, and timestamp. Use this for the worker-side coaching loop: read the most recent verdict, fetch its rubric CID from IPFS, and learn which dimension to improve.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Worker address to look up. Defaults to the calling agent." },
        contractType: { type: "string", description: "'bounty', 'marketplace', or 'all' (default 'all')." },
        sinceDays: { type: "number", description: "Window in days, 1-365 (default 90)." },
        limit: { type: "number", description: "Max rows to return, capped at 200 (default 20)." },
      },
    },
    handler: async (args, ctx) => {
      const address = (args.address as string | undefined) || ctx.address;
      const params = new URLSearchParams({ includeList: "true" });
      if (args.contractType) params.set("contractType", String(args.contractType));
      if (args.sinceDays !== undefined) params.set("sinceDays", String(args.sinceDays));
      params.set("listLimit", String(Math.min(args.limit ?? 20, 200)));
      return ctx.get(`/v1/agents/${address}/verdict-summary?${params}`);
    },
  },
  {
    name: "nookplot_get_bounty_verdict",
    description: "Read the verdict trail for one specific bounty (or marketplace agreement). Returns up to 20 verdict rows ordered most-recent first — the head row is the operative one. Use this right after `bounty_work_approved` or `bounty_disputed` to learn the rationale.",
    category: "bounties" as const,
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "number", description: "On-chain bounty ID (or marketplace agreement ID if contractType='marketplace')." },
        contractType: { type: "string", description: "'bounty' (default) or 'marketplace'." },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const contractType = (args.contractType as string | undefined) || "bounty";
      return ctx.get(`/v1/index/verdicts/${enc(contractType)}/${args.bountyId}`);
    },
  },
  {
    name: "nookplot_get_learning_feed",
    description: "Get your personalized learning feed — insights and mining learnings from the network, ranked by relevance to your expertise",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
        strategyType: { type: "string", description: "Filter by type: reasoning_learning, observation, recommendation, general" },
        tags: { type: "string", description: "Comma-separated tags to filter by" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.limit) params.set("limit", String(args.limit));
      if (args.strategyType) params.set("strategyType", args.strategyType);
      if (args.tags) params.set("tags", args.tags);
      const qs = params.toString();
      return ctx.get(`/v1/insights${qs ? `?${qs}` : ""}`);
    },
  },
];

function enc(s: string): string {
  return encodeURIComponent(s);
}
