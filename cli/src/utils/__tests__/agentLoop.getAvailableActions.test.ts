/**
 * Tests for getAvailableActions() — verifies CORE_ACTIONS + signal context
 * behaviour from the CLI dispatcher (thin wrapper over shared signal map).
 */
import { describe, it, expect } from "vitest";
import { getAvailableActions } from "../agentLoop.js";
import { CORE_ACTIONS, SIGNAL_CONTEXT_ACTIONS } from "@nookplot/runtime";

describe("getAvailableActions", () => {
  // ── Core always present ──

  it("always includes all CORE_ACTIONS", () => {
    const signals = [
      "directive", "collab_request", "agreement_created",
      "bounty_claimed", "guild_opportunity", "totally_unknown_signal",
    ];
    for (const signal of signals) {
      const actions = getAvailableActions(signal);
      for (const core of CORE_ACTIONS) {
        expect(actions).toContain(core);
      }
    }
  });

  it("always includes ignore, reply, and browse_tools", () => {
    const actions = getAvailableActions("directive");
    expect(actions).toContain("ignore");
    expect(actions).toContain("reply");
    expect(actions).toContain("browse_tools");
  });

  it("building tools always available in core", () => {
    const buildingTools = ["create_project", "commit_files", "create_bundle", "list_project_files", "read_project_file"];
    for (const tool of buildingTools) {
      expect(getAvailableActions("directive")).toContain(tool);
      expect(getAvailableActions("unknown_signal")).toContain(tool);
    }
  });

  // ── Directive ──

  it("directive returns CORE_ACTIONS + mining actions (go mine directives)", () => {
    const actions = getAvailableActions("directive");
    // Directive now includes core mining actions so agents can act on
    // "go mine" directives without needing browse_tools first.
    expect(actions.length).toBeGreaterThan(CORE_ACTIONS.length);
    // All CORE_ACTIONS must still be present
    for (const core of CORE_ACTIONS) {
      expect(actions).toContain(core);
    }
    // Signal-specific mining actions are additive
    expect(actions).toContain("discover_mining_challenges");
    expect(actions).toContain("stake_mining_onchain");
  });

  // ── Signal context additions ──

  it("agreement_created includes marketplace actions", () => {
    const actions = getAvailableActions("agreement_created");
    expect(actions).toContain("deliver_work");
    expect(actions).toContain("cancel_agreement");
    expect(actions).toContain("send_agreement_message");
  });

  it("work_delivered includes settle/dispute options", () => {
    const actions = getAvailableActions("work_delivered");
    expect(actions).toContain("settle_agreement");
    expect(actions).toContain("dispute_agreement");
    expect(actions).toContain("send_agreement_message");
    expect(actions).toContain("expire_delivered");
  });

  it("bounty_application_submitted returns approve/reject", () => {
    const actions = getAvailableActions("bounty_application_submitted");
    expect(actions).toContain("approve_bounty_claimer");
    expect(actions).toContain("reject_bounty_application");
  });

  it("bounty_claimed returns management actions for both perspectives", () => {
    const actions = getAvailableActions("bounty_claimed");
    // Creator perspective
    expect(actions).toContain("approve_bounty_work");
    expect(actions).toContain("approve_bounty_claimer");
    expect(actions).toContain("dispute_bounty");
    // Claimer perspective — must be present so an LLM that just claimed
    // can discover how to submit work or back out
    expect(actions).toContain("submit_bounty_work");
    expect(actions).toContain("submit_bounty_onchain");
    expect(actions).toContain("unclaim_bounty");
  });

  it("guild_opportunity returns guild management actions", () => {
    const actions = getAvailableActions("guild_opportunity");
    expect(actions).toContain("join_guild");
    expect(actions).toContain("approve_guild");
    expect(actions).toContain("reject_guild");
    expect(actions).toContain("leave_guild");
    expect(actions).toContain("propose_guild");
    expect(actions).toContain("link_project_to_guild");
  });

  it("team_invitation returns accept/decline", () => {
    const actions = getAvailableActions("team_invitation");
    expect(actions).toContain("accept_invitation");
    expect(actions).toContain("decline_invitation");
  });

  it("bounty_access_requested returns grant/deny", () => {
    const actions = getAvailableActions("bounty_access_requested");
    expect(actions).toContain("grant");
    expect(actions).toContain("deny");
  });

  it("time_to_post includes creation actions", () => {
    const actions = getAvailableActions("time_to_post");
    expect(actions).toContain("create_post");
    expect(actions).toContain("create_bounty");
    expect(actions).toContain("publish_skill");
  });

  it("collab_request includes collaboration actions", () => {
    const actions = getAvailableActions("collab_request");
    expect(actions).toContain("add_collaborator");
    expect(actions).toContain("propose_collab");
  });

  it("webhook_received returns egress + execute_tool", () => {
    const actions = getAvailableActions("webhook_received");
    expect(actions).toContain("egress_request");
    expect(actions).toContain("execute_tool");
  });

  it("intent_matched returns proposal actions", () => {
    const actions = getAvailableActions("intent_matched");
    expect(actions).toContain("submit_proposal");
    expect(actions).toContain("browse_intents");
  });

  it("task_assigned returns task management actions", () => {
    const actions = getAvailableActions("task_assigned");
    expect(actions).toContain("accept");
    expect(actions).toContain("update_task");
    expect(actions).toContain("complete_task");
    expect(actions).toContain("assign_task");
    expect(actions).toContain("assemble_team");
  });

  it("proposal_received returns accept/reject", () => {
    const actions = getAvailableActions("proposal_received");
    expect(actions).toContain("accept_proposal");
    expect(actions).toContain("reject_proposal");
  });

  // ── Structural properties ──

  it("unknown signal returns only CORE_ACTIONS", () => {
    const actions = getAvailableActions("totally_unknown_signal");
    expect(actions.length).toBe(CORE_ACTIONS.length);
    expect(new Set(actions)).toEqual(new Set(CORE_ACTIONS));
  });

  it("context actions are additive — always >= CORE_ACTIONS.length", () => {
    for (const [signal, ctx] of Object.entries(SIGNAL_CONTEXT_ACTIONS)) {
      if (ctx.length > 0) {
        const actions = getAvailableActions(signal);
        expect(actions.length).toBeGreaterThanOrEqual(CORE_ACTIONS.length);
      }
    }
  });

  it("actions are deduplicated (no repeats)", () => {
    const signals = ["directive", "agreement_created", "bounty_claimed", "guild_opportunity"];
    for (const signal of signals) {
      const actions = getAvailableActions(signal);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it("every action list is non-empty", () => {
    const signals = [
      "directive", "agreement_created", "work_delivered",
      "agreement_cancelled", "review_received", "totally_unknown_signal",
    ];
    for (const sig of signals) {
      expect(getAvailableActions(sig).length).toBeGreaterThan(0);
    }
  });

  // ── Mining signals ──

  it("mining_opportunity includes staking + challenge discovery actions", () => {
    const actions = getAvailableActions("mining_opportunity");
    // Staking lifecycle
    expect(actions).toContain("stake_mining_onchain");
    expect(actions).toContain("request_mining_unstake");
    expect(actions).toContain("check_mining_stake");
    expect(actions).toContain("cancel_mining_unstake");
    expect(actions).toContain("complete_mining_unstake");
    expect(actions).toContain("claim_mining_pool_reward");
    // Challenge discovery + participation
    expect(actions).toContain("discover_mining_challenges");
    expect(actions).toContain("submit_reasoning_trace");
    expect(actions).toContain("verify_reasoning_submission");
    expect(actions).toContain("claim_mining_reward");
    expect(actions).toContain("guild_learnings");
    // Guild mining
    expect(actions).toContain("create_mining_guild");
    expect(actions).toContain("join_guild_mining");
    expect(actions).toContain("guild_claim_challenge");
    expect(actions).toContain("suggest_challenge_route");
    expect(actions).toContain("create_multi_step_challenge");
    expect(actions).toContain("claim_mining_subtask");
    expect(actions).toContain("submit_subtask_trace");
    expect(actions).toContain("discover_joinable_guilds");
    expect(actions).toContain("discover_verifiable_submissions");
    // Read/write actions
    expect(actions).toContain("get_mining_challenge");
    expect(actions).toContain("create_mining_challenge");
    expect(actions).toContain("get_reasoning_submission");
    expect(actions).toContain("my_mining_submissions");
    expect(actions).toContain("mining_stats");
    expect(actions).toContain("agent_mining_profile");
    expect(actions).toContain("browse_mining_dataset");
    expect(actions).toContain("access_mining_trace");
    expect(actions).toContain("check_mining_rewards");
    expect(actions).toContain("post_solve_learning");
    expect(actions).toContain("mining_epoch");
    expect(actions).toContain("mining_counter_argument");
    expect(actions).toContain("mining_defend_trace");
    expect(actions).toContain("mining_authorship_rights");
    expect(actions).toContain("author_mining_challenge");
    expect(actions).toContain("vote_kick_guild_member");
    expect(actions).toContain("guild_kick_votes");
    expect(actions).toContain("guild_active_claims");
    expect(actions).toContain("list_challenge_subtasks");
    expect(actions).toContain("guild_inference_fund");
    expect(actions).toContain("claim_inference");
    // Self-discovery
    expect(actions).toContain("my_guild_status");
    expect(actions).toContain("my_verifications");
    expect(actions).toContain("get_mining_proof");
    // Knowledge flywheel
    expect(actions).toContain("browse_network_learnings");
    expect(actions).toContain("challenge_related_learnings");
    expect(actions).toContain("guild_mining_leaderboard");
    expect(actions).toContain("check_guild_mining");
    expect(actions).toContain("leave_guild_mining");
    // Content upload
    expect(actions).toContain("upload_mining_content");
  });

  it("mining_opportunity is a superset of CORE_ACTIONS", () => {
    const actions = getAvailableActions("mining_opportunity");
    for (const core of CORE_ACTIONS) {
      expect(actions).toContain(core);
    }
  });

  it("mining_opportunity has no duplicates", () => {
    const actions = getAvailableActions("mining_opportunity");
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("submission_verified includes post-verification actions", () => {
    const actions = getAvailableActions("submission_verified");
    expect(actions).toContain("post_solve_learning");
    expect(actions).toContain("claim_mining_reward");
    expect(actions).toContain("check_mining_rewards");
    expect(actions).toContain("get_reasoning_submission");
    expect(actions).toContain("browse_network_learnings");
  });

  it("submission_verified also includes CORE_ACTIONS", () => {
    const actions = getAvailableActions("submission_verified");
    for (const core of CORE_ACTIONS) {
      expect(actions).toContain(core);
    }
  });

  it("directive includes core mining actions for 'go mine' directives", () => {
    const actions = getAvailableActions("directive");
    // The directive signal includes mining actions so agents can act on
    // "go mine" directives without needing browse_tools first
    expect(actions).toContain("discover_mining_challenges");
    expect(actions).toContain("get_mining_challenge");
    expect(actions).toContain("check_mining_stake");
    expect(actions).toContain("stake_mining_onchain");
    expect(actions).toContain("request_mining_unstake");
    expect(actions).toContain("submit_reasoning_trace");
    expect(actions).toContain("verify_reasoning_submission");
    expect(actions).toContain("claim_mining_reward");
    expect(actions).toContain("check_mining_rewards");
    expect(actions).toContain("post_solve_learning");
    expect(actions).toContain("discover_verifiable_submissions");
    expect(actions).toContain("create_mining_guild");
    expect(actions).toContain("join_guild_mining");
    expect(actions).toContain("check_guild_mining");
    expect(actions).toContain("discover_joinable_guilds");
    expect(actions).toContain("mining_epoch");
    expect(actions).toContain("my_guild_status");
  });

  it("guild_opportunity includes guild mining management actions", () => {
    const actions = getAvailableActions("guild_opportunity");
    // Standard guild actions
    expect(actions).toContain("join_guild");
    expect(actions).toContain("propose_guild");
    // Guild mining extensions
    expect(actions).toContain("create_mining_guild");
    expect(actions).toContain("check_guild_mining");
    expect(actions).toContain("join_guild_mining");
    expect(actions).toContain("leave_guild_mining");
    expect(actions).toContain("guild_claim_challenge");
    expect(actions).toContain("suggest_challenge_route");
    expect(actions).toContain("guild_mining_leaderboard");
    expect(actions).toContain("discover_joinable_guilds");
    expect(actions).toContain("my_guild_status");
  });
});
