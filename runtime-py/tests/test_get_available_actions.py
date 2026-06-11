"""Tests for get_available_actions() — verifies CORE_ACTIONS + signal context behaviour."""
from __future__ import annotations

from nookplot_runtime.autonomous import get_available_actions
from nookplot_runtime.signal_action_map import (
    CORE_ACTIONS,
    SIGNAL_CONTEXT_ACTIONS,
)


class TestGetAvailableActions:
    # ── Core always present ──

    def test_always_includes_core_actions(self):
        signals = [
            "directive", "collab_request", "agreement_created",
            "bounty_claimed", "guild_opportunity", "totally_unknown_signal",
        ]
        for sig in signals:
            actions = get_available_actions(sig)
            for core in CORE_ACTIONS:
                assert core in actions, f"'{core}' missing for signal '{sig}'"

    def test_always_includes_ignore_and_reply(self):
        actions = get_available_actions("directive")
        assert "ignore" in actions
        assert "reply" in actions

    def test_always_includes_browse_tools(self):
        assert "browse_tools" in get_available_actions("directive")
        assert "browse_tools" in get_available_actions("bounty_claimed")
        assert "browse_tools" in get_available_actions("unknown_signal")

    def test_building_tools_always_available(self):
        building = ["create_project", "commit_files", "create_bundle",
                     "list_project_files", "read_project_file"]
        for tool in building:
            assert tool in CORE_ACTIONS
            assert tool in get_available_actions("directive")
            assert tool in get_available_actions("unknown_signal")

    # ── Directive ──

    def test_directive_returns_only_core(self):
        """directive has empty context — browse_tools handles expansion."""
        actions = get_available_actions("directive")
        assert len(actions) == len(CORE_ACTIONS)
        assert set(actions) == set(CORE_ACTIONS)

    # ── Signal context additions ──

    def test_agreement_created(self):
        actions = get_available_actions("agreement_created")
        assert "deliver_work" in actions
        assert "cancel_agreement" in actions
        assert "send_agreement_message" in actions

    def test_work_delivered(self):
        actions = get_available_actions("work_delivered")
        assert "settle_agreement" in actions
        assert "dispute_agreement" in actions
        assert "send_agreement_message" in actions
        assert "expire_delivered" in actions

    def test_agreement_settled(self):
        assert "submit_review" in get_available_actions("agreement_settled")

    def test_revision_requested(self):
        actions = get_available_actions("revision_requested")
        assert "deliver_work" in actions
        assert "send_agreement_message" in actions

    def test_bounty_application_submitted(self):
        actions = get_available_actions("bounty_application_submitted")
        assert "approve_bounty_claimer" in actions
        assert "reject_bounty_application" in actions

    def test_bounty_claimed(self):
        actions = get_available_actions("bounty_claimed")
        assert "approve_bounty_work" in actions
        assert "approve_bounty_claimer" in actions
        assert "dispute_bounty" in actions
        assert "unclaim_bounty" in actions

    def test_team_invitation(self):
        actions = get_available_actions("team_invitation")
        assert "accept_invitation" in actions
        assert "decline_invitation" in actions

    def test_guild_opportunity(self):
        actions = get_available_actions("guild_opportunity")
        assert "join_guild" in actions
        assert "approve_guild" in actions
        assert "reject_guild" in actions
        assert "leave_guild" in actions
        assert "propose_guild" in actions
        assert "link_project_to_guild" in actions

    def test_webhook_received(self):
        actions = get_available_actions("webhook_received")
        assert "egress_request" in actions
        assert "execute_tool" in actions

    def test_collab_request(self):
        actions = get_available_actions("collab_request")
        assert "add_collaborator" in actions
        assert "propose_collab" in actions

    def test_time_to_post(self):
        actions = get_available_actions("time_to_post")
        assert "create_post" in actions
        assert "create_bounty" in actions
        assert "create_listing" in actions
        assert "publish_skill" in actions
        # publish_insight is in CORE, should also be present
        assert "publish_insight" in actions

    def test_intent_matched(self):
        actions = get_available_actions("intent_matched")
        assert "submit_proposal" in actions
        assert "browse_intents" in actions

    def test_teaching_signals(self):
        assert "accept_teaching" in get_available_actions("teaching_proposed")
        assert "reject_teaching" in get_available_actions("teaching_proposed")
        assert "deliver_teaching" in get_available_actions("teaching_accepted")
        assert "approve_teaching" in get_available_actions("teaching_delivered")
        assert "propose_teaching" in get_available_actions("teaching_opportunity")
        assert "search_teachers" in get_available_actions("teaching_opportunity")

    def test_specialization_path(self):
        actions = get_available_actions("specialization_path")
        assert "record_gap" in actions
        assert "update_proficiency" in actions
        assert "search_skills" in actions
        assert "install_skill" in actions

    def test_credit_agreement_signals(self):
        assert "accept_credit_agreement" in get_available_actions("credit_agreement_created")
        assert "deliver_credit_work" in get_available_actions("credit_agreement_accepted")
        assert "complete_credit_agreement" in get_available_actions("credit_work_delivered")

    # ── Structural properties ──

    def test_unknown_signal_returns_only_core(self):
        actions = get_available_actions("totally_unknown_signal")
        assert len(actions) == len(CORE_ACTIONS)
        assert set(actions) == set(CORE_ACTIONS)

    def test_context_actions_are_additive(self):
        """Signals with context always have >= CORE_ACTIONS."""
        for signal, ctx in SIGNAL_CONTEXT_ACTIONS.items():
            if ctx:
                actions = get_available_actions(signal)
                assert len(actions) >= len(CORE_ACTIONS)

    def test_signal_with_context_has_correct_count(self):
        """Actions = CORE + context (deduped)."""
        for signal, ctx in SIGNAL_CONTEXT_ACTIONS.items():
            if ctx:
                actions = get_available_actions(signal)
                expected = set(CORE_ACTIONS) | set(ctx)
                assert len(actions) == len(expected), f"Mismatch for '{signal}'"

    def test_actions_are_deduplicated(self):
        for signal in ["directive", "agreement_created", "bounty_claimed", "guild_opportunity"]:
            actions = get_available_actions(signal)
            assert len(set(actions)) == len(actions), f"Duplicates in '{signal}'"

    def test_all_lists_non_empty(self):
        signals = [
            "directive", "collab_request", "agreement_created",
            "agreement_cancelled", "review_received",
            "bounty_application_rejected", "totally_unknown_signal",
        ]
        for sig in signals:
            assert len(get_available_actions(sig)) > 0

    def test_loaded_categories_expand_actions(self):
        base = get_available_actions("directive")
        expanded = get_available_actions("directive", {"projects"})
        assert len(expanded) >= len(base)

    def test_all_signal_context_types_handled(self):
        for signal in SIGNAL_CONTEXT_ACTIONS:
            actions = get_available_actions(signal)
            assert len(actions) >= len(CORE_ACTIONS)

    def test_search_skills_and_load_skill_in_core(self):
        """search_skills + load_skill are universal capabilities."""
        assert "search_skills" in CORE_ACTIONS
        assert "load_skill" in CORE_ACTIONS

    def test_progressive_disclosure_flag_off(self):
        """With the progressive-disclosure flag off, signal-context tools present."""
        import os
        os.environ.pop("NOOKPLOT_PROGRESSIVE_DISCLOSURE", None)
        actions = get_available_actions("agreement_created")
        for a in SIGNAL_CONTEXT_ACTIONS.get("agreement_created", []):
            assert a in actions

    def test_progressive_disclosure_flag_on(self):
        """With the progressive-disclosure flag on, only CORE_ACTIONS regardless of signal."""
        import os
        os.environ["NOOKPLOT_PROGRESSIVE_DISCLOSURE"] = "1"
        try:
            actions = get_available_actions("agreement_created", {"projects"})
            assert set(actions) == set(CORE_ACTIONS)
        finally:
            os.environ.pop("NOOKPLOT_PROGRESSIVE_DISCLOSURE", None)
