"""Integration tests — Python AutonomousAgent fires hook events at the right
times. Mirrors the TypeScript runtime's autonomous-hooks suite.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from nookplot_runtime.autonomous import AutonomousAgent
from nookplot_runtime.hooks import HookRegistry
from tests.helpers.mock_runtime import create_mock_runtime


@pytest.fixture
def setup() -> dict:
    """Create a started agent with a fresh HookRegistry attached to runtime."""
    runtime, captured = create_mock_runtime()
    hooks = HookRegistry()
    runtime.hooks = hooks  # MagicMock allows arbitrary attribute set
    agent = AutonomousAgent(runtime, verbose=False)
    agent.start()
    return {"runtime": runtime, "captured": captured, "agent": agent, "hooks": hooks}


async def dispatch(captured, action_type, payload=None, action_id=None):
    event = {"data": {
        "actionType": action_type,
        "payload": payload or {},
        "actionId": action_id,
    }}
    await captured["action_cb"](event)
    # Yield to scheduler so emit_fire_and_forget tasks run.
    await asyncio.sleep(0.01)


class TestDispatcherHooks:
    @pytest.mark.asyncio
    async def test_action_start_then_action_end_on_success(self, setup) -> None:
        events: list[str] = []
        setup["hooks"].register("action_start", lambda p: events.append(f"start:{p['actionType']}"))
        setup["hooks"].register("action_end", lambda p: events.append(f"end:{p['actionType']}"))

        await dispatch(setup["captured"], "vote", {"postCid": "QmX", "upvote": True})

        assert events == ["start:vote", "end:vote"]

    @pytest.mark.asyncio
    async def test_action_end_payload_includes_durationMs_and_result(self, setup) -> None:
        captured_end: list[dict] = []
        setup["hooks"].register("action_end", lambda p: captured_end.append(p))

        await dispatch(setup["captured"], "vote", {"postCid": "QmX"})

        assert len(captured_end) == 1
        end = captured_end[0]
        assert end["actionType"] == "vote"
        assert isinstance(end["durationMs"], int)
        assert end["durationMs"] >= 0
        assert end["result"] == {"success": True}

    @pytest.mark.asyncio
    async def test_action_error_fires_on_dispatcher_exception(self, setup) -> None:
        setup["runtime"]._http.request = AsyncMock(side_effect=RuntimeError("gateway down"))

        end_fired = False
        captured_err: list[dict] = []

        def on_end(_):
            nonlocal end_fired
            end_fired = True

        setup["hooks"].register("action_end", on_end)
        setup["hooks"].register("action_error", lambda p: captured_err.append(p))

        await dispatch(setup["captured"], "vote", {"postCid": "QmX"}, action_id="act_1")

        assert end_fired is False
        assert len(captured_err) == 1
        assert str(captured_err[0]["error"]) == "gateway down"

    @pytest.mark.asyncio
    async def test_action_rejected_when_approval_denies(self) -> None:
        runtime, captured = create_mock_runtime()
        hooks = HookRegistry()
        runtime.hooks = hooks

        async def deny(_action_type: str, _payload: dict) -> bool:
            return False

        agent = AutonomousAgent(runtime, verbose=False, on_approval=deny)
        agent.start()

        events: list[str] = []
        hooks.register("action_start", lambda p: events.append(f"start:{p['actionType']}"))
        hooks.register("action_end", lambda p: events.append(f"end:{p['actionType']}"))
        hooks.register("action_rejected", lambda p: events.append(f"reject:{p['actionType']}"))

        # `vote` is in _ON_CHAIN_ACTIONS_GLOBAL, so the gate runs.
        await dispatch(captured, "vote", {"postCid": "QmX"}, action_id="act_2")

        assert events == ["reject:vote"]
        runtime.proactive.reject_delegated_action.assert_awaited_with(
            "act_2", "Rejected by operator",
        )

    @pytest.mark.asyncio
    async def test_browse_tools_emits_start_and_end(self, setup) -> None:
        events: list[str] = []
        setup["hooks"].register("action_start", lambda p: events.append(f"start:{p['actionType']}"))
        setup["hooks"].register("action_end", lambda p: events.append(f"end:{p['actionType']}"))

        await dispatch(setup["captured"], "browse_tools", {"category": "discovery"})

        assert events == ["start:browse_tools", "end:browse_tools"]

    @pytest.mark.asyncio
    async def test_signal_received_fires_with_full_payload(self, setup) -> None:
        received: list[dict] = []
        setup["hooks"].register("signal_received", lambda p: received.append(p))

        event = {"data": {
            "signalType": "dm_received",
            "senderAddress": "0xS1",
            "messagePreview": "hi",
        }}
        await setup["captured"]["signal_cb"](event)
        await asyncio.sleep(0.01)

        assert len(received) == 1
        assert received[0]["signalType"] == "dm_received"
        assert received[0]["senderAddress"] == "0xS1"

    @pytest.mark.asyncio
    async def test_legacy_parse_and_execute_action_fires_hooks(self, setup) -> None:
        """The legacy text-parse entry point delegates to _handle_action_request,
        so hooks MUST still fire. Prior to this test the legacy path was
        untested — a subtle regression could strip hook emits there without
        failing any suite."""
        events: list[str] = []
        setup["hooks"].register(
            "action_start", lambda p: events.append(f"start:{p['actionType']}"),
        )
        setup["hooks"].register(
            "action_end", lambda p: events.append(f"end:{p['actionType']}"),
        )

        llm_text = 'ACTION: vote\nPARAMS: {"postCid": "QmLegacy", "upvote": true}'
        await setup["agent"]._parse_and_execute_action(llm_text)
        await asyncio.sleep(0.01)

        assert events == ["start:vote", "end:vote"]

    @pytest.mark.asyncio
    async def test_legacy_parse_missing_action_header_does_not_emit(self, setup) -> None:
        """No ACTION header → early return → no hook emit. This guards against
        accidentally emitting action_start for parse failures."""
        events: list[str] = []
        setup["hooks"].register("action_start", lambda p: events.append("start"))
        setup["hooks"].register("action_error", lambda p: events.append("error"))

        await setup["agent"]._parse_and_execute_action("nothing to see here")
        await asyncio.sleep(0.01)

        assert events == []
