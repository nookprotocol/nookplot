"""Integration tests — Python AutonomousAgent doom-loop detector.

Parity with the TypeScript runtime's autonomous doom-loop suite. Three identical
actions (or A,B,A,B cycles) accumulate triggers; on the 3rd trigger the cycle
aborts and fires `doom_loop_detected` + `action_error` instead of executing.
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
    runtime, captured = create_mock_runtime()
    hooks = HookRegistry()
    runtime.hooks = hooks
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
    await asyncio.sleep(0.01)


class TestAutonomousDoomLoop:
    @pytest.mark.asyncio
    async def test_three_identical_actions_trigger(self, setup) -> None:
        events: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: events.append(p))

        await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})
        await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})
        await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})

        assert len(events) >= 1
        assert events[0]["offender"] == "send_dm"
        assert events[0]["triggers"] == 1

    @pytest.mark.asyncio
    async def test_two_identical_actions_do_not_trigger(self, setup) -> None:
        events: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: events.append(p))

        await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})
        await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})

        assert events == []

    @pytest.mark.asyncio
    async def test_abab_pattern_triggers(self, setup) -> None:
        events: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: events.append(p))

        await dispatch(setup["captured"], "send_dm", {"to": "0xA"})
        await dispatch(setup["captured"], "vote", {"postCid": "QmA"})
        await dispatch(setup["captured"], "send_dm", {"to": "0xA"})
        await dispatch(setup["captured"], "vote", {"postCid": "QmA"})

        assert len(events) >= 1
        assert events[0]["offender"] in ("send_dm", "vote")

    @pytest.mark.asyncio
    async def test_aba_does_not_trigger(self, setup) -> None:
        events: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: events.append(p))

        await dispatch(setup["captured"], "send_dm", {"to": "0xA"})
        await dispatch(setup["captured"], "vote", {"postCid": "QmA"})
        await dispatch(setup["captured"], "send_dm", {"to": "0xA"})

        assert events == []

    @pytest.mark.asyncio
    async def test_three_triggers_aborts_cycle(self, setup) -> None:
        triggers: list[dict] = []
        ends: list[dict] = []
        errors: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: triggers.append(p))
        setup["hooks"].register("action_end", lambda p: ends.append(p))
        setup["hooks"].register("action_error", lambda p: errors.append(p))

        # 5 identical calls: first 2 don't trigger; next 3 trip the detector.
        # On the 3rd trigger the cycle aborts (no action_end, fires action_error).
        for _ in range(5):
            await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"})

        assert len(triggers) >= 3
        assert triggers[-1]["triggers"] == 3
        assert len(errors) >= 1

    @pytest.mark.asyncio
    async def test_rejects_delegated_action_at_abort(self, setup) -> None:
        reject_mock = AsyncMock()
        setup["runtime"].proactive.reject_delegated_action = reject_mock

        for i in range(5):
            await dispatch(setup["captured"], "send_dm", {"to": "0xA", "content": "hi"}, action_id=f"act_{i}")

        # At least one rejection with the corrective-prompt reason.
        assert reject_mock.await_count >= 1
        last_call_args = reject_mock.call_args_list[-1]
        assert "Doom loop detected on 'send_dm'" in last_call_args.args[1]

    @pytest.mark.asyncio
    async def test_non_repeating_actions_never_trigger(self, setup) -> None:
        events: list[dict] = []
        setup["hooks"].register("doom_loop_detected", lambda p: events.append(p))

        await dispatch(setup["captured"], "send_dm", {"to": "0xA"})
        await dispatch(setup["captured"], "vote", {"postCid": "QmA"})
        await dispatch(setup["captured"], "attest", {"subject": "0xB"})
        await dispatch(setup["captured"], "post", {"body": "gm"})
        await dispatch(setup["captured"], "follow", {"target": "0xC"})

        assert events == []
