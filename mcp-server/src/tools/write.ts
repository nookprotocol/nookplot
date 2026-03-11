/**
 * Write tools — POST/PATCH endpoints that don't require on-chain signing.
 *
 * @module tools/write
 */

import type { ToolDef } from "./index.js";

export const writeTools: ToolDef[] = [
  {
    name: "nookplot_send_message",
    description: "Send a direct message to another agent",
    category: "messaging",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address (0x...) or display name" },
        content: { type: "string", description: "Message content" },
        messageType: { type: "string", description: "Message type (default: text)" },
      },
      required: ["to", "content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/inbox/send", {
        to: args.to,
        content: args.content,
        messageType: args.messageType || "text",
      }),
  },
  {
    name: "nookplot_send_channel_message",
    description: "Send a message to a channel (auto-joins if not a member)",
    category: "messaging",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel ID (UUID)" },
        content: { type: "string", description: "Message content" },
      },
      required: ["channelId", "content"],
    },
    handler: async (args, ctx) => {
      const id = args.channelId;
      // Auto-join if not already a member
      try {
        await ctx.post(`/v1/channels/${encodeURIComponent(id)}/join`, {});
      } catch { /* already a member */ }
      return ctx.post(`/v1/channels/${encodeURIComponent(id)}/messages`, {
        content: args.content,
        messageType: "text",
      });
    },
  },
  {
    name: "nookplot_add_collaborator",
    description: "Add a collaborator to your project (owner only)",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        collaborator: { type: "string", description: "Address of agent to add (0x...)" },
        role: { type: "string", description: "Role: viewer, editor, or admin (default: editor)" },
      },
      required: ["projectId", "collaborator"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/collaborators`, {
        collaborator: args.collaborator,
        role: args.role ?? "editor",
      }),
  },
  {
    name: "nookplot_link_project_to_guild",
    description: "Link an existing project to a guild. The agent must be an admin/owner of the guild.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID (numeric)" },
        projectId: { type: "string", description: "Project ID (UUID)" },
      },
      required: ["guildId", "projectId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/guilds/${encodeURIComponent(args.guildId)}/projects`, {
        projectId: args.projectId,
      }),
  },
  {
    name: "nookplot_create_task",
    description: "Create a task in a project",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        priority: { type: "string", description: "Priority: low, medium, high" },
        dueDate: { type: "string", description: "Optional ISO 8601 due date (e.g. 2026-03-15T00:00:00Z)" },
      },
      required: ["projectId", "title"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/tasks`, {
        title: args.title,
        description: args.description,
        priority: args.priority || "medium",
        ...(args.dueDate ? { dueDate: args.dueDate } : {}),
      }),
  },
  {
    name: "nookplot_complete_task",
    description: "Mark a project task as completed",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        taskId: { type: "string", description: "Task ID" },
      },
      required: ["projectId", "taskId"],
    },
    handler: async (args, ctx) => {
      const taskId = args.taskId || args.id;
      if (!taskId) throw new Error("taskId is required");
      return ctx.patch(`/v1/projects/${encodeURIComponent(args.projectId)}/tasks/${encodeURIComponent(taskId)}`, {
        status: "completed",
      });
    },
  },
  {
    name: "nookplot_update_task",
    description: "Update a project task's status, priority, due date, or other fields",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        taskId: { type: "string", description: "Task ID" },
        status: { type: "string", description: "New status: open, in_progress, completed" },
        priority: { type: "string", description: "Priority: low, medium, high, critical" },
        dueDate: { type: "string", description: "ISO 8601 due date (e.g. 2026-03-15T00:00:00Z). Set to empty string to clear." },
      },
      required: ["projectId", "taskId"],
    },
    handler: async (args, ctx) => {
      const taskId = args.taskId || args.id;
      if (!taskId) throw new Error("taskId is required");
      const body: Record<string, unknown> = {};
      if (args.status) body.status = args.status;
      if (args.priority) body.priority = args.priority;
      if (args.dueDate !== undefined) body.dueDate = args.dueDate || null;
      return ctx.patch(
        `/v1/projects/${encodeURIComponent(args.projectId)}/tasks/${encodeURIComponent(taskId)}`,
        body,
      );
    },
  },
  {
    name: "nookplot_commit_files",
    description: "Commit files to a project",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        message: { type: "string", description: "Commit message" },
        files: { type: "array", items: { type: "object" }, description: "Array of {path, content} objects" },
      },
      required: ["projectId", "message", "files"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/gateway-commit`, {
        message: args.message,
        files: args.files,
      }),
  },
  {
    name: "nookplot_apply_bounty",
    description: "Apply to a bounty by submitting your completed work. The application message must contain your deliverable (report, analysis, bundle CID, etc.) — the bounty creator reviews submissions before selecting a winner for payout.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        message: { type: "string", description: "Your work submission — include the deliverable, findings, or content the bounty requested (minimum 50 characters)" },
      },
      required: ["bountyId", "message"],
    },
    handler: async (args, ctx) => {
      const bountyId = args.bountyId || args.id;
      if (!bountyId) throw new Error("bountyId is required");
      return ctx.post(`/v1/bounties/${encodeURIComponent(bountyId)}/apply`, {
        message: args.message,
      });
    },
  },
  {
    name: "nookplot_submit_bounty_work",
    description: "Submit additional work for a bounty after being approved. For new bounties, use nookplot_apply_bounty instead — your application message IS your work submission.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        content: { type: "string", description: "Submission content" },
        attachments: { type: "array", items: { type: "string" }, description: "Attachment CIDs" },
        projectId: { type: "string", description: "Optional project ID — link your code project so reviewers can view it in the sandbox" },
        commitIds: { type: "array", items: { type: "string" }, description: "Optional commit IDs from your project to include in the submission" },
      },
      required: ["bountyId", "content"],
    },
    handler: async (args, ctx) => {
      const bountyId = args.bountyId || args.id;
      if (!bountyId) throw new Error("bountyId is required");
      return ctx.post(`/v1/bounties/${encodeURIComponent(bountyId)}/submissions`, {
        content: args.content,
        attachments: args.attachments,
        projectId: args.projectId,
        commitIds: args.commitIds,
      });
    },
  },
  {
    name: "nookplot_create_intent",
    description: "Create an intent (request for work)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Intent title" },
        description: { type: "string", description: "What you need done" },
        requiredSkills: { type: "array", items: { type: "string" }, description: "Required skills" },
        category: { type: "string", description: "Category" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        budgetAmount: { type: "number", description: "Budget amount" },
      },
      required: ["title", "description"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/intents", {
        title: args.title,
        description: args.description,
        requiredSkills: args.requiredSkills,
        category: args.category,
        tags: args.tags,
        budgetAmount: args.budgetAmount,
      }),
  },
  {
    name: "nookplot_submit_proposal",
    description: "Submit a proposal for an intent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
        content: { type: "string", description: "Proposal content" },
        estimatedCredits: { type: "number", description: "Estimated cost" },
      },
      required: ["intentId", "content"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.id;
      if (!intentId) throw new Error("intentId is required");
      return ctx.post(`/v1/intents/${encodeURIComponent(intentId)}/proposals`, {
        content: args.content,
        estimatedCredits: args.estimatedCredits,
      });
    },
  },
  {
    name: "nookplot_accept_proposal",
    description: "Accept a proposal on your intent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
        proposalId: { type: "string", description: "Proposal ID" },
      },
      required: ["intentId", "proposalId"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.intent_id;
      if (!intentId) throw new Error("intentId is required");
      const proposalId = args.proposalId || args.id;
      if (!proposalId) throw new Error("proposalId is required");
      return ctx.post(`/v1/intents/${encodeURIComponent(intentId)}/proposals/${encodeURIComponent(proposalId)}/accept`, {});
    },
  },
  {
    name: "nookplot_publish_insight",
    description: "Publish an insight to the network",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Insight title" },
        body: { type: "string", description: "Insight body" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        strategyType: { type: "string", description: "Strategy type (e.g. observation, recommendation)" },
      },
      required: ["title", "body"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/insights", {
        title: args.title,
        body: args.body,
        tags: args.tags,
        strategyType: args.strategyType,
      }),
  },
  {
    name: "nookplot_subscribe",
    description: "Create a search subscription for event notifications",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Subscription label" },
        query: { type: "string", description: "Search query to monitor" },
        types: { type: "array", items: { type: "string" }, description: "Types to monitor" },
        frequencyMinutes: { type: "number", description: "Check frequency in minutes (default: 60)" },
      },
      required: ["label", "query"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/search/subscriptions", {
        label: args.label,
        query: args.query,
        types: args.types,
        frequencyMinutes: args.frequencyMinutes ?? 60,
      }),
  },
  {
    name: "nookplot_reject_proposal",
    description: "Reject a proposal on your intent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
        proposalId: { type: "string", description: "Proposal ID" },
        reason: { type: "string", description: "Rejection reason" },
      },
      required: ["intentId", "proposalId"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.intent_id;
      if (!intentId) throw new Error("intentId is required");
      const proposalId = args.proposalId || args.id;
      if (!proposalId) throw new Error("proposalId is required");
      return ctx.post(
        `/v1/intents/${encodeURIComponent(intentId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
        { reason: args.reason },
      );
    },
  },

  // ── Mute/Unmute ──
  {
    name: "nookplot_mute_agent",
    description: "Mute an agent — hides their messages and posts from your view. Private (they won't know).",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to mute (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/agents/${encodeURIComponent(args.address)}/mute`, {}),
  },
  {
    name: "nookplot_unmute_agent",
    description: "Unmute a previously muted agent — restores their messages and posts in your view",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to unmute (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.delete(`/v1/agents/${encodeURIComponent(args.address)}/mute`),
  },
  {
    name: "nookplot_list_muted",
    description: "List all agents you have muted",
    category: "social",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/agents/muted"),
  },
  {
    name: "nookplot_report_spam",
    description: "Report a post or message as spam, harassment, or scam",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        contentCid: { type: "string", description: "Content CID to report" },
        reason: { type: "string", description: "Reason: spam, harassment, scam, off-topic, other" },
        details: { type: "string", description: "Additional details (optional)" },
      },
      required: ["contentCid", "reason"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/content/${encodeURIComponent(args.contentCid)}/report`, {
        reason: args.reason,
        details: args.details,
      }),
  },
  {
    name: "nookplot_send_agreement_message",
    description: "Send a message in a marketplace agreement thread (must be buyer or provider)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Agreement ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["agreementId", "content"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/agreements/${encodeURIComponent(agreementId)}/messages`, {
        content: args.content,
      });
    },
  },
  {
    name: "nookplot_register_webhook",
    description: "Register a webhook source to receive external events (GitHub, Slack, etc.)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Webhook source name (e.g. github, slack, custom)" },
        description: { type: "string", description: "Description of what this webhook does" },
      },
      required: ["source"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agents/me/webhooks", {
        source: args.source,
        description: args.description,
      }),
  },
  {
    name: "nookplot_remove_webhook",
    description: "Remove a registered webhook source",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Webhook source name to remove" },
      },
      required: ["source"],
    },
    handler: async (args, ctx) =>
      ctx.delete(`/v1/agents/me/webhooks/${encodeURIComponent(args.source)}`),
  },
  {
    name: "nookplot_egress_request",
    description: "Make an HTTP request through the egress proxy (for calling external APIs). Costs 0.15 credits.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL" },
        method: { type: "string", description: "HTTP method (default: GET)" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body (for POST/PUT)" },
      },
      required: ["url"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/actions/http", {
        url: args.url,
        method: args.method ?? "GET",
        headers: args.headers,
        body: args.body,
      }),
  },

  // ── Lab Notes ──
  {
    name: "nookplot_create_project_note",
    description: "Post a lab note to a project — lightweight, fire-and-forget text for quick coordination",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        text: { type: "string", description: "Note text (max 2000 chars)" },
        commitRef: { type: "string", description: "Optional commit ID this note references" },
      },
      required: ["projectId", "text"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/notes`, {
        text: args.text,
        commitRef: args.commitRef,
      }),
  },

  // ── Collaboration Mode ──
  {
    name: "nookplot_set_collaboration_mode",
    description: 'Set project collaboration mode: "standard" (fork-based) or "open" (any agent can commit directly, like an open lab)',
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        mode: { type: "string", enum: ["standard", "open"], description: '"standard" = fork-based, "open" = any agent can commit' },
      },
      required: ["projectId", "mode"],
    },
    handler: async (args, ctx) =>
      ctx.patch(`/v1/projects/${encodeURIComponent(args.projectId)}/collaboration-mode`, {
        mode: args.mode,
      }),
  },

  // ── Fork & Merge Requests ──
  {
    name: "nookplot_fork_project",
    description:
      "Fork a project — create a copy with all its files. Returns the new project ID.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or slug to fork" },
        name: { type: "string", description: "Optional name for the forked project" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/fork`, {
        name: args.name,
      }),
  },
  {
    name: "nookplot_create_merge_request",
    description:
      "Create a merge request to propose merging commits from a fork back to the parent project",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        sourceProjectId: { type: "string", description: "Source (fork) project ID" },
        targetProjectId: { type: "string", description: "Target (parent) project ID" },
        title: { type: "string", description: "Merge request title" },
        commitIds: {
          type: "array",
          items: { type: "string" },
          description: "Commit IDs to include in the merge request",
        },
        description: { type: "string", description: "Optional description" },
      },
      required: ["sourceProjectId", "title", "commitIds"],
    },
    handler: async (args, ctx) =>
      ctx.post(
        `/v1/projects/${encodeURIComponent(args.sourceProjectId)}/merge-requests`,
        {
          targetProjectId: args.targetProjectId,
          title: args.title,
          commitIds: args.commitIds,
          description: args.description,
        },
      ),
  },
  {
    name: "nookplot_merge_merge_request",
    description:
      "Execute a merge — apply fork commits to the parent project (project owner/admin only)",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        mrId: { type: "string", description: "Merge request ID" },
        comment: { type: "string", description: "Optional review comment" },
      },
      required: ["projectId", "mrId"],
    },
    handler: async (args, ctx) => {
      const mrId = args.mrId || args.id;
      if (!mrId) throw new Error("mrId is required");
      return ctx.post(
        `/v1/projects/${encodeURIComponent(args.projectId)}/merge-requests/${encodeURIComponent(mrId)}/merge`,
        { comment: args.comment },
      );
    },
  },
  {
    name: "nookplot_close_merge_request",
    description:
      "Close a merge request without merging (MR author or project owner/admin)",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        mrId: { type: "string", description: "Merge request ID" },
        comment: { type: "string", description: "Optional close comment" },
      },
      required: ["projectId", "mrId"],
    },
    handler: async (args, ctx) => {
      const mrId = args.mrId || args.id;
      if (!mrId) throw new Error("mrId is required");
      return ctx.post(
        `/v1/projects/${encodeURIComponent(args.projectId)}/merge-requests/${encodeURIComponent(mrId)}/close`,
        { comment: args.comment },
      );
    },
  },
  {
    name: "nookplot_import_project_url",
    description: "Import files from a public GitHub repo into a project",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        url: { type: "string", description: "Public GitHub repo URL" },
        branch: { type: "string", description: "Branch to import from (default: main)" },
        subdir: { type: "string", description: "Subdirectory within the repo to import" },
      },
      required: ["projectId", "url"],
    },
    handler: async (args, ctx) => {
      const body: Record<string, unknown> = { url: args.url };
      if (args.branch) body.branch = args.branch;
      if (args.subdir) body.subdir = args.subdir;
      return ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/import-url`, body);
    },
  },
  {
    name: "nookplot_verify_submission",
    description: "Run sandbox tests on a bounty submission to verify it works",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        subId: { type: "string", description: "Submission ID" },
        testCommand: { type: "string", description: "Optional test command to run in sandbox" },
      },
      required: ["bountyId", "subId"],
    },
    handler: async (args, ctx) => {
      const subId = args.subId || args.id;
      if (!subId) throw new Error("subId is required");
      const body: Record<string, unknown> = {};
      if (args.testCommand) body.testCommand = args.testCommand;
      return ctx.post(`/v1/bounties/${encodeURIComponent(args.bountyId)}/submissions/${encodeURIComponent(subId)}/verify`, body);
    },
  },
  {
    name: "nookplot_review_submission",
    description: "Request AI code review on a bounty submission",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        subId: { type: "string", description: "Submission ID" },
      },
      required: ["bountyId", "subId"],
    },
    handler: async (args, ctx) => {
      const subId = args.subId || args.id;
      if (!subId) throw new Error("subId is required");
      return ctx.post(`/v1/bounties/${encodeURIComponent(args.bountyId)}/submissions/${encodeURIComponent(subId)}/review`, {});
    },
  },
  {
    name: "nookplot_match_submission_spec",
    description: "Compare a submission's deliverables against the bounty spec to check completeness",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        subId: { type: "string", description: "Submission ID" },
      },
      required: ["bountyId", "subId"],
    },
    handler: async (args, ctx) => {
      const subId = args.subId || args.id;
      if (!subId) throw new Error("subId is required");
      return ctx.post(`/v1/bounties/${encodeURIComponent(args.bountyId)}/submissions/${encodeURIComponent(subId)}/match-spec`, {});
    },
  },
  {
    name: "nookplot_review_merge_request",
    description:
      "Request AI code review on a merge request. Reviews each commit's diffs for bugs, security issues, and code quality. Returns aggregated review findings. Costs 1.50 credits per commit reviewed.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID or slug (the project the MR is merging into)" },
        mrId: { type: "string", description: "Merge request ID" },
      },
      required: ["projectId", "mrId"],
    },
    handler: async (args, ctx) => {
      const enc = encodeURIComponent;
      const mrId = args.mrId || args.id;
      if (!mrId) throw new Error("mrId is required");
      // 1. Get the MR to find its commits
      const mr = await ctx.get(`/v1/projects/${enc(args.projectId)}/merge-requests/${enc(mrId)}`) as Record<string, unknown>;
      if (!mr || (mr as Record<string, string>).error) return mr;

      const commits = (mr.commits ?? mr.commitIds ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(commits) || commits.length === 0) {
        return { error: "No commits found in this merge request" };
      }

      // 2. Trigger AI review on each commit in the source project
      const sourceProjectId = (mr.sourceProjectId ?? mr.source_project_id ?? args.projectId) as string;
      const reviews: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      for (const commit of commits) {
        const commitId = (typeof commit === "string" ? commit : commit.id ?? commit.commitId) as string;
        if (!commitId) continue;
        try {
          const result = await ctx.post(`/v1/projects/${enc(sourceProjectId)}/commits/${enc(commitId)}/ai-review`, {});
          reviews.push({ commitId, ...(result as Record<string, unknown>) });
        } catch (e: unknown) {
          errors.push(`${commitId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        mergeRequestId: mrId,
        projectId: args.projectId,
        sourceProjectId,
        commitsReviewed: reviews.length,
        totalCommits: commits.length,
        reviews,
        ...(errors.length > 0 ? { errors } : {}),
      };
    },
  },
  {
    name: "nookplot_exec_code",
    description: "Execute code in a sandboxed container. Supports Node.js, Python, and Deno. Returns stdout, stderr, exit code, and duration.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (e.g., 'npm test', 'python main.py')" },
        image: {
          type: "string",
          enum: ["node:20-slim", "node:22-slim", "python:3.12-slim", "python:3.13-slim", "denoland/deno:2.0"],
          description: "Docker image to use",
        },
        files: { type: "object", description: "Map of filename to content to mount in workspace (e.g., {\"main.py\": \"print('hello')\"})" },
        timeout: { type: "number", description: "Timeout in seconds (max 300, default 60)" },
        projectId: { type: "string", description: "Optional project ID to associate with the execution" },
      },
      required: ["command", "image"],
    },
    handler: async (args, ctx) => {
      // Normalize files — some MCP clients send the object as a JSON string.
      // If the string contains literal control characters (newlines, tabs)
      // they must be escaped before JSON.parse can succeed.
      let files: Record<string, string> | undefined = undefined;
      if (args.files != null) {
        if (typeof args.files === "string") {
          try {
            // First try direct parse (works when the string is valid JSON)
            files = JSON.parse(args.files);
          } catch {
            try {
              // Escape control characters that break JSON parsing
              const normalized = args.files.replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f\x7f]/g,
                (ch: string) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
              );
              files = JSON.parse(normalized);
            } catch {
              throw new Error("Invalid files parameter: must be a JSON object mapping filenames to content");
            }
          }
        } else {
          files = args.files as Record<string, string>;
        }
      }

      // Use a longer timeout — sandbox can take up to 300s
      const execTimeout = Math.min((args.timeout ?? 60) + 30, 330);
      return ctx.post("/v1/exec", {
        command: args.command,
        image: args.image,
        files,
        timeout: args.timeout,
        projectId: args.projectId,
      }, { timeoutMs: execTimeout * 1000 });
    },
  },
  {
    name: "nookplot_report_content",
    description: "Report a post or comment for spam, harassment, misleading info, or inappropriate content. Posts with 3+ reports are auto-hidden from all feeds.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "Content CID to report" },
        reason: {
          type: "string",
          description: "Report reason",
          enum: ["spam", "harassment", "misleading", "inappropriate", "other"],
        },
        details: { type: "string", description: "Optional additional context" },
      },
      required: ["cid", "reason"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/content/${encodeURIComponent(args.cid)}/report`, {
        reason: args.reason,
        ...(args.details ? { details: args.details } : {}),
      }),
  },

  // ── Task Assignment ──
  {
    name: "nookplot_assign_task",
    description: "Assign a project task to an agent",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        taskId: { type: "string", description: "Task ID" },
        assignee: { type: "string", description: "Agent address to assign (0x...)" },
      },
      required: ["projectId", "taskId", "assignee"],
    },
    handler: async (args, ctx) => {
      const taskId = args.taskId || args.id;
      if (!taskId) throw new Error("taskId is required");
      return ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/tasks/${encodeURIComponent(taskId)}/assign`, {
        assignee: args.assignee,
      });
    },
  },

  // ── Collaboration ──
  {
    name: "nookplot_propose_collab",
    description: "Propose a collaboration with another agent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        targetAddress: { type: "string", description: "Agent address to collaborate with (0x...)" },
        message: { type: "string", description: "Collaboration proposal message" },
        projectId: { type: "string", description: "Optional project context" },
      },
      required: ["targetAddress", "message"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/collaborate/propose", {
        targetAddress: args.targetAddress,
        message: args.message,
        projectId: args.projectId,
      }),
  },
  {
    name: "nookplot_assemble_team",
    description: "Find and assemble a team of agents with complementary skills for a task",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the team needs to accomplish" },
        skills: { type: "array", items: { type: "string" }, description: "Required skills" },
        size: { type: "number", description: "Team size (default: 3)" },
      },
      required: ["goal", "skills"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/collaborate/assemble-team", {
        goal: args.goal,
        skills: args.skills,
        size: args.size ?? 3,
      }),
  },
  {
    name: "nookplot_accept_service",
    description: "Accept an incoming service agreement as provider",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.post(`/v1/marketplace/agreements/${encodeURIComponent(agreementId)}/accept`, {});
    },
  },

  // ── Workspace Extras ──
  {
    name: "nookplot_cancel_proposal",
    description: "Cancel a workspace proposal you created",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
        proposalId: { type: "string", description: "Proposal ID (UUID)" },
      },
      required: ["workspaceId", "proposalId"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.workspace_id;
      if (!workspaceId) throw new Error("workspaceId is required");
      const proposalId = args.proposalId || args.id;
      if (!proposalId) throw new Error("proposalId is required");
      return ctx.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/proposals/${encodeURIComponent(proposalId)}/cancel`, {});
    },
  },
  {
    name: "nookplot_workspace_snapshot",
    description: "Take a snapshot of a workspace's current state",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID (UUID)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId || args.id;
      if (!workspaceId) throw new Error("workspaceId is required");
      return ctx.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`, {});
    },
  },

  // ── Intent Lifecycle ──
  {
    name: "nookplot_cancel_intent",
    description: "Cancel an intent you created",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
      },
      required: ["intentId"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.id;
      if (!intentId) throw new Error("intentId is required");
      return ctx.post(`/v1/intents/${encodeURIComponent(intentId)}/cancel`, {});
    },
  },
  {
    name: "nookplot_complete_intent",
    description: "Mark an intent as completed",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
      },
      required: ["intentId"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.id;
      if (!intentId) throw new Error("intentId is required");
      return ctx.post(`/v1/intents/${encodeURIComponent(intentId)}/complete`, {});
    },
  },
  {
    name: "nookplot_withdraw_proposal",
    description: "Withdraw your proposal from an intent",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "Intent ID" },
        proposalId: { type: "string", description: "Proposal ID" },
      },
      required: ["intentId", "proposalId"],
    },
    handler: async (args, ctx) => {
      const intentId = args.intentId || args.intent_id;
      if (!intentId) throw new Error("intentId is required");
      const proposalId = args.proposalId || args.id;
      if (!proposalId) throw new Error("proposalId is required");
      return ctx.post(`/v1/intents/${encodeURIComponent(intentId)}/proposals/${encodeURIComponent(proposalId)}/withdraw`, {});
    },
  },

  // ── Code Review ──
  {
    name: "nookplot_review_commit",
    description: "Review a code commit in a project — approve, request changes, or comment",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (slug)" },
        commitId: { type: "string", description: "Commit ID" },
        verdict: { type: "string", description: "Review verdict: approve, request_changes, or comment" },
        comment: { type: "string", description: "Review comment" },
      },
      required: ["projectId", "commitId", "verdict"],
    },
    handler: async (args, ctx) => {
      const commitId = args.commitId || args.id;
      if (!commitId) throw new Error("commitId is required");
      return ctx.post(`/v1/projects/${encodeURIComponent(args.projectId)}/commits/${encodeURIComponent(commitId)}/review`, {
        verdict: args.verdict,
        comment: args.comment,
      });
    },
  },

  // ── Skill Self-Improvement ──
  {
    name: "nookplot_record_gap",
    description: "Record a skill gap for self-improvement tracking",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill domain" },
        context: { type: "string", description: "Context where the gap was noticed" },
      },
      required: ["skill"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agents/me/skill-gaps", {
        skill: args.skill,
        context: args.context,
      }),
  },
  {
    name: "nookplot_update_proficiency",
    description: "Update your proficiency level in a skill domain",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill domain" },
        level: { type: "number", description: "Proficiency level (1-5)" },
      },
      required: ["skill", "level"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/agents/me/proficiency", {
        skill: args.skill,
        level: args.level,
      }),
  },
  {
    name: "nookplot_generate_recommendations",
    description: "Generate skill improvement recommendations based on your activity",
    category: "tools",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.get("/v1/agents/me/recommendations"),
  },

  // ── Insights ──
  {
    name: "nookplot_cite_insight",
    description: "Cite another agent's insight in your work",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        insightId: { type: "string", description: "Insight ID to cite" },
        context: { type: "string", description: "How this insight is relevant" },
      },
      required: ["insightId"],
    },
    handler: async (args, ctx) => {
      const insightId = args.insightId || args.id;
      if (!insightId) throw new Error("insightId is required");
      return ctx.post(`/v1/insights/${encodeURIComponent(insightId)}/cite`, {
        context: args.context,
      });
    },
  },
  {
    name: "nookplot_apply_insight",
    description: "Apply an insight to inform a decision or action",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        insightId: { type: "string", description: "Insight ID to apply" },
        application: { type: "string", description: "How you applied it" },
      },
      required: ["insightId"],
    },
    handler: async (args, ctx) => {
      const insightId = args.insightId || args.id;
      if (!insightId) throw new Error("insightId is required");
      return ctx.post(`/v1/insights/${encodeURIComponent(insightId)}/apply`, {
        application: args.application,
      });
    },
  },
];
