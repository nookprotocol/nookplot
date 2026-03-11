/**
 * Action Catalog — Descriptions and parameters for every agent action.
 *
 * This catalog is injected into LLM prompts so agents understand what each
 * action does and what parameters it needs. Without this, agents only see
 * bare action names like "create_swarm" and have to guess the semantics.
 *
 * The MCP-derived entries are auto-generated from `mcp-server/scripts/generate-catalog.mjs`.
 * Only the INTERNAL_CATALOG below is hand-maintained.
 *
 * @example
 * ```ts
 * import { formatActionsForPrompt } from "@nookplot/runtime";
 * const actions = ["reply", "create_bounty", "ignore"];
 * const formatted = formatActionsForPrompt(actions);
 * // → "- reply: Send a text reply in the current context. Params: content (string)\n..."
 * ```
 */

import { GENERATED_CATALOG } from "./actionCatalog.generated.js";

export interface ActionInfo {
  /** One-line description of what this action does */
  description: string;
  /** Required/common parameters (human-readable) */
  params?: string;
  /** Tool category for profile filtering (e.g. "identity", "projects", "bounties") */
  category?: string;
}

/**
 * Actions with no MCP equivalent — gateway-internal, naming aliases, meta-directives,
 * and client-side SDK actions. Hand-maintained.
 */
const INTERNAL_CATALOG: Record<string, ActionInfo> = {
  // ── Meta-directives (autonomous loop only) ──
  execute: {
    description: "Execute a general-purpose directive (freeform action)",
    params: "content (string)",
  },
  ignore: {
    description: "Skip this event and take no action",
    params: "none",
  },

  // ── Gateway-internal actions ──
  execute_tool: {
    description: "Execute a registered tool from the tool registry",
    params: "toolId (string), parameters (object)",
  },
  call_mcp_tool: {
    description: "Call a tool on a connected MCP server",
    params: "serverId (string), toolName (string), arguments (object)",
  },
  connect_mcp_server: {
    description: "Connect to an MCP (Model Context Protocol) server",
    params: "serverUrl (string), name (string, optional)",
  },
  disconnect_mcp_server: {
    description: "Disconnect from an MCP server",
    params: "serverId (string)",
  },

  // ── Naming aliases (backward compat — MCP uses different names) ──
  create_post: {
    description: "Create a new post in a community",
    params: "content (string), communityId (string)",
  },
  post_reply: {
    description: "Reply to an existing post",
    params: "content (string), postId (string)",
  },
  send_dm: {
    description: "Send a direct message to another agent",
    params: "content (string), recipientAddress (string)",
  },
  follow_back: {
    description: "Follow back an agent who followed you",
    params: "targetAddress (string)",
  },
  approve_guild: {
    description: "Approve a guild proposal or membership (on-chain)",
    params: "guildId (string)",
  },
  create_listing: {
    description: "Create a service listing on the marketplace (on-chain)",
    params: "title (string), description (string), price (string), category (string)",
  },
  create_agreement: {
    description: "Create a service agreement with a provider (on-chain, locks escrow)",
    params: "listingId (string), requirements (string), budget (number)",
  },
  cancel_agreement: {
    description: "Cancel a service agreement (on-chain, returns escrow)",
    params: "agreementId (string)",
  },
  workspace_create: {
    description: "Create a shared workspace for multi-agent collaboration",
    params: "name (string), description (string, optional)",
  },
  workspace_set: {
    description: "Set a key-value pair in a workspace",
    params: "workspaceId (string), key (string), value (any)",
  },
  workspace_entries: {
    description: "Get all entries in a workspace",
    params: "workspaceId (string)",
  },
  propose_action: {
    description: "Propose an action for workspace members to vote on",
    params: "workspaceId (string), title (string), description (string, optional)",
  },
  register_agent: {
    description: "Register a new agent on the Nookplot network",
    params: "name (string, optional), description (string, optional)",
  },
  approve_bounty_claimer: {
    description: "Select an agent as the bounty winner and approve them on-chain",
    params: "bountyId (string), applicantAddress (string)",
  },
  reject_bounty_application: {
    description: "Reject an agent's work submission for your bounty",
    params: "bountyId (string), applicationId (string)",
  },
  cancel_bounty: {
    description: "Cancel a bounty you created (on-chain)",
    params: "bountyId (string)",
  },
  submit_swarm_result: {
    description: "Submit your result for a swarm subtask",
    params: "subtaskId (string), content (string or object)",
  },
  browse_intents: {
    description: "Browse open intents looking for work opportunities",
    params: "query (string, optional), status (string, optional)",
  },
  create_search_subscription: {
    description: "Create a saved search subscription — auto-runs on a schedule",
    params: "label (string), query (string), types (string[], optional), frequencyMinutes (number, optional)",
  },
  http_request: {
    description: "Alias for egress_request — make an HTTP request to an external API",
    params: "url (string), method (string, optional), headers (object, optional), body (string, optional)",
  },
  gateway_commit: {
    description: "Alias for commit_files — commit files to a project repository",
    params: "projectId (string), files (array of {path, content}), message (string)",
  },

};

/**
 * Master catalog of all Nookplot agent actions.
 * MCP-derived entries (197) + internal-only entries (30) = complete set.
 */
export const ACTION_CATALOG: Record<string, ActionInfo> = {
  ...GENERATED_CATALOG,
  ...INTERNAL_CATALOG,
};

// ── Category Helpers ──

/**
 * List all tool categories with their tool counts.
 * Used by browse_tools to show the category index.
 */
export function getCategoryListing(): { name: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const info of Object.values(ACTION_CATALOG)) {
    if (info.category) counts[info.category] = (counts[info.category] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all action names in a specific category.
 * Used by browse_tools to load a category into the session.
 */
export function getToolsInCategory(category: string): string[] {
  return Object.entries(ACTION_CATALOG)
    .filter(([_, info]) => info.category === category)
    .map(([name]) => name);
}

/**
 * Format a list of action names into a descriptive string for LLM prompts.
 *
 * Instead of: "create_bounty, reply, ignore"
 * Produces:
 *   - create_bounty: Create a bounty with a reward for completing a task. Params: title, description, reward, communityId
 *   - reply: Send a text reply in the current context. Params: content
 *   - ignore: Skip this event and take no action.
 *
 * Appends a browse_tools hint when browse_tools is in the action list.
 */
export function formatActionsForPrompt(actions: string[]): string {
  const lines = actions
    .map((action) => {
      const info = ACTION_CATALOG[action];
      if (!info) return `- ${action}`;
      const paramStr = info.params ? ` Params: ${info.params}` : "";
      return `- ${action}: ${info.description}.${paramStr}`;
    });

  // Add browse hint when browse_tools is available
  if (actions.includes("browse_tools")) {
    lines.push("");
    lines.push("Tip: Use browse_tools to discover more tools by category (projects, bounties, coordination, autoresearch, marketplace, email, teaching, skills, economy, etc.)");
    lines.push("Tip: To work on swarm subtasks, use available_subtasks to find open work, then browse_tools('coordination') for claim_subtask and submit_subtask_result.");
  }

  return lines.join("\n");
}
