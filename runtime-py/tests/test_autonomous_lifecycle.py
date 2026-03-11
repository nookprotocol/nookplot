"""Tests for AutonomousAgent lifecycle — start/stop, callbacks, options."""
from __future__ import annotations

import logging
import pytest
from unittest.mock import AsyncMock, MagicMock

from nookplot_runtime.autonomous import AutonomousAgent
from tests.helpers.mock_runtime import create_mock_runtime


class TestStartStop:
    def test_start_registers_callbacks(self):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        runtime.proactive.on_signal.assert_called_once()
        runtime.proactive.on_action_request.assert_called_once()
        assert captured["signal_cb"] is not None
        assert captured["action_cb"] is not None

    def test_double_start_is_idempotent(self):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        agent.start()  # Second call should be no-op
        assert runtime.proactive.on_signal.call_count == 1

    def test_stop_prevents_processing(self):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        agent.stop()
        assert agent._running is False

    @pytest.mark.asyncio
    async def test_stopped_agent_drops_signals(self):
        runtime, captured = create_mock_runtime()
        handler = AsyncMock()
        agent = AutonomousAgent(runtime, on_signal=handler, verbose=False)
        agent.start()
        agent.stop()
        await captured["signal_cb"]({"data": {"signalType": "dm_received", "senderAddress": "0x1"}})
        handler.assert_not_called()

    @pytest.mark.asyncio
    async def test_stopped_agent_drops_actions(self):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        agent.stop()
        await captured["action_cb"]({"data": {"actionType": "reply", "payload": {}}})
        # After stop, no dispatch should happen
        runtime._http.request.assert_not_called()


class TestNoHandlerWarning:
    def test_warns_when_no_handlers(self, caplog):
        runtime, _ = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=True)
        with caplog.at_level(logging.WARNING, logger="nookplot.autonomous"):
            agent.start()
        assert any("Neither generate_response nor on_signal" in r.message for r in caplog.records)

    def test_no_warning_with_on_signal(self, caplog):
        runtime, _ = create_mock_runtime()
        agent = AutonomousAgent(runtime, on_signal=AsyncMock(), verbose=True)
        with caplog.at_level(logging.WARNING, logger="nookplot.autonomous"):
            agent.start()
        assert not any("Neither generate_response nor on_signal" in r.message for r in caplog.records)

    def test_no_warning_with_generate_response(self, caplog):
        runtime, _ = create_mock_runtime()
        agent = AutonomousAgent(runtime, generate_response=AsyncMock(), verbose=True)
        with caplog.at_level(logging.WARNING, logger="nookplot.autonomous"):
            agent.start()
        assert not any("Neither generate_response nor on_signal" in r.message for r in caplog.records)


class TestOnSignalMode:
    @pytest.mark.asyncio
    async def test_on_signal_receives_data(self):
        runtime, captured = create_mock_runtime()
        handler = AsyncMock()
        agent = AutonomousAgent(runtime, on_signal=handler, verbose=False)
        agent.start()
        await captured["signal_cb"]({"data": {"signalType": "dm_received", "senderAddress": "0xABC"}})
        handler.assert_called_once()
        call_data = handler.call_args[0][0]
        assert call_data["signalType"] == "dm_received"
        assert call_data["senderAddress"] == "0xABC"

    @pytest.mark.asyncio
    async def test_on_signal_receives_runtime(self):
        runtime, captured = create_mock_runtime()
        handler = AsyncMock()
        agent = AutonomousAgent(runtime, on_signal=handler, verbose=False)
        agent.start()
        await captured["signal_cb"]({"data": {"signalType": "dm_received", "senderAddress": "0xABC"}})
        call_runtime = handler.call_args[0][1]
        assert call_runtime is runtime


class TestApprovalHandler:
    @pytest.mark.asyncio
    async def test_approval_blocks_action(self):
        runtime, captured = create_mock_runtime()
        approval = AsyncMock(return_value=False)
        agent = AutonomousAgent(runtime, on_approval=approval, verbose=False)
        agent.start()
        await captured["action_cb"]({"data": {
            "actionType": "create_community",
            "actionId": "act_1",
            "payload": {"slug": "test", "name": "Test", "description": "A test community"},
            "suggestedContent": "Test desc",
        }})
        approval.assert_called_once()
        runtime._http.request.assert_not_called()
        runtime.proactive.reject_delegated_action.assert_called_once_with("act_1", "Rejected by operator")

    @pytest.mark.asyncio
    async def test_approval_allows_action(self):
        runtime, captured = create_mock_runtime()
        approval = AsyncMock(return_value=True)
        agent = AutonomousAgent(runtime, on_approval=approval, verbose=False)
        agent.start()
        await captured["action_cb"]({"data": {
            "actionType": "create_community",
            "payload": {"slug": "test", "name": "Test", "description": "desc"},
            "suggestedContent": "desc",
        }})
        approval.assert_called_once()
        runtime._http.request.assert_called()

    @pytest.mark.asyncio
    async def test_no_approval_handler_auto_approves(self):
        runtime, captured = create_mock_runtime()
        agent = AutonomousAgent(runtime, verbose=False)
        agent.start()
        await captured["action_cb"]({"data": {
            "actionType": "create_community",
            "payload": {"slug": "test", "name": "Test", "description": "desc"},
            "suggestedContent": "desc",
        }})
        runtime._http.request.assert_called()


class TestOnActionHandler:
    @pytest.mark.asyncio
    async def test_custom_action_handler(self):
        runtime, captured = create_mock_runtime()
        custom_handler = AsyncMock()
        agent = AutonomousAgent(runtime, on_action=custom_handler, verbose=False)
        agent.start()
        await captured["action_cb"]({"data": {
            "actionType": "reply",
            "payload": {"channelId": "ch1"},
            "suggestedContent": "hello",
        }})
        custom_handler.assert_called_once()
        # Default dispatch should NOT run
        runtime._http.request.assert_not_called()


class TestActivityCallback:
    @pytest.mark.asyncio
    async def test_activity_callback_fires(self):
        runtime, captured = create_mock_runtime()
        activity = MagicMock()
        handler = AsyncMock()
        agent = AutonomousAgent(runtime, on_signal=handler, on_activity=activity, verbose=False)
        agent.start()
        await captured["signal_cb"]({"data": {"signalType": "dm_received", "senderAddress": "0xABC"}})
        assert activity.call_count >= 1
        # First call should be "signal_received"
        first_call = activity.call_args_list[0]
        assert first_call[0][0] == "signal_received"
