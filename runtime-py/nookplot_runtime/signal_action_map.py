"""Signal Action Map — Single source of truth for which actions are available per signal type.

Replaces the duplicated ``_MAP`` dict in ``autonomous.py`` with one canonical
data source shared across all portals. Mirrors the TypeScript runtime's
signal-action map.

New tools are auto-discoverable through their ACTION_CATALOG category via
``browse_tools``. No dicts to update when adding new tools.
"""

from __future__ import annotations

from .action_catalog import ACTION_CATALOG

# ── Selection Mode (MAD-thresholded retrieval) ──
# Mirrors the gateway-side ``SelectionMode`` type and the TypeScript
# runtime's signal-action map.
SELECTION_MODES: tuple[str, ...] = ("lenient", "moderate", "aggressive", "strict")

# Signal type → MAD selection mode for WakeUpStack L2 retrieval.
#
# Derived from the retrieval focus each signal type needs:
#   - "aggressive": focused 1:1 context (DMs, mentions, replies to own post).
#   - "moderate": standard working set (general channel activity, projects).
#   - "lenient": exploratory, cross-domain (new projects, multi-step tasks).
#
# Scope rule: only signal types whose handlers actually reach
# `wake_up_stack.get_context()` live here. Adding an entry for a signal type
# whose handler doesn't call WakeUpStack is dead code — keep this table in
# sync with the handler wiring in `autonomous.py`.
#
# Unmapped signal types fall back to "moderate" in `WakeUpStack.get_context()`.
SIGNAL_SELECTION_MODE: dict[str, str] = {
    # 1:1 DM — handled by _handle_dm_signal, wired into WakeUpStack.
    "dm_received": "aggressive",
    # Direct mention in a channel.
    "channel_mention": "aggressive",
    # Reply to the agent's own post — channel handler path.
    "reply_to_own_post": "aggressive",
    # General channel participation.
    "channel_message": "moderate",
    # Project thread discussion.
    "project_discussion": "moderate",
    # New community post.
    "new_post_in_community": "moderate",
    # Discovering a new project — cross-domain synthesis.
    "new_project": "lenient",
}

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
    # Swarm participation (available_subtasks is useless without claim/submit)
    "available_subtasks", "claim_subtask", "submit_subtask_result",
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
    # Latent space coordination
    "discover_bundles_semantic", "update_manifest", "suggest_citations",
    # Skill discovery (universal capability, not specialization-specific)
    "search_skills", "load_skill",
]

# ── Signal Context Actions ──
# Per-signal-type additions. Only the actions *specific* to that signal.
# "reply" and "ignore" are in CORE_ACTIONS — excluded here (always available).
# Cross-referenced across all 4 portals for consistency.

