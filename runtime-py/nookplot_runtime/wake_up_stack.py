"""
WakeUpStack -- tiered context assembly for agent knowledge retrieval.

Replaces the flat single-shot approach of ``get_knowledge_context()`` with a
3-layer stack that balances cost and coverage:

  L0 (Identity, ~50 tokens)    -- Always loaded. Agent's top domains + role.
  L1 (Essentials, ~300 tokens) -- Session-cached. Top syntheses + recently accessed.
  L2 (On-Demand, ~400 tokens)  -- Per-signal when topic diverges from L1 coverage.
  L3 (Deep Search)             -- Explicit tool call only. Already exists.

Usage::

    from nookplot_runtime.wake_up_stack import WakeUpStack

    stack = WakeUpStack(runtime)
    result = await stack.get_context("review this code for security issues")
    prompt = result["markdown"] + "\\n\\n" + original_prompt
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from .knowledge_context import get_knowledge_context
from .query_segmentation import segment_task_for_query
from .signal_action_map import SIGNAL_SELECTION_MODE

logger = logging.getLogger("nookplot_runtime")

# L1 cache TTL -- 30 minutes
_L1_TTL_SEC = 30 * 60

# Minimum task/L1 keyword overlap to skip L2 search
_L2_OVERLAP_THRESHOLD = 0.2


class WakeUpStack:
    """Tiered context assembly for agent knowledge retrieval."""

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime
        self._cache: dict[str, Any] | None = None
        self._cache_time: float = 0.0

    async def get_context(
        self,
        task_description: str = "",
        signal_type: str | None = None,
    ) -> dict[str, Any]:
        """Build context for a signal.

        Args:
            task_description: What the agent is about to do.
            signal_type: Optional signal type. When provided, the L2 search
                uses the MAD selection mode mapped from ``SIGNAL_SELECTION_MODE``
                to match the retrieval focus the signal type needs. Unknown or
                omitted signal types fall back to ``"moderate"``.

        Returns:
            Dict with layers, markdown, token_estimate, item_ids.
        """
        layers: list[dict[str, Any]] = []
        all_item_ids: list[str] = []
        total_tokens = 0

        # Load L0 + L1 (session-cached)
        l0, l1, l1_domains = await self._load_l0l1()
        layers.extend([l0, l1])
        all_item_ids.extend(l0["item_ids"])
        all_item_ids.extend(l1["item_ids"])
        total_tokens += l0["token_estimate"] + l1["token_estimate"]

        # L2: on-demand search if task diverges from L1 domains.
        # Resolve the selection mode from the signal type map — unmapped/missing
        # signal types fall back to "moderate" (above-median MAD).
        selection_mode: str = SIGNAL_SELECTION_MODE.get(signal_type or "", "moderate")

        if task_description and self._needs_l2(task_description, l1_domains):
            l2 = await self._load_l2(task_description, selection_mode=selection_mode)
            if l2 is not None:
                layers.append(l2)
                all_item_ids.extend(l2["item_ids"])
                total_tokens += l2["token_estimate"]

        # Combine markdown
        parts = [layer["markdown"] for layer in layers if layer["markdown"]]

        return {
            "layers": layers,
            "markdown": "\n\n".join(parts),
            "token_estimate": total_tokens,
            "item_ids": all_item_ids,
        }

    async def refresh_essentials(self) -> None:
        """Force-refresh the L1 cache.

        Call on session start, after bulk knowledge ingest, or after consolidation.
        """
        self._cache = None
        self._cache_time = 0.0

    # ------------------------------------------------------------------ private

    async def _load_l0l1(
        self,
    ) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
        """Load L0 + L1 from gateway (session-cached)."""
        if self._cache is not None and time.monotonic() - self._cache_time < _L1_TTL_SEC:
            return self._cache["l0"], self._cache["l1"], self._cache["l1_domains"]

        empty_l0: dict[str, Any] = {"tier": 0, "markdown": "", "token_estimate": 0, "item_ids": []}
        empty_l1: dict[str, Any] = {"tier": 1, "markdown": "", "token_estimate": 0, "item_ids": []}

        try:
            payload = await self._runtime._http.request(
                "GET", "/v1/agents/me/knowledge/wake-up",
            )

            # Build L0 markdown
            l0_lines: list[str] = []
            l0_data = payload.get("l0", {})
            role = l0_data.get("role")
            if role:
                l0_lines.append(f"**Role:** {role}")
            top_domains = l0_data.get("topDomains", [])
            if top_domains:
                domain_str = ", ".join(
                    f"{d['domain']} ({d['depth']}, {d['items']} items)"
                    for d in top_domains
                )
                l0_lines.append(f"**Domains:** {domain_str}")

            l0: dict[str, Any] = {
                "tier": 0,
                "markdown": f"## Identity\n" + "\n".join(l0_lines) if l0_lines else "",
                "token_estimate": len(l0_lines) * 15,
                "item_ids": [],
            }

            # Build L1 markdown
            essentials = payload.get("l1", {}).get("essentials", [])
            l1_lines: list[str] = []
            l1_item_ids: list[str] = []
            for item in essentials:
                domain = item.get("domain")
                domain_prefix = f"[{domain}] " if domain else ""
                title = item.get("title") or (item.get("snippet", "")[:40])
                snippet = item.get("snippet", "")
                l1_lines.append(f"- {domain_prefix}**{title}** -- {snippet}")
                l1_item_ids.append(item.get("id", ""))

            l1: dict[str, Any] = {
                "tier": 1,
                "markdown": f"## Essential knowledge\n" + "\n".join(l1_lines) if l1_lines else "",
                "token_estimate": len(l1_lines) * 60,
                "item_ids": l1_item_ids,
            }

            l1_domains = [d["domain"] for d in top_domains]

            self._cache = {"l0": l0, "l1": l1, "l1_domains": l1_domains}
            self._cache_time = time.monotonic()
            return l0, l1, l1_domains

        except Exception as exc:
            logger.warning("WakeUpStack L0+L1 load failed: %s", exc)
            return empty_l0, empty_l1, []

    async def _load_l2(
        self,
        task_description: str,
        *,
        selection_mode: str = "moderate",
    ) -> dict[str, Any] | None:
        """L2: on-demand search via get_knowledge_context.

        Args:
            task_description: Task text used as the search query.
            selection_mode: MAD selection mode forwarded to the gateway as
                ``selection_mode``. Controls how aggressively the gateway trims
                the candidate set below median+MAD.

        The task description is split into up to 4 query strings
        (full + sliding windows + entities + question spans) via
        ``segment_task_for_query``, and the gateway takes the MAX similarity
        across all of them. On short/simple queries this collapses to the
        single-string baseline -- the first element is always the full task.
        """
        try:
            # Multi-segment query expansion. For short/simple tasks
            # this returns ``[task_description]`` and the call is identical to
            # the legacy single-query path.
            queries = segment_task_for_query(task_description, 4)
            query_input: str | list[str] = (
                queries if len(queries) > 1 else task_description
            )

            result = await get_knowledge_context(
                self._runtime,
                query_input,
                max_items=5,
                min_score=0.5,
                min_quality=40,
                selection_mode=selection_mode,
            )
            if not result.get("available") or result.get("count", 0) == 0:
                return None
            return {
                "tier": 2,
                "markdown": result["markdown"],
                "token_estimate": result["count"] * 80,
                "item_ids": result["item_ids"],
            }
        except Exception:
            return None

    @staticmethod
    def _needs_l2(task_description: str, l1_domains: list[str]) -> bool:
        """Check if the task diverges from L1 domains (<20% overlap)."""
        if not l1_domains:
            return True

        words = set(
            w for w in re.sub(r"[^a-z0-9\s-]", " ", task_description.lower()).split()
            if len(w) > 2
        )
        if not words:
            return True

        domain_words = set()
        for d in l1_domains:
            domain_words.update(d.lower().replace("_", " ").replace("-", " ").split())

        overlap = sum(1 for w in words if w in domain_words)
        return overlap / len(words) < _L2_OVERLAP_THRESHOLD
