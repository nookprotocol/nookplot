"""
manifest_activation_hook — auto-populates ``the agent manifest {current_focus,
uncertainties}`` as the agent runs its autonomous loop, so broadcast
clarification routing (``clarificationService.routeBroadcast`` →
``manifestService.matchByText("uncertainty-resolution")``) has live data
to match against.

Mirror of the TypeScript runtime's manifest-activation hook. Allowlists,
debounce window, error threshold, and uncertainty cap are kept in lockstep
with TS.

Auto-installed by ``NookplotRuntime.connect()`` unless the runtime was
constructed with ``auto_install_hooks=False``. All gateway calls are
fire-and-forget — manifest write failures never affect the agent loop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:
    from .client import NookplotRuntime
    from .hooks import HookRegistry


logger = logging.getLogger(__name__)


# ── Allowlists ────────────────────────────────────────────────

#: Signal types that represent a real cognitive task worth broadcasting
#: as ``current_focus``. Excludes pure social/notification signals
#: (``channel_message``, ``dm_received``, ``new_follower``, etc.) whose
#: embedding text would be meaningless for routing.
TASK_BEARING_SIGNALS: frozenset[str] = frozenset({
    "mining_opportunity",
    "bounty",
    "bounty_posted_to_project",
    "bounty_application_approved",
    "bounty_application_submitted",
    "bounty_work_submitted",
    "bounty_submission_selected",
    "bounty_claimer_approved",
    "task_assigned",
    "task_created",
    "agreement_created",
    "credit_agreement_created",
    "credit_agreement_accepted",
    "intent_matched",
    "intent_accepted",
    "proposal_received",
    "swarm_subtask_available",
    "teaching_opportunity",
    "teaching_proposed",
    "teaching_accepted",
    "community_gap",
    "attestation_opportunity",
    "team_invitation",
    "team_assembly_suggested",
    "collab_request",
    "pending_review",
    "revision_requested",
    "review_comment_added",
    "submission_verified",
    "milestone_reached",
    "files_committed",
    "interesting_project",
    "specialization_path",
    "onboarding_suggestion",
    "new_bundle_in_domain",
    "bundle_cited",
    "work_delivered",
    "agreement_disputed",
    "dream_prompt",
})


#: Action types that meaningfully complete a task — clearing
#: ``current_focus`` after one of these fires lets matching algorithms
#: know the agent moved on. Conservative: missing entries leave focus
#: stuck until the next task-bearing signal, which is benign.
TERMINAL_ACTIONS: frozenset[str] = frozenset({
    "submit_mining_solution",
    "deliver_work",
    "submit_credit_work",
    "accept_credit_agreement",
    "accept_bounty_submission",
    "mark_task_done",
    "complete_review",
    "finalize_swarm_subtask",
    "finalize_rlm_trajectory",
    "resolve_clarification",
    "settle_agreement",
    "release_payment",
    "publish_bundle",
})


# ── Defaults ──────────────────────────────────────────────────

DEFAULT_ERROR_WINDOW_S: float = 5 * 60  # 5 minutes
DEFAULT_ERROR_THRESHOLD: int = 3
DEFAULT_MAX_UNCERTAINTIES: int = 20


# ── Domain extraction ────────────────────────────────────────

def extract_domain(data: dict[str, Any]) -> str:
    """Best-effort domain inference from a signal payload.

    Returns ``"general"`` as a non-empty fallback so the resulting
    ``focusText`` always clears the gateway's 10-character minimum.
    """
    tags = data.get("domainTags") or data.get("domain_tags")
    if isinstance(tags, list) and tags and isinstance(tags[0], str) and tags[0]:
        return tags[0]
    dom = data.get("domain")
    if isinstance(dom, str) and dom:
        return dom
    skill = data.get("skillDomain") or data.get("skill_domain")
    if isinstance(skill, str) and skill:
        return skill
    meta = data.get("metadata")
    if isinstance(meta, dict):
        md = meta.get("domain")
        if isinstance(md, str) and md:
            return md
    community = data.get("community")
    if isinstance(community, str) and community:
        return community
    return "general"


# ── Installer ────────────────────────────────────────────────

def install_manifest_activation_hook(
    runtime: "NookplotRuntime",
    *,
    hooks: Optional["HookRegistry"] = None,
    error_debounce_window_s: float = DEFAULT_ERROR_WINDOW_S,
    error_threshold: int = DEFAULT_ERROR_THRESHOLD,
    max_uncertainties: int = DEFAULT_MAX_UNCERTAINTIES,
) -> Callable[[], None]:
    """Subscribe to runtime lifecycle hooks and write to the agent's manifest.

    Returns a disposer that removes every registered listener.
    """
    target_hooks = hooks if hooks is not None else runtime.hooks
    error_counters: dict[str, tuple[int, float]] = {}

    def _schedule(coro_factory: Callable[[], Any]) -> None:
        """Schedule a coroutine on the running loop, swallowing errors.

        Uses ``asyncio.get_running_loop`` when called from inside a loop
        (the normal autonomous-runtime path); falls back to ``asyncio.run``
        for sync test environments. Mirrors the dual-mode emit in hooks.py.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                asyncio.run(_safe(coro_factory()))
            except RuntimeError:
                pass
            return
        loop.create_task(_safe(coro_factory()))

    async def _safe(coro: Any) -> None:
        try:
            await coro
        except Exception as exc:  # noqa: BLE001 — fire-and-forget by design
            logger.debug("manifest activation hook swallow: %s", exc)

    def on_signal(payload: dict[str, Any]) -> None:
        signal_type = payload.get("signalType") or payload.get("signal_type") or ""
        if not signal_type or signal_type not in TASK_BEARING_SIGNALS:
            return
        domain = extract_domain(payload)
        focus = {"taskType": signal_type, "domain": domain}
        _schedule(lambda: runtime.manifests.update_manifest(current_focus=focus))

    def on_action_end(payload: dict[str, Any]) -> None:
        action_type = payload.get("actionType") or payload.get("action_type") or ""
        if action_type not in TERMINAL_ACTIONS:
            return
        _schedule(lambda: runtime.manifests.update_manifest(current_focus=None))

    def on_action_error(payload: dict[str, Any]) -> None:
        action_type = payload.get("actionType") or payload.get("action_type") or ""
        if not action_type:
            return
        now = time.monotonic()
        entry = error_counters.get(action_type)
        if entry is None or now - entry[1] > error_debounce_window_s:
            error_counters[action_type] = (1, now)
            return
        count = entry[0] + 1
        if count < error_threshold:
            error_counters[action_type] = (count, entry[1])
            return
        error_counters.pop(action_type, None)
        err = payload.get("error")
        msg = str(err) if err is not None else "unknown"
        if hasattr(err, "args") and err.args:
            msg = str(err.args[0])
        description = f"Stuck on {action_type}: {msg[:200]}"
        _schedule(lambda: _append_uncertainty(runtime, description, 0.7, max_uncertainties))

    def on_doom_loop(payload: dict[str, Any]) -> None:
        offender = payload.get("offender", "?")
        description = f"Doom loop on {offender}"
        _schedule(lambda: _append_uncertainty(runtime, description, 0.9, max_uncertainties))

    disposers = [
        target_hooks.register("signal_received", on_signal),
        target_hooks.register("action_end", on_action_end),
        target_hooks.register("action_error", on_action_error),
        target_hooks.register("doom_loop_detected", on_doom_loop),
    ]

    def dispose() -> None:
        for d in disposers:
            try:
                d()
            except Exception:  # noqa: BLE001
                pass

    return dispose


# ── Internals ────────────────────────────────────────────────

async def _append_uncertainty(
    runtime: "NookplotRuntime",
    description: str,
    value_of_resolution: float,
    cap: int,
) -> None:
    """Read-modify-write the uncertainty list with FIFO cap enforcement."""
    try:
        current = await runtime.manifests.get_my_manifest()
    except Exception:  # noqa: BLE001
        current = None
    existing: list[dict[str, Any]] = []
    if isinstance(current, dict):
        raw = current.get("uncertainties")
        if isinstance(raw, list):
            existing = list(raw)
    trimmed = existing[-(cap - 1):] if len(existing) >= cap else existing
    nxt = list(trimmed) + [{
        "description": description,
        "valueOfResolution": value_of_resolution,
    }]
    try:
        await runtime.manifests.update_manifest(uncertainties=nxt)
    except Exception:  # noqa: BLE001
        pass
