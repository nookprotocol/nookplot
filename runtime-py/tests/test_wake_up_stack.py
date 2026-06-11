"""Tests for WakeUpStack -- tiered context assembly.

Mirrors the TypeScript runtime's WakeUpStack test suite.
Uses a fake runtime with an ``_http.request`` mock to feed canned wake-up payloads.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from nookplot_runtime.wake_up_stack import WakeUpStack


def _payload(
    *,
    domains: list[dict[str, Any]] | None = None,
    role: str | None = "Security researcher",
    essentials: list[dict[str, Any]] | None = None,
    _use_role: bool = True,
) -> dict[str, Any]:
    """Canned wake-up payload. Set _use_role=False to pass role=None explicitly."""
    if domains is None:
        domains = [
            {"domain": "security", "depth": "expert", "items": 40},
            {"domain": "rust", "depth": "proficient", "items": 12},
        ]
    if essentials is None:
        essentials = [
            {
                "id": "e-1",
                "domain": "security",
                "title": "Audit checklist",
                "snippet": "Always check reentrancy first",
                "qualityScore": 85,
            }
        ]
    resolved_role = role if _use_role else None
    return {
        "l0": {"topDomains": domains, "role": resolved_role},
        "l1": {"essentials": essentials},
        "tokenEstimate": 150,
    }


class _FakeRuntime:
    """Minimal runtime stub exposing ``_http.request`` for WakeUpStack."""

    def __init__(self) -> None:
        self._http = type("H", (), {})()
        self._http.request = AsyncMock(return_value=_payload())


@pytest.fixture
def runtime() -> _FakeRuntime:
    return _FakeRuntime()


class TestWakeUpStackGetContext:
    @pytest.mark.asyncio
    async def test_fetches_wake_up_endpoint(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        # "security check" overlaps L1 "security" domain → only one call
        await stack.get_context("security check")
        # First (and only) call hits the wake-up endpoint
        first_call = runtime._http.request.call_args_list[0]
        assert first_call[0] == ("GET", "/v1/agents/me/knowledge/wake-up")

    @pytest.mark.asyncio
    async def test_returns_l0_l1_layers(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        # "security audit" overlaps L1 domain "security" → no L2 fires
        result = await stack.get_context("security audit today")

        assert len(result["layers"]) >= 2
        assert result["layers"][0]["tier"] == 0
        assert result["layers"][1]["tier"] == 1
        assert "Identity" in result["markdown"]
        assert "Security researcher" in result["markdown"]
        assert "Essential knowledge" in result["markdown"]
        assert "Audit checklist" in result["markdown"]

    @pytest.mark.asyncio
    async def test_tracks_l1_item_ids(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        result = await stack.get_context("security check")
        assert "e-1" in result["item_ids"]

    @pytest.mark.asyncio
    async def test_caches_l0_l1_between_calls(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        await stack.get_context("first security task")
        await stack.get_context("second security task")
        # Only one wake-up fetch — L1 cached
        assert runtime._http.request.call_count == 1

    @pytest.mark.asyncio
    async def test_refresh_essentials_invalidates_cache(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        await stack.get_context("security task")
        await stack.refresh_essentials()
        await stack.get_context("security task")
        assert runtime._http.request.call_count == 2

    @pytest.mark.asyncio
    async def test_degrades_gracefully_on_endpoint_failure(
        self, runtime: _FakeRuntime
    ):
        runtime._http.request = AsyncMock(side_effect=RuntimeError("boom"))
        stack = WakeUpStack(runtime)
        result = await stack.get_context("any task")

        # Does not throw, returns empty layers
        assert result["markdown"] == ""
        assert len(result["layers"]) >= 2

    @pytest.mark.asyncio
    async def test_triggers_l2_when_task_diverges(self, runtime: _FakeRuntime):
        # First call: wake-up (security/rust domains)
        # Second call: L2 search (off-domain task)
        runtime._http.request = AsyncMock(
            side_effect=[
                _payload(),
                {
                    "results": [
                        {
                            "item": {
                                "id": "bio-1",
                                "title": "Protein",
                                "contentText": "Folding behavior",
                                "domain": "biology",
                                "qualityScore": 80,
                            },
                            "score": 0.85,
                        }
                    ]
                },
            ]
        )

        stack = WakeUpStack(runtime)
        result = await stack.get_context("biology protein folding pathway")

        # 2 calls: wake-up + L2 search
        assert runtime._http.request.call_count == 2
        second_call = runtime._http.request.call_args_list[1]
        assert second_call[0][0] == "GET"
        assert "/v1/agents/me/knowledge?" in second_call[0][1]

        # L2 layer appended
        l2_layers = [lr for lr in result["layers"] if lr["tier"] == 2]
        assert len(l2_layers) == 1
        assert "bio-1" in l2_layers[0]["item_ids"]

    @pytest.mark.asyncio
    async def test_skips_l2_when_task_overlaps_l1(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        # "security audit" shares "security" with domain → overlap > 20% → skip L2
        await stack.get_context("security audit")
        assert runtime._http.request.call_count == 1

    @pytest.mark.asyncio
    async def test_forces_l2_when_no_l1_domains(self, runtime: _FakeRuntime):
        runtime._http.request = AsyncMock(
            side_effect=[
                _payload(domains=[], role=None, essentials=[], _use_role=False),
                {"results": []},
            ]
        )
        stack = WakeUpStack(runtime)
        await stack.get_context("any task here")
        # With no L1 domains, needs_l2 returns True → attempts L2
        assert runtime._http.request.call_count == 2

    @pytest.mark.asyncio
    async def test_forwards_signal_type_to_l2_selection_mode(
        self, runtime: _FakeRuntime
    ):
        runtime._http.request = AsyncMock(
            side_effect=[_payload(), {"results": []}]
        )
        stack = WakeUpStack(runtime)
        # Off-domain task to force L2. "dm_received" maps to "aggressive".
        await stack.get_context("biology protein folding", signal_type="dm_received")

        l2_call = runtime._http.request.call_args_list[1]
        l2_url = l2_call[0][1]
        assert "selection_mode=aggressive" in l2_url

    @pytest.mark.asyncio
    async def test_falls_back_to_moderate_for_unknown_signal(
        self, runtime: _FakeRuntime
    ):
        runtime._http.request = AsyncMock(
            side_effect=[_payload(), {"results": []}]
        )
        stack = WakeUpStack(runtime)
        await stack.get_context(
            "biology protein folding", signal_type="some_unknown_signal"
        )

        l2_call = runtime._http.request.call_args_list[1]
        l2_url = l2_call[0][1]
        assert "selection_mode=moderate" in l2_url

    @pytest.mark.asyncio
    async def test_new_project_uses_lenient(self, runtime: _FakeRuntime):
        runtime._http.request = AsyncMock(
            side_effect=[_payload(), {"results": []}]
        )
        stack = WakeUpStack(runtime)
        await stack.get_context("biology protein folding", signal_type="new_project")

        l2_call = runtime._http.request.call_args_list[1]
        l2_url = l2_call[0][1]
        assert "selection_mode=lenient" in l2_url

    @pytest.mark.asyncio
    async def test_handles_missing_role(self, runtime: _FakeRuntime):
        runtime._http.request = AsyncMock(
            return_value=_payload(role=None, _use_role=False)
        )
        stack = WakeUpStack(runtime)
        result = await stack.get_context("security work")

        # No Role: line but domains still present
        assert "Role:" not in result["markdown"]
        assert "security" in result["markdown"]

    @pytest.mark.asyncio
    async def test_l1_includes_domain_prefix(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        result = await stack.get_context("security work")
        assert "[security]" in result["markdown"]

    @pytest.mark.asyncio
    async def test_l2_failure_non_fatal(self, runtime: _FakeRuntime):
        runtime._http.request = AsyncMock(
            side_effect=[_payload(), RuntimeError("L2 search failed")]
        )
        stack = WakeUpStack(runtime)
        result = await stack.get_context("biology protein folding")

        # L0+L1 still present even though L2 failed
        assert len(result["layers"]) == 2
        assert result["layers"][0]["tier"] == 0
        assert result["layers"][1]["tier"] == 1
        assert "Identity" in result["markdown"]

    @pytest.mark.asyncio
    async def test_token_estimate_sums_layers(self, runtime: _FakeRuntime):
        stack = WakeUpStack(runtime)
        result = await stack.get_context("security work")
        assert result["token_estimate"] > 0

    @pytest.mark.asyncio
    async def test_l0_markdown_empty_for_empty_payload(
        self, runtime: _FakeRuntime
    ):
        runtime._http.request = AsyncMock(
            side_effect=[
                _payload(domains=[], role=None, essentials=[], _use_role=False),
                {"results": []},
            ]
        )
        stack = WakeUpStack(runtime)
        result = await stack.get_context("anything")

        l0 = next(layer for layer in result["layers"] if layer["tier"] == 0)
        assert l0["markdown"] == ""


class TestWakeUpStackNeedsL2:
    """Direct tests of the _needs_l2 divergence heuristic (<20% overlap)."""

    def test_no_domains_always_needs_l2(self):
        assert WakeUpStack._needs_l2("any task", []) is True

    def test_empty_task_needs_l2(self):
        assert WakeUpStack._needs_l2("", ["security"]) is True

    def test_full_overlap_skips_l2(self):
        # "security" task vs "security" domain → 100% overlap → no L2
        assert WakeUpStack._needs_l2("security", ["security"]) is False

    def test_partial_overlap_above_threshold_skips_l2(self):
        # 2 of 4 words match (50%) → skip L2
        result = WakeUpStack._needs_l2(
            "security review code audit", ["security", "audit"]
        )
        assert result is False

    def test_no_overlap_forces_l2(self):
        # No words shared → needs L2
        assert (
            WakeUpStack._needs_l2("biology protein folding", ["security", "rust"])
            is True
        )

    def test_handles_hyphenated_domains(self):
        # domain "distributed-systems" should match "systems" in task
        assert (
            WakeUpStack._needs_l2(
                "debugging distributed systems issues", ["distributed-systems"]
            )
            is False
        )

    def test_ignores_short_words(self):
        # "is" / "a" are shorter than 3 chars → dropped from task words
        assert WakeUpStack._needs_l2("is a security check", ["security"]) is False
