"""HookRegistry — local, in-process event bus for runtime-internal lifecycle.

Mirrors the TypeScript runtime's hooks API. Snake-case event names
match the TS string literals (``action_start``, ``action_end``, etc.) so a
single fixture can validate payload parity across both SDKs.

This is a SEPARATE concern from ``EventManager`` (which routes gateway
WebSocket events). Hooks fire inside the runtime process when actions
start/end, signals arrive, and chat turns complete — use them to attach
cross-cutting concerns without inlining logic at every call site.

Sync callbacks are dispatched in-thread; async callbacks are awaited via
``asyncio.gather(..., return_exceptions=True)`` so one throwing callback
never prevents the rest from running.

Example::

    runtime.hooks.register("action_end", lambda payload: metrics.observe(payload))
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Literal, Union

logger = logging.getLogger("nookplot.hooks")


# ── Event names + payload contracts ──────────────────────────
# The same set as TypeScript's HookEvent type. Snake-case here matches the
# string literals used on the TS side (they are identical wire names).

HookEvent = Literal[
    "action_start",
    "action_end",
    "action_error",
    "action_rejected",
    "signal_received",
    "tool_input",
    "tool_output",
    "chat_turn_complete",
    "memory_compacted",
    "compaction_failed",
]

# Payloads are plain dicts (snake_case keys mirroring the TS camelCase
# fields documented in hooks.ts). The fixtures test that both SDKs emit
# the same shape — see ``runtime/__tests__/fixtures/hook-events.json``.
HookCallback = Callable[[dict[str, Any]], Union[None, Awaitable[None]]]


class HookRegistry:
    """Ordered, in-process callback registry.

    Each event name has its own list of callbacks. ``emit`` runs them via
    ``asyncio.gather(return_exceptions=True)`` so one throwing callback
    doesn't prevent others. ``emit_fire_and_forget`` schedules the emit
    on the running loop and returns immediately — use in hot paths.
    """

    def __init__(self) -> None:
        self._listeners: dict[str, list[HookCallback]] = {}

    def register(
        self,
        event: HookEvent,
        cb: HookCallback,
        *,
        prepend: bool = False,
    ) -> Callable[[], None]:
        """Register a callback. Returns a zero-arg disposer."""
        listeners = self._listeners.setdefault(event, [])
        if prepend:
            listeners.insert(0, cb)
        else:
            listeners.append(cb)

        def _dispose() -> None:
            self.deregister(event, cb)

        return _dispose

    def deregister(self, event: HookEvent, cb: HookCallback) -> None:
        """Remove the first matching callback. Idempotent."""
        listeners = self._listeners.get(event)
        if not listeners:
            return
        try:
            listeners.remove(cb)
        except ValueError:
            return
        if not listeners:
            self._listeners.pop(event, None)

    async def emit(self, event: HookEvent, payload: dict[str, Any]) -> None:
        """Emit and await all callbacks. Errors are caught + logged."""
        listeners = self._listeners.get(event)
        if not listeners:
            return
        # Snapshot so callbacks that mutate the list mid-emit don't affect us.
        snapshot = list(listeners)
        coros: list[Awaitable[None]] = []
        for cb in snapshot:
            try:
                ret = cb(payload)
            except Exception as exc:  # sync callback raised
                # Warning-level: matches TS ``console.error`` — operators must
                # see silent hook failures (downed episodic write, metrics
                # pipeline, etc.) without flipping on DEBUG logging.
                logger.warning("[hooks] callback for %s raised: %s", event, exc)
                continue
            if asyncio.iscoroutine(ret):
                coros.append(self._safe_await(event, ret))
            elif ret is not None and hasattr(ret, "__await__"):
                # Awaitable but not a native coroutine — wrap defensively.
                coros.append(self._safe_await(event, ret))  # type: ignore[arg-type]
        if coros:
            await asyncio.gather(*coros, return_exceptions=True)

    @staticmethod
    async def _safe_await(event: str, awaitable: Awaitable[None]) -> None:
        try:
            await awaitable
        except Exception as exc:
            logger.warning("[hooks] async callback for %s raised: %s", event, exc)

    def emit_fire_and_forget(self, event: HookEvent, payload: dict[str, Any]) -> None:
        """Schedule emit and return immediately.

        Sync callbacks fire INLINE so observable side-effects happen in the
        same call frame as the emit — matches the TS contract where sync
        callbacks run during emit's synchronous prelude. Async callbacks
        are scheduled on the running loop (or drained via ``asyncio.run``
        when no loop is present) so they never block the caller.
        """
        listeners = self._listeners.get(event)
        if not listeners:
            return
        snapshot = list(listeners)
        async_callbacks: list[Awaitable[None]] = []
        for cb in snapshot:
            try:
                ret = cb(payload)
            except Exception as exc:
                logger.warning("[hooks] sync callback for %s raised: %s", event, exc)
                continue
            if asyncio.iscoroutine(ret):
                async_callbacks.append(ret)
            elif ret is not None and hasattr(ret, "__await__"):
                async_callbacks.append(ret)  # type: ignore[arg-type]
        if not async_callbacks:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop — drain via asyncio.run; this preserves the prior
            # sync-environment safety net for tests that emit without await.
            try:
                asyncio.run(self._gather(async_callbacks))
            except RuntimeError:
                for awaitable in async_callbacks:
                    awaitable.close()  # type: ignore[union-attr]
            return
        for awaitable in async_callbacks:
            loop.create_task(self._safe_await(event, awaitable))

    @staticmethod
    async def _gather(awaitables: list[Awaitable[None]]) -> None:
        await asyncio.gather(*awaitables, return_exceptions=True)

    def clear(self, event: HookEvent | None = None) -> None:
        """Test helper. With no arg, clears all subscribers."""
        if event is None:
            self._listeners.clear()
        else:
            self._listeners.pop(event, None)

    def count(self, event: HookEvent) -> int:
        """Number of registered callbacks for an event."""
        listeners = self._listeners.get(event)
        return len(listeners) if listeners else 0


# Module-level singleton. ``NookplotRuntime`` attaches this same instance as
# ``runtime.hooks`` so ``from nookplot_runtime.hooks import hooks`` and the
# attribute access are interchangeable.
hooks = HookRegistry()
