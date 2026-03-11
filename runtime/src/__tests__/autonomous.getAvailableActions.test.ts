import { describe, it, expect } from "vitest";
import { getAvailableActions } from "../autonomous.js";
import { CORE_ACTIONS, SIGNAL_CONTEXT_ACTIONS } from "../signalActionMap.js";

describe("getAvailableActions", () => {
  it("always includes all CORE_ACTIONS", () => {
    const signals = [
      "directive", "collab_request", "agreement_created", "bounty_claimed",
      "team_invitation", "guild_opportunity", "webhook_received",
      "totally_unknown_signal",
    ];
    for (const signal of signals) {
      const actions = getAvailableActions(signal);
      for (const core of CORE_ACTIONS) {
        expect(actions).toContain(core);
      }
    }
  });

  it("always includes ignore and reply", () => {
    const actions = getAvailableActions("directive");
    expect(actions).toContain("ignore");
    expect(actions).toContain("reply");
  });

  it("always includes browse_tools for self-expansion", () => {
    expect(getAvailableActions("directive")).toContain("browse_tools");
    expect(getAvailableActions("bounty_claimed")).toContain("browse_tools");
    expect(getAvailableActions("unknown_signal")).toContain("browse_tools");
  });

  it("directive returns only CORE_ACTIONS (no context additions)", () => {
    const actions = getAvailableActions("directive");
    // directive has empty context — agents use browse_tools for expansion
    expect(actions.length).toBe(CORE_ACTIONS.length);
    expect(new Set(actions)).toEqual(new Set(CORE_ACTIONS));
  });

  it("agreement_created includes context-specific marketplace actions", () => {
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

  it("agreement_settled includes submit_review", () => {
    const actions = getAvailableActions("agreement_settled");
    expect(actions).toContain("submit_review");
  });

  it("revision_requested includes deliver + message", () => {
    const actions = getAvailableActions("revision_requested");
    expect(actions).toContain("deliver_work");
    expect(actions).toContain("send_agreement_message");
  });

  it("bounty_application_submitted returns approve/reject", () => {
    const actions = getAvailableActions("bounty_application_submitted");
    expect(actions).toContain("approve_bounty_claimer");
    expect(actions).toContain("reject_bounty_application");
  });

  it("bounty_claimed returns management actions", () => {
    const actions = getAvailableActions("bounty_claimed");
    expect(actions).toContain("approve_bounty_work");
    expect(actions).toContain("approve_bounty_claimer");
    expect(actions).toContain("dispute_bounty_work");
    expect(actions).toContain("unclaim_bounty");
  });

  it("team_invitation returns accept/decline", () => {
    const actions = getAvailableActions("team_invitation");
    expect(actions).toContain("accept_invitation");
    expect(actions).toContain("decline_invitation");
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

  it("webhook_received returns egress + execute_tool", () => {
    const actions = getAvailableActions("webhook_received");
    expect(actions).toContain("egress_request");
    expect(actions).toContain("execute_tool");
  });

  it("collab_request includes collaboration actions", () => {
    const actions = getAvailableActions("collab_request");
    expect(actions).toContain("add_collaborator");
    expect(actions).toContain("propose_collab");
  });

  it("teaching signals include teaching actions", () => {
    expect(getAvailableActions("teaching_proposed")).toContain("accept_teaching");
    expect(getAvailableActions("teaching_proposed")).toContain("reject_teaching");
    expect(getAvailableActions("teaching_accepted")).toContain("deliver_teaching");
    expect(getAvailableActions("teaching_delivered")).toContain("approve_teaching");
    expect(getAvailableActions("teaching_opportunity")).toContain("propose_teaching");
    expect(getAvailableActions("teaching_opportunity")).toContain("search_teachers");
  });

  it("files_committed includes DAG navigation + note actions", () => {
    const actions = getAvailableActions("files_committed");
    expect(actions).toContain("get_commit_leaves");
    expect(actions).toContain("get_commit_children");
    expect(actions).toContain("create_project_note");
  });

  it("pending_review includes DAG navigation + note actions", () => {
    const actions = getAvailableActions("pending_review");
    expect(actions).toContain("get_commit_leaves");
    expect(actions).toContain("get_commit_children");
    expect(actions).toContain("create_project_note");
  });

  it("project_forked includes get_commit_leaves", () => {
    const actions = getAvailableActions("project_forked");
    expect(actions).toContain("get_commit_leaves");
  });

  it("merge_request_created includes DAG navigation actions", () => {
    const actions = getAvailableActions("merge_request_created");
    expect(actions).toContain("get_commit_leaves");
    expect(actions).toContain("get_commit_lineage");
  });

  it("specialization_path includes skill improvement actions", () => {
    const actions = getAvailableActions("specialization_path");
    expect(actions).toContain("record_gap");
    expect(actions).toContain("update_proficiency");
    expect(actions).toContain("search_skills");
    expect(actions).toContain("install_skill");
  });

  it("unknown signal returns only CORE_ACTIONS", () => {
    const actions = getAvailableActions("totally_unknown_signal");
    expect(actions.length).toBe(CORE_ACTIONS.length);
    expect(new Set(actions)).toEqual(new Set(CORE_ACTIONS));
  });

  it("context actions are additive — signal actions superset CORE_ACTIONS", () => {
    const signals = Object.keys(SIGNAL_CONTEXT_ACTIONS).filter(
      (s) => SIGNAL_CONTEXT_ACTIONS[s].length > 0,
    );
    for (const signal of signals) {
      const actions = getAvailableActions(signal);
      expect(actions.length).toBeGreaterThanOrEqual(CORE_ACTIONS.length);
    }
  });

  it("signal actions with context have more actions than core-only", () => {
    const contextSignals = Object.entries(SIGNAL_CONTEXT_ACTIONS)
      .filter(([_, ctx]) => ctx.length > 0)
      .map(([signal]) => signal);
    for (const signal of contextSignals) {
      const actions = getAvailableActions(signal);
      const contextActions = SIGNAL_CONTEXT_ACTIONS[signal];
      // Should have CORE + context (minus duplicates)
      const expected = new Set([...CORE_ACTIONS, ...contextActions]);
      expect(actions.length).toBe(expected.size);
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
      "directive", "collab_request", "agreement_created", "work_delivered",
      "agreement_cancelled", "review_received", "bounty_application_rejected",
      "totally_unknown_signal",
    ];
    for (const signal of signals) {
      expect(getAvailableActions(signal).length).toBeGreaterThan(0);
    }
  });

  it("building tools are always available in CORE", () => {
    const buildingTools = ["create_project", "commit_files", "create_bundle", "list_project_files", "read_project_file"];
    for (const tool of buildingTools) {
      expect(CORE_ACTIONS).toContain(tool);
      expect(getAvailableActions("directive")).toContain(tool);
      expect(getAvailableActions("unknown")).toContain(tool);
    }
  });

  it("loadedCategories expands available actions", () => {
    // Without loaded categories, directive has ~30 core actions
    const base = getAvailableActions("directive");
    // With loaded categories, should have more
    const expanded = getAvailableActions("directive", new Set(["projects"]));
    expect(expanded.length).toBeGreaterThanOrEqual(base.length);
  });

  it("all SIGNAL_CONTEXT_ACTIONS signal types are handled", () => {
    for (const signal of Object.keys(SIGNAL_CONTEXT_ACTIONS)) {
      const actions = getAvailableActions(signal);
      expect(actions.length).toBeGreaterThanOrEqual(CORE_ACTIONS.length);
    }
  });
});
