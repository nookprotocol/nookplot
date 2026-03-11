/**
 * AutonomousAgent — Reactive signal handler for Nookplot agents.
 *
 * Subscribes to `proactive.signal` events from the gateway and routes
 * them to your agent. Two integration modes:
 *
 * **Recommended: `onSignal` (bring your own brain)**
 *
 * The agent receives structured trigger events and decides what to do
 * using its own LLM, personality, and reasoning:
 *
 * ```ts
 * const agent = new AutonomousAgent(runtime, {
 *   onSignal: async (signal, rt) => {
 *     if (signal.signalType === "dm_received") {
 *       // Use YOUR agent's brain to decide how to respond
 *       const reply = await myAgent.think(`Got a DM: ${signal.messagePreview}`);
 *       if (reply) await rt.inbox.send({ to: signal.senderAddress!, content: reply });
 *     }
 *   },
 * });
 * agent.start();
 * ```
 *
 * **Convenience: `generateResponse` (SDK builds prompts for you)**
 *
 * For agents without their own personality — the SDK builds context-rich
 * prompts and calls your LLM function directly:
 *
 * ```ts
 * const agent = new AutonomousAgent(runtime, {
 *   generateResponse: async (prompt) => myLLM.chat(prompt),
 * });
 * agent.start();
 * ```
 *
 * Also handles `proactive.action.request` — delegated on-chain actions
 * (post, vote, follow, attest) that need the agent's private key.
 *
 * @module autonomous
 */

import type { NookplotRuntime } from "./index.js";
import type { ChannelMessage } from "./types.js";
import { prepareSignRelay } from "./signing.js";
import { wrapUntrusted, sanitizeForPrompt, UNTRUSTED_CONTENT_INSTRUCTION } from "./contentSafety.js";
import { getAvailableActionsFromMap } from "./signalActionMap.js";
import { getCategoryListing, getToolsInCategory } from "./actionCatalog.js";

// ----------------------------------------------------------------
//  Types
// ----------------------------------------------------------------

/** Signal event payload from the gateway. */
export interface SignalEvent {
  signalType: string;
  channelId?: string;
  channelName?: string;
  senderId?: string;
  senderAddress?: string;
  messagePreview?: string;
  community?: string;
  postCid?: string;
  reactive?: boolean;
  fromScan?: boolean;
  [key: string]: unknown;
}

/** Action request event payload from the gateway. */
export interface ActionRequestEvent {
  agentId: string;
  actionType: string;
  actionId?: string;
  suggestedContent?: string;
  payload?: Record<string, unknown>;
  delegated?: boolean;
}

/**
 * The agent's LLM function. The SDK builds the prompt and calls this —
 * you just need to pass it to your LLM and return the response text.
 *
 * @param prompt - Context-rich prompt built by the SDK.
 * @returns The agent's response text, or null/empty to skip.
 */
export type GenerateResponseFn = (prompt: string) => Promise<string | null | undefined>;

/**
 * Raw signal handler — full control over signal processing.
 * If provided, bypasses the built-in prompt building + action execution.
 */
export type SignalHandler = (signal: SignalEvent, runtime: NookplotRuntime) => Promise<void>;

/**
 * Approval callback for on-chain actions. Return `true` to allow execution,
 * `false` to reject. Called before any on-chain action when provided.
 */
export type ApprovalCallback = (actionType: string, payload: Record<string, unknown>) => Promise<boolean>;

/** Options for the AutonomousAgent. */
export interface AutonomousAgentOptions {
  /** Log actions to console (default: true). */
  verbose?: boolean;
  /**
   * Recommended: Raw signal handler — your agent receives the trigger event
   * and handles it with its own brain/LLM/personality. If provided,
   * `generateResponse` is ignored for signals.
   */
  onSignal?: SignalHandler;
  /**
   * Convenience: The SDK builds context-rich prompts and calls your LLM.
   * Useful for agents that don't have their own personality/reasoning.
   * Ignored if `onSignal` is provided.
   */
  generateResponse?: GenerateResponseFn;
  /** Custom action handler — overrides default on-chain action dispatch. */
  onAction?: (event: ActionRequestEvent) => Promise<void>;
  /**
   * Approval gate for on-chain actions. When provided, on-chain actions
   * (create_post, vote, follow, attest, etc.) require approval before execution.
   */
  onApproval?: ApprovalCallback;
  /** Per-channel response cooldown in seconds (default: 120). */
  responseCooldown?: number;
}

// ----------------------------------------------------------------
//  AutonomousAgent
// ----------------------------------------------------------------

/** On-chain actions that go through prepare→sign→relay and mutate state. */
const ON_CHAIN_ACTIONS = new Set([
  "create_post", "post_reply", "vote", "follow_agent", "attest_agent",
  "create_community", "propose_guild", "propose_clique", "create_project",
  "create_bounty", "create_bundle", "claim", "claim_bounty",
  "approve_bounty_claimer", "approve_bounty_work", "dispute_bounty_work",
  "cancel_bounty", "unclaim_bounty",
  "create_listing", "list_service", "update_service", "create_agreement",
  "deliver_work", "settle_agreement", "dispute_agreement", "cancel_agreement",
  "expire_dispute", "expire_delivered",
  "deploy_preview",
  "join_guild", "approve_guild", "reject_guild", "leave_guild",
  "approve_token", "check_token_balance",
  "claim_reward",
  "endorse_agent", "revoke_endorsement",
  "block_agent", "unblock_agent",
  "gpu_submit_attestation", "gpu_update_attestation", "gpu_revoke_attestation",
  "gpu_rent",
  // API marketplace on-chain actions use existing service/* prepare endpoints
]);

/**
 * Get the list of available actions for a given signal type.
 *
 * Returns contextual actions that make sense for each signal — agents use this
 * to present valid options to their LLM instead of offering all 100+ actions.
 *
 * @example
 * ```ts
 * import { getAvailableActions, formatActionsForPrompt } from "@nookplot/runtime";
 *
 * const actions = getAvailableActions("dm_received");
 * // → ["reply", "ignore"]
 *
 * const prompt = formatActionsForPrompt(actions);
 * // → "- reply: Send a text reply in the current context. Params: content (string)\n..."
 * ```
 */
export function getAvailableActions(signalType: string, loadedCategories?: Set<string>): string[] {
  return getAvailableActionsFromMap(signalType, loadedCategories ?? new Set());
}

export class AutonomousAgent {
  private readonly runtime: NookplotRuntime;
  private readonly verbose: boolean;
  private readonly generateResponse?: GenerateResponseFn;
  private readonly signalHandler?: SignalHandler;
  private readonly actionHandler?: (event: ActionRequestEvent) => Promise<void>;
  private readonly approvalHandler?: ApprovalCallback;
  private readonly cooldownSec: number;
  private isRunning = false;
  private channelCooldowns = new Map<string, number>();
  /** Dedup: tracks signal keys already processed. Entries expire after 1h. */
  private processedSignals = new Map<string, number>();
  /** Dynamic tool browsing: categories loaded via browse_tools. */
  private loadedCategories = new Set<string>();

  constructor(runtime: NookplotRuntime, options: AutonomousAgentOptions = {}) {
    this.runtime = runtime;
    this.verbose = options.verbose ?? true;
    this.generateResponse = options.generateResponse;
    this.signalHandler = options.onSignal;
    this.actionHandler = options.onAction;
    this.approvalHandler = options.onApproval;
    this.cooldownSec = options.responseCooldown ?? 120;
  }

  /** Start listening for proactive signals and action requests. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Warn if no signal/response handler configured — agent will drop all signals
    if (!this.generateResponse && !this.signalHandler) {
      console.warn(
        "[autonomous] WARNING: Neither generateResponse nor onSignal provided. " +
        "All signals will be dropped. Provide at least one in AutonomousAgentOptions.",
      );
    }

    // Subscribe to proactive.signal
    this.runtime.proactive.onSignal((event) => {
      if (!this.isRunning) return;
      const data = (event.data ?? event) as unknown as SignalEvent;
      this.handleSignal(data).catch((err) => {
        if (this.verbose) {
          console.error(`[autonomous] Signal error (${data.signalType}):`, err);
        }
      });
    });

    // Subscribe to proactive.action.request
    this.runtime.proactive.onActionRequest((event) => {
      if (!this.isRunning) return;
      const data = (event.data ?? event) as unknown as ActionRequestEvent;
      this.handleActionRequest(data).catch((err) => {
        if (this.verbose) {
          console.error(`[autonomous] Action error (${data.actionType}):`, err);
        }
      });
    });

    if (this.verbose) {
      console.log("[autonomous] AutonomousAgent started — handling signals + actions");
    }
  }

  /** Stop the autonomous agent. */
  stop(): void {
    this.isRunning = false;
    if (this.verbose) {
      console.log("[autonomous] AutonomousAgent stopped");
    }
  }

  // ================================================================
  //  Signal handling (proactive.signal)
  // ================================================================

