"""
Event subscription system for the Nookplot Agent Runtime SDK.

Manages WebSocket connection for real-time events and provides
a callback-based subscription API.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any, Callable, Coroutine

from nookplot_runtime.types import RuntimeEvent

logger = logging.getLogger(__name__)

# Type alias for event handlers
EventHandler = Callable[[RuntimeEvent], Coroutine[Any, Any, None] | None]


class EventManager:
    """Manages real-time event subscriptions over WebSocket."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)
        self._wildcard_handlers: list[EventHandler] = []
        self._ws: Any | None = None
        self._listen_task: asyncio.Task[None] | None = None

    def subscribe(self, event_type: str, handler: EventHandler) -> None:
        """Register a handler for a specific event type."""
        self._handlers[event_type].append(handler)

    def subscribe_all(self, handler: EventHandler) -> None:
        """Register a handler for all event types."""
        self._wildcard_handlers.append(handler)

    def unsubscribe(self, event_type: str, handler: EventHandler | None = None) -> None:
        """Remove a handler (or all handlers) for an event type."""
        if handler is None:
            self._handlers.pop(event_type, None)
        else:
            handlers = self._handlers.get(event_type, [])
            self._handlers[event_type] = [h for h in handlers if h is not handler]

    async def _dispatch(self, event: RuntimeEvent) -> None:
        """Dispatch an event to all matching handlers."""
        handlers = list(self._handlers.get(event.type, []))
        handlers.extend(self._wildcard_handlers)

        for handler in handlers:
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception("Error in event handler for %s", event.type)

    async def _listen_loop(self, ws: Any) -> None:
        """Listen for WebSocket messages and dispatch events."""
        try:
            async for raw in ws:
                try:
                    data = json.loads(raw)
                    event = RuntimeEvent(**data)
                    await self._dispatch(event)
                except (json.JSONDecodeError, Exception):
                    logger.debug("Ignoring non-event WS message")
        except Exception:
            logger.debug("WebSocket listen loop ended")

    def start(self, ws: Any) -> None:
        """Start listening for events on the given WebSocket."""
        self._ws = ws
        self._listen_task = asyncio.create_task(self._listen_loop(ws))

    async def stop(self) -> None:
        """Stop the event listener."""
        if self._listen_task and not self._listen_task.done():
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        self._listen_task = None
        self._ws = None
