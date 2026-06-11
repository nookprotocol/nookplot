"""Default guardrails — installed automatically by ``NookplotClient.connect()``.

Two real-action examples chosen from ``_ON_CHAIN_ACTIONS_GLOBAL`` to prove
the two patterns the registry supports:
  - ``send_dm`` — string mutation path (validate address, sanitize content).
  - ``create_bounty`` — typed/numeric validation + rejection path.

Adding more wirings is intentionally a follow-up. The plan was to
land the registry plus two illustrative examples; agents who want
stricter validation register their own via
``runtime.guardrails.register(...)``.
"""

from __future__ import annotations

import re
import time
from typing import Any, Callable

from .content_safety import sanitize_for_prompt
from .guardrails import GuardrailRegistry, InputGuardrailTripped


# 0x-prefixed 40-hex-character Ethereum address.
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# DM payloads larger than this are pre-sanitized to keep prompt budgets sane.
_DM_CONTENT_MAX = 2000


# ── send_dm ──────────────────────────────────────────────────


def _validate_dm_recipient(to: Any = None) -> dict[str, Any] | None:
    """Reject malformed addresses; lowercase the canonical form."""
    if not isinstance(to, str) or not _ADDRESS_RE.match(to):
        raise InputGuardrailTripped(
            "`to` must be a 0x-prefixed 40-hex Ethereum address"
        )
    return {"to": to.lower()}


def _sanitize_dm_content(content: Any = None) -> dict[str, Any] | None:
    """Strip injection delimiters and clamp to ``_DM_CONTENT_MAX``."""
    if not isinstance(content, str):
        raise InputGuardrailTripped("`content` must be a string")
    if not content:
        raise InputGuardrailTripped("`content` must be non-empty")
    return {"content": sanitize_for_prompt(content, _DM_CONTENT_MAX)}


# ── create_bounty ───────────────────────────────────────────


def _validate_bounty_reward(
    reward: Any = None, amount: Any = None,
) -> dict[str, Any] | None:
    """Reject non-positive rewards. Accepts either ``reward`` or ``amount``
    since the gateway's history accepts both — guardrail only validates
    whichever is present."""
    value = reward if reward is not None else amount
    if value is None:
        return None
    try:
        numeric = float(value) if not isinstance(value, (int, float)) else value
    except (TypeError, ValueError) as exc:
        raise InputGuardrailTripped(f"`reward` must be numeric: {exc}") from exc
    if numeric != numeric or numeric in (float("inf"), float("-inf")):  # NaN / inf
        raise InputGuardrailTripped("`reward` must be a finite number")
    if numeric <= 0:
        raise InputGuardrailTripped("`reward` must be > 0")
    return None


def _validate_bounty_deadline(deadline: Any = None) -> dict[str, Any] | None:
    """Require deadline to be at least 60s in the future (accepts s OR ms)."""
    if deadline is None:
        return None
    try:
        epoch = float(deadline)
    except (TypeError, ValueError) as exc:
        raise InputGuardrailTripped(
            "`deadline` must be a unix-epoch number (seconds or ms)"
        ) from exc
    if epoch != epoch or epoch in (float("inf"), float("-inf")):
        raise InputGuardrailTripped("`deadline` must be a finite number")
    now_sec = time.time()
    now_ms = now_sec * 1000.0
    future_by_sec = epoch > now_sec + 60.0
    future_by_ms = epoch > now_ms + 60_000.0
    if not (future_by_sec or future_by_ms):
        raise InputGuardrailTripped("`deadline` must be at least 60s in the future")
    return None


def register_default_guardrails(registry: GuardrailRegistry) -> Callable[[], None]:
    """Register all default guardrails. Returns a single disposer that removes
    every guardrail this call added — useful for tests and disconnect()."""
    disposers = [
        registry.register(
            "send_dm",
            input=[_validate_dm_recipient, _sanitize_dm_content],
        ),
        registry.register(
            "create_bounty",
            input=[_validate_bounty_reward, _validate_bounty_deadline],
        ),
    ]

    def _dispose() -> None:
        for dispose in disposers:
            dispose()

    return _dispose