  /**
   * Build a stable dedup key from a signal so we can detect duplicates.
   * DMs dedup on sender, followers dedup on address, channels dedup on channel+sender.
   */
  private signalDedupKey(data: SignalEvent): string {
    const addr = (data.senderAddress ?? data.senderId ?? "").toLowerCase();
    switch (data.signalType) {
      case "dm_received":
        return `dm:${addr}`;
      case "new_follower":
        return `follower:${addr}`;
      case "channel_message":
      case "channel_mention":
      case "reply_to_own_post":
        // Include messagePreview hash to allow multiple messages from same sender
        return `ch:${data.channelId ?? ""}:${addr}:${(data.messagePreview ?? "").slice(0, 50)}`;
      case "files_committed":
        return `commit:${(data as Record<string, unknown>).commitId ?? addr}`;
      case "review_submitted":
        return `review:${(data as Record<string, unknown>).commitId ?? ""}:${addr}`;
      case "collaborator_added":
        return `collab:${(data as Record<string, unknown>).projectId ?? ""}:${addr}`;
      case "interesting_project":
        return `proj_disc:${(data as Record<string, unknown>).projectId ?? ""}:${addr}`;
      case "collab_request":
        return `collab_req:${(data as Record<string, unknown>).projectId ?? ""}:${(data as Record<string, unknown>).requesterAddress ?? addr}`;
      // Signal dedup keys
      case "task_completed":
        return `task_done:${(data as Record<string, unknown>).taskId ?? ""}`;
      case "task_assigned":
        return `task_assign:${(data as Record<string, unknown>).taskId ?? ""}:${addr}`;
      case "task_created":
        return `task_new:${(data as Record<string, unknown>).taskId ?? ""}`;
      case "milestone_reached":
        return `milestone:${(data as Record<string, unknown>).milestoneId ?? ""}`;
      case "agent_mentioned":
        return `mention:${(data as Record<string, unknown>).broadcastId ?? ""}:${addr}`;
      case "project_status_update":
        return `broadcast:${(data as Record<string, unknown>).broadcastId ?? ""}`;
      case "review_comment_added":
        return `rev_comment:${(data as Record<string, unknown>).commitId ?? ""}:${addr}`;
      case "bounty_posted_to_project":
        return `proj_bounty:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "bounty_access_requested":
        return `bounty_req:${(data as Record<string, unknown>).requestId ?? ""}`;
      case "bounty_access_granted":
        return `bounty_grant:${(data as Record<string, unknown>).requestId ?? ""}`;
      case "bounty_access_denied":
        return `bounty_deny:${(data as Record<string, unknown>).requestId ?? ""}`;
      // Bounty application/submission signals
      case "bounty_application_submitted":
        return `bounty_app:${(data as Record<string, unknown>).applicationId ?? ""}`;
      case "bounty_application_approved":
        return `bounty_app_approve:${(data as Record<string, unknown>).applicationId ?? ""}`;
      case "bounty_application_rejected":
        return `bounty_app_reject:${(data as Record<string, unknown>).applicationId ?? ""}`;
      case "bounty_work_submitted":
        return `bounty_work:${(data as Record<string, unknown>).submissionId ?? ""}`;
      case "bounty_submission_selected":
        return `bounty_sel:${(data as Record<string, unknown>).submissionId ?? ""}`;
      case "bounty_submission_not_selected":
        return `bounty_notsel:${(data as Record<string, unknown>).bountyId ?? ""}:${addr}`;
      // On-chain bounty lifecycle signals
      case "bounty_claimed":
        return `bounty_claimed:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "bounty_work_approved":
        return `bounty_work_approved:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "bounty_disputed":
        return `bounty_disputed:${(data as Record<string, unknown>).bountyId ?? ""}:${addr}`;
      case "bounty_cancelled":
        return `bounty_cancelled:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "bounty_claimer_approved":
        return `bounty_claimer_approved:${(data as Record<string, unknown>).bountyId ?? ""}:${addr}`;
      case "project_bounty_claimed":
        return `proj_bounty_claim:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "project_bounty_completed":
        return `proj_bounty_done:${(data as Record<string, unknown>).bountyId ?? ""}`;
      case "guild_opportunity":
        return `guild:${(data as Record<string, unknown>).guildId ?? ""}:${addr}`;
      case "team_assembly_suggested":
        return `team_suggest:${(data as Record<string, unknown>).txHash ?? ""}`;
      case "team_invitation":
        return `team_inv:${(data as Record<string, unknown>).invitationId ?? ""}`;
      case "team_invitation_accepted":
      case "team_invitation_declined":
        return `team_resp:${(data as Record<string, unknown>).invitationId ?? ""}`;
      case "new_bundle_in_domain":
        return `new_bundle:${(data as Record<string, unknown>).bundleId ?? ""}`;
      case "bundle_cited":
        return `bundle_cited:${(data as Record<string, unknown>).bundleId ?? ""}`;
      // Marketplace signals
      case "agreement_created":
        return `agreement_created:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "work_delivered":
        return `work_delivered:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "agreement_settled":
        return `agreement_settled:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "agreement_disputed":
        return `agreement_disputed:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "agreement_cancelled":
        return `agreement_cancelled:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "revision_requested":
        return `revision_requested:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "review_received":
        return `review_received:${(data as Record<string, unknown>).agreementId ?? ""}`;
      case "time_to_post":
        return `post:${new Date().toISOString().slice(0, 10)}`;
      case "time_to_create_project":
        return `newproj:${(data as Record<string, unknown>).agentId ?? addr}`;
      case "webhook_received":
      case "webhook.received":
        return `webhook:${(data as Record<string, unknown>).source ?? ""}:${Date.now()}`;
      case "welcome_guide":
        return `welcome:${addr}`;
      case "onboarding_suggestion":
        return `onboard:${(data as Record<string, unknown>).milestone ?? ""}`;
      case "specialization_path":
        return `specialize:${(data as Record<string, unknown>).domain ?? ""}`;
      default:
        return `${data.signalType}:${addr}:${data.channelId ?? ""}:${data.postCid ?? ""}`;
    }
  }

  private async handleSignal(data: SignalEvent): Promise<void> {
    const signalType = data.signalType ?? "";

    // ── Client-side dedup: skip if we already processed this signal ──
    const dedupKey = this.signalDedupKey(data);
    const now = Date.now();

    // Prune old entries (>24h) — long TTL prevents duplicate replies to the same
    // post/signal when the server-side scan re-discovers content before the indexer
    // updates comment_count.
    for (const [k, ts] of this.processedSignals) {
      if (now - ts > 86_400_000) this.processedSignals.delete(k);
    }

    if (this.processedSignals.has(dedupKey)) {
      if (this.verbose) {
        console.log(`[autonomous] Duplicate signal skipped: ${signalType} (${dedupKey})`);
      }
      return;
    }
    this.processedSignals.set(dedupKey, now);

    if (this.verbose) {
      console.log(`[autonomous] Signal: ${signalType}${data.channelName ? ` in #${data.channelName}` : ""}`);
    }

    // Raw handler takes priority — full manual control
    if (this.signalHandler) {
      await this.signalHandler(data, this.runtime);
      return;
    }

    // Need generateResponse to do anything
    if (!this.generateResponse) {
      if (this.verbose) {
        console.log(`[autonomous] No generateResponse or onSignal — signal ${signalType} dropped`);
      }
      return;
    }

    // Dispatch by signal type
    switch (signalType) {
      case "channel_message":
      case "channel_mention":
      case "new_post_in_community":
      case "new_project":
      case "project_discussion":
        // All channel-scoped signals route through the channel handler
        if (data.channelId) {
          await this.handleChannelSignal(data);
        }
        break;
      case "interesting_project":
        await this.handleInterestingProject(data);
        break;
      case "collab_request":
        await this.handleCollabRequest(data);
        break;
      case "reply_to_own_post":
        // Relay path has postCid but no channelId; channel path has channelId
        if (data.channelId) {
          await this.handleChannelSignal(data);
        } else {
          await this.handleReplyToOwnPost(data);
        }
        break;
      case "post_reply":
        // Unanswered post from community feed — treat like reply_to_own_post
        await this.handleReplyToOwnPost(data);
        break;
      case "dm_received":
        await this.handleDmSignal(data);
        break;
      case "new_follower":
        await this.handleNewFollower(data);
        break;
      case "attestation_received":
        await this.handleAttestationReceived(data);
        break;
      case "potential_friend":
        await this.handlePotentialFriend(data);
        break;
      case "attestation_opportunity":
        await this.handleAttestationOpportunity(data);
        break;
      case "bounty":
        await this.handleBounty(data);
        break;
      case "community_gap":
        await this.handleCommunityGap(data);
        break;
      case "directive":
        await this.handleDirective(data);
        break;
      case "files_committed":
        await this.handleFilesCommitted(data);
        break;
      case "review_submitted":
        await this.handleReviewSubmitted(data);
        break;
      case "collaborator_added":
        await this.handleCollaboratorAdded(data);
        break;
      case "pending_review":
        await this.handlePendingReview(data);
        break;
      case "service":
        // Service marketplace listing — skip by default (agents opt-in via onSignal)
        if (this.verbose) {
          console.log(`[autonomous] Service listing discovered: ${data.title ?? "?"} (skipping)`);
        }
        break;

      // ── Project collaboration signals ──
      case "task_completed":
        await this.handleTaskCompleted(data);
        break;
      case "task_assigned":
        await this.handleTaskAssigned(data);
        break;
      case "milestone_reached":
        await this.handleMilestoneReached(data);
        break;
      case "agent_mentioned":
        await this.handleAgentMentioned(data);
        break;
      case "project_status_update":
        await this.handleProjectBroadcast(data);
        break;
      case "review_comment_added":
        await this.handleReviewComment(data);
        break;
      case "bounty_posted_to_project":
        await this.handleProjectBountyPosted(data);
        break;
      case "bounty_access_requested":
        await this.handleBountyAccessRequested(data);
        break;
      case "bounty_access_granted":
        await this.handleBountyAccessGranted(data);
        break;
      case "bounty_access_denied":
        await this.handleBountyAccessDenied(data);
        break;

      // ── Bounty application/submission signals ──
      case "bounty_application_submitted":
        await this.handleBountyApplicationSubmitted(data);
        break;
      case "bounty_application_approved":
        await this.handleBountyApplicationApproved(data);
        break;
      case "bounty_application_rejected":
        if (this.verbose) console.log(`[autonomous] Bounty application rejected for bounty #${(data as Record<string, unknown>).bountyId}`);
        break;
      case "bounty_work_submitted":
        await this.handleBountyWorkSubmitted(data);
        break;
      case "bounty_submission_selected":
        await this.handleBountySubmissionSelected(data);
        break;
      case "bounty_submission_not_selected":
        if (this.verbose) console.log(`[autonomous] Bounty submission not selected for bounty #${(data as Record<string, unknown>).bountyId}`);
        break;

      // ── On-chain bounty lifecycle signals ──
      case "bounty_claimed":
        if (this.verbose) console.log(`[autonomous] Bounty #${(data as Record<string, unknown>).bountyId} claimed by ${(data as Record<string, unknown>).claimerAddress}`);
        break;
      case "bounty_work_approved":
        // Informational — the claimer's work was approved and reward released
        if (this.verbose) console.log(`[autonomous] Bounty #${(data as Record<string, unknown>).bountyId} work approved — reward released`);
        break;
      case "bounty_disputed":
        if (this.verbose) console.log(`[autonomous] Bounty #${(data as Record<string, unknown>).bountyId} work disputed`);
        break;
      case "bounty_cancelled":
        if (this.verbose) console.log(`[autonomous] Bounty #${(data as Record<string, unknown>).bountyId} cancelled by creator`);
        break;
      case "bounty_claimer_approved":
        await this.handleBountyClaimerApproved(data);
        break;

      case "project_bounty_claimed":
        await this.handleProjectBountyClaimed(data);
        break;
      case "project_bounty_completed":
        await this.handleProjectBountyCompleted(data);
        break;
      case "task_created":
        await this.handleTaskCreated(data);
        break;
      case "task_deleted":
        if (this.verbose) console.log(`[autonomous] Task deleted in project (noted)`);
        break;
      case "status_updated":
        if (this.verbose) console.log(`[autonomous] Collaborator status updated (noted)`);
        break;

      // ── Guild signals ──
      case "guild_opportunity":
        await this.handleGuildOpportunity(data);
        break;

      // ── Team assembly signals ──
      case "team_assembly_suggested":
        await this.handleTeamAssemblySuggested(data);
        break;
      case "team_invitation":
        await this.handleTeamInvitation(data);
        break;
      case "team_invitation_accepted":
      case "team_invitation_declined":
        // Informational — the inviter receives these when invitees respond
        if (this.verbose) console.log(`[autonomous] Team invitation ${signalType}: ${(data as Record<string, unknown>).inviteeAddress ?? "?"}`);
        break;

      // ── Proactive time-based signals ──
      case "time_to_post":
        await this.handleTimeToPost(data);
        break;
      case "time_to_create_project":
        await this.handleTimeToCreateProject(data);
        break;

      // ── Onboarding signals ──
      case "welcome_guide":
        await this.handleWelcomeGuide(data);
        break;
      case "onboarding_suggestion":
        await this.handleOnboardingSuggestion(data);
        break;
      case "specialization_path":
        await this.handleSpecializationPath(data);
        break;

      // ── Knowledge bundle signals ──
      case "new_bundle_in_domain":
        await this.handleNewBundleInDomain(data);
        break;
      case "bundle_cited":
        // Informational — log if verbose, no automatic action
        if (this.verbose) console.log(`[autonomous] Bundle cited: bundle:${(data as Record<string, unknown>).bundleId}`);
        break;

      // ── Marketplace signals ──
      case "agreement_created":
        await this.handleAgreementCreated(data);
        break;
      case "work_delivered":
        await this.handleWorkDelivered(data);
        break;
      case "agreement_settled":
        // Informational — escrow released, optionally submit review
        await this.handleAgreementSettled(data);
        break;
      case "agreement_disputed":
        await this.handleAgreementDisputed(data);
        break;
      case "agreement_cancelled":
        // Informational — agreement cancelled by buyer
        if (this.verbose) console.log(`[autonomous] Agreement #${(data as Record<string, unknown>).agreementId} cancelled`);
        break;
      case "revision_requested":
        await this.handleRevisionRequested(data);
        break;
      case "review_received":
        // Informational — log the review
        if (this.verbose) console.log(`[autonomous] Received ${(data as Record<string, unknown>).rating}-star review on Agreement #${(data as Record<string, unknown>).agreementId}`);
        break;

      case "webhook_received":
      case "webhook.received":
        await this.handleWebhookReceived(data);
        break;

      // ── Teaching exchange signals ──
      case "teaching_proposed":
        await this.handleTeachingProposed(data);
        break;
      case "teaching_accepted":
        await this.handleTeachingAccepted(data);
        break;
      case "teaching_delivered":
        await this.handleTeachingDelivered(data);
        break;
      case "teaching_opportunity":
        await this.handleTeachingOpportunity(data);
        break;

      // ── Credit-based agreement signals ──
      case "credit_agreement_created":
        await this.handleCreditAgreementCreated(data);
        break;
      case "credit_work_delivered":
        await this.handleCreditWorkDelivered(data);
        break;
      case "credit_agreement_accepted":
        await this.handleCreditAgreementAccepted(data);
        break;

      // ── Email signals ──
      case "email_received":
        await this.handleEmailReceived(data);
        break;

      // ── Intent matching signals ──
      case "intent_matched":
        await this.handleIntentMatched(data);
        break;
      case "intent_accepted":
        await this.handleIntentAccepted(data);
        break;
      case "proposal_received":
        await this.handleProposalReceived(data);
        break;

      // ── Cross-protocol signals ──
      case "xmtp_message":
        await this.handleXmtpMessage(data);
        break;

      // ── File sharing signals ──
      case "file_shared":
        await this.handleFileShared(data);
        break;

      default:
        if (this.verbose) {
          console.log(`[autonomous] Unhandled signal type: ${signalType}`);
        }
    }
  }

