"""Python parity for loadedSkillRefs capture + flush.

Mirrors the TypeScript runtime's loaded-skill-refs suite. The Python
runtime SDK records every nookplot_load_skill canonical_ref + kind, then
flushes the buffer into the payload of the next submit_reasoning_trace /
submit_subtask_trace call. Without this, the gateway's intersection logic
finds no recent loads and trace_id never gets recorded as a skill-usage signal.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from nookplot_runtime.autonomous import AutonomousAgent
from tests.helpers.mock_runtime import create_mock_runtime


@pytest.fixture
def agent_setup():
    runtime, captured = create_mock_runtime()

    # Make the dispatch mock branch on tool name. load_skill returns
    # canonical_ref; everything else returns a generic completed result.
    async def dispatch(method, path, body=None):
        if method == "POST" and path == "/v1/actions/execute":
            tool_name = (body or {}).get("toolName")
            if tool_name == "nookplot_load_skill":
                return {
                    "status": "completed",
                    "result": {
                        "kind": "community",
                        "canonical_ref": "abc-123-uuid",
                        "content": "skill content",
                    },
                }
            return {"status": "completed", "result": {"id": "submission_xyz"}}
        return {"success": True}

    runtime._http.request = AsyncMock(side_effect=dispatch)
    agent = AutonomousAgent(runtime, verbose=False)
    agent.start()
    return runtime, captured, agent


async def dispatch_action(captured, action_type, payload=None):
    event = {"data": {
        "actionType": action_type,
        "payload": payload or {},
        "suggestedContent": None,
        "actionId": None,
    }}
    await captured["action_cb"](event)


def get_payload(runtime, call_index):
    call = runtime._http.request.call_args_list[call_index]
    return call[0][2]["payload"]


class TestLoadedSkillRefs:
    @pytest.mark.asyncio
    async def test_captures_and_flushes_on_submit_reasoning_trace(self, agent_setup):
        runtime, captured, _ = agent_setup
        await dispatch_action(captured, "load_skill", {"name": "mining", "kind": "community"})
        await dispatch_action(captured, "submit_reasoning_trace", {
            "challengeId": "ch_1", "traceCid": "Qm...", "traceHash": "abc",
        })
        submit_payload = get_payload(runtime, 1)
        assert submit_payload["loadedSkillRefs"] == ["community:abc-123-uuid"]

    @pytest.mark.asyncio
    async def test_flushes_multiple_skills(self, agent_setup):
        runtime, captured, _ = agent_setup

        # Override side_effect for two different load responses then a submit.
        async def custom_dispatch(method, path, body=None):
            tool_name = (body or {}).get("toolName")
            if tool_name == "nookplot_load_skill":
                kind = body["payload"]["kind"]
                if kind == "community":
                    return {"status": "completed", "result": {"kind": "community", "canonical_ref": "uuid-A"}}
                if kind == "mcp_tool":
                    return {"status": "completed", "result": {"kind": "mcp_tool", "canonical_ref": "nookplot_create_post"}}
            return {"status": "completed", "result": {"id": "sub"}}

        runtime._http.request = AsyncMock(side_effect=custom_dispatch)
        await dispatch_action(captured, "load_skill", {"name": "mining", "kind": "community"})
        await dispatch_action(captured, "load_skill", {"name": "nookplot_create_post", "kind": "mcp_tool"})
        await dispatch_action(captured, "submit_reasoning_trace", {"challengeId": "ch_1"})

        submit_payload = get_payload(runtime, 2)
        assert submit_payload["loadedSkillRefs"] == [
            "community:uuid-A",
            "mcp_tool:nookplot_create_post",
        ]

    @pytest.mark.asyncio
    async def test_flushes_on_submit_subtask_trace(self, agent_setup):
        runtime, captured, _ = agent_setup
        await dispatch_action(captured, "load_skill", {"name": "mining", "kind": "community"})
        await dispatch_action(captured, "submit_subtask_trace", {
            "challengeId": "ch_1", "subtaskOrdinal": 1, "guildId": 5,
        })
        submit_payload = get_payload(runtime, 1)
        assert submit_payload["loadedSkillRefs"] == ["community:abc-123-uuid"]

    @pytest.mark.asyncio
    async def test_no_injection_when_buffer_empty(self, agent_setup):
        runtime, captured, _ = agent_setup
        await dispatch_action(captured, "submit_reasoning_trace", {"challengeId": "ch_1"})
        submit_payload = get_payload(runtime, 0)
        assert "loadedSkillRefs" not in submit_payload

    @pytest.mark.asyncio
    async def test_caller_override_wins(self, agent_setup):
        runtime, captured, _ = agent_setup
        await dispatch_action(captured, "load_skill", {"name": "mining", "kind": "community"})
        await dispatch_action(captured, "submit_reasoning_trace", {
            "challengeId": "ch_1",
            "loadedSkillRefs": ["protocol_skill:custom-ref"],
        })
        submit_payload = get_payload(runtime, 1)
        assert submit_payload["loadedSkillRefs"] == ["protocol_skill:custom-ref"]

    @pytest.mark.asyncio
    async def test_search_skills_does_not_capture(self, agent_setup):
        runtime, captured, _ = agent_setup

        async def custom_dispatch(method, path, body=None):
            tool_name = (body or {}).get("toolName")
            if tool_name == "nookplot_search_skills":
                return {
                    "status": "completed",
                    "result": {"candidates": [{"name": "x", "canonical_ref": "uuid-search"}]},
                }
            return {"status": "completed", "result": {"id": "sub"}}

        runtime._http.request = AsyncMock(side_effect=custom_dispatch)
        await dispatch_action(captured, "search_skills", {"query": "test"})
        await dispatch_action(captured, "submit_reasoning_trace", {"challengeId": "ch_1"})

        submit_payload = get_payload(runtime, 1)
        assert "loadedSkillRefs" not in submit_payload

    @pytest.mark.asyncio
    async def test_buffer_caps_at_64(self, agent_setup):
        runtime, captured, _ = agent_setup

        counter = {"i": 0}

        async def custom_dispatch(method, path, body=None):
            tool_name = (body or {}).get("toolName")
            if tool_name == "nookplot_load_skill":
                i = counter["i"]
                counter["i"] += 1
                return {
                    "status": "completed",
                    "result": {"kind": "community", "canonical_ref": f"uuid-{i}"},
                }
            return {"status": "completed", "result": {"id": "sub"}}

        runtime._http.request = AsyncMock(side_effect=custom_dispatch)

        for i in range(70):
            await dispatch_action(captured, "load_skill", {"name": f"skill-{i}", "kind": "community"})
        await dispatch_action(captured, "submit_reasoning_trace", {"challengeId": "ch_1"})

        submit_payload = get_payload(runtime, 70)
        refs = submit_payload["loadedSkillRefs"]
        assert len(refs) == 64
        assert refs[0] == "community:uuid-6"
        assert refs[63] == "community:uuid-69"

    @pytest.mark.asyncio
    async def test_ignores_load_response_without_canonical_ref(self, agent_setup):
        runtime, captured, _ = agent_setup

        async def custom_dispatch(method, path, body=None):
            tool_name = (body or {}).get("toolName")
            if tool_name == "nookplot_load_skill":
                return {"status": "completed", "result": {"kind": "community"}}  # no canonical_ref
            return {"status": "completed", "result": {"id": "sub"}}

        runtime._http.request = AsyncMock(side_effect=custom_dispatch)
        await dispatch_action(captured, "load_skill", {"name": "broken", "kind": "community"})
        await dispatch_action(captured, "submit_reasoning_trace", {"challengeId": "ch_1"})

        submit_payload = get_payload(runtime, 1)
        assert "loadedSkillRefs" not in submit_payload
