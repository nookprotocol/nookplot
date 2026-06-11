"""
Knowledge Context — auto-retrieves relevant compiled knowledge for task augmentation.

Before an agent processes a task, call ``get_knowledge_context(runtime, task_description)``
to fetch the top relevant items from the agent's compiled knowledge graph. Returns a
compact markdown string (~400 tokens) ready for injection into the agent's prompt.

Usage::

    from nookplot_runtime.knowledge_context import get_knowledge_context

    ctx = await get_knowledge_context(runtime, "review this code for security issues")
    if ctx["available"]:
        prompt = ctx["markdown"] + "\\n\\n" + original_prompt
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode


# Defaults
MAX_ITEMS = 5
MIN_SCORE = 0.6
MIN_QUALITY = 50
MAX_SNIPPET = 120


async def get_knowledge_context(
    runtime: Any,
    task_description: str | list[str],
    *,
    max_items: int = MAX_ITEMS,
    min_score: float = MIN_SCORE,
    min_quality: float = MIN_QUALITY,
    selection_mode: str | None = None,
) -> dict[str, Any]:
    """Retrieve relevant compiled knowledge for a task.

    .. deprecated::
        Use :class:`~nookplot_runtime.wake_up_stack.WakeUpStack` instead.
        WakeUpStack provides tiered retrieval (L0 identity, L1 essentials cached
        per-session, L2 on-demand) which reduces token cost for in-domain signals.

        This function is preserved for backward compatibility and is used internally
        by WakeUpStack as the L2 on-demand search layer.

    Args:
        runtime: Nookplot runtime instance.
        task_description: Task text used as the search query. Accepts a single
            string (legacy path) or a list of up to 4 query strings
            (multi-segment retrieval).
        max_items: Max results to keep after filtering.
        min_score: Minimum relevance score floor.
        min_quality: Minimum quality score floor.
        selection_mode: MAD selection mode forwarded as the gateway
            ``selection_mode`` query param.

    Returns a dict with:
        markdown (str): Compact markdown context for prompt injection
        item_ids (list[str]): Item UUIDs for citation tracking
        count (int): Number of items retrieved
        available (bool): Whether any relevant context was found
    """
    empty: dict[str, Any] = {"markdown": "", "item_ids": [], "count": 0, "available": False}

    # Normalize to list form (multi-query support). Single string
    # becomes ``[task_description]`` and the URL emits a single ``q=`` param
    # -- identical to the legacy single-query behavior.
    if isinstance(task_description, str):
        raw_queries: list[str] = [task_description]
    else:
        raw_queries = list(task_description)

    queries = [q[:200] for q in raw_queries if q and len(q.strip()) >= 3][:4]
    if not queries:
        return empty

    try:
        # Emit repeated ``q=`` params via urlencode(..., doseq=True). Express
        # parses repeated query keys as ``string[]`` natively.
        q_part = urlencode([("q", q) for q in queries], doseq=True)
        selection_param = f"&selection_mode={selection_mode}" if selection_mode else ""
        data = await runtime._http.request(
            "GET",
            f"/v1/agents/me/knowledge?{q_part}&limit={max_items * 2}&include_public=false{selection_param}",
        )

        results = data.get("results", []) if isinstance(data, dict) else []
        if not results:
            return empty

        # Filter by relevance + quality
        filtered = []
        for r in results:
            score = r.get("score", 0)
            item = r.get("item", {})
            qs = item.get("qualityScore")
            if score >= min_score and (qs is None or qs >= min_quality):
                filtered.append(r)
            if len(filtered) >= max_items:
                break

        if not filtered:
            return empty

        # Build compact markdown
        lines = ["## Your compiled knowledge (auto-retrieved)", ""]
        item_ids: list[str] = []

        for i, r in enumerate(filtered):
            item = r.get("item", {})
            title = item.get("title") or (item.get("contentText", "")[:60])
            domain = item.get("domain")
            domain_prefix = f"[{domain}] " if domain else ""
            snippet = item.get("contentText", "")[:MAX_SNIPPET].replace("\n", " ").strip()
            lines.append(f"{i + 1}. {domain_prefix}**{title}** — {snippet}")
            item_ids.append(item.get("id", ""))

        return {
            "markdown": "\n".join(lines),
            "item_ids": item_ids,
            "count": len(filtered),
            "available": True,
        }

    except Exception as exc:
        # Non-fatal — agent proceeds without knowledge context
        # Log for debugging (don't raise — context injection is advisory)
        import logging
        logging.getLogger("nookplot_runtime").warning(
            "Knowledge context retrieval failed: %s", exc
        )
        return empty
