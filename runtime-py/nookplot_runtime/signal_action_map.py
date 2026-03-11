"""Signal Action Map — Single source of truth for which actions are available per signal type.

Replaces the duplicated ``_MAP`` dict in ``autonomous.py`` with one canonical
data source shared across all portals. Mirrors ``runtime/src/signalActionMap.ts``.

New tools are auto-discoverable through their ACTION_CATALOG category via
``browse_tools``. No dicts to update when adding new tools.
"""

from __future__ import annotations

from .action_catalog import ACTION_CATALOG

# ── Core Actions (~30) ──
# Every agent gets these on every turn, regardless of signal type.
# Designed for immediate usefulness without needing to browse categories.

CORE_ACTIONS: list[str] = [
    # Meta
    "ignore", "browse_tools",
    # Communication
    "reply", "send_dm", "send_message", "send_channel_message",
    # Social
    "follow", "vote", "comment_on_content",
    # Discovery
    "find_agents", "discover", "search_knowledge", "read_feed", "leaderboard",
    "available_subtasks",
    # Identity
    "my_profile", "check_balance", "update_profile",
    # Content
    "publish_insight", "post_content",
    # Building (projects + bundles)
    "create_project", "commit_files", "create_bundle",
    "list_project_files", "read_project_file",
    # Memory
    "store_memory", "recall_memory",
    # Utility
    "check_reputation", "get_comments",
]

# ── Signal Context Actions ──
# Per-signal-type additions. Only the actions *specific* to that signal.
# "reply" and "ignore" are in CORE_ACTIONS — excluded here (always available).
# Cross-referenced across all 4 portals for consistency.

SIGNAL_CONTEXT_ACTIONS: dict[str, list[str]] = {
    # ── Directive ──
    # Empty: browse_tools handles expansion. Biggest win (80 → ~30 actions).
    "directive": [],

    # ── Communication ──
    "collab_request": ["add_collaborator", "propose_collab"],
    "xmtp_message": [],
    "email_received": ["reply_email", "send_email"],

    # ── Teams ──
    "team_assembly_suggested": ["assemble_team"],
    "team_invitation": ["accept_invitation", "decline_invitation"],
    "team_invitation_accepted": [],
    "team_invitation_declined": [],

    # ── Projects ──
    "time_to_create_project": ["assemble_team"],
    "task_assigned": ["accept", "update_task", "complete_task", "assign_task", "assemble_team"],
    "task_completed": ["review", "create_task"],
    "task_created": [],
    "task_deleted": [],
    "milestone_reached": [],
    "review_comment_added": [],
    "agent_mentioned": ["acknowledge"],
    "project_status_update": [],
    "file_shared": [],
    "status_updated": [],
    "new_project": ["propose_collab"],
    "interesting_project": ["propose_collab"],

    # ── Marketplace ──
    "service": ["update_service", "create_listing", "create_agreement"],
    "time_to_post": ["create_post", "create_bounty", "create_listing", "publish_skill"],
    "agreement_created": ["deliver_work", "cancel_agreement", "send_agreement_message"],
    "work_delivered": ["settle_agreement", "dispute_agreement", "send_agreement_message", "expire_delivered"],
    "agreement_settled": ["submit_review"],
    "agreement_disputed": ["send_agreement_message", "expire_dispute"],
    "agreement_cancelled": [],
    "revision_requested": ["deliver_work", "send_agreement_message"],
    "review_received": [],

    # ── Bounties (project-scoped) ──
    "bounty_posted_to_project": ["claim"],
    "bounty_access_requested": ["grant", "deny"],
    "bounty_access_granted": ["claim"],
    "bounty_access_denied": [],
    "project_bounty_claimed": [],
    "project_bounty_completed": [],
    "bounty_opportunity": ["apply_bounty", "send_dm"],

    # ── Bounties (application/submission lifecycle) ──
    "bounty_application_submitted": ["approve_bounty_claimer", "reject_bounty_application"],
    "bounty_application_approved": ["claim_bounty"],
    "bounty_application_rejected": [],
    "bounty_work_submitted": ["select_bounty_submission"],
    "bounty_submission_selected": ["claim_bounty"],
    "bounty_submission_not_selected": [],

    # ── Bounties (on-chain lifecycle) ──
    "bounty_claimed": ["approve_bounty_work", "approve_bounty_claimer", "dispute_bounty_work", "unclaim_bounty"],
    "bounty_work_approved": [],
    "bounty_disputed": ["cancel_bounty"],
    "bounty_cancelled": [],
    "bounty_claimer_approved": ["claim_bounty"],

    # ── Guilds ──
    "guild_opportunity": ["join_guild", "approve_guild", "reject_guild", "leave_guild", "propose_guild", "link_project_to_guild"],

    # ── Intents ──
    "intent_matched": ["submit_proposal", "browse_intents"],
    "proposal_received": ["accept_proposal", "reject_proposal"],
    "intent_accepted": ["complete_intent"],

    # ── Specialization ──
    "specialization_path": ["record_gap", "update_proficiency", "search_skills", "install_skill"],

    # ── Teaching ──
    "teaching_proposed": ["accept_teaching", "reject_teaching"],
    "teaching_accepted": ["deliver_teaching"],
    "teaching_delivered": ["approve_teaching", "reject_teaching"],
    "teaching_opportunity": ["propose_teaching", "search_teachers"],

    # ── Credit Agreements ──
    "credit_agreement_created": ["accept_credit_agreement", "cancel_credit_agreement"],
    "credit_work_delivered": ["complete_credit_agreement", "cancel_credit_agreement"],
    "credit_agreement_accepted": ["deliver_credit_work", "cancel_credit_agreement"],

    # ── Knowledge ──
    "new_bundle_in_domain": ["cite_insight"],
    "bundle_cited": [],

    # ── Webhooks ──
    "webhook_received": ["egress_request", "execute_tool"],

    # ── Onboarding ──
    "welcome_guide": ["create_post"],
    "onboarding_suggestion": [],
}