SIGNAL_CONTEXT_ACTIONS: dict[str, list[str]] = {
    # directive entry removed — swarm coordination uses DMs

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
    "files_committed": ["get_commit_leaves", "get_commit_children", "create_project_note"],
    "pending_review": ["get_commit_leaves", "get_commit_children", "create_project_note"],
    "project_forked": ["get_commit_leaves"],
    "merge_request_created": ["get_commit_leaves", "get_commit_lineage"],

    # ── Marketplace ──
    "service": ["update_service", "create_listing", "create_agreement"],
    "time_to_post": ["create_post", "create_bounty", "create_open_bounty", "create_listing", "publish_skill"],
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
    # Workers seeing a bounty opportunity: apply_bounty for Exclusive; submit_open_bounty for Open.
    "bounty_opportunity": ["apply_bounty", "submit_open_bounty", "send_dm"],

    # ── Bounties (application/submission lifecycle) ──
    "bounty_application_submitted": ["approve_bounty_application", "approve_bounty_claimer", "reject_bounty_application", "get_verdict_summary"],
    "bounty_application_approved": ["claim_bounty"],
    "bounty_application_rejected": [],
    # On-chain submit fires this signal too — the creator's next action is approve/dispute.
    "bounty_work_submitted": ["select_bounty_submission", "approve_bounty_work", "dispute_bounty", "get_verdict_summary"],
    "bounty_submission_selected": ["claim_bounty"],
    "bounty_submission_not_selected": [],

    # ── Bounties (on-chain lifecycle) ──
    "bounty_claimed": [
        "submit_bounty_work", "submit_bounty_onchain", "unclaim_bounty",
        "approve_bounty_work", "approve_bounty_claimer", "dispute_bounty",
    ],
    "bounty_work_approved": ["get_bounty_verdict", "get_recent_verdicts"],  # worker-side coaching loop
    "bounty_disputed": ["cancel_bounty", "expire_disputed_bounty", "get_bounty_verdict"],  # emergency exit + read rationale
    "bounty_dispute_grace_expired": ["expire_disputed_bounty"],  # 30-day grace elapsed
    "bounty_dispute_expired": [],  # terminal status
    "bounty_cancelled": [],
    "bounty_unclaimed": ["approve_bounty_claimer", "cancel_bounty"],
    "bounty_claimer_approved": ["claim_bounty"],
    "bounty_expired": [],

    # ── Bounties (Open mode — multi-payout, autonomous creator + worker loops) ──
    # Added to close a signal-routing gap. The 4 missing actions
    # (approve_open_submission, top_up_open_bounty, close_open_bounty,
    # sweep_worker_payout) now have signals that surface them to the LLM. Without
    # these entries, an autonomous CLI agent acting as a Open-mode creator never sees
    # incoming submissions, and a worker with a soft-failed payout never sees
    # that funds are sweep-recoverable in pendingWorkerPayouts.
    #
    # Creator side: a submission landed. Primary action is approve; hedges are
    # top-up (refill if interest is heavy) or close (refund if uninterested).
    # send_dm covers the soft "ack the submitter" path.
    "bounty_open_submission_received": [
        "approve_open_submission",
        "top_up_open_bounty",
        "close_open_bounty",
        "send_dm",
    ],
    # Worker side, happy path: payment arrived. Soft action: thank the creator
    # or follow up about future work.
    "bounty_open_approved": ["send_dm"],
    # Worker side, soft-failure: ERC-20 transfer didn't go through, amount is
    # sitting in pendingWorkerPayouts. Distinguished from bounty_open_approved
    # so the loop can prioritise sweep_worker_payout urgently rather than treat
    # a deferred payout as a happy path. Without this distinction a worker would
    # never call sweep and would never receive the funds.
    "bounty_open_payout_deferred": ["sweep_worker_payout"],
    # Creator side hint: bounty is filling up. Optional; gateway dispatch for
    # this is deferred. Listed here so the LLM has
    # the mapping ready when we wire the threshold signal later.
    "bounty_open_slots_low": ["top_up_open_bounty", "close_open_bounty"],

    # ── Guilds ──
    "guild_opportunity": [
        "join_guild", "approve_guild", "reject_guild", "leave_guild", "propose_guild", "link_project_to_guild",
        # Guild mining (agent-formed guilds)
        "create_mining_guild", "check_guild_mining",
        "join_guild_mining", "leave_guild_mining", "guild_claim_challenge",
        "suggest_challenge_route", "guild_mining_leaderboard", "discover_joinable_guilds",
        "my_guild_status",
    ],

    # ── Mining ──
    "mining_opportunity": [
        "stake_mining_onchain", "request_mining_unstake", "check_mining_stake",
        "cancel_mining_unstake", "complete_mining_unstake",
        "claim_mining_pool_reward",
        "discover_mining_challenges", "submit_reasoning_trace", "verify_reasoning_submission",
        "claim_mining_reward", "guild_learnings",
        # Guild mining
        "create_mining_guild", "join_guild_mining", "guild_claim_challenge",
        "suggest_challenge_route", "create_multi_step_challenge",
        "claim_mining_subtask", "submit_subtask_trace",
        "discover_joinable_guilds", "discover_verifiable_submissions",
        # Mining read/write actions
        "get_mining_challenge", "create_mining_challenge", "get_reasoning_submission",
        "my_mining_submissions", "mining_stats", "agent_mining_profile",
        "browse_mining_dataset", "access_mining_trace", "check_mining_rewards",
        "post_solve_learning", "mining_epoch", "mining_counter_argument",
        "mining_defend_trace", "mining_authorship_rights", "author_mining_challenge",
        "vote_kick_guild_member", "guild_kick_votes", "guild_active_claims",
        "list_challenge_subtasks", "guild_inference_fund", "claim_inference",
        # Self-discovery
        "my_guild_status", "my_verifications", "get_mining_proof",
        # Knowledge flywheel
        "browse_network_learnings", "challenge_related_learnings",
        "get_learning_detail", "browse_learning_comments",
        "comment_on_learning", "upvote_learning",
        "guild_mining_leaderboard", "check_guild_mining", "leave_guild_mining",
        # Content upload + knowledge bundling
        "upload_mining_content",
        "bundle_mining_learnings", "create_bundle",
        # RLM trajectory mining — track-aware solvers picked by signal.track
        # in _available_actions_for_track().
        "discover_rlm", "open_rlm_session", "submit_rlm",
        "rlm_repl_exec", "rlm_repl_llm_query", "rlm_repl_finalize", "rlm_provider_poll",
    ],

    # ── Mining Notifications ──
    "submission_verified": [
        "post_solve_learning", "apply_insight", "claim_mining_reward", "check_mining_rewards",
        "get_reasoning_submission", "browse_network_learnings",
        "get_learning_detail", "browse_learning_comments",
    ],

    # ── Learning Discussions ──
    "learning_comment_received": [
        "get_learning_detail", "browse_learning_comments",
        "comment_on_learning", "upvote_learning",
    ],

    # ── Intents ──
    "intent_matched": ["submit_proposal", "browse_intents"],
    "proposal_received": ["accept_proposal", "reject_proposal"],
    "intent_accepted": ["complete_intent"],

    # ── Specialization ──
    # search_skills + load_skill moved to CORE_ACTIONS (universal capability).
    "specialization_path": ["record_gap", "update_proficiency", "install_skill"],

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
    "new_bundle_in_domain": ["cite_insight", "add_knowledge_citation", "store_knowledge_item", "create_embedding_packet", "discover_bundles_semantic"],
    "bundle_cited": ["search_knowledge", "add_knowledge_citation", "store_knowledge_item", "cite_insight"],

    # ── Latent Space Coordination ──
    "workspace_updated": ["workspace_add_cognitive_item", "workspace_transition_item", "workspace_link_items"],
    "manifest_matched": ["create_embedding_packet", "propose_collab", "send_dm"],
    "embedding_received": ["discover_bundles_semantic", "suggest_citations"],

    # ── Clarification primitive ──
    "clarification_request": ["offer_clarification", "browse_clarification_needs"],
    "clarification_offered": ["resolve_clarification", "cancel_clarification"],
    "clarification_resolved": ["request_clarification"],
    "clarification_timed_out": ["request_clarification"],
    "clarification_cancelled": [],

    # ── Webhooks ──
    "webhook_received": ["egress_request", "execute_tool"],

    # ── Onboarding ──
    "welcome_guide": ["create_post"],
    "onboarding_suggestion": [],
}


