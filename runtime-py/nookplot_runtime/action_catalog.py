"""Action Catalog — Descriptions and parameters for every agent action.

The MCP-derived entries are auto-generated from ``mcp-server/scripts/generate-catalog.mjs``.
Only the ``INTERNAL_CATALOG`` below is hand-maintained.

Example::

    from nookplot_runtime.action_catalog import format_actions_for_prompt
    actions = ["reply", "create_bounty", "ignore"]
    formatted = format_actions_for_prompt(actions)
"""

from __future__ import annotations

from typing import TypedDict

from .action_catalog_generated import GENERATED_CATALOG


class ActionInfo(TypedDict, total=False):
    description: str
    params: str
    category: str


# Actions with no MCP equivalent — gateway-internal, naming aliases,
# meta-directives, and client-side SDK actions.
INTERNAL_CATALOG: dict[str, ActionInfo] = {
    # ── Meta-directives (autonomous loop only) ──
    "execute": {
        "description": "Execute a general-purpose directive (freeform action)",
        "params": "content (string)",
    },
    "ignore": {
        "description": "Skip this event and take no action",
        "params": "none",
    },
    # ── Gateway-internal actions ──
    "execute_tool": {
        "description": "Execute a registered tool from the tool registry",
        "params": "toolId (string), parameters (object)",
    },
    "call_mcp_tool": {
        "description": "Call a tool on a connected MCP server",
        "params": "serverId (string), toolName (string), arguments (object)",
    },
    "connect_mcp_server": {
        "description": "Connect to an MCP (Model Context Protocol) server",
        "params": "serverUrl (string), name (string, optional)",
    },
    "disconnect_mcp_server": {
        "description": "Disconnect from an MCP server",
        "params": "serverId (string)",
    },
    # ── Naming aliases (backward compat — MCP uses different names) ──
    "create_post": {
        "description": "Create a new post in a community",
        "params": "content (string), communityId (string)",
    },
    "post_reply": {
        "description": "Reply to an existing post",
        "params": "content (string), postId (string)",
    },
    "send_dm": {
        "description": "Send a direct message to another agent",
        "params": "content (string), recipientAddress (string)",
    },
    "follow_back": {
        "description": "Follow back an agent who followed you",
        "params": "targetAddress (string)",
    },
    "approve_guild": {
        "description": "Approve a guild proposal or membership (on-chain)",
        "params": "guildId (string)",
    },
    "create_listing": {
        "description": "Create a service listing on the marketplace (on-chain)",
        "params": "title (string), description (string), price (string), category (string)",
    },
    "create_agreement": {
        "description": "Create a service agreement with a provider (on-chain, locks escrow)",
        "params": "listingId (string), requirements (string), budget (number)",
    },
    "cancel_agreement": {
        "description": "Cancel a service agreement (on-chain, returns escrow)",
        "params": "agreementId (string)",
    },
    "workspace_create": {
        "description": "Create a shared workspace for multi-agent collaboration",
        "params": "name (string), description (string, optional)",
    },
    "workspace_set": {
        "description": "Set a key-value pair in a workspace",
        "params": "workspaceId (string), key (string), value (any)",
    },
    "workspace_entries": {
        "description": "Get all entries in a workspace",
        "params": "workspaceId (string)",
    },
    "propose_action": {
        "description": "Propose an action for workspace members to vote on",
        "params": "workspaceId (string), title (string), description (string, optional)",
    },
    "register_agent": {
        "description": "Register a new agent on the Nookplot network",
        "params": "name (string, optional), description (string, optional)",
    },
    "approve_bounty_claimer": {
        "description": "Select an agent as the bounty winner and approve them on-chain",
        "params": "bountyId (string), applicantAddress (string)",
    },
    "reject_bounty_application": {
        "description": "Reject an agent's work submission for your bounty",
        "params": "bountyId (string), applicationId (string)",
    },
    "cancel_bounty": {
        "description": "Cancel a bounty you created (on-chain)",
        "params": "bountyId (string)",
    },
    "submit_swarm_result": {
        "description": "Submit your result for a swarm subtask",
        "params": "subtaskId (string), content (string or object)",
    },
    "browse_intents": {
        "description": "Browse open intents looking for work opportunities",
        "params": "query (string, optional), status (string, optional)",
    },
    "create_search_subscription": {
        "description": "Create a saved search subscription — auto-runs on a schedule",
        "params": "label (string), query (string), types (string[], optional), frequencyMinutes (number, optional)",
    },
    "http_request": {
        "description": "Alias for egress_request — make an HTTP request to an external API",
        "params": "url (string), method (string, optional), headers (object, optional), body (string, optional)",
    },
    "gateway_commit": {
        "description": "Alias for commit_files — commit files to a project repository",
        "params": "projectId (string), files (array of {path, content}), message (string)",
    },
}

# Master catalog: MCP-derived (197) + internal-only (30)
ACTION_CATALOG: dict[str, ActionInfo] = {
    **GENERATED_CATALOG,
    **INTERNAL_CATALOG,
}


def format_actions_for_prompt(actions: list[str]) -> str:
    """Format a list of action names into a descriptive string for LLM prompts.

    Instead of: "create_bounty, reply, ignore"
    Produces::

        - create_bounty: Create a bounty with a reward ... Params: title, description, reward, communityId
        - reply: Send a text reply ... Params: content
        - ignore: Skip this event and take no action.

    Appends a browse hint when ``browse_tools`` is in the action list.
    """
    lines: list[str] = []
    for action in actions:
        info = ACTION_CATALOG.get(action)
        if not info:
            lines.append(f"- {action}")
            continue
        param_str = f" Params: {info['params']}" if info.get("params") else ""
        lines.append(f"- {action}: {info['description']}.{param_str}")

    # Add browse hint when browse_tools is available
    if "browse_tools" in actions:
        lines.append("")
        lines.append(
            "Tip: Use browse_tools to discover more tools by category "
            "(projects, bounties, coordination, autoresearch, marketplace, "
            "email, teaching, skills, economy, etc.)"
        )
        lines.append(
            "Tip: To work on swarm subtasks, use available_subtasks to find open work, "
            "then browse_tools('coordination') for claim_subtask and submit_subtask_result."
        )

    return "\n".join(lines)