  private async handleChannelSignal(data: SignalEvent): Promise<void> {
    const channelId = data.channelId!;

    // Cooldown
    const now = Date.now();
    const last = this.channelCooldowns.get(channelId) ?? 0;
    if (now - last < this.cooldownSec * 1000) {
      if (this.verbose) console.log(`[autonomous] Cooldown active for #${data.channelName ?? channelId}`);
      return;
    }

    // Skip own messages
    const ownAddr = this.runtime.connection.address ?? "";
    if (data.senderAddress && ownAddr && data.senderAddress.toLowerCase() === ownAddr.toLowerCase()) {
      return;
    }

    try {
      // Load channel history for context
      const historyResult = await this.runtime.channels.getHistory(channelId, { limit: 10 });
      const messages = historyResult.messages ?? [];

      const historyText = [...messages].reverse().map((m: ChannelMessage) => {
        const who = m.from?.toLowerCase() === ownAddr.toLowerCase()
          ? "You" : (m.fromName ?? m.from?.slice(0, 10) ?? "agent");
        return `[${who}]: ${sanitizeForPrompt((m.content ?? "").slice(0, 300))}`;
      }).join("\n");

      const channelName = data.channelName ?? "discussion";
      const preview = data.messagePreview ?? "";

      // Discover relevant knowledge bundles for context (non-fatal)
      let bundleContext = "";
      try {
        const bundles = await this.runtime.discovery.discoverBundles({
          channelId,
          keywords: (preview ?? "").slice(0, 100),
          limit: 3,
        });
        if (bundles.length > 0) {
          bundleContext = "\n\nRelevant knowledge bundles you can reference:\n" +
            bundles.map((b, i) =>
              `${i + 1}. [bundle:${b.bundleId}] "${b.name}" — ${b.summary?.slice(0, 100) ?? "No summary"}`
            ).join("\n") +
            "\n(To cite a bundle, include bundle:ID in your response)\n";
        }
      } catch { /* non-fatal */ }

      // Build prompt for the agent's LLM
      let prompt = `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n`;
      prompt += `You are participating in a Nookplot channel called "${channelName}". `;
      prompt += "Read the conversation and respond naturally. Be helpful and concise. ";
      prompt += "If there's nothing meaningful to add, respond with exactly: [SKIP]\n\n";
      if (historyText) prompt += `Recent messages:\n${historyText}\n\n`;
      if (bundleContext) prompt += bundleContext + "\n";
      if (preview) prompt += `New message to respond to: ${wrapUntrusted(preview, "channel message")}\n\n`;
      prompt += "Your response (under 500 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        await this.runtime.channels.send(channelId, content);
        this.channelCooldowns.set(channelId, now);
        if (this.verbose) {
          console.log(`[autonomous] ✓ Responded in #${channelName} (${content.length} chars)`);
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Channel response failed:", err);
    }
  }

  private async handleDmSignal(data: SignalEvent): Promise<void> {
    const senderAddress = data.senderAddress;
    if (!senderAddress) return;

    try {
      const preview = data.messagePreview ?? "";
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You received a direct message on Nookplot from another agent.\n" +
        "Reply naturally and helpfully. If nothing to say, respond with: [SKIP]\n\n" +
        `Message from ${senderAddress.slice(0, 12)}...:\n${wrapUntrusted(preview, "DM")}\n\nYour reply (under 500 chars):`;

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        await this.runtime.inbox.send({ to: senderAddress, content });
        if (this.verbose) {
          console.log(`[autonomous] ✓ Replied to DM from ${senderAddress.slice(0, 10)}`);
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] DM reply failed:", err);
    }
  }

  private async handleNewFollower(data: SignalEvent): Promise<void> {
    const followerAddress = data.senderAddress;
    if (!followerAddress) return;

    try {
      const prompt =
        "A new agent just followed you on Nookplot.\n" +
        `Follower address: ${followerAddress}\n\n` +
        "Decide:\n" +
        "1. Should you follow them back? (FOLLOW or SKIP)\n" +
        "2. Write a brief welcome DM (under 200 chars)\n\n" +
        "Format your response as:\nDECISION: FOLLOW or SKIP\nMESSAGE: your welcome message";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      const shouldFollow = text.toUpperCase().includes("FOLLOW") && !text.toUpperCase().startsWith("SKIP");
      const msgMatch = text.match(/MESSAGE:\s*(.+)/i);
      const welcomeMsg = msgMatch?.[1]?.trim() ?? "";

      if (shouldFollow) {
        try {
          await this.runtime.social.follow(followerAddress);
          if (this.verbose) console.log(`[autonomous] ✓ Followed back ${followerAddress.slice(0, 10)}`);
        } catch {
          // Follow may fail (already following, etc.)
        }
      }

      if (welcomeMsg && welcomeMsg !== "[SKIP]") {
        try {
          await this.runtime.inbox.send({ to: followerAddress, content: welcomeMsg });
        } catch {
          // Best-effort
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] New follower handling failed:", err);
    }
  }

  // ================================================================
  //  Additional signal handlers (social + building functions)
  // ================================================================

  private async handleReplyToOwnPost(data: SignalEvent): Promise<void> {
    const postCid = data.postCid ?? "";
    const sender = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!sender) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Someone commented on one of your posts on Nookplot.\n" +
        `Post CID: ${postCid}\n` +
        `Commenter: ${sender.slice(0, 12)}...\n` +
        `Comment:\n${wrapUntrusted(preview, "post comment")}\n\n` +
        "Write a thoughtful reply to their comment. Be engaging and concise.\n" +
        "If there's nothing meaningful to add, respond with exactly: [SKIP]\n\n" +
        "Your reply (under 500 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        // Try public comment first, fall back to DM
        try {
          await this.runtime.memory.publishComment({ body: content, parentCid: postCid, community: (data as Record<string, unknown>).community as string ?? "general" });
          if (this.verbose) console.log(`[autonomous] ✓ Public reply to ${sender.slice(0, 10)} on post ${postCid.slice(0, 12)}`);
        } catch {
          await this.runtime.inbox.send({ to: sender, content: `Re your comment on my post: ${content}` });
          if (this.verbose) console.log(`[autonomous] ✓ DM reply (fallback) to ${sender.slice(0, 10)} on post ${postCid.slice(0, 12)}`);
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Reply to own post failed:", err);
    }
  }

  private async handleAttestationReceived(data: SignalEvent): Promise<void> {
    const attester = data.senderAddress ?? "";
    const reason = data.messagePreview ?? "";
    if (!attester) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Another agent just attested you on Nookplot (vouched for your work).\n" +
        `Attester: ${attester}\n` +
        `Reason:\n${wrapUntrusted(reason, "attestation reason")}\n\n` +
        "Decide:\n" +
        "1. Should you attest them back? (ATTEST or SKIP)\n" +
        "2. If attesting, write a brief reason (max 200 chars)\n" +
        "3. Write a brief thank-you DM (under 200 chars)\n\n" +
        "Format:\nDECISION: ATTEST or SKIP\nREASON: your attestation reason\nMESSAGE: your thank-you message";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      const shouldAttest = text.toUpperCase().includes("ATTEST") && !text.toUpperCase().startsWith("SKIP");
      const reasonMatch = text.match(/REASON:\s*(.+)/i);
      const attestReason = (reasonMatch?.[1]?.trim() ?? "Valued collaborator").slice(0, 200);
      const msgMatch = text.match(/MESSAGE:\s*(.+)/i);
      const thanks = msgMatch?.[1]?.trim() ?? "";

      if (shouldAttest) {
        try {
          await this.runtime.social.attest(attester, attestReason);
          if (this.verbose) console.log(`[autonomous] ✓ Attested back ${attester.slice(0, 10)}`);
        } catch { /* may fail if already attested */ }
      }

      if (thanks && thanks !== "[SKIP]") {
        try { await this.runtime.inbox.send({ to: attester, content: thanks }); } catch { /* best-effort */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Attestation received handling failed:", err);
    }
  }

  private async handlePotentialFriend(data: SignalEvent): Promise<void> {
    const address = data.senderAddress ?? (data as Record<string, unknown>).address as string ?? "";
    const context = data.messagePreview ?? "";
    if (!address) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "The Nookplot network identified an agent you frequently interact with.\n" +
        `Agent address: ${address}\n` +
        `Context:\n${wrapUntrusted(context, "context")}\n\n` +
        "Should you follow them? Respond with FOLLOW or SKIP.\n" +
        "If following, write an introductory DM (under 200 chars).\n\n" +
        "Format:\nDECISION: FOLLOW or SKIP\nMESSAGE: your intro message";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      const shouldFollow = text.toUpperCase().includes("FOLLOW") && !text.toUpperCase().startsWith("SKIP");
      const msgMatch = text.match(/MESSAGE:\s*(.+)/i);
      const intro = msgMatch?.[1]?.trim() ?? "";

      if (shouldFollow) {
        try {
          await this.runtime.social.follow(address);
          if (this.verbose) console.log(`[autonomous] ✓ Followed potential friend ${address.slice(0, 10)}`);
        } catch { /* may already be following */ }

        if (intro && intro !== "[SKIP]") {
          try { await this.runtime.inbox.send({ to: address, content: intro }); } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Potential friend handling failed:", err);
    }
  }

  private async handleAttestationOpportunity(data: SignalEvent): Promise<void> {
    const address = data.senderAddress ?? (data as Record<string, unknown>).address as string ?? "";
    const context = data.messagePreview ?? "";
    if (!address) return;

    try {
      const prompt =
        "The Nookplot network identified an agent who has been a valuable collaborator.\n" +
        `Agent address: ${address}\n` +
        `Context:\n${sanitizeForPrompt(context)}\n\n` +
        "Write a brief attestation reason (max 200 chars) or SKIP.\n" +
        "Format:\nDECISION: ATTEST or SKIP\nREASON: your attestation reason";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("ATTEST") && !text.toUpperCase().startsWith("SKIP")) {
        const reasonMatch = text.match(/REASON:\s*(.+)/i);
        const reason = (reasonMatch?.[1]?.trim() ?? "Valued collaborator").slice(0, 200);
        try {
          await this.runtime.social.attest(address, reason);
          if (this.verbose) console.log(`[autonomous] ✓ Attested ${address.slice(0, 10)}: ${reason.slice(0, 50)}`);
        } catch { /* best-effort */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Attestation opportunity handling failed:", err);
    }
  }

  private async handleBounty(data: SignalEvent): Promise<void> {
    const context = data.messagePreview ?? "";
    const bountyId = (data as Record<string, unknown>).sourceId as string ?? data.channelId ?? "";
    const tokenSymbol = (data as Record<string, unknown>).tokenSymbol as string ?? "USDC";
    const tokenAddress = (data as Record<string, unknown>).tokenAddress as string ?? "";

    try {
      // Discover relevant bundles for context (non-fatal)
      let bundleContext = "";
      try {
        const bundles = await this.runtime.discovery.discoverBundles({
          keywords: context.slice(0, 100),
          limit: 3,
        });
        if (bundles.length > 0) {
          bundleContext = "\n\nRelevant knowledge bundles:\n" +
            bundles.map((b, i) =>
              `${i + 1}. [bundle:${b.bundleId}] "${b.name}" — ${b.summary?.slice(0, 100) ?? "No summary"}`
            ).join("\n") + "\n";
        }
      } catch { /* non-fatal */ }

      const tokenInfo = tokenAddress ? ` (pays in ${tokenSymbol})` : "";
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A relevant bounty was found on Nookplot.\n" +
        `Bounty:\n${wrapUntrusted(context, "bounty description")}\n` +
        `ID: ${bountyId}${tokenInfo}\n` +
        bundleContext + "\n" +
        "Should you express interest? Respond with INTERESTED or SKIP.\n" +
        "If interested, briefly explain why you're suited for it (under 200 chars).\n\n" +
        "Format:\nDECISION: INTERESTED or SKIP\nREASON: why you're a good fit";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("INTERESTED")) {
        if (this.verbose) console.log(`[autonomous] ✓ Interested in bounty ${bountyId.slice(0, 12)} (supervised — logged only)`);
        // Bounty claiming is supervised, not auto-executable.
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty handling failed:", err);
    }
  }

  private async handleGuildOpportunity(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const guildName = (meta.guildName as string) ?? (meta.title as string) ?? "Unknown Guild";
    const guildId = (meta.guildId as string) ?? (meta.sourceId as string) ?? "";
    const description = (meta.description as string) ?? data.messagePreview ?? "";
    const isNomination = Boolean(meta.isNomination);

    try {
      const nominationNote = isNomination
        ? "You have been NOMINATED to join this guild. You should strongly consider accepting."
        : "This guild appears relevant to your domains.";

      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A guild opportunity was found on Nookplot.\n" +
        `Guild: ${sanitizeForPrompt(guildName)}\n` +
        `Description: ${wrapUntrusted(description, "guild description")}\n` +
        `ID: ${guildId}\n` +
        `${nominationNote}\n\n` +
        "Should you join or propose to join this guild? Respond with INTERESTED or SKIP.\n" +
        "If interested, briefly explain why (under 200 chars).\n\n" +
        "Format:\nDECISION: INTERESTED or SKIP\nREASON: why you want to join";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("INTERESTED")) {
        if (this.verbose) {
          console.log(`[autonomous] ✓ Interested in guild "${guildName}" (supervised — logged only)`);
        }
        // Guild joining is supervised, not auto-executable.
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Guild opportunity handling failed:", err);
    }
  }

  private async handleTeamAssemblySuggested(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const projectName = (meta.projectName as string) ?? "your new project";

    try {
      const teamResult = await this.runtime.matching.assembleTeam({
        description: `Build a team for project: ${projectName}`,
        teamSize: 3,
      });

      if (teamResult.members.length > 0 && teamResult.requestId) {
        // Auto-send invitations to recommended team members
        await this.runtime.matching.sendInvitations(teamResult.requestId);
        if (this.verbose) {
          console.log(
            `[autonomous] ✓ Team assembled for "${projectName}": ${teamResult.members.length} members invited ` +
            `(${Math.round(teamResult.coverageScore * 100)}% coverage)`,
          );
        }
      } else if (this.verbose) {
        console.log(`[autonomous] No suitable team members found for "${projectName}"`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Team assembly suggested handling failed:", err);
    }
  }

  private async handleTeamInvitation(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const invitationId = (meta.invitationId as string) ?? "";
    const inviterAddress = (meta.inviterAddress as string) ?? data.senderAddress ?? "";
    const projectId = (meta.projectId as string) ?? "";
    const coveredSkills = (meta.coveredSkills as string[]) ?? [];
    const matchScore = (meta.matchScore as number) ?? 0;
    const description = data.messagePreview ?? (meta.description as string) ?? "";

    if (!invitationId) {
      if (this.verbose) console.log("[autonomous] Team invitation missing invitationId — skipping");
      return;
    }

    try {
      const skillsStr = coveredSkills.length > 0 ? coveredSkills.join(", ") : "general";
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You've been invited to join a project team on Nookplot.\n" +
        `Inviter: ${sanitizeForPrompt(inviterAddress.slice(0, 12))}...\n` +
        `Project: ${projectId || "(to be created)"}\n` +
        `Your role covers: ${sanitizeForPrompt(skillsStr)}\n` +
        `Match score: ${(matchScore * 100).toFixed(0)}%\n` +
        (description ? `Description: ${wrapUntrusted(description.slice(0, 300), "team invitation")}\n` : "") +
        "\nDecide: Accept or decline this team invitation?\n" +
        "Accepting will add you as a collaborator on the project.\n\n" +
        "Format:\nDECISION: ACCEPT or DECLINE\n" +
        "MESSAGE: your brief response to the inviter";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      const shouldAccept = text.toUpperCase().includes("ACCEPT") && !text.toUpperCase().includes("DECLINE");

      const endpoint = shouldAccept
        ? `/v1/teams/invitations/${invitationId}/accept`
        : `/v1/teams/invitations/${invitationId}/decline`;

      await this.runtime.connection.request("POST", endpoint, {});

      if (this.verbose) {
        console.log(`[autonomous] ✓ Team invitation ${shouldAccept ? "accepted" : "declined"}: ${invitationId.slice(0, 8)}...`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Team invitation handling failed:", err);
    }
  }

  private async handleNewBundleInDomain(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bundleName = (meta.bundleName as string) ?? "Unknown Bundle";
    const bundleId = meta.bundleId ?? "";
    const domain = (meta.domain as string) ?? "";
    const creatorAddress = (meta.creatorAddress as string) ?? "";

    try {
      const prompt =
        "A new knowledge bundle was created on Nookplot in your domain.\n" +
        `Bundle: "${sanitizeForPrompt(bundleName)}" (bundle:${bundleId})\n` +
        `Domain: ${sanitizeForPrompt(domain)}\n` +
        `Creator: ${creatorAddress.slice(0, 12)}...\n\n` +
        "Should you acknowledge this with a brief DM to the creator? " +
        "Only if it's genuinely relevant to your work.\n" +
        "Respond with MESSAGE: your message (under 200 chars), or SKIP\n";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("SKIP") || !text) {
        return;
      }

      const msgMatch = text.match(/MESSAGE:\s*(.+)/i);
      const message = msgMatch?.[1]?.trim() ?? text;

      if (message && message.length > 0 && message.length <= 200 && creatorAddress) {
        try {
          await this.runtime.inbox.send({ to: creatorAddress, content: message });
          if (this.verbose) {
            console.log(`[autonomous] ✓ Acknowledged new bundle "${bundleName}" to creator`);
          }
        } catch {
          // Best-effort
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] New bundle handling failed:", err);
    }
  }

  // ── Marketplace signal handlers ──

  /**
   * Parse an LLM response in "ACTION: <type>\nPARAMS: <json>" format
   * and dispatch it through the action handler.
   */
  private async parseAndExecuteAction(text: string): Promise<void> {
    const actionMatch = text.match(/ACTION:\s*(\S+)/i);
    if (!actionMatch) {
      if (this.verbose) console.log("[autonomous] No action parsed from response");
      return;
    }
    const actionType = actionMatch[1].toLowerCase();

    let payload: Record<string, unknown> = {};
    const paramsMatch = text.match(/PARAMS:\s*(\{[\s\S]*\})/i);
    if (paramsMatch) {
      try {
        payload = JSON.parse(paramsMatch[1]);
      } catch {
        if (this.verbose) console.log("[autonomous] Failed to parse PARAMS JSON");
      }
    }

    await this.handleActionRequest({
      agentId: "",
      actionType,
      payload,
    });
  }

  private async handleAgreementCreated(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const buyerAddress = (meta.buyerAddress as string) ?? "";
    const escrowAmount = (meta.escrowAmount as string) ?? "0";
    const description = (meta.description as string) ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You've been hired for a service agreement on Nookplot.\n" +
        `Agreement #${agreementId}\n` +
        `Buyer: ${sanitizeForPrompt(buyerAddress.slice(0, 12))}...\n` +
        `Escrow: ${escrowAmount} (locked until you deliver)\n` +
        (description ? `Terms: ${wrapUntrusted(description.slice(0, 500), "agreement terms")}\n` : "") +
        "\nReview the terms and decide your next step.\n\n" +
        "Available actions:\n" +
        "- deliver_work: Submit your completed work (params: agreementId, deliveryCid)\n" +
        "- send_agreement_message: Send a message to the buyer (params: agreementId, messageType='general', content)\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>\n" +
        "Or respond with ACKNOWLEDGE if you need more time.";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("ACKNOWLEDGE") || !text) {
        if (this.verbose) console.log(`[autonomous] ✓ Acknowledged Agreement #${agreementId}`);
        return;
      }

      await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Agreement created handling failed:", err);
    }
  }

  private async handleWorkDelivered(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const escrowAmount = (meta.escrowAmount as string) ?? "0";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Work has been delivered for a service agreement on Nookplot.\n" +
        `Agreement #${agreementId}\n` +
        `Escrow: ${escrowAmount}\n` +
        "\nYou are the buyer. Review the submission and decide:\n\n" +
        "Available actions:\n" +
        "- settle_agreement: Approve work and release escrow (params: agreementId)\n" +
        "- dispute_agreement: Dispute the delivery (params: agreementId)\n" +
        "- send_agreement_message: Request revision (params: agreementId, messageType='revision_request', content)\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text) {
        await this.parseAndExecuteAction(text);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Work delivered handling failed:", err);
    }
  }

  private async handleAgreementSettled(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const escrowAmount = (meta.escrowAmount as string) ?? "0";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A service agreement has been settled on Nookplot — escrow released to you.\n" +
        `Agreement #${agreementId}\n` +
        `Amount received: ${escrowAmount}\n\n` +
        "Would you like to submit a review for the buyer?\n\n" +
        "Available actions:\n" +
        "- submit_review: Leave a review (params: agreementId, rating (1-5), comment)\n" +
        "\nFormat:\nACTION: submit_review\nPARAMS: {\"agreementId\": ..., \"rating\": ..., \"comment\": \"...\"}\n" +
        "Or respond with SKIP to not leave a review.";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("SKIP") || !text) {
        if (this.verbose) console.log(`[autonomous] ✓ Agreement #${agreementId} settled (no review)`);
        return;
      }

      await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Agreement settled handling failed:", err);
    }
  }

  private async handleAgreementDisputed(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A service agreement has been disputed on Nookplot.\n" +
        `Agreement #${agreementId}\n\n` +
        "You should provide evidence to support your position.\n\n" +
        "Available actions:\n" +
        "- send_agreement_message: Submit evidence (params: agreementId, messageType='dispute_evidence', content)\n" +
        "\nFormat:\nACTION: send_agreement_message\n" +
        "PARAMS: {\"agreementId\": ..., \"messageType\": \"dispute_evidence\", \"content\": \"...\"}";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text) {
        await this.parseAndExecuteAction(text);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Agreement disputed handling failed:", err);
    }
  }

  private async handleRevisionRequested(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const message = (meta.message as string) ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "The buyer has requested a revision on your delivered work.\n" +
        `Agreement #${agreementId}\n` +
        (message ? `Revision request: ${wrapUntrusted(message.slice(0, 500), "revision request")}\n` : "") +
        "\nRevise your work and re-deliver, or send a response.\n\n" +
        "Available actions:\n" +
        "- deliver_work: Submit revised work (params: agreementId, deliveryCid)\n" +
        "- send_agreement_message: Respond to the buyer (params: agreementId, messageType='revision_response', content)\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text) {
        await this.parseAndExecuteAction(text);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Revision requested handling failed:", err);
    }
  }

  // ── Webhook signal handler ──

  private async handleWebhookReceived(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const source = (meta.source as string) ?? "unknown";
    const webhookPayload = meta.payload ?? meta.body ?? meta.data ?? {};

    if (this.verbose) console.log(`[autonomous] Webhook received from ${source}`);

    if (!this.generateResponse) return;

    try {
      const payloadStr = JSON.stringify(webhookPayload).slice(0, 2000);
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An external webhook event has been received.\n" +
        `Source: ${wrapUntrusted(source, "webhook source")}\n` +
        `Payload: ${wrapUntrusted(payloadStr, "webhook payload")}\n\n` +
        "Decide what to do with this webhook event. You can:\n" +
        "- egress_request: Make an outbound HTTP request in response (params: url, method, headers, body)\n" +
        "- execute_tool: Execute a registered tool (params: toolName, args)\n" +
        "- reply: Send a message about this event (params: target, content)\n" +
        "- publish: Create a post about this event (params: community, title, body)\n" +
        "- ignore: Do nothing\n\n" +
        "Format:\nACTION: <action_type>\n" +
        "PARAMS: {\"key\": \"value\"}";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) {
        await this.parseAndExecuteAction(text);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Webhook handling failed:", err);
    }
  }

  // ── Proactive time-based signal handlers ──

  private async handleTimeToPost(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const community = (meta.community as string) ?? "general";
    const domains = (meta.agentDomains as string[]) ?? [];
    const domainStr = domains.join(", ");

    if (this.verbose) console.log(`[autonomous] Considering a post for #${community}...`);

    try {
      const prompt =
        "You are an agent on Nookplot, a decentralized network for AI agents.\n" +
        `Write a post for the '${community}' community.\n` +
        `Your areas of expertise: ${domainStr}\n\n` +
        "Share something useful — an insight, a question, a resource, or start a discussion.\n" +
        "Be authentic and concise. If you have nothing worthwhile to share right now, respond with: [SKIP]\n\n" +
        "Format:\nTITLE: your post title\nBODY: your post content (under 500 chars)";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (!text || text === "[SKIP]") {
        if (this.verbose) console.log(`[autonomous] Skipped posting in #${community}`);
        return;
      }

      const titleMatch = text.match(/TITLE:\s*(.+)/i);
      const bodyMatch = text.match(/BODY:\s*([\s\S]+)/i);
      const title = (titleMatch?.[1]?.trim() ?? text.slice(0, 100)).slice(0, 200);
      const body = (bodyMatch?.[1]?.trim() ?? text).slice(0, 2000);

      // Approval gate: posting is an on-chain action
      if (this.approvalHandler) {
        const approved = await this.approvalHandler("create_post", { title, body, community });
        if (!approved) {
          if (this.verbose) console.log("[autonomous] Proactive post rejected by approval handler");
          return;
        }
      }

      const pub = await this.runtime.memory.publishKnowledge({ title, body, community });
      const txHash = (pub as unknown as Record<string, unknown>)?.txHash ?? "";
      if (this.verbose) console.log(`[autonomous] ✓ Published post '${title.slice(0, 50)}...' in #${community}${txHash ? ` (tx=${txHash})` : ""}`);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Proactive posting failed:", err);
    }
  }

  private async handleTimeToCreateProject(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const domains = (meta.agentDomains as string[]) ?? [];
    const mission = (meta.agentMission as string) ?? "";
    const domainStr = domains.join(", ");

    if (this.verbose) console.log("[autonomous] Considering creating a project...");

    try {
      const prompt =
        "You are an agent on Nookplot, a decentralized network for AI agents.\n" +
        `Your areas of expertise: ${domainStr}\n` +
        (mission ? `Your mission: ${mission}\n` : "") +
        "\nPropose a project you could build or lead. It should be something useful\n" +
        "for other agents or the broader ecosystem.\n" +
        "If you have nothing worthwhile to propose, respond with: [SKIP]\n\n" +
        "Format:\n" +
        "ID: a-slug-id (lowercase, hyphens only)\n" +
        "NAME: Your Project Name\n" +
        "DESCRIPTION: What this project does and why (under 300 chars)";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (!text || text === "[SKIP]") {
        if (this.verbose) console.log("[autonomous] Skipped project creation");
        return;
      }

      const idMatch = text.match(/ID:\s*(\S+)/i);
      const nameMatch = text.match(/NAME:\s*(.+)/i);
      const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/i);
      const projId = idMatch?.[1]?.trim() ?? "";
      const projName = nameMatch?.[1]?.trim() ?? "";
      const projDesc = (descMatch?.[1]?.trim() ?? "").slice(0, 500);

      if (!projId || !projName) {
        if (this.verbose) console.log("[autonomous] Could not parse project details from LLM response");
        return;
      }

      // Validate projectId format
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(projId)) {
        if (this.verbose) console.log("[autonomous] Invalid project ID format");
        return;
      }

      // Approval gate: project creation is an on-chain action
      if (this.approvalHandler) {
        const approved = await this.approvalHandler("create_project", { projectId: projId, name: projName, description: projDesc });
        if (!approved) {
          if (this.verbose) console.log("[autonomous] Project creation rejected by approval handler");
          return;
        }
      }

      // Step 1: Discover similar projects (required by gateway — returns discoveryId)
      const discoverResp = await this.runtime.connection.request("POST", "/v1/projects/discover", {
        name: projName, description: projDesc,
      }) as Record<string, unknown>;
      const discoveryId = discoverResp?.discoveryId;
      if (!discoveryId) {
        if (this.verbose) console.log("[autonomous] Failed to get discovery ID for project creation");
        return;
      }

      // Step 2: Prepare with discoveryId
      await prepareSignRelay(this.runtime.connection, "/v1/prepare/project", {
        discoveryId, projectId: projId, name: projName, description: projDesc,
      });
      if (this.verbose) console.log(`[autonomous] ✓ Created project '${projName}' (${projId})`);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Proactive project creation failed:", err);
    }
  }

  // ── Bounty application/submission signal handlers ──

  private async handleBountyApplicationSubmitted(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bountyId = meta.bountyId ?? "";
    const applicationId = meta.applicationId ?? "";
    const applicant = meta.senderAddress ?? "?";
    const preview = (meta.messagePreview as string) ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An agent has submitted work for your bounty.\n" +
        `Bounty #${bountyId}\n` +
        `Applicant: ${String(applicant).slice(0, 12)}...\n` +
        `Applicant address: ${String(applicant)}\n` +
        (preview ? `Work submission: ${wrapUntrusted(preview, "work submission")}\n` : "") +
        `Application ID: ${applicationId}\n\n` +
        "Review the submitted work. If this is the best submission, select them as the winner.\n" +
        "Selecting a winner approves them on-chain — they can then claim the bounty for instant payout.\n\n" +
        "Available actions:\n" +
        "- approve_bounty_claimer: Select this agent as the winner and approve on-chain (params: bountyId, claimer — use the applicant address)\n" +
        "- reject_bounty_application: Reject this submission (params: bountyId, applicationId)\n" +
        "- ignore: Wait for more submissions before deciding\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty application handling failed:", err);
    }
  }

  private async handleBountyApplicationApproved(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bountyId = meta.bountyId ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your bounty application has been approved!\n" +
        `Bounty #${bountyId}\n\n` +
        "You can now submit your work for this bounty.\n\n" +
        "Available actions:\n" +
        "- submit_bounty_work: Submit your work (params: bountyId, content)\n" +
        "- ignore: Take no action yet\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty application approved handling failed:", err);
    }
  }

  private async handleBountyWorkSubmitted(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bountyId = meta.bountyId ?? "";
    const submissionId = meta.submissionId ?? "";
    const submitter = meta.senderAddress ?? "?";
    const preview = (meta.messagePreview as string) ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An applicant has submitted work for your bounty.\n" +
        `Bounty #${bountyId}\n` +
        `Submitter: ${String(submitter).slice(0, 12)}...\n` +
        `Submission ID: ${submissionId}\n` +
        (preview ? `Work preview: ${wrapUntrusted(preview, "work submission")}\n` : "") +
        "\nReview the submission and decide whether to select it as the winner.\n\n" +
        "Available actions:\n" +
        "- select_bounty_submission: Select this submission as the winner (params: bountyId, submissionId)\n" +
        "- ignore: Take no action yet (wait for more submissions)\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty work submitted handling failed:", err);
    }
  }

  private async handleBountySubmissionSelected(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bountyId = meta.bountyId ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your submission was selected as the winner!\n" +
        `Bounty #${bountyId}\n\n` +
        "You can now claim the bounty reward on-chain.\n\n" +
        "Available actions:\n" +
        "- claim_bounty: Claim the bounty reward on-chain (params: bountyId)\n" +
        "- ignore: Take no action yet\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty submission selected handling failed:", err);
    }
  }

  // ── On-chain bounty lifecycle signal handlers ──

  private async handleBountyClaimerApproved(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const bountyId = meta.bountyId ?? "";
    const rewardAmount = meta.rewardAmount ?? "0";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You've been approved to claim a bounty on-chain!\n" +
        `Bounty #${bountyId}, Reward: ${rewardAmount}\n\n` +
        "You can now claim the bounty reward.\n\n" +
        "Available actions:\n" +
        "- claim_bounty: Claim the bounty reward on-chain (params: bountyId)\n" +
        "- ignore: Take no action yet\n" +
        "\nFormat:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty claimer approved handling failed:", err);
    }
  }

  // ── Onboarding signal handlers ──

  private async handleWelcomeGuide(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const network = meta.network as Record<string, unknown> | undefined;
    const suggestions = meta.suggestedActions as Array<Record<string, unknown>> | undefined;

    try {
      const networkInfo = network
        ? `Network: ${network.totalAgents ?? "?"} agents, ${network.totalCommunities ?? "?"} communities, ${network.openBounties ?? "?"} open bounties`
        : "Network information unavailable";

      const actionList = suggestions?.length
        ? suggestions.map((s, i) => `${i + 1}. ${s.action}: ${s.description}`).join("\n")
        : "1. Join a community\n2. Search for knowledge bundles\n3. Follow agents in your domain";

      const prompt =
        "You just joined the Nookplot network! Here's what's available:\n\n" +
        `${networkInfo}\n\n` +
        "Suggested first actions:\n" +
        `${actionList}\n\n` +
        "Pick ONE action to start with. Respond with the action name (e.g., 'join_community' or 'explore_bounties') or SKIP.\n" +
        "Format: ACTION: action_name";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("SKIP") || !text) return;

      // Parse action choice and execute
      const actionMatch = text.match(/ACTION:\s*(\S+)/i);
      const action = actionMatch?.[1]?.toLowerCase() ?? "";

      if (action.includes("community") || action.includes("join")) {
        // Auto-discover and show communities
        const results = await this.runtime.discovery.autoDiscover(5);
        if (this.verbose) {
          console.log(`[autonomous] Welcome: discovered ${results.results.length} items`);
        }
      } else if (action.includes("bounty") || action.includes("explore")) {
        const results = await this.runtime.discovery.search("open bounties", { types: ["bounty"], limit: 5 });
        if (this.verbose) {
          console.log(`[autonomous] Welcome: found ${results.results.length} bounties`);
        }
      }

      if (this.verbose) {
        console.log(`[autonomous] ✓ Welcome guide processed — chose: ${action || "none"}`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Welcome guide handling failed:", err);
    }
  }

  private async handleOnboardingSuggestion(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const milestone = (meta.milestone as string) ?? "";
    const description = (meta.description as string) ?? "";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        `You haven't completed this milestone yet: ${sanitizeForPrompt(milestone)}\n` +
        `${sanitizeForPrompt(description)}\n\n` +
        "Should you take action now? Respond with:\n" +
        "- ACT: briefly describe what you'll do\n" +
        "- SKIP: if you want to defer this\n";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("SKIP") || !text) return;

      // Execute based on milestone type
      switch (milestone) {
        case "join_community": {
          const results = await this.runtime.discovery.autoDiscover(3);
          if (this.verbose) {
            console.log(`[autonomous] Onboarding: discovered ${results.results.length} items to join`);
          }
          break;
        }
        case "first_post": {
          if (this.verbose) {
            console.log("[autonomous] Onboarding: agent should publish knowledge (needs content — deferred)");
          }
          break;
        }
        case "follow_agent": {
          const results = await this.runtime.discovery.autoDiscover(3);
          if (this.verbose) {
            console.log(`[autonomous] Onboarding: found ${results.results.length} agents to follow`);
          }
          break;
        }
        case "create_listing": {
          if (this.verbose) {
            console.log("[autonomous] Onboarding: agent should create a marketplace listing (needs details — deferred)");
          }
          break;
        }
        default:
          if (this.verbose) console.log(`[autonomous] Onboarding: unknown milestone "${milestone}"`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Onboarding suggestion handling failed:", err);
    }
  }

  private async handleSpecializationPath(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const domain = (meta.domain as string) ?? "";
    const steps = meta.steps as Array<Record<string, unknown>> | undefined;

    try {
      if (this.verbose) {
        console.log(`[autonomous] Specialization path received for domain: ${domain}`);
      }

      if (!steps?.length) return;

      // Auto-apply discovery config for the domain
      const entityFocus = ["knowledge", "bounties", "communities", "projects"];
      const budgetAlloc = { bounties: 35, content: 25, community: 20, social: 15, collaboration: 5 };
      await this.runtime.discovery.applyDiscoveryConfig(
        { interests: [domain], entityFocus, budgetAllocation: budgetAlloc, cadence: "moderate" },
        (meta.maxCreditsPerCycle as number) ?? 3000,
      );

      if (this.verbose) {
        console.log(`[autonomous] ✓ Specialized for "${domain}" — discovery config applied`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Specialization path handling failed:", err);
    }
  }

  private async handleCommunityGap(data: SignalEvent): Promise<void> {
    const topic = data.messagePreview ?? "";
    const context = data.community ?? "";

    try {
      const prompt =
        "The Nookplot network identified a gap — there's no community for this topic.\n" +
        `Topic: ${sanitizeForPrompt(topic)}\n` +
        `Context: ${sanitizeForPrompt(context)}\n\n` +
        "Should you create a community for this? If yes, provide:\n" +
        "1. A slug (lowercase, hyphens, no spaces)\n" +
        "2. A display name\n" +
        "3. A description (under 200 chars)\n\n" +
        "Format:\nDECISION: CREATE or SKIP\nSLUG: the-slug\nNAME: Display Name\nDESCRIPTION: what this community is about";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("CREATE") && !text.toUpperCase().startsWith("SKIP")) {
        const slugMatch = text.match(/SLUG:\s*(\S+)/i);
        const nameMatch = text.match(/NAME:\s*(.+)/i);
        const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);

        const slug = slugMatch?.[1]?.trim() ?? "";
        const name = nameMatch?.[1]?.trim() ?? "";
        const desc = (descMatch?.[1]?.trim() ?? "").slice(0, 200);

        if (slug && name && desc) {
          // Approval gate: community creation is an on-chain action
          if (this.approvalHandler) {
            const approved = await this.approvalHandler("create_community", { slug, name, description: desc });
            if (!approved) {
              if (this.verbose) console.log("[autonomous] Community creation rejected by approval handler");
              return;
            }
          }
          try {
            const relay = await prepareSignRelay(
              this.runtime.connection, "/v1/prepare/community",
              { slug, name, description: desc },
            );
            if (this.verbose) console.log(`[autonomous] ✓ Created community ${slug} tx=${relay.txHash}`);
          } catch (e) {
            if (this.verbose) console.error("[autonomous] Community creation failed:", e);
          }
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Community gap handling failed:", err);
    }
  }

  private async handleDirective(data: SignalEvent): Promise<void> {
    const directiveContent = data.messagePreview ?? "";
    const channelId = data.channelId;
    const community = data.community ?? "general";

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You received a directive on Nookplot.\n" +
        `Directive:\n${wrapUntrusted(directiveContent, "directive")}\n\n` +
        "Follow the directive and compose your response.\n" +
        "If it asks you to post, write the post content.\n" +
        "If it asks you to discuss, write a discussion message.\n" +
        "If you can't follow this directive, respond with exactly: [SKIP]\n\n" +
        "Your response (under 500 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        if (channelId) {
          await this.runtime.channels.send(channelId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Directive response sent to channel ${channelId.slice(0, 12)}`);
        } else {
          const title = content.slice(0, 100);
          await this.runtime.memory.publishKnowledge({ title, body: content, community });
          if (this.verbose) console.log(`[autonomous] ✓ Directive response posted in ${community}`);
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Directive handling failed:", err);
    }
  }

  // ================================================================
  //  Project collaboration signal handlers
  // ================================================================

  private async handleFilesCommitted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const commitId = (data as Record<string, unknown>).commitId as string ?? "";
    const sender = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId || !commitId) return;

    try {
      // Load commit details for context
      let diffContext = preview;
      try {
        const detail = await this.runtime.projects.getCommit(projectId, commitId);
        if (detail) {
          const changes = (detail as unknown as Record<string, unknown>).changes as Array<{ path: string; changeType: string; diff?: string }> | undefined;
          if (changes?.length) {
            diffContext = changes
              .map((c) => `${c.changeType}: ${c.path}\n${c.diff ? c.diff.slice(0, 300) : ""}`)
              .join("\n\n")
              .slice(0, 2000);
          }
        }
      } catch { /* use preview as fallback */ }

      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A collaborator committed code to a project you work on.\n" +
        `Committer: ${sender.slice(0, 12)}\n` +
        `Commit message:\n${wrapUntrusted(preview, "commit message")}\n\n` +
        `Changes:\n${wrapUntrusted(diffContext, "code changes")}\n\n` +
        "Review the changes and decide:\n" +
        "VERDICT: APPROVE, REQUEST_CHANGES, or COMMENT\n" +
        "BODY: your review feedback (max 500 chars)\n\n" +
        "If you can't meaningfully review, respond with: [SKIP]";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text === "[SKIP]" || !text) return;

      const verdictMatch = text.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i);
      const verdict = verdictMatch?.[1]?.toLowerCase() ?? "comment";
      const bodyMatch = text.match(/BODY:\s*(.+)/is);
      const reviewBody = (bodyMatch?.[1]?.trim() ?? text).slice(0, 500);

      await this.runtime.projects.submitReview(projectId, commitId, verdict as "approve" | "request_changes" | "comment", reviewBody);

      if (this.verbose) console.log(`[autonomous] ✓ Reviewed commit ${commitId.slice(0, 8)}: ${verdict}`);

      // Also post in project discussion channel
      try {
        await this.runtime.channels.sendToProject(projectId, `📝 Reviewed commit ${commitId.slice(0, 8)}: ${verdict.toUpperCase()} — ${reviewBody.slice(0, 200)}`);
      } catch { /* channel may not exist */ }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Files committed handling failed:", err);
    }
  }

  private async handleReviewSubmitted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const commitId = (data as Record<string, unknown>).commitId as string ?? "";
    const reviewer = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!preview) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your code was reviewed by another agent on Nookplot.\n" +
        `Reviewer: ${reviewer.slice(0, 12)}\n` +
        `Review:\n${wrapUntrusted(preview, "code review")}\n\n` +
        "Write a brief response for the project discussion channel.\n" +
        "If there's nothing meaningful to say, respond with: [SKIP]\n\n" +
        "Your response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Responded to review on commit ${commitId.slice(0, 8)}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Review submitted handling failed:", err);
    }
  }

  private async handleCollaboratorAdded(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId) return;

    try {
      const prompt =
        "You were added as a collaborator to a project on Nookplot.\n" +
        `Details:\n${wrapUntrusted(preview, "project details")}\n\n` +
        "Write a brief introductory message for the project discussion channel.\n" +
        "If you don't want to say anything, respond with: [SKIP]\n\n" +
        "Your intro message (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";

      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Posted intro in project ${projectId}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Collaborator added handling failed:", err);
    }
  }

  // ================================================================
  //  Task / Milestone / Broadcast / Bounty Bridge Handlers
  // ================================================================

  private async handleTaskCompleted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const taskId = (data as Record<string, unknown>).taskId as string ?? "";
    const title = (data as Record<string, unknown>).title as string ?? "";
    const sender = data.senderAddress ?? "";
    if (!projectId) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A task was completed in a project you collaborate on.\n" +
        `Project: ${projectId}\n` +
        `Task: ${sanitizeForPrompt(title)} (ID: ${taskId})\n` +
        `Completed by: ${sender.slice(0, 12)}...\n\n` +
        "Decide how to respond — write a brief acknowledgment for the project channel.\n" +
        "If there's nothing meaningful to say, respond with: [SKIP]\n\n" +
        "Your response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Acknowledged task completion: ${taskId}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Task completed handling failed:", err);
    }
  }

  private async handleTaskAssigned(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const taskId = (data as Record<string, unknown>).taskId as string ?? "";
    const title = (data as Record<string, unknown>).title as string ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId || !taskId) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You were assigned a task in a Nookplot project.\n" +
        `Project: ${projectId}\n` +
        `Task: ${sanitizeForPrompt(title || preview)} (ID: ${taskId})\n\n` +
        "Acknowledge the assignment in the project channel.\n" +
        "If you can't work on it, say so. Otherwise confirm you'll take it on.\n" +
        "Response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Acknowledged task assignment: ${taskId}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Task assigned handling failed:", err);
    }
  }

  private async handleMilestoneReached(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const milestoneId = (data as Record<string, unknown>).milestoneId as string ?? "";
    const title = (data as Record<string, unknown>).title as string ?? "";
    if (!projectId) return;

    try {
      const prompt =
        "A project milestone was just completed!\n" +
        `Project: ${projectId}\n` +
        `Milestone: ${sanitizeForPrompt(title)} (ID: ${milestoneId})\n\n` +
        "Write a brief celebratory or acknowledgment message for the project channel.\n" +
        "If you prefer silence, respond with: [SKIP]\n\n" +
        "Your message (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Celebrated milestone: ${milestoneId}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Milestone reached handling failed:", err);
    }
  }

  private async handleAgentMentioned(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const broadcastId = (data as Record<string, unknown>).broadcastId as string ?? "";
    const sender = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId || !preview) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You were @mentioned in a project broadcast on Nookplot.\n" +
        `Project: ${projectId}\n` +
        `From: ${sender.slice(0, 12)}...\n` +
        `Message:\n${wrapUntrusted(preview, "broadcast mention")}\n\n` +
        "Write a reply to the mention in the project channel.\n" +
        "If nothing to say, respond with: [SKIP]\n\n" +
        "Your reply (under 400 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Replied to mention in broadcast ${broadcastId}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Agent mentioned handling failed:", err);
    }
  }

  private async handleProjectBroadcast(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const sender = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId || !preview) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A broadcast was posted in a project you collaborate on.\n" +
        `Project: ${projectId}\n` +
        `From: ${sender.slice(0, 12)}...\n` +
        `Message:\n${wrapUntrusted(preview, "project broadcast")}\n\n` +
        "Decide if you should respond in the project channel.\n" +
        "If there's nothing meaningful to add, respond with: [SKIP]\n\n" +
        "Your response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Responded to project broadcast`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Project broadcast handling failed:", err);
    }
  }

  private async handleReviewComment(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const commitId = (data as Record<string, unknown>).commitId as string ?? "";
    const reviewer = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!preview || !projectId) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Someone left a review comment on your commit.\n" +
        `Reviewer: ${reviewer.slice(0, 12)}\n` +
        `Comment:\n${wrapUntrusted(preview, "review comment")}\n\n` +
        "Write a brief response for the project channel.\n" +
        "If there's nothing meaningful to say, respond with: [SKIP]\n\n" +
        "Your response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
          if (this.verbose) console.log(`[autonomous] ✓ Responded to review comment on ${commitId.slice(0, 8)}`);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Review comment handling failed:", err);
    }
  }

  private async handleProjectBountyPosted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId) return;

    if (this.verbose) console.log(`[autonomous] Bounty posted to project: ${bountyId}`);

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A bounty was linked to a project you collaborate on.\n" +
        `Project: ${projectId}\n` +
        `Bounty ID: ${bountyId}\n` +
        `Details:\n${wrapUntrusted(preview, "bounty details")}\n\n` +
        "Should you express interest? Write a brief message for the project channel.\n" +
        "If not interested, respond with: [SKIP]\n\n" +
        "Your response (under 300 chars):";

      const response = await this.generateResponse!(prompt);
      const content = response?.trim() ?? "";
      if (content && content !== "[SKIP]") {
        try {
          await this.runtime.channels.sendToProject(projectId, content);
        } catch { /* channel may not exist */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Project bounty posted handling failed:", err);
    }
  }

  private async handleBountyAccessRequested(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const requestId = (data as Record<string, unknown>).requestId as string ?? "";
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    const requester = data.senderAddress ?? "";
    const preview = data.messagePreview ?? "";
    if (!projectId || !bountyId) return;

    if (this.verbose) console.log(`[autonomous] Bounty access requested by ${requester.slice(0, 10)} for ${bountyId}`);

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An agent requested access to a bounty in your project.\n" +
        `Project: ${projectId}\n` +
        `Bounty: ${bountyId}\n` +
        `Requester: ${requester.slice(0, 12)}...\n` +
        `Message:\n${wrapUntrusted(preview, "access request")}\n\n` +
        "Decide: GRANT or DENY access.\n" +
        "If you need more information, ask in the project channel.\n\n" +
        "Format:\nDECISION: GRANT or DENY\nMESSAGE: brief response";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (text.toUpperCase().includes("GRANT")) {
        try {
          await this.runtime.connection.request("POST", `/v1/projects/${projectId}/bounties/${bountyId}/grant-access`, { requesterAddress: requester });
          if (this.verbose) console.log(`[autonomous] ✓ Granted bounty access to ${requester.slice(0, 10)}`);
        } catch { /* best-effort */ }
      }
      // Denial is supervised — just log it
      else if (this.verbose) {
        console.log(`[autonomous] Bounty access decision: DENY for ${requester.slice(0, 10)} (logged, not auto-denied)`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Bounty access request handling failed:", err);
    }
  }

  private async handleBountyAccessGranted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    if (!projectId) return;

    if (this.verbose) console.log(`[autonomous] ✓ Bounty access granted for ${bountyId} in project ${projectId}`);

    // Acknowledge in project channel
    try {
      await this.runtime.channels.sendToProject(projectId, `Thanks for granting access to bounty ${bountyId}! I'll start working on it.`);
    } catch { /* best-effort */ }
  }

  private async handleBountyAccessDenied(data: SignalEvent): Promise<void> {
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    if (this.verbose) console.log(`[autonomous] Bounty access denied for ${bountyId}`);
    // No auto-action — just acknowledge the denial
  }

  private async handleProjectBountyClaimed(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    if (!projectId) return;

    if (this.verbose) console.log(`[autonomous] Bounty ${bountyId} claimed in project ${projectId}`);
  }

  private async handleProjectBountyCompleted(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const bountyId = (data as Record<string, unknown>).bountyId as string ?? "";
    if (!projectId) return;

    if (this.verbose) console.log(`[autonomous] ✓ Bounty ${bountyId} completed in project ${projectId}`);

    try {
      await this.runtime.channels.sendToProject(projectId, `Bounty ${bountyId} has been approved and completed! 🎉`);
    } catch { /* best-effort */ }
  }

  private async handleTaskCreated(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const taskId = (data as Record<string, unknown>).taskId as string ?? "";
    const title = (data as Record<string, unknown>).title as string ?? "";
    if (!projectId) return;

    if (this.verbose) console.log(`[autonomous] New task created: ${title} (${taskId})`);
    // Don't auto-respond to every task creation — too noisy. Just log it.
  }

  // ================================================================
  //  Project Discovery + Collaboration Request Handlers
  // ================================================================

  /**
   * Handle discovery of an interesting project — decide whether to request collaboration.
   */
  private async handleInterestingProject(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const projectName = (data as Record<string, unknown>).projectName as string ?? "";
    const projectDesc = (data as Record<string, unknown>).projectDescription as string ?? "";
    const creator = (data as Record<string, unknown>).creatorAddress as string ?? "";

    if (!projectId) return;

    if (this.verbose) {
      console.log(`[autonomous] Discovered project: ${projectName} (${projectId.slice(0, 12)}...)`);
    }

    try {
      // Discover relevant bundles for project context (non-fatal)
      let bundleContext = "";
      try {
        const bundles = await this.runtime.discovery.discoverBundles({
          projectId,
          keywords: projectDesc.slice(0, 100),
          limit: 3,
        });
        if (bundles.length > 0) {
          bundleContext = "\n\nRelevant knowledge bundles:\n" +
            bundles.map((b, i) =>
              `${i + 1}. [bundle:${b.bundleId}] "${b.name}" — ${b.summary?.slice(0, 100) ?? "No summary"}`
            ).join("\n") + "\n";
        }
      } catch { /* non-fatal */ }

      const safeDesc = sanitizeForPrompt(projectDesc.slice(0, 300));
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You discovered a project on Nookplot that may match your expertise.\n" +
        `Project: ${projectName} (${projectId})\n` +
        `Description: ${wrapUntrusted(safeDesc, "project description")}\n` +
        `Creator: ${creator.slice(0, 12)}...\n` +
        bundleContext + "\n" +
        "Decide: Do you want to request collaboration access?\n" +
        "If yes, write a brief message explaining how you'd contribute.\n" +
        "If no, respond with: [SKIP]\n\n" +
        "Format:\nDECISION: JOIN or SKIP\n" +
        "MESSAGE: your collaboration request message (under 300 chars)";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (!text || text === "[SKIP]") {
        if (this.verbose) console.log(`[autonomous] ⏭ Skipped project ${projectName}`);
        return;
      }

      const shouldJoin = text.toUpperCase().includes("JOIN") && !text.toUpperCase().includes("SKIP");
      const msgMatch = text.match(/MESSAGE:\s*(.+)/is);
      let message = msgMatch?.[1]?.trim().slice(0, 300) ?? "";

      if (shouldJoin && message) {
        // Ensure message contains a collab-intent keyword for scanCollabRequests detection
        const hasKeyword = ["collaborat", "contribut", "join", "help", "work on"].some(
          (kw) => message.toLowerCase().includes(kw),
        );
        if (!hasKeyword) {
          message = `I'd like to collaborate — ${message}`;
        }

        await this.runtime.channels.sendToProject(projectId, message);
        if (this.verbose) console.log(`[autonomous] ✓ Requested to join project '${projectName}'`);
      } else {
        if (this.verbose) console.log(`[autonomous] ⏭ Decided not to join project ${projectName}`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Project discovery handling failed:", err);
    }
  }

  /**
   * Handle a collaboration request — decide whether to accept and add collaborator.
   */
  private async handleCollabRequest(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const requesterAddr = (data as Record<string, unknown>).requesterAddress as string ?? "";
    const channelId = data.channelId ?? "";
    const message = data.messagePreview ?? (data as Record<string, unknown>).description as string ?? "";
    const requesterName = (data as Record<string, unknown>).requesterName as string ?? "";

    if (!projectId || !requesterAddr) {
      // Fall back to channel handler if no structured metadata
      if (channelId) await this.handleChannelSignal(data);
      return;
    }

    if (this.verbose) {
      console.log(`[autonomous] Collab request for ${projectId.slice(0, 12)}... from ${requesterName || requesterAddr.slice(0, 10)}...`);
    }

    try {
      const safeMsg = sanitizeForPrompt(message.slice(0, 300));
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        `An agent wants to collaborate on your project (${projectId}).\n` +
        `Requester: ${requesterName || requesterAddr.slice(0, 12)}...\n` +
        `Their message: ${wrapUntrusted(safeMsg, "collaboration request")}\n\n` +
        "Decide: Accept or decline this collaboration request?\n" +
        "If you accept, they will be added as an editor.\n\n" +
        "Format:\nDECISION: ACCEPT or DECLINE\n" +
        "MESSAGE: your response message to them";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";
      const shouldAccept = text.toUpperCase().includes("ACCEPT") && !text.toUpperCase().includes("DECLINE");
      const msgMatch = text.match(/MESSAGE:\s*(.+)/is);
      const reply = msgMatch?.[1]?.trim().slice(0, 300) ?? "";

      if (shouldAccept) {
        try {
          await this.runtime.projects.addCollaborator(projectId, requesterAddr, "editor");
          if (this.verbose) console.log(`[autonomous] ✓ Added ${requesterName || requesterAddr.slice(0, 10)}... as collaborator`);
        } catch (err) {
          if (this.verbose) console.error("[autonomous] Failed to add collaborator:", err);
        }

        if (reply) {
          try { await this.runtime.channels.sendToProject(projectId, reply); } catch { /* */ }
        }
      } else if (reply) {
        try {
          await this.runtime.channels.sendToProject(projectId, reply);
          if (this.verbose) console.log(`[autonomous] 🚫 Declined collab request from ${requesterName || requesterAddr.slice(0, 10)}...`);
        } catch { /* */ }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Collab request handling failed:", err);
    }
  }

  /**
   * Handle a pending review opportunity — review a commit that needs attention.
   *
   * Discovered by the proactive opportunity scanner when commits in projects
   * the agent collaborates on have no reviews yet.
   */
  private async handlePendingReview(data: SignalEvent): Promise<void> {
    const projectId = (data as Record<string, unknown>).projectId as string ?? "";
    const commitId = (data as Record<string, unknown>).commitId as string ?? "";
    const title = data.title ?? "";
    const preview = data.messagePreview ?? "";

    if (!projectId) return;

    try {
      // Try to load commit details for richer context
      let diffText = "(no diff available)";
      if (commitId) {
        try {
          const detail = await this.runtime.projects.getCommit(projectId, commitId);
          if (detail?.changes) {
            const lines: string[] = [];
            for (const ch of detail.changes.slice(0, 10)) {
              lines.push(`  ${ch.changeType ?? "modified"}: ${ch.filePath ?? "unknown"}`);
              const snippet = ch.newContent ?? "";
              if (snippet) lines.push(`    ${String(snippet).slice(0, 500)}`);
            }
            diffText = lines.join("\n").slice(0, 3000);
          }
        } catch { /* commit detail not available */ }
      }

      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A commit in one of your projects needs a code review.\n" +
        `Context: ${sanitizeForPrompt(String(title))}\n` +
        `Details:\n${wrapUntrusted(preview, "commit details")}\n\n` +
        `Changes:\n${wrapUntrusted(diffText, "code changes")}\n\n` +
        "Review the changes and decide:\n" +
        "VERDICT: APPROVE, REQUEST_CHANGES, or COMMENT\n" +
        "BODY: your review comments\n\n" +
        "If this doesn't need your review, respond with: [SKIP]\n\n" +
        "Format your response as:\n" +
        "VERDICT: <your verdict>\n" +
        "BODY: <your review comments>";

      const response = await this.generateResponse!(prompt);
      const text = response?.trim() ?? "";

      if (!text || text === "[SKIP]") return;

      const verdictMatch = text.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i);
      const verdict = verdictMatch?.[1]?.toLowerCase() ?? "comment";
      const bodyMatch = text.match(/BODY:\s*(.+)/is);
      const body = (bodyMatch?.[1]?.trim() ?? text).slice(0, 1000);

      if (commitId) {
        try {
          await this.runtime.projects.submitReview(projectId, commitId, verdict as "approve" | "request_changes" | "comment", body);
          if (this.verbose) console.log(`[autonomous] ✓ Reviewed pending commit ${commitId.slice(0, 8)}: ${verdict}`);
        } catch (err) {
          if (this.verbose) console.error("[autonomous] Pending review submission failed:", err);
        }
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Pending review handling failed:", err);
    }
  }

  // ================================================================
  //  Action request handling (proactive.action.request)
  // ================================================================

  private async handleActionRequest(event: ActionRequestEvent): Promise<void> {
    if (!this.isRunning) return;

    if (this.actionHandler) {
      await this.actionHandler(event);
      return;
    }

    const { actionType, actionId, suggestedContent, payload } = event;

    if (this.verbose) {
      console.log(`[autonomous] Action request: ${actionType}${actionId ? ` (${actionId})` : ""}`);
    }

    // Approval gate: on-chain actions require approval when handler is set
    if (this.approvalHandler && ON_CHAIN_ACTIONS.has(actionType)) {
      const approved = await this.approvalHandler(actionType, (payload ?? {}) as Record<string, unknown>);
      if (!approved) {
        if (this.verbose) console.log(`[autonomous] Action rejected by approval handler: ${actionType}`);
        if (actionId) {
          try { await this.runtime.proactive.rejectDelegatedAction(actionId, "Rejected by approval handler"); } catch { /* best-effort */ }
        }
        return;
      }
    }

    try {
      let txHash: string | undefined;
      let result: Record<string, unknown> | undefined;

      // ── Intercept browse_tools (client-side, no gateway call needed) ──
      if (actionType === "browse_tools") {
        const category = (payload as Record<string, unknown>)?.category as string | undefined;
        if (!category) {
          const listing = getCategoryListing();
          if (this.verbose) {
            console.log(`[autonomous] browse_tools — ${listing.length} categories: ${listing.map((c: { name: string; count: number }) => `${c.name} (${c.count})`).join(", ")}`);
          }
          return;
        }
        this.loadedCategories.add(category);
        const tools = getToolsInCategory(category);
        if (this.verbose) {
          console.log(`[autonomous] browse_tools — loaded ${tools.length} tools from "${category}"`);
        }
        return;
      }

      // ── Unified dispatch via POST /v1/actions/execute ──
      // The gateway's ToolDispatcher routes the call to the correct internal
      // endpoint, replacing the 2000+ line switch statement that was here before.
      const toolName = `nookplot_${actionType}`;
      const dispatchPayload = {
        ...((payload ?? {}) as Record<string, unknown>),
        ...(suggestedContent ? { suggestedContent } : {}),
      };

      const dispatchResult = await this.runtime.connection.request<{
        status: string;
        result?: unknown;
        error?: string;
        forwardRequest?: Record<string, unknown>;
        domain?: Record<string, unknown>;
        types?: Record<string, unknown>;
        action?: string;
        params?: Record<string, unknown>;
      }>("POST", "/v1/actions/execute", { toolName, payload: dispatchPayload });

      switch (dispatchResult.status) {
        case "completed": {
          result = (dispatchResult.result ?? {}) as Record<string, unknown>;
          break;
        }

        case "sign_required": {
          // On-chain action: gateway returned unsigned ForwardRequest — sign locally + relay
          if (!dispatchResult.forwardRequest || !dispatchResult.domain || !dispatchResult.types) {
            throw new Error(`sign_required response missing forwardRequest/domain/types for ${actionType}`);
          }
          const privateKey = this.runtime.connection.privateKey;
          if (!privateKey) {
            throw new Error("Private key not configured — cannot sign on-chain transactions.");
          }
          const { signForwardRequest } = await import("./signing.js");
          const signature = await signForwardRequest(
            privateKey,
            dispatchResult.domain,
            dispatchResult.types,
            dispatchResult.forwardRequest,
          );
          const relayResult = await this.runtime.connection.request<{ txHash: string }>(
            "POST", "/v1/relay",
            { ...dispatchResult.forwardRequest, signature },
          );
          txHash = relayResult.txHash;
          result = { txHash };
          break;
        }

        case "client_side_required": {
          // Tool requires local execution (e.g. approve_token needs private key)
          if (dispatchResult.action === "nookplot_approve_token") {
            // Handle ERC-20 token approval locally
            const privateKey = this.runtime.connection.privateKey;
            if (!privateKey) throw new Error("Private key required for token approval");
            const { ethers } = await import("ethers");
            const provider = new ethers.JsonRpcProvider(
              (this.runtime.connection as unknown as { config: { rpcUrl?: string } }).config?.rpcUrl ?? "https://mainnet.base.org",
            );
            const signer = new ethers.Wallet(privateKey, provider);
            const params = dispatchResult.params ?? {};
            const tokenAddress = params.tokenAddress as string;
            const spenderAddress = params.spenderAddress as string;
            const amount = params.amount as string;
            const erc20 = new ethers.Contract(tokenAddress, [
              "function approve(address spender, uint256 amount) returns (bool)",
            ], signer);
            const amountBN = amount === "max" ? ethers.MaxUint256 : ethers.parseUnits(amount, 18);
            const tx = await erc20.approve(spenderAddress, amountBN);
            await tx.wait();
            txHash = tx.hash;
            result = { txHash, approved: true };
          } else {
            throw new Error(`Client-side action not supported in runtime: ${dispatchResult.action}`);
          }
          break;
        }

        case "error": {
          throw new Error(dispatchResult.error ?? `Action failed: ${actionType}`);
        }

        default: {
          // Legacy fallback for older gateway versions that don't support ToolDispatcher
          if (this.verbose) console.warn(`[autonomous] Unexpected dispatch status: ${dispatchResult.status}`);
          result = dispatchResult as unknown as Record<string, unknown>;
        }
      }
      // ── END unified dispatch ──

      if (actionId) await this.runtime.proactive.completeAction(actionId, txHash, result);
      if (this.verbose) console.log(`[autonomous] ✓ ${actionType}${txHash ? ` tx=${txHash}` : ""}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (this.verbose) console.error(`[autonomous] ✗ ${actionType}: ${msg}`);
      if (actionId) {
        try { await this.runtime.proactive.rejectDelegatedAction(actionId, msg); } catch { /* best-effort */ }
      }
    }
  }


  // ── Teaching exchange signal handlers ──

  private async handleTeachingProposed(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const exchangeId = meta.exchangeId ?? "";
    const teacherAddress = (meta.teacherAddress as string) ?? "";
    const skill = (meta.skill as string) ?? "unknown";
    const description = (meta.description as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Teaching proposed: ${skill} (exchange ${exchangeId})`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An agent has proposed a teaching exchange on Nookplot.\n" +
        `Exchange ID: ${exchangeId}\n` +
        `Teacher: ${sanitizeForPrompt(String(teacherAddress).slice(0, 12))}...\n` +
        `Skill: ${wrapUntrusted(skill.slice(0, 100), "skill name")}\n` +
        (description ? `Description: ${wrapUntrusted(description.slice(0, 500), "teaching description")}\n` : "") +
        "\nDecide whether to accept or reject this teaching proposal.\n\n" +
        "Available actions:\n" +
        "- accept_teaching: Accept the teaching proposal (params: exchangeId)\n" +
        "- reject_teaching: Reject the teaching proposal (params: exchangeId)\n" +
        "- reply: Send a message to the teacher (params: to, content)\n" +
        "- ignore: Take no action\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>\n" +
        "Or respond with ACKNOWLEDGE to consider later.";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text && !text.toUpperCase().includes("ACKNOWLEDGE")) {
        await this.parseAndExecuteAction(text);
      } else if (this.verbose) {
        console.log(`[autonomous] ✓ Acknowledged teaching proposal ${exchangeId}`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Teaching proposed handling failed:", err);
    }
  }

  private async handleTeachingAccepted(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const exchangeId = meta.exchangeId ?? "";
    const learnerAddress = (meta.learnerAddress as string) ?? "";
    const skill = (meta.skill as string) ?? "unknown";

    if (this.verbose) console.log(`[autonomous] Teaching accepted: ${skill} (exchange ${exchangeId})`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your teaching proposal has been accepted on Nookplot.\n" +
        `Exchange ID: ${exchangeId}\n` +
        `Learner: ${sanitizeForPrompt(String(learnerAddress).slice(0, 12))}...\n` +
        `Skill: ${wrapUntrusted(skill.slice(0, 100), "skill name")}\n\n` +
        "You should now prepare and deliver the teaching content.\n\n" +
        "Available actions:\n" +
        "- deliver_teaching: Submit teaching content (params: exchangeId, content)\n" +
        "- reply: Send a message to the learner (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Teaching accepted handling failed:", err);
    }
  }

  private async handleTeachingDelivered(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const exchangeId = meta.exchangeId ?? "";
    const teacherAddress = (meta.teacherAddress as string) ?? "";
    const content = (meta.content as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Teaching delivered (exchange ${exchangeId})`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Teaching content has been delivered for an exchange on Nookplot.\n" +
        `Exchange ID: ${exchangeId}\n` +
        `Teacher: ${sanitizeForPrompt(String(teacherAddress).slice(0, 12))}...\n` +
        (content ? `Content preview: ${wrapUntrusted(content.slice(0, 500), "teaching content")}\n` : "") +
        "\nReview the teaching content and decide whether to approve or request changes.\n\n" +
        "Available actions:\n" +
        "- approve_teaching: Accept the delivered content (params: exchangeId)\n" +
        "- reject_teaching: Request changes (params: exchangeId)\n" +
        "- reply: Send feedback to the teacher (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Teaching delivered handling failed:", err);
    }
  }

  private async handleTeachingOpportunity(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const skill = (meta.skill as string) ?? "unknown";
    const learnerAddress = (meta.learnerAddress as string) ?? "";
    const description = (meta.description as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Teaching opportunity: ${skill}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A teaching opportunity has been discovered on Nookplot.\n" +
        `Skill requested: ${wrapUntrusted(skill.slice(0, 100), "skill name")}\n` +
        (learnerAddress ? `Learner: ${sanitizeForPrompt(learnerAddress.slice(0, 12))}...\n` : "") +
        (description ? `Details: ${wrapUntrusted(description.slice(0, 500), "opportunity details")}\n` : "") +
        "\nDecide whether to offer your teaching services.\n\n" +
        "Available actions:\n" +
        "- propose_teaching: Offer to teach this skill (params: skill, description, targetAgent)\n" +
        "- search_teachers: Search for other teachers (params: skill)\n" +
        "- reply: Send a message to the learner (params: to, content)\n" +
        "- ignore: Skip this opportunity\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Teaching opportunity handling failed:", err);
    }
  }

  // ── Credit-based agreement signal handlers ──

  private async handleCreditAgreementCreated(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const buyerAddress = (meta.buyerAddress as string) ?? "";
    const amount = (meta.amount as string) ?? (meta.credits as string) ?? "0";
    const description = (meta.description as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Credit agreement created: #${agreementId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A credit-based service agreement has been created for you on Nookplot.\n" +
        `Agreement #${agreementId}\n` +
        `Buyer: ${sanitizeForPrompt(String(buyerAddress).slice(0, 12))}...\n` +
        `Credits: ${amount}\n` +
        (description ? `Terms: ${wrapUntrusted(description.slice(0, 500), "agreement terms")}\n` : "") +
        "\nReview and decide whether to accept this agreement.\n\n" +
        "Available actions:\n" +
        "- accept_credit_agreement: Accept the agreement (params: agreementId)\n" +
        "- cancel_credit_agreement: Decline (params: agreementId)\n" +
        "- reply: Send a message to the buyer (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>\n" +
        "Or respond with ACKNOWLEDGE to consider later.";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text && !text.toUpperCase().includes("ACKNOWLEDGE")) {
        await this.parseAndExecuteAction(text);
      } else if (this.verbose) {
        console.log(`[autonomous] ✓ Acknowledged credit agreement #${agreementId}`);
      }
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Credit agreement created handling failed:", err);
    }
  }

  private async handleCreditWorkDelivered(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const providerAddress = (meta.providerAddress as string) ?? "";
    const deliveryNotes = (meta.deliveryNotes as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Credit work delivered: agreement #${agreementId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Work has been delivered on a credit-based agreement on Nookplot.\n" +
        `Agreement #${agreementId}\n` +
        `Provider: ${sanitizeForPrompt(String(providerAddress).slice(0, 12))}...\n` +
        (deliveryNotes ? `Delivery notes: ${wrapUntrusted(deliveryNotes.slice(0, 500), "delivery notes")}\n` : "") +
        "\nYou are the buyer. Review the submission and decide.\n\n" +
        "Available actions:\n" +
        "- complete_credit_agreement: Accept work and release credits (params: agreementId, rating, review)\n" +
        "- cancel_credit_agreement: Reject and refund (params: agreementId)\n" +
        "- reply: Send feedback (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Credit work delivered handling failed:", err);
    }
  }

  private async handleCreditAgreementAccepted(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const agreementId = meta.agreementId ?? "";
    const buyerAddress = (meta.buyerAddress as string) ?? "";
    const amount = (meta.amount as string) ?? (meta.credits as string) ?? "0";

    if (this.verbose) console.log(`[autonomous] Credit agreement accepted: #${agreementId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your credit-based agreement has been accepted on Nookplot.\n" +
        `Agreement #${agreementId}\n` +
        `Buyer: ${sanitizeForPrompt(String(buyerAddress).slice(0, 12))}...\n` +
        `Credits: ${amount}\n\n` +
        "You should now start working and deliver when ready.\n\n" +
        "Available actions:\n" +
        "- deliver_credit_work: Submit your work (params: agreementId, deliveryNotes)\n" +
        "- cancel_credit_agreement: Cancel the agreement (params: agreementId)\n" +
        "- reply: Send a message to the buyer (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Credit agreement accepted handling failed:", err);
    }
  }

  // ── Email signal handler ──

  private async handleEmailReceived(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const from = (meta.from as string) ?? "unknown";
    const subject = (meta.subject as string) ?? "";
    const body = (meta.body as string) ?? (meta.preview as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Email received from ${from}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You have received an email.\n" +
        `From: ${wrapUntrusted(from.slice(0, 100), "sender")}\n` +
        (subject ? `Subject: ${wrapUntrusted(subject.slice(0, 200), "subject")}\n` : "") +
        (body ? `Body: ${wrapUntrusted(body.slice(0, 1000), "email body")}\n` : "") +
        "\nDecide how to respond to this email.\n\n" +
        "Available actions:\n" +
        "- reply_email: Reply to the email (params: to, subject, body)\n" +
        "- send_email: Send a new email (params: to, subject, body)\n" +
        "- send_dm: Message another agent about this (params: to, content)\n" +
        "- ignore: Take no action\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Email received handling failed:", err);
    }
  }

  // ── Intent matching signal handlers ──

  private async handleIntentMatched(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const intentId = meta.intentId ?? "";
    const title = (meta.title as string) ?? "";
    const description = (meta.description as string) ?? "";
    const budget = (meta.budgetAmount as string) ?? (meta.budget as string) ?? "";
    const skills = (meta.requiredSkills as string[]) ?? [];

    if (this.verbose) console.log(`[autonomous] Intent matched: ${title || intentId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "An intent has been matched to your skills on Nookplot.\n" +
        `Intent ID: ${intentId}\n` +
        (title ? `Title: ${wrapUntrusted(title.slice(0, 200), "intent title")}\n` : "") +
        (description ? `Description: ${wrapUntrusted(description.slice(0, 500), "intent description")}\n` : "") +
        (budget ? `Budget: ${budget} credits\n` : "") +
        (skills.length ? `Required skills: ${skills.join(", ")}\n` : "") +
        "\nDecide whether to submit a proposal for this work.\n\n" +
        "Available actions:\n" +
        "- submit_proposal: Submit a proposal (params: intentId, content, estimatedCredits)\n" +
        "- browse_intents: Browse more intents (params: query)\n" +
        "- reply: Send a message (params: to, content)\n" +
        "- ignore: Skip this opportunity\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Intent matched handling failed:", err);
    }
  }

  private async handleIntentAccepted(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const intentId = meta.intentId ?? "";
    const title = (meta.title as string) ?? "";

    if (this.verbose) console.log(`[autonomous] Intent accepted: ${title || intentId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "Your proposal has been accepted for an intent on Nookplot.\n" +
        `Intent ID: ${intentId}\n` +
        (title ? `Title: ${wrapUntrusted(title.slice(0, 200), "intent title")}\n` : "") +
        "\nYou should now complete the work as described in your proposal.\n\n" +
        "Available actions:\n" +
        "- complete_intent: Mark the intent as completed (params: intentId)\n" +
        "- reply: Send a message to the intent creator (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Intent accepted handling failed:", err);
    }
  }

  private async handleProposalReceived(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const intentId = meta.intentId ?? "";
    const proposalId = meta.proposalId ?? "";
    const proposerAddress = (meta.proposerAddress as string) ?? "";
    const content = (meta.content as string) ?? "";
    const estimatedCredits = meta.estimatedCredits ?? "";

    if (this.verbose) console.log(`[autonomous] Proposal received on intent ${intentId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A proposal has been submitted for your intent on Nookplot.\n" +
        `Intent ID: ${intentId}\n` +
        `Proposal ID: ${proposalId}\n` +
        `Proposer: ${sanitizeForPrompt(String(proposerAddress).slice(0, 12))}...\n` +
        (estimatedCredits ? `Estimated cost: ${estimatedCredits} credits\n` : "") +
        (content ? `Proposal: ${wrapUntrusted(String(content).slice(0, 500), "proposal content")}\n` : "") +
        "\nReview the proposal and decide whether to accept or reject it.\n\n" +
        "Available actions:\n" +
        "- accept_proposal: Accept this proposal (params: intentId, proposalId)\n" +
        "- reject_proposal: Reject this proposal (params: intentId, proposalId, reason)\n" +
        "- reply: Send a message to the proposer (params: to, content)\n" +
        "- ignore: Take no action yet\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] Proposal received handling failed:", err);
    }
  }

  // ── XMTP message signal handler ──

  private async handleXmtpMessage(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const senderAddress = (meta.senderAddress as string) ?? "";
    const content = (meta.content as string) ?? (meta.messagePreview as string) ?? "";

    if (this.verbose) console.log(`[autonomous] XMTP message from ${senderAddress.slice(0, 10)}...`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "You have received a cross-protocol XMTP message.\n" +
        `From: ${sanitizeForPrompt(senderAddress.slice(0, 12))}...\n` +
        (content ? `Message: ${wrapUntrusted(content.slice(0, 1000), "xmtp message")}\n` : "") +
        "\nDecide how to respond.\n\n" +
        "Available actions:\n" +
        "- reply: Send a reply via XMTP (params: to, content)\n" +
        "- ignore: Take no action\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] XMTP message handling failed:", err);
    }
  }

  // ── File sharing signal handler ──

  private async handleFileShared(data: SignalEvent): Promise<void> {
    const meta = data as Record<string, unknown>;
    const projectId = (meta.projectId as string) ?? "";
    const filePath = (meta.filePath as string) ?? (meta.path as string) ?? "";
    const sharedBy = (meta.sharedBy as string) ?? (meta.senderAddress as string) ?? "";

    if (this.verbose) console.log(`[autonomous] File shared: ${filePath} in project ${projectId}`);
    if (!this.generateResponse) return;

    try {
      const prompt =
        `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n` +
        "A file has been shared in a project on Nookplot.\n" +
        (projectId ? `Project: ${projectId}\n` : "") +
        (filePath ? `File: ${wrapUntrusted(filePath.slice(0, 200), "file path")}\n` : "") +
        (sharedBy ? `Shared by: ${sanitizeForPrompt(sharedBy.slice(0, 12))}...\n` : "") +
        "\nDecide how to respond.\n\n" +
        "Available actions:\n" +
        "- reply: Acknowledge or comment on the file (params: to, content)\n" +
        "- ignore: Take no action\n\n" +
        "Format:\nACTION: <action_type>\nPARAMS: <json params>";

      const response = await this.generateResponse(prompt);
      const text = response?.trim() ?? "";
      if (text) await this.parseAndExecuteAction(text);
    } catch (err) {
      if (this.verbose) console.error("[autonomous] File shared handling failed:", err);
    }
  }
}
