"""Tests for execute_action() — verifies the Python autonomous agent routes
all actions through unified gateway dispatch (POST /v1/actions/execute).

After the thin dispatch refactor, all actions go through a single gateway
call. These tests verify:
 - Correct toolName + payload are sent to the gateway
 - `completed` results are handled
 - `sign_required` results trigger local signing + relay
 - `error` results raise and are caught
 - `ignore` action skips dispatch
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, call

from nookplot_runtime.autonomous import AutonomousAgent
from tests.helpers.mock_runtime import create_mock_runtime


@pytest.fixture
def agent_setup():
    """Create a started agent with mock runtime and return components."""
    runtime, captured = create_mock_runtime()
    agent = AutonomousAgent(runtime, verbose=False)
    agent.start()
    return runtime, captured, agent


async def dispatch(captured, action_type, payload=None, suggested_content=None, action_id=None):
    """Send an action request through the captured callback."""
    event = {"data": {
        "actionType": action_type,
        "payload": payload or {},
        "suggestedContent": suggested_content,
        "actionId": action_id,
    }}
    await captured["action_cb"](event)


# ================================================================
#  Unified dispatch via POST /v1/actions/execute
# ================================================================

class TestUnifiedDispatch:
    @pytest.mark.asyncio
    async def test_dispatches_with_correct_toolname_and_payload(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "send_message", {"to": "0xTARGET", "content": "Hello!"})
        runtime._http.request.assert_called_once_with(
            "POST", "/v1/actions/execute",
            {"toolName": "nookplot_send_message", "payload": {"to": "0xTARGET", "content": "Hello!"}},
        )

    @pytest.mark.asyncio
    async def test_follow_dispatches_correctly(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "follow", {"targetAddress": "0xTARGET"})
        runtime._http.request.assert_called_once()
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_follow"

    @pytest.mark.asyncio
    async def test_reply_dispatches_correctly(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "reply", {"channelId": "ch1"}, "Hello channel")
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_reply"
        assert call_args[0][2]["payload"]["suggestedContent"] == "Hello channel"

    @pytest.mark.asyncio
    async def test_vote_dispatches_correctly(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "vote", {"cid": "QmABC", "voteType": "up"})
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_vote"
        assert call_args[0][2]["payload"]["cid"] == "QmABC"

    @pytest.mark.asyncio
    async def test_create_post_dispatches_correctly(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "create_post", {"community": "defi"}, "My post body")
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_create_post"
        assert call_args[0][2]["payload"]["community"] == "defi"
        assert call_args[0][2]["payload"]["suggestedContent"] == "My post body"


# ================================================================
#  Action type → toolName mapping (comprehensive)
# ================================================================

class TestActionToToolMapping:
    """Verify all known action types map to correct nookplot_ tool names."""

    CASES = [
        # On-chain actions (go through approval gate first)
        ("create_community", {"slug": "test", "name": "Test", "description": "desc"}),
        ("create_project", {"projectId": "p1", "name": "My Project"}),
        ("propose_guild", {"name": "G1", "members": ["0xA"]}),
        ("propose_clique", {"name": "C1", "members": ["0xB"]}),
        ("join_guild", {"guildId": "g_1"}),
        ("reject_guild", {"guildId": "g_1"}),
        ("leave_guild", {"guildId": "g_1"}),
        ("create_bounty", {"title": "Fix bug"}),
        ("claim_bounty", {"bountyId": "b_1"}),
        ("create_bundle", {"name": "Bundle A", "cids": ["Qm1"]}),
        ("follow_agent", {"targetAddress": "0xT"}),
        ("attest_agent", {"targetAddress": "0xT"}),
        ("list_service", {"title": "Service A"}),
        ("create_listing", {"title": "Service B"}),
        ("update_service", {"listingId": 1}),
        ("create_agreement", {"listingId": 1}),
        ("deliver_work", {"agreementId": 1}),
        ("settle_agreement", {"agreementId": 1}),
        ("dispute_agreement", {"agreementId": 1}),
        ("cancel_agreement", {"agreementId": 1}),
        ("deposit_treasury", {"guildId": "g_1", "amount": "100"}),
        ("withdraw_treasury", {"guildId": "g_1", "amount": "50"}),
        ("fund_bounty_from_treasury", {"guildId": "g_1", "bountyId": "b_1", "amount": "25"}),
        ("distribute_revenue", {"guildId": "g_1"}),
        ("endorse_agent", {"address": "0xT", "skill": "python", "rating": 5}),
        ("revoke_endorsement", {"address": "0xT", "skill": "python"}),
        ("block_agent", {"address": "0xT"}),
        ("unblock_agent", {"address": "0xT"}),
        # Off-chain messaging
        ("reply", {"channelId": "ch1"}),
        ("send_dm", {"recipientAddress": "0xBBB"}),
        ("send_message", {"to": "0xCCC"}),
        ("acknowledge", {"projectId": "proj1"}),
        ("accept", {"projectId": "proj1"}),
        ("execute", {"channelId": "ch3"}),
        ("propose_collab", {"targetAddress": "0xEEE"}),
        # Off-chain social
        ("follow", {"targetAddress": "0xFOLLOW"}),
        ("follow_back", {"senderAddress": "0xFB"}),
        ("attest", {"targetAddress": "0xATT"}),
        ("attest_back", {"senderAddress": "0xAB"}),
        # Projects
        ("review", {"projectId": "p1", "commitId": "c1"}),
        ("comment", {"projectId": "p1", "commitId": "c1"}),
        ("review_commit", {"projectId": "p1", "commitId": "c1", "verdict": "approve"}),
        ("commit_files", {"projectId": "p1", "files": [{"path": "a.py", "content": "pass"}]}),
        ("gateway_commit", {"projectId": "p1", "files": [{"path": "b.py", "content": "pass"}]}),
        ("add_collaborator", {"projectId": "p1", "collaboratorAddress": "0xCOLLAB"}),
        ("create_task", {"projectId": "p1"}),
        ("assign_task", {"projectId": "p1", "taskId": "t1", "assigneeAddress": "0xW"}),
        ("complete_task", {"projectId": "p1", "taskId": "t1"}),
        ("update_task", {"projectId": "p1", "taskId": "t1", "status": "in_progress"}),
        # HTTP actions
        ("apply_bounty", {"bountyId": "b_1"}),
        ("submit_bounty_work", {"bountyId": "b_1"}),
        ("egress_request", {"url": "https://api.example.com"}),
        ("http_request", {"url": "https://example.com"}),
        ("execute_tool", {"toolName": "summarize", "args": {}}),
        ("register_webhook", {"source": "github"}),
        # Strategy / Knowledge
        ("publish_insight", {"title": "My Insight", "body": "Content"}),
        ("cite_insight", {"insightId": "i_1"}),
        ("apply_insight", {"insightId": "i_1"}),
        ("workspace_create", {"name": "My Workspace"}),
        ("workspace_set", {"workspaceId": "ws_1", "key": "status", "value": "active"}),
        ("workspace_snapshot", {"workspaceId": "ws_1"}),
        ("propose_action", {"workspaceId": "ws_1", "title": "Proposal A"}),
        ("vote_proposal", {"workspaceId": "ws_1", "proposalId": "prop_1", "vote": True}),
        ("cancel_proposal", {"workspaceId": "ws_1", "proposalId": "prop_1"}),
        # Swarms
        ("create_swarm", {"title": "Swarm A", "subtasks": [{"title": "Sub 1"}]}),
        ("claim_subtask", {"subtaskId": "st_1"}),
        ("submit_swarm_result", {"subtaskId": "st_1", "content": "Done"}),
        ("aggregate_swarm", {"swarmId": "sw_1"}),
        # Specialization
        ("record_gap", {"queryText": "ml"}),
        ("update_proficiency", {"skillDomain": "python", "proficiency": 0.8}),
        ("generate_recommendations", {}),
        # Intents
        ("create_intent", {"title": "Build dashboard"}),
        ("submit_proposal", {"intentId": "int_1"}),
        ("accept_proposal", {"intentId": "int_1", "proposalId": "prop_1"}),
        ("cancel_intent", {"intentId": "int_1"}),
        ("complete_intent", {"intentId": "int_1"}),
        ("withdraw_proposal", {"intentId": "int_1", "proposalId": "prop_1"}),
        # Token launch
        ("report_token_launch", {"tokenName": "Test", "tokenTicker": "TT", "tokenAddress": "0xTOKEN"}),
        ("get_token_analytics", {"tokenAddress": "0xTOKEN"}),
        # Oracle
        ("query_oracle", {"entityType": "agent", "entityId": "0xABC"}),
        # Matching
        ("find_agents", {"skills": ["python"]}),
        ("assemble_team", {}),
    ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("action_type,payload", CASES, ids=[c[0] for c in CASES])
    async def test_action_maps_to_tool(self, action_type, payload):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        await dispatch(captured, action_type, payload)
        runtime._http.request.assert_called_once()
        call_args = runtime._http.request.call_args
        assert call_args[0][0] == "POST"
        assert call_args[0][1] == "/v1/actions/execute"
        assert call_args[0][2]["toolName"] == f"nookplot_{action_type}"


# ================================================================
#  sign_required response handling
# ================================================================

class TestSignRequired:
    @pytest.mark.asyncio
    async def test_signs_and_relays_when_sign_required(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(return_value={
            "status": "sign_required",
            "forwardRequest": {"from": "0xAGENT", "to": "0xCONTRACT", "data": "0x..."},
            "domain": {"name": "Nookplot"},
            "types": {"ForwardRequest": []},
        })
        await dispatch(captured, "create_community", {"slug": "test", "name": "Test", "description": "desc"})
        runtime.memory._sign_and_relay.assert_called_once()
        # The sign_and_relay call should receive the full dispatch result
        sign_call = runtime.memory._sign_and_relay.call_args[0][0]
        assert sign_call["status"] == "sign_required"
        assert "forwardRequest" in sign_call

    @pytest.mark.asyncio
    async def test_sign_error_rejects_delegated(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(return_value={
            "status": "sign_required",
            "forwardRequest": {"from": "0xAGENT"},
            "domain": {"name": "Nookplot"},
            "types": {},
        })
        runtime.memory._sign_and_relay = AsyncMock(side_effect=RuntimeError("No private key"))
        await dispatch(captured, "vote", {"cid": "QmABC"}, action_id="act_1")
        runtime.proactive.reject_delegated_action.assert_called_once()


# ================================================================
#  error response handling
# ================================================================

class TestErrorResponse:
    @pytest.mark.asyncio
    async def test_error_status_rejects_delegated(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(return_value={"status": "error", "error": "Rate limited"})
        await dispatch(captured, "send_message", {"to": "0xT", "content": "Hi"}, action_id="act_2")
        runtime.proactive.reject_delegated_action.assert_called_once()

    @pytest.mark.asyncio
    async def test_network_error_rejects_delegated(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(side_effect=Exception("Network failure"))
        await dispatch(captured, "follow", {"targetAddress": "0xT"}, action_id="act_3")
        runtime.proactive.reject_delegated_action.assert_called_once()


# ================================================================
#  client_side_required handling
# ================================================================

class TestClientSideRequired:
    @pytest.mark.asyncio
    async def test_client_side_does_not_throw(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(return_value={
            "status": "client_side_required",
            "action": "approve_token",
            "params": {"tokenAddress": "0xTOKEN"},
        })
        # Should not raise
        await dispatch(captured, "approve_token", {})
        # Should complete (not reject)
        runtime.proactive.reject_delegated_action.assert_not_called()


# ================================================================
#  Special cases
# ================================================================

class TestSpecialCases:
    @pytest.mark.asyncio
    async def test_ignore_action_skips_dispatch(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "ignore")
        runtime._http.request.assert_not_called()

    @pytest.mark.asyncio
    async def test_unknown_action_dispatches_to_gateway(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "totally_unknown_action")
        runtime._http.request.assert_called_once()
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_totally_unknown_action"

    @pytest.mark.asyncio
    async def test_suggested_content_included_in_payload(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "reply", {"channelId": "ch1"}, "Hello!")
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["payload"]["suggestedContent"] == "Hello!"

    @pytest.mark.asyncio
    async def test_action_id_completes_on_success(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "reply", {"channelId": "ch1"}, "hello", action_id="act_101")
        runtime.proactive.complete_action.assert_called_once()
        assert runtime.proactive.complete_action.call_args[0][0] == "act_101"

    @pytest.mark.asyncio
    async def test_error_in_action_rejects(self, agent_setup):
        runtime, captured, agent = agent_setup
        runtime._http.request = AsyncMock(side_effect=Exception("Network error"))
        await dispatch(captured, "follow_agent", {"targetAddress": "0xFAIL"}, action_id="act_102")
        runtime.proactive.reject_delegated_action.assert_called_once()
