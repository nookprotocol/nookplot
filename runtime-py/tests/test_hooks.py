"""HookRegistry — unit tests + parity-fixture contract."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from nookplot_runtime.hooks import HookRegistry, hooks as module_singleton


# Same fixture as the TS suite — both SDKs assert against the same payload shape.
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "hook-events.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text())


@pytest.fixture
def reg() -> HookRegistry:
    return HookRegistry()


class TestRegistrationOrder:
    @pytest.mark.asyncio
    async def test_preserves_insertion_order(self, reg: HookRegistry) -> None:
        calls: list[int] = []
        reg.register("action_start", lambda _: calls.append(1))
        reg.register("action_start", lambda _: calls.append(2))
        reg.register("action_start", lambda _: calls.append(3))
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_prepend_puts_callback_at_front(self, reg: HookRegistry) -> None:
        calls: list[str] = []
        reg.register("action_start", lambda _: calls.append("b"))
        reg.register("action_start", lambda _: calls.append("a"), prepend=True)
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == ["a", "b"]


class TestErrorIsolation:
    @pytest.mark.asyncio
    async def test_throwing_callback_does_not_block_others(self, reg: HookRegistry) -> None:
        counted = 0

        def boom(_: dict) -> None:
            raise RuntimeError("boom")

        def increment(_: dict) -> None:
            nonlocal counted
            counted += 1

        async def increment_async(_: dict) -> None:
            nonlocal counted
            counted += 1

        reg.register("action_start", boom)
        reg.register("action_start", increment)
        reg.register("action_start", increment_async)
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert counted == 2

    @pytest.mark.asyncio
    async def test_sync_callback_error_logs_at_warning_level(
        self, reg: HookRegistry, caplog: "pytest.LogCaptureFixture",
    ) -> None:
        """Sync callback exceptions must be observable at WARNING — not DEBUG.
        Downed episodic writes / metrics pipelines must not fail silently."""
        def boom(_: dict) -> None:
            raise RuntimeError("explosion")

        reg.register("action_start", boom)
        with caplog.at_level("WARNING", logger="nookplot.hooks"):
            await reg.emit("action_start", {"actionType": "x", "args": {}})

        matched = [
            r for r in caplog.records
            if r.name == "nookplot.hooks"
            and r.levelname == "WARNING"
            and "explosion" in r.getMessage()
        ]
        assert matched, f"expected WARNING log; got {[r.levelname for r in caplog.records]}"

    @pytest.mark.asyncio
    async def test_async_callback_error_logs_at_warning_level(
        self, reg: HookRegistry, caplog: "pytest.LogCaptureFixture",
    ) -> None:
        async def async_boom(_: dict) -> None:
            raise RuntimeError("async-explosion")

        reg.register("action_end", async_boom)
        with caplog.at_level("WARNING", logger="nookplot.hooks"):
            await reg.emit("action_end", {
                "actionType": "x", "args": {}, "result": None, "durationMs": 0,
            })

        matched = [
            r for r in caplog.records
            if r.name == "nookplot.hooks"
            and r.levelname == "WARNING"
            and "async-explosion" in r.getMessage()
        ]
        assert matched


class TestDeregister:
    @pytest.mark.asyncio
    async def test_deregister_removes_only_matching_callback(self, reg: HookRegistry) -> None:
        calls: list[str] = []

        def cb_a(_: dict) -> None:
            calls.append("a")

        def cb_b(_: dict) -> None:
            calls.append("b")

        reg.register("action_start", cb_a)
        reg.register("action_start", cb_b)
        reg.deregister("action_start", cb_a)
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == ["b"]
        assert reg.count("action_start") == 1

    @pytest.mark.asyncio
    async def test_disposer_returned_by_register_removes_only_that_callback(self, reg: HookRegistry) -> None:
        calls: list[str] = []
        dispose = reg.register("action_start", lambda _: calls.append("a"))
        reg.register("action_start", lambda _: calls.append("b"))
        dispose()
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == ["b"]


class TestAsyncSemantics:
    @pytest.mark.asyncio
    async def test_emit_awaits_async_callbacks(self, reg: HookRegistry) -> None:
        resolved = False

        async def slow(_: dict) -> None:
            nonlocal resolved
            await asyncio.sleep(0.02)
            resolved = True

        reg.register("action_start", slow)
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert resolved is True

    @pytest.mark.asyncio
    async def test_fire_and_forget_returns_immediately(self, reg: HookRegistry) -> None:
        resolved = False

        async def slow(_: dict) -> None:
            nonlocal resolved
            await asyncio.sleep(0.02)
            resolved = True

        reg.register("action_start", slow)
        reg.emit_fire_and_forget("action_start", {"actionType": "x", "args": {}})
        # Should not have completed yet; control returns immediately.
        assert resolved is False
        await asyncio.sleep(0.05)
        assert resolved is True

    @pytest.mark.asyncio
    async def test_sync_and_async_callbacks_coexist(self, reg: HookRegistry) -> None:
        calls: list[str] = []
        reg.register("action_start", lambda _: calls.append("sync1"))

        async def async1(_: dict) -> None:
            calls.append("async1")

        reg.register("action_start", async1)
        reg.register("action_start", lambda _: calls.append("sync2"))
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert sorted(calls) == ["async1", "sync1", "sync2"]


class TestClear:
    @pytest.mark.asyncio
    async def test_clear_event_removes_only_that_event_subscribers(self, reg: HookRegistry) -> None:
        a = b = 0

        def inc_a(_: dict) -> None:
            nonlocal a
            a += 1

        def inc_b(_: dict) -> None:
            nonlocal b
            b += 1

        reg.register("action_start", inc_a)
        reg.register("action_end", inc_b)
        reg.clear("action_start")
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        await reg.emit("action_end", {"actionType": "x", "args": {}, "result": None, "durationMs": 0})
        assert a == 0
        assert b == 1

    def test_clear_all_removes_all_events(self, reg: HookRegistry) -> None:
        reg.register("action_start", lambda _: None)
        reg.register("action_end", lambda _: None)
        reg.clear()
        assert reg.count("action_start") == 0
        assert reg.count("action_end") == 0


class TestSnapshot:
    @pytest.mark.asyncio
    async def test_callback_registering_another_mid_emit_does_not_fire_it_this_turn(
        self, reg: HookRegistry,
    ) -> None:
        calls: list[str] = []

        def first(_: dict) -> None:
            calls.append("first")
            reg.register("action_start", lambda _: calls.append("late"))

        reg.register("action_start", first)
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == ["first"]
        await reg.emit("action_start", {"actionType": "x", "args": {}})
        assert calls == ["first", "first", "late"]


def test_module_singleton_is_a_hook_registry() -> None:
    assert isinstance(module_singleton, HookRegistry)


# ── Cross-runtime parity fixture ──────────────────────────────


class TestParityFixture:
    """The shared hook-events fixture is the single source of truth for hook
    payload shapes. Both SDKs validate against the same file — drift fails
    the build."""

    def test_fixture_lists_all_python_event_names(self) -> None:
        # Mirror of TypeScript's HookEvent union
        py_events = {
            "action_start", "action_end", "action_error", "action_rejected",
            "signal_received", "tool_input", "tool_output",
            "chat_turn_complete", "memory_compacted", "doom_loop_detected",
        }
        fixture_events = set(FIXTURE["events"].keys())
        missing = py_events - fixture_events
        assert not missing, f"Python events missing from fixture: {missing}"

    def test_representative_payload_satisfies_required_keys(self) -> None:
        samples = {
            "action_start": {"actionType": "vote", "args": {"postCid": "QmX"}},
            "action_end": {
                "actionType": "vote", "args": {}, "result": {"txHash": "0x1"}, "durationMs": 12,
            },
            "action_error": {
                "actionType": "vote", "args": {}, "error": RuntimeError("nope"), "durationMs": 5,
            },
            "action_rejected": {"actionType": "vote", "args": {}, "reason": "denied"},
            "signal_received": {"signalType": "dm_received"},
            "tool_input": {"toolName": "send_dm", "args": {"to": "0x1", "content": "hi"}},
            "tool_output": {"toolName": "send_dm", "args": {}, "result": {"ok": True}},
            "chat_turn_complete": {
                "sender": "alice", "platform": "telegram",
                "message": "hi", "response": "hello",
                "toolsUsed": False, "toolCallCount": 0,
            },
            "memory_compacted": {
                "sessionId": "sess1", "compactionNumber": 1,
                "messagesCompacted": 8, "summaryTokens": 256,
            },
            "doom_loop_detected": {
                "offender": "send_dm", "triggers": 1, "actionType": "send_dm",
            },
        }
        for evt, payload in samples.items():
            spec = FIXTURE["events"][evt]
            for key in spec["required_keys"]:
                assert key in payload, f"{evt}.{key} missing from sample payload"
