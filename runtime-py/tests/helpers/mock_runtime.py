"""Mock runtime factory for autonomous agent tests.

Creates a fake NookplotRuntime with all managers stubbed via MagicMock/AsyncMock.
No real HTTP calls, no gateway required.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, PropertyMock


def _make_manager(**methods: dict) -> MagicMock:
    """Create a MagicMock manager with named async methods returning defaults."""
    mgr = MagicMock()
    for name, default in methods.items():
        setattr(mgr, name, AsyncMock(return_value=default))
    return mgr


def create_mock_runtime() -> MagicMock:
    """Build a mock NookplotRuntime with all managers stubbed.

    Returns a MagicMock that behaves enough like NookplotRuntime for
    AutonomousAgent to register callbacks and dispatch actions.
    """
    runtime = MagicMock()
    runtime._address = "0xAGENT_ADDRESS"

    # ── HTTP client (used by thin dispatch via POST /v1/actions/execute) ──
    runtime._http = MagicMock()
    runtime._http.request = AsyncMock(return_value={"status": "completed", "result": {"success": True}})

    # ── Proactive manager ──
    # Capture registered callbacks so tests can invoke them
    captured = {"signal_cb": None, "action_cb": None}

    def on_signal(cb):
        captured["signal_cb"] = cb

    def on_action_request(cb):
        captured["action_cb"] = cb

    runtime.proactive = MagicMock()
    runtime.proactive.on_signal = MagicMock(side_effect=on_signal)
    runtime.proactive.on_action_request = MagicMock(side_effect=on_action_request)
    runtime.proactive.complete_action = AsyncMock(return_value=None)
    runtime.proactive.reject_delegated_action = AsyncMock(return_value=None)

    # ── Memory bridge ──
    runtime.memory = _make_manager(
        publish_knowledge={"cid": "QmMOCK", "txHash": "0xMOCK_TX"},
        publish_comment={"cid": "QmCOMMENT", "txHash": "0xMOCK_TX"},
        vote={"txHash": "0xMOCK_TX"},
        query_knowledge=[],
    )
    runtime.memory._sign_and_relay = AsyncMock(return_value={"txHash": "0xMOCK_TX"})

    # ── Social ──
    runtime.social = _make_manager(
        follow={"txHash": "0xMOCK_TX"},
        attest={"txHash": "0xMOCK_TX"},
    )

    # ── Inbox ──
    runtime.inbox = _make_manager(
        send={"id": "msg_mock", "to": "0xTARGET"},
        get_messages=[],
    )

    # ── Channels ──
    runtime.channels = _make_manager(
        send={"id": "ch_msg_mock"},
        send_to_project={"id": "ch_proj_mock"},
        get_history={"messages": []},
    )

    # ── Projects ──
    runtime.projects = _make_manager(
        commit_files={"commitId": "commit_mock"},
        submit_review={"reviewId": "review_mock"},
        request_ai_review={"reviewId": "ai_review_mock", "verdict": "approve", "findings_count": 0, "credits_cost": 150},
        create_task={"taskId": "task_mock"},
        assign_task={"assigned": True},
        update_task={"updated": True},
        get_commit={"changes": [], "message": "mock commit"},
        set_guild_attribution={"success": True},
        add_collaborator={"added": True},
    )

    # ── Cliques / Guilds ──
    runtime.cliques = _make_manager(
        link_project={"linked": True},
        get=MagicMock(members=[]),
    )
    runtime.guilds = _make_manager(
        link_project={"linked": True},
        get=MagicMock(members=[]),
        deposit_treasury={"deposited": True},
        withdraw_treasury={"withdrawn": True},
        fund_bounty_from_treasury={"funded": True},
        distribute_revenue={"distributed": True},
    )

    # ── Tools ──
    runtime.tools = _make_manager(
        http_request={"status": 200, "body": "ok"},
        execute_tool={"output": "tool_result"},
        connect_mcp_server={"connected": True},
        disconnect_mcp_server=None,
        register_webhook={"registered": True, "webhookUrl": "https://mock.webhook"},
    )

    # ── Marketplace ──
    runtime.marketplace = _make_manager(
        list_service={"listingId": 1},
        create_agreement={"agreementId": 1},
    )

    # ── Insights ──
    runtime.insights = _make_manager(
        publish={"insightId": "insight_mock"},
        cite={"cited": True},
        apply={"applied": True},
    )

    # ── Workspaces ──
    runtime.workspaces = _make_manager(
        create={"workspaceId": "ws_mock"},
        set_state={"set": True},
        create_snapshot={"snapshotId": "snap_mock"},
        create_proposal={"proposalId": "prop_mock"},
        vote={"voted": True},
        cancel_proposal={"cancelled": True},
    )

    # ── Swarms ──
    runtime.swarms = _make_manager(
        create={"swarmId": "swarm_mock"},
        claim_subtask={"claimed": True},
        submit_result={"submitted": True},
        aggregate={"aggregated": True},
    )

    # ── Specialization ──
    runtime.specialization = _make_manager(
        record_gap=None,
        update_proficiency={"updated": True},
        generate_recommendations=[],
        dismiss_recommendation=None,
    )

    # ── Matching ──
    runtime.matching = _make_manager(
        find_agents={"matches": []},
        assemble_team={"members": [], "requestId": "req_mock", "coverageScore": 0.8},
        send_invitations={"sent": True},
    )

    # ── Discovery ──
    runtime.discovery = _make_manager(
        auto_discover={"results": []},
        search={"results": []},
        apply_discovery_config={"applied": True},
    )

    # ── Connection (for address) ──
    runtime.connection = MagicMock()
    runtime.connection.address = "0xAGENT_ADDRESS"

    return runtime, captured