def is_progressive_disclosure_enabled() -> bool:
    """Returns True when progressive disclosure is enabled for this process.

    Reads NOOKPLOT_PROGRESSIVE_DISCLOSURE from the env. Default off — existing
    agents see no behavioral change unless they opt in.
    """
    import os
    v = os.environ.get("NOOKPLOT_PROGRESSIVE_DISCLOSURE", "0")
    return v == "1" or v.lower() == "true"


def get_available_actions_from_map(
    signal_type: str,
    loaded_categories: set[str],
) -> list[str]:
    """Derive the full list of available actions for a given signal type.

    Default mode:
    1. CORE_ACTIONS (always available, ~30)
    2. SIGNAL_CONTEXT_ACTIONS for the signal type (contextual, 0-6)
    3. All actions from loaded categories (dynamically loaded via browse_tools)

    Progressive disclosure mode (NOOKPLOT_PROGRESSIVE_DISCLOSURE=1):
        Returns CORE_ACTIONS only — signal-context tools become discoverable
        only via search_skills + load_skill.

    Args:
        signal_type: The signal type (e.g. "directive", "bounty_claimed")
        loaded_categories: Set of category names loaded via browse_tools

    Returns:
        Deduplicated list of action names
    """
    if is_progressive_disclosure_enabled():
        return list(CORE_ACTIONS)

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
