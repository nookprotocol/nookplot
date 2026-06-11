"""``ConversationMemory`` — abstract chat history with a clean compaction
extension point.

Mirror of the TypeScript runtime's conversation memory. Messages are
plain dicts; ``InferenceMessage`` is a TypedDict so callers can use either
mappings or class instances.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, List, Optional, TypedDict


class InferenceMessage(TypedDict, total=False):
    """A message in an inference conversation.

    Same shape as the TypeScript ``InferenceMessage`` (snake_case fields):

    * ``role``: ``"user" | "assistant" | "system" | "tool"``
    * ``content``: string body
    * ``tool_calls`` (optional): assistant-emitted structured tool calls
    * ``tool_call_id`` (optional): set when ``role == "tool"``
    """

    role: str
    content: str
    tool_calls: list[dict[str, Any]]
    tool_call_id: str


class ConversationMemory(ABC):
    """Per-session conversation history. Sub-class to add compaction or IO."""

    sessionId: str
    """Stable identifier — public attribute, mirrors the TS interface."""

    @abstractmethod
    async def add_message(self, msg: InferenceMessage) -> None:
        """Append a message. Implementations may compact afterwards."""

    @abstractmethod
    def get_context(self) -> List[InferenceMessage]:
        """Snapshot of messages to feed into the next inference call."""

    @abstractmethod
    async def reset(self) -> None:
        """Drop all messages and reset internal counters."""


class BasicConversationMemory(ConversationMemory):
    """Append-only message log with an optional max-message cap.

    Used when callers want the legacy unbounded history without paying the
    compaction setup cost (no model name, no ``compact_fn``, no log store).
    """

    def __init__(
        self,
        *,
        session_id: str = "__default__",
        max_messages: Optional[int] = None,
    ) -> None:
        self.sessionId = session_id
        self._max_messages = max_messages
        self._messages: list[InferenceMessage] = []

    async def add_message(self, msg: InferenceMessage) -> None:
        self._messages.append(dict(msg))  # defensive copy
        if self._max_messages is not None and len(self._messages) > self._max_messages:
            del self._messages[: len(self._messages) - self._max_messages]

    def get_context(self) -> List[InferenceMessage]:
        return [dict(m) for m in self._messages]

    async def reset(self) -> None:
        self._messages = []

    @property
    def length(self) -> int:
        """Test inspection — current message count."""
        return len(self._messages)
