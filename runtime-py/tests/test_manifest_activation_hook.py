"""manifest_activation_hook contract tests — Python parity with TS suite.

Stub-based unit tests. The runtime is a minimal namespace with ``hooks``
(a fresh ``HookRegistry`` per test) and ``manifests`` (an ``AsyncMock`` bag
covering ``set_focus`` / ``update_manifest`` / ``get_my_manifest``).
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from nookplot_runtime.hooks import HookRegistry
from nookplot_runtime.manifest_activation_hook import (
    install_manifest_activation_hook,
    extract_domain,
    TASK_BEARING_SIGNALS,
    TERMINAL_ACTIONS,
)


def make_runtime(initial_uncertainties: list[dict[str, Any]] | None = None):
    """Build a minimal runtime stub with ``hooks`` + ``manifests`` mocks."""
    hooks = HookRegistry()
    manifest_state: dict[str, Any] = {
        "uncertainties": initial_uncertainties or [],
    }
    manifests = SimpleNamespace(
        update_manifest=AsyncMock(return_value={"agentId": "a1"}),
        get_my_manifest=AsyncMock(return_value=manifest_state),
    )
    runtime = SimpleNamespace(hooks=hooks, manifests=manifests)
    return runtime, hooks, manifests


async def flush() -> None:
    """Yield control so scheduled tasks can complete."""
    for _ in range(5):
        await asyncio.sleep(0.005)


# ── installer ────────────────────────────────────────────────


class TestInstaller:
    def test_registers_four_listeners_and_disposer_removes_all(self) -> None:
        runtime, hooks, _ = make_runtime()
        assert hooks.count("signal_received") == 0
        assert hooks.count("action_end") == 0
        assert hooks.count("action_error") == 0
        assert hooks.count("doom_loop_detected") == 0

        dispose = install_manifest_activation_hook(runtime)
        assert hooks.count("signal_received") == 1
        assert hooks.count("action_end") == 1
        assert hooks.count("action_error") == 1
        assert hooks.count("doom_loop_detected") == 1

        dispose()
        assert hooks.count("signal_received") == 0
        assert hooks.count("action_end") == 0
        assert hooks.count("action_error") == 0
        assert hooks.count("doom_loop_detected") == 0

    def test_uses_registry_from_kwarg(self) -> None:
        runtime, runtime_hooks, _ = make_runtime()
        opts_hooks = HookRegistry()
        install_manifest_activation_hook(runtime, hooks=opts_hooks)
        assert opts_hooks.count("signal_received") == 1
        assert runtime_hooks.count("signal_received") == 0


# ── signal_received ──────────────────────────────────────────


class TestSignalReceived:
    @pytest.mark.asyncio
    async def test_setfocus_for_task_bearing_signal(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("signal_received", {
            "signalType": "mining_opportunity",
            "domainTags": ["solidity-security", "audit"],
        })
        await flush()
        manifests.update_manifest.assert_awaited_once()
        kwargs = manifests.update_manifest.await_args.kwargs
        assert kwargs == {
            "current_focus": {
                "taskType": "mining_opportunity",
                "domain": "solidity-security",
            },
        }

    @pytest.mark.asyncio
    async def test_skips_non_allowlisted_signals(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("signal_received", {"signalType": "channel_message"})
        await hooks.emit("signal_received", {"signalType": "dm_received"})
        await hooks.emit("signal_received", {"signalType": "new_follower"})
        await flush()
        manifests.update_manifest.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_falls_back_to_general_when_no_domain_hint(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("signal_received", {"signalType": "bounty"})
        await flush()
        manifests.update_manifest.assert_awaited_once_with(
            current_focus={"taskType": "bounty", "domain": "general"},
        )

    @pytest.mark.asyncio
    async def test_swallows_manifest_write_failure(self) -> None:
        runtime, hooks, manifests = make_runtime()
        manifests.update_manifest.side_effect = RuntimeError("gateway down")
        install_manifest_activation_hook(runtime)
        # Must not raise.
        await hooks.emit("signal_received", {
            "signalType": "task_assigned",
            "domain": "data-science",
        })
        await flush()


# ── action_end ───────────────────────────────────────────────


class TestActionEnd:
    @pytest.mark.asyncio
    async def test_clears_focus_on_terminal_action(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("action_end", {
            "actionType": "submit_mining_solution",
            "args": {},
            "result": {},
            "durationMs": 100,
        })
        await flush()
        manifests.update_manifest.assert_awaited_once_with(current_focus=None)

    @pytest.mark.asyncio
    async def test_does_not_clear_for_non_terminal_action(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("action_end", {
            "actionType": "browse_tools",
            "args": {},
            "result": {},
            "durationMs": 100,
        })
        await hooks.emit("action_end", {
            "actionType": "get_my_balance",
            "args": {},
            "result": {},
            "durationMs": 100,
        })
        await flush()
        manifests.update_manifest.assert_not_awaited()


# ── action_error debounce ────────────────────────────────────


class TestActionErrorDebounce:
    @pytest.mark.asyncio
    async def test_no_write_after_one_error(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("action_error", {
            "actionType": "submit_mining_solution",
            "args": {},
            "error": RuntimeError("blip"),
            "durationMs": 50,
        })
        await flush()
        manifests.update_manifest.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_writes_one_uncertainty_after_three_errors_in_window(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        for i in range(3):
            await hooks.emit("action_error", {
                "actionType": "submit_mining_solution",
                "args": {},
                "error": RuntimeError(f"fail-{i}"),
                "durationMs": 50,
            })
        await flush()
        manifests.get_my_manifest.assert_awaited_once()
        manifests.update_manifest.assert_awaited_once()
        kwargs = manifests.update_manifest.await_args.kwargs
        uncertainties = kwargs["uncertainties"]
        assert len(uncertainties) == 1
        assert "Stuck on submit_mining_solution" in uncertainties[0]["description"]
        assert "fail-2" in uncertainties[0]["description"]
        assert uncertainties[0]["valueOfResolution"] == 0.7

    @pytest.mark.asyncio
    async def test_window_reset_when_errors_spread_in_time(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime, error_debounce_window_s=0.05)
        await hooks.emit("action_error", {
            "actionType": "deliver_work",
            "args": {},
            "error": RuntimeError("a"),
            "durationMs": 0,
        })
        await asyncio.sleep(0.08)  # exceeds window
        await hooks.emit("action_error", {
            "actionType": "deliver_work",
            "args": {},
            "error": RuntimeError("b"),
            "durationMs": 0,
        })
        await flush()
        manifests.update_manifest.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_per_action_type_counters_are_independent(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("action_error", {"actionType": "A", "args": {}, "error": RuntimeError("x"), "durationMs": 0})
        await hooks.emit("action_error", {"actionType": "B", "args": {}, "error": RuntimeError("x"), "durationMs": 0})
        await hooks.emit("action_error", {"actionType": "A", "args": {}, "error": RuntimeError("x"), "durationMs": 0})
        await flush()
        manifests.update_manifest.assert_not_awaited()


# ── doom_loop_detected ───────────────────────────────────────


class TestDoomLoop:
    @pytest.mark.asyncio
    async def test_appends_uncertainty_unconditionally(self) -> None:
        runtime, hooks, manifests = make_runtime()
        install_manifest_activation_hook(runtime)
        await hooks.emit("doom_loop_detected", {
            "offender": "submit_mining_solution",
            "triggers": 1,
            "actionType": "submit_mining_solution",
        })
        await flush()
        manifests.update_manifest.assert_awaited_once()
        uncertainties = manifests.update_manifest.await_args.kwargs["uncertainties"]
        assert uncertainties[0]["description"] == "Doom loop on submit_mining_solution"
        assert uncertainties[0]["valueOfResolution"] == 0.9


# ── uncertainty cap ──────────────────────────────────────────


class TestUncertaintyCap:
    @pytest.mark.asyncio
    async def test_drops_oldest_at_default_cap_of_20(self) -> None:
        existing = [
            {"description": f"old-{i}", "valueOfResolution": 0.5}
            for i in range(20)
        ]
        runtime, hooks, manifests = make_runtime(initial_uncertainties=existing)
        install_manifest_activation_hook(runtime)
        await hooks.emit("doom_loop_detected", {
            "offender": "X",
            "triggers": 1,
            "actionType": "X",
        })
        await flush()
        uncertainties = manifests.update_manifest.await_args.kwargs["uncertainties"]
        assert len(uncertainties) == 20
        assert uncertainties[0]["description"] == "old-1"
        assert uncertainties[19]["description"] == "Doom loop on X"

    @pytest.mark.asyncio
    async def test_respects_custom_cap(self) -> None:
        existing = [
            {"description": f"old-{i}", "valueOfResolution": 0.5}
            for i in range(5)
        ]
        runtime, hooks, manifests = make_runtime(initial_uncertainties=existing)
        install_manifest_activation_hook(runtime, max_uncertainties=5)
        await hooks.emit("doom_loop_detected", {
            "offender": "Y",
            "triggers": 1,
            "actionType": "Y",
        })
        await flush()
        uncertainties = manifests.update_manifest.await_args.kwargs["uncertainties"]
        assert len(uncertainties) == 5
        assert uncertainties[4]["description"] == "Doom loop on Y"


# ── extract_domain ───────────────────────────────────────────


class TestExtractDomain:
    def test_prefers_domainTags_first_entry(self) -> None:
        assert extract_domain({"domainTags": ["alpha", "beta"]}) == "alpha"

    def test_supports_snake_case_domain_tags(self) -> None:
        assert extract_domain({"domain_tags": ["alpha"]}) == "alpha"

    def test_falls_back_to_domain(self) -> None:
        assert extract_domain({"domain": "bio"}) == "bio"

    def test_falls_back_to_skill_domain(self) -> None:
        assert extract_domain({"skillDomain": "code-review"}) == "code-review"

    def test_falls_back_to_metadata_domain(self) -> None:
        assert extract_domain({"metadata": {"domain": "math"}}) == "math"

    def test_falls_back_to_community(self) -> None:
        assert extract_domain({"community": "defi"}) == "defi"

    def test_returns_general_as_last_resort(self) -> None:
        assert extract_domain({}) == "general"

    def test_ignores_empty_domain_tags_list(self) -> None:
        assert extract_domain({"domainTags": []}) == "general"


# ── allowlists parity ────────────────────────────────────────


class TestAllowlists:
    def test_task_bearing_signals_excludes_social(self) -> None:
        assert len(TASK_BEARING_SIGNALS) > 10
        for social in (
            "channel_message",
            "dm_received",
            "new_follower",
            "attestation_received",
            "welcome_guide",
        ):
            assert social not in TASK_BEARING_SIGNALS

    def test_terminal_actions_includes_canonical_completions(self) -> None:
        for action in (
            "submit_mining_solution",
            "deliver_work",
            "mark_task_done",
            "resolve_clarification",
        ):
            assert action in TERMINAL_ACTIONS

    def test_terminal_actions_excludes_read_only(self) -> None:
        for action in (
            "browse_tools",
            "get_my_balance",
            "nookplot_get_manifest",
        ):
            assert action not in TERMINAL_ACTIONS