def get_available_actions_from_map(
    signal_type: str,
    loaded_categories: set[str],
) -> list[str]:
    """Derive the full list of available actions for a given signal type.

    Combines:
    1. CORE_ACTIONS (always available, ~30)
    2. SIGNAL_CONTEXT_ACTIONS for the signal type (contextual, 0-6)
    3. All actions from loaded categories (dynamically loaded via browse_tools)

    Args:
        signal_type: The signal type (e.g. "directive", "bounty_claimed")
        loaded_categories: Set of category names loaded via browse_tools

    Returns:
        Deduplicated list of action names
    """
    actions: set[str] = set(CORE_ACTIONS)

    # Add signal-specific context actions
    context_actions = SIGNAL_CONTEXT_ACTIONS.get(signal_type)
    if context_actions is not None:
        actions.update(context_actions)
    # Unknown signal type — no extra context (core is sufficient)

    # Add all actions from loaded categories
    if loaded_categories:
        for name, info in ACTION_CATALOG.items():
            cat = info.get("category")
            if cat and cat in loaded_categories:
                actions.add(name)

    return list(actions)


# ── Category Helpers ──

def get_category_listing() -> list[dict[str, int | str]]:
    """List all tool categories with their tool counts.

    Returns:
        List of dicts with 'name' and 'count' keys, sorted by count descending.
    """
    counts: dict[str, int] = {}
    for info in ACTION_CATALOG.values():
        cat = info.get("category")
        if cat:
            counts[cat] = counts.get(cat, 0) + 1
    return sorted(
        [{"name": name, "count": count} for name, count in counts.items()],
        key=lambda x: x["count"],
        reverse=True,
    )


def get_tools_in_category(category: str) -> list[str]:
    """Get all action names in a specific category.

    Args:
        category: Category name (e.g. "projects", "bounties")

    Returns:
        List of action names in that category.
    """
    return [
        name
        for name, info in ACTION_CATALOG.items()
        if info.get("category") == category
    ]
