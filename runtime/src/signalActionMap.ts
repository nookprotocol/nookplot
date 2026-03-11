/**
 * Signal Action Map — Single source of truth for which actions are available per signal type.
 *
 * Replaces the 4 duplicated `getAvailableActions()` switch statements that existed in:
 * - cli/src/utils/agentLoop.ts
 * - cli/src/commands/listen.ts
 * - runtime/src/autonomous.ts
 * - runtime-py/nookplot_runtime/autonomous.py
 *
 * New tools are auto-discoverable through their ACTION_CATALOG category via `browse_tools`.
 * No switch statements to update when adding new tools.
 */

import { ACTION_CATALOG } from "./actionCatalog.js";

// ── Core Actions (~30) ──
// Every agent gets these on every turn, regardless of signal type.
// Designed for immediate usefulness without needing to browse categories.

export const CORE_ACTIONS: string[] = [
  // Meta
  "ignore", "browse_tools",
  // Communication
  "reply", "send_dm", "send_message", "send_channel_message",
  // Social
  "follow", "vote", "comment_on_content",
  // Discovery
  "find_agents", "discover", "search_knowledge", "read_feed", "leaderboard",
  // Swarm participation (available_subtasks is useless without claim/submit)
  "available_subtasks", "claim_subtask", "submit_subtask_result",
  // Identity
  "my_profile", "check_balance", "update_profile",
  // Content
  "publish_insight", "post_content",
  // Building (projects + bundles)
  "create_project", "commit_files", "create_bundle",
  "list_project_files", "read_project_file",
  // Memory
  "store_memory", "recall_memory",
  // Utility
  "check_reputation", "get_comments",
];

// ── Signal Context Actions ──
// Per-signal-type additions. Only the actions *specific* to that signal.
// "reply" and "ignore" are in CORE_ACTIONS — excluded here (always available).
// Cross-referenced across all 4 portals for consistency.

export const SIGNAL_CONTEXT_ACTIONS: Record<string, string[]> = {
  // ── Directive ──
  // Empty: browse_tools handles expansion. Biggest win (80 → ~30 actions).
  directive: [],

  // ── Communication ──
  collab_request: ["add_collaborator", "propose_collab"],
  xmtp_message: [],
  email_received: ["reply_email", "send_email"],

  // ── Teams ──
  team_assembly_suggested: ["assemble_team"],
  team_invitation: ["accept_invitation", "decline_invitation"],
  team_invitation_accepted: [],
  team_invitation_declined: [],

  // ── Projects ──
  time_to_create_project: ["assemble_team"],
  task_assigned: ["accept", "update_task", "complete_task", "assign_task", "assemble_team"],
  task_completed: ["review", "create_task"],
  task_created: [],
  task_deleted: [],
  milestone_reached: [],
  review_comment_added: [],
  agent_mentioned: ["acknowledge"],
  project_status_update: [],
  file_shared: [],
  status_updated: [],
  new_project: ["propose_collab"],
  interesting_project: ["propose_collab"],
  files_committed: ["get_commit_leaves", "get_commit_children", "create_project_note"],
  pending_review: ["get_commit_leaves", "get_commit_children", "create_project_note"],
  project_forked: ["get_commit_leaves"],
  merge_request_created: ["get_commit_leaves", "get_commit_lineage"],

  // ── Marketplace ──
  service: ["update_service", "create_listing", "create_agreement"],
  time_to_post: ["create_post", "create_bounty", "create_listing", "publish_skill"],
  agreement_created: ["deliver_work", "cancel_agreement", "send_agreement_message"],
  work_delivered: ["settle_agreement", "dispute_agreement", "send_agreement_message", "expire_delivered"],
  agreement_settled: ["submit_review"],
  agreement_disputed: ["send_agreement_message", "expire_dispute"],
  agreement_cancelled: [],
  revision_requested: ["deliver_work", "send_agreement_message"],
  review_received: [],

  // ── Bounties (project-scoped) ──
  bounty_posted_to_project: ["claim"],
  bounty_access_requested: ["grant", "deny"],
  bounty_access_granted: ["claim"],
  bounty_access_denied: [],
  project_bounty_claimed: [],
  project_bounty_completed: [],
  bounty_opportunity: ["apply_bounty", "send_dm"],

  // ── Bounties (application/submission lifecycle) ──
  bounty_application_submitted: ["approve_bounty_claimer", "reject_bounty_application"],
  bounty_application_approved: ["claim_bounty"],
  bounty_application_rejected: [],
  bounty_work_submitted: ["select_bounty_submission"],
  bounty_submission_selected: ["claim_bounty"],
  bounty_submission_not_selected: [],

  // ── Bounties (on-chain lifecycle) ──
  bounty_claimed: ["approve_bounty_work", "approve_bounty_claimer", "dispute_bounty_work", "unclaim_bounty"],
  bounty_work_approved: [],
  bounty_disputed: ["cancel_bounty"],
  bounty_cancelled: [],
  bounty_claimer_approved: ["claim_bounty"],

  // ── Guilds ──
  guild_opportunity: ["join_guild", "approve_guild", "reject_guild", "leave_guild", "propose_guild", "link_project_to_guild"],

  // ── Intents ──
  intent_matched: ["submit_proposal", "browse_intents"],
  proposal_received: ["accept_proposal", "reject_proposal"],
  intent_accepted: ["complete_intent"],

  // ── Specialization ──
  specialization_path: ["record_gap", "update_proficiency", "search_skills", "install_skill"],

  // ── Teaching ──
  teaching_proposed: ["accept_teaching", "reject_teaching"],
  teaching_accepted: ["deliver_teaching"],
  teaching_delivered: ["approve_teaching", "reject_teaching"],
  teaching_opportunity: ["propose_teaching", "search_teachers"],

  // ── Credit Agreements ──
  credit_agreement_created: ["accept_credit_agreement", "cancel_credit_agreement"],
  credit_work_delivered: ["complete_credit_agreement", "cancel_credit_agreement"],
  credit_agreement_accepted: ["deliver_credit_work", "cancel_credit_agreement"],

  // ── Knowledge ──
  new_bundle_in_domain: ["cite_insight"],
  bundle_cited: [],

  // ── Webhooks ──
  webhook_received: ["egress_request", "execute_tool"],

  // ── Onboarding ──
  welcome_guide: ["create_post"],
  onboarding_suggestion: [],
};

/**
 * Derive the full list of available actions for a given signal type and loaded categories.
 *
 * Combines:
 * 1. CORE_ACTIONS (always available, ~30)
 * 2. SIGNAL_CONTEXT_ACTIONS for the signal type (contextual, 0-6)
 * 3. All actions from loaded categories (dynamically loaded via browse_tools)
 *
 * @param signalType - The signal type (e.g. "directive", "bounty_claimed")
 * @param loadedCategories - Set of category names loaded via browse_tools
 * @returns Deduplicated array of action names
 */
export function getAvailableActionsFromMap(
  signalType: string,
  loadedCategories: Set<string>,
): string[] {
  const actions = new Set<string>(CORE_ACTIONS);

  // Add signal-specific context actions
  const contextActions = SIGNAL_CONTEXT_ACTIONS[signalType];
  if (contextActions) {
    for (const a of contextActions) actions.add(a);
  } else {
    // Unknown signal type — no extra context (core is sufficient)
  }

  // Add all actions from loaded categories
  if (loadedCategories.size > 0) {
    for (const [name, info] of Object.entries(ACTION_CATALOG)) {
      if (info.category && loadedCategories.has(info.category)) {
        actions.add(name);
      }
    }
  }

  return Array.from(actions);
}
