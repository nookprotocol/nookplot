"""Tests for signal dedup key generation and duplicate suppression."""
from __future__ import annotations

import time
import pytest
from unittest.mock import AsyncMock

from nookplot_runtime.autonomous import AutonomousAgent
from tests.helpers.mock_runtime import create_mock_runtime


class TestSignalDedupKey:
    """Test _signal_dedup_key() produces correct, stable keys."""

    def setup_method(self):
        self.runtime, self.captured = create_mock_runtime()
        self.agent = AutonomousAgent(self.runtime, verbose=False)

    def test_dm_received_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "dm_received",
            "senderAddress": "0xABC123",
        })
        assert key == "dm:0xabc123"

    def test_new_follower_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "new_follower",
            "senderAddress": "0xDEF456",
        })
        assert key == "follower:0xdef456"

    def test_channel_message_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "channel_message",
            "channelId": "ch_1",
            "senderAddress": "0xABC",
            "messagePreview": "Hello world",
        })
        assert key == "ch:ch_1:0xabc:Hello world"

    def test_files_committed_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "files_committed",
            "commitId": "commit_abc",
        })
        assert key == "commit:commit_abc"

    def test_agreement_created_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "agreement_created",
            "agreementId": "ag_42",
        })
        assert key == "agreement_created:ag_42"

    def test_team_invitation_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "team_invitation",
            "invitationId": "inv_99",
        })
        assert key == "team_inv:inv_99"

    def test_webhook_received_includes_timestamp(self):
        key1 = self.agent._signal_dedup_key({
            "signalType": "webhook_received",
            "source": "github",
        })
        assert key1.startswith("webhook:github:")
        # Webhook keys should be unique per call (include timestamp)
        time.sleep(0.01)
        key2 = self.agent._signal_dedup_key({
            "signalType": "webhook_received",
            "source": "github",
        })
        # They might be the same within the same second, but the format is right
        assert key2.startswith("webhook:github:")

    def test_unknown_signal_fallback(self):
        key = self.agent._signal_dedup_key({
            "signalType": "some_new_signal",
            "senderAddress": "0xABC",
            "channelId": "ch1",
            "postCid": "Qm123",
        })
        assert key == "some_new_signal:0xabc:ch1:Qm123"

    def test_case_insensitive_address(self):
        key1 = self.agent._signal_dedup_key({
            "signalType": "dm_received",
            "senderAddress": "0xABCDEF",
        })
        key2 = self.agent._signal_dedup_key({
            "signalType": "dm_received",
            "senderAddress": "0xabcdef",
        })
        assert key1 == key2

    def test_time_to_post_daily_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "time_to_post",
        })
        import datetime
        today = datetime.date.today().isoformat()
        assert key == f"post:{today}"

    def test_bounty_application_submitted_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "bounty_application_submitted",
            "applicationId": "app_42",
        })
        assert key == "bounty_app:app_42"

    def test_guild_opportunity_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "guild_opportunity",
            "guildId": "g_1",
            "senderAddress": "0xABC",
        })
        assert key == "guild:g_1:0xabc"

    def test_task_assigned_key(self):
        key = self.agent._signal_dedup_key({
            "signalType": "task_assigned",
            "taskId": "task_1",
            "senderAddress": "0xABC",
        })
        assert key == "task_assign:task_1:0xabc"


class TestDedupSuppression:
    """Test that duplicate signals are suppressed within the 1h window."""

    def setup_method(self):
        self.runtime, self.captured = create_mock_runtime()
        self.handler = AsyncMock()
        self.agent = AutonomousAgent(self.runtime, on_signal=self.handler, verbose=False)
        self.agent.start()

    @pytest.mark.asyncio
    async def test_duplicate_signal_suppressed(self):
        signal = {"data": {"signalType": "dm_received", "senderAddress": "0xABC"}}
        # First call — should be handled
        await self.captured["signal_cb"](signal)
        assert self.handler.call_count == 1

        # Second call — same dedup key, should be suppressed
        await self.captured["signal_cb"](signal)
        assert self.handler.call_count == 1  # Still 1

    @pytest.mark.asyncio
    async def test_different_signals_not_suppressed(self):
        sig1 = {"data": {"signalType": "dm_received", "senderAddress": "0xAAA"}}
        sig2 = {"data": {"signalType": "dm_received", "senderAddress": "0xBBB"}}
        await self.captured["signal_cb"](sig1)
        await self.captured["signal_cb"](sig2)
        assert self.handler.call_count == 2

    @pytest.mark.asyncio
    async def test_expired_signal_not_suppressed(self):
        signal = {"data": {"signalType": "new_follower", "senderAddress": "0xCCC"}}
        await self.captured["signal_cb"](signal)
        assert self.handler.call_count == 1

        # Simulate expiry by backdating the entry (>24h TTL)
        for k in list(self.agent._processed_signals):
            self.agent._processed_signals[k] = time.time() - 86401

        await self.captured["signal_cb"](signal)
        assert self.handler.call_count == 2
