"""``CompactionMemory`` — turn-boundary-aware conversation memory with optional
JSONL persistence.

Mirror of the TypeScript runtime's compaction memory. See the TypeScript
file for the full design rationale (Unit A/B/C boundaries, deferred
compaction, sanitize-before-store).
"""

from __future__ import annotations

import asyncio
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable, List, Mapping, Optional, TypedDict

from ..content_safety import sanitize_for_prompt
from ..hooks import HookRegistry, hooks as default_hooks
from .conversation_log_store import ConversationLogStore, LogEntry
from .conversation_memory import ConversationMemory, InferenceMessage
from .model_limits import (
    DEFAULT_COMPACTION_SYSTEM_PROMPT,
    ModelThreshold,
    estimate_tokens as default_estimate_tokens,
    get_model_threshold,
)


CompactFn = Callable[[List[InferenceMessage], str], Awaitable[str]]
"""Caller-supplied summarizer. We do NOT pin a model dependency."""


@dataclass
class CompactionConfig:
    """Configuration for :class:`CompactionMemory`."""

    model_name: str
    compact_fn: CompactFn
    safety_ratio: float = 0.8
    preserve_recent: Optional[int] = None
    system_prompt_preamble: Optional[str] = None
    store: Optional[ConversationLogStore] = None
    session_id: Optional[str] = None
    enable_memory_tools: bool = True
    hooks: Optional[HookRegistry] = None
    estimate_tokens: Optional[Callable[[Iterable[Mapping[str, object]]], int]] = None
    max_summary_chars: int = 2000


@dataclass
class CompactionStats:
    """Runtime-observable counters."""

    message_count: int
    pending_tool_calls: int
    compaction_count: int
    estimated_tokens: int


class MemoryToolDefinition(TypedDict):
    """LLM-facing tool definition produced by :meth:`CompactionMemory.build_tools`."""

    name: str
    description: str
    inputSchema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Awaitable[Any]]


_DEFAULT_SEARCH_LIMIT = 5
_MAX_SEARCH_LIMIT = 20


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CompactionMemory(ConversationMemory):
    """Turn-boundary-aware compacting memory."""

    def __init__(self, config: CompactionConfig) -> None:
        self.sessionId = config.session_id or str(uuid.uuid4())
        self._threshold: ModelThreshold = get_model_threshold(config.model_name)
        self._safety_ratio = config.safety_ratio
        self._preserve_recent = (
            config.preserve_recent
            if config.preserve_recent is not None
            else self._threshold.preserve_recent
        )
        self._preamble = (
            config.system_prompt_preamble
            if config.system_prompt_preamble is not None
            else DEFAULT_COMPACTION_SYSTEM_PROMPT
        )
        self._store = config.store
        self._hooks = config.hooks or default_hooks
        self._compact_fn = config.compact_fn
        self._estimate_tokens = config.estimate_tokens or default_estimate_tokens
        self._enable_memory_tools = config.enable_memory_tools
        self._max_summary_chars = config.max_summary_chars

        self._messages: list[InferenceMessage] = []
        self._unit_boundaries: list[int] = []
        self._pending_tool_calls = 0
        self._compaction_count = 0
        self._removed_from_head = 0
        self._compaction_lock = asyncio.Lock()

    # ── ConversationMemory ──────────────────────────────────

    async def add_message(self, msg: InferenceMessage) -> None:
        msg = dict(msg)  # defensive copy
        self._messages.append(msg)
        self._update_unit_state(msg)

        if self._store is not None:
            await self._store.append(
                self.sessionId,
                {"kind": "message", "ts": _now_iso(), "msg": msg},
            )

        if self._pending_tool_calls == 0 and self._should_compact():
            await self._run_compaction_once()

    def get_context(self) -> List[InferenceMessage]:
        return [dict(m) for m in self._messages]

    async def reset(self) -> None:
        self._messages = []
        self._unit_boundaries = []
        self._pending_tool_calls = 0
        self._compaction_count = 0
        self._removed_from_head = 0
        if self._store is not None:
            await self._store.append(self.sessionId, {"kind": "reset", "ts": _now_iso()})

    def stats(self) -> CompactionStats:
        return CompactionStats(
            message_count=len(self._messages),
            pending_tool_calls=self._pending_tool_calls,
            compaction_count=self._compaction_count,
            estimated_tokens=self._estimate_tokens(self._messages),
        )

    # ── Restore ─────────────────────────────────────────────

    @classmethod
    async def restore_from_log(
        cls,
        session_id: str,
        store: ConversationLogStore,
        config: CompactionConfig,
    ) -> "CompactionMemory":
        """Reconstruct a session from its persisted JSONL log."""
        # Materialize a fresh instance bound to the same session + store.
        cfg = CompactionConfig(
            model_name=config.model_name,
            compact_fn=config.compact_fn,
            safety_ratio=config.safety_ratio,
            preserve_recent=config.preserve_recent,
            system_prompt_preamble=config.system_prompt_preamble,
            store=store,
            session_id=session_id,
            enable_memory_tools=config.enable_memory_tools,
            hooks=config.hooks,
            estimate_tokens=config.estimate_tokens,
            max_summary_chars=config.max_summary_chars,
        )
        memory = cls(cfg)
        if not await store.exists(session_id):
            return memory

        for entry in await store.read(session_id):
            kind = entry.get("kind")
            if kind == "reset":
                memory._messages = []
                memory._compaction_count = 0
                memory._removed_from_head = 0
            elif kind == "message":
                msg = entry.get("msg")  # type: ignore[index]
                if isinstance(msg, dict):
                    memory._messages.append(msg)  # type: ignore[arg-type]
            elif kind == "compaction":
                drop = min(int(entry["messagesCompacted"]), len(memory._messages))  # type: ignore[index]
                tail = memory._messages[drop:]
                memory._messages = [
                    {"role": "system", "content": f"[Conversation Summary]\n{entry['summary']}"}  # type: ignore[index]
                ] + tail
                memory._compaction_count = int(entry["compactionNumber"])  # type: ignore[index]
                memory._removed_from_head = int(entry["replacedRange"][1])  # type: ignore[index]

        memory._replay_unit_state()
        return memory

    # ── Tool exposure (agent-internal) ──────────────────────

    def build_tools(self) -> List[MemoryToolDefinition]:
        """Tool definitions the agent can call to recover summarized detail.

        The session id is captured in the closure — the LLM never supplies it.
        Returns ``[]`` when ``enable_memory_tools=False`` or no store is set.
        """
        if not self._enable_memory_tools or self._store is None:
            return []
        store = self._store
        session_id = self.sessionId

        async def _search(args: dict[str, Any]) -> List[InferenceMessage]:
            query = args.get("query")
            if not isinstance(query, str):
                query = ""
            cap_raw = args.get("maxResults", _DEFAULT_SEARCH_LIMIT)
            try:
                cap = int(cap_raw)
            except (TypeError, ValueError):
                cap = _DEFAULT_SEARCH_LIMIT
            if cap < 1:
                cap = _DEFAULT_SEARCH_LIMIT
            if cap > _MAX_SEARCH_LIMIT:
                cap = _MAX_SEARCH_LIMIT
            # session_id is closure-captured. Any sessionId in args is ignored.
            return await store.search_messages(session_id, query, cap)

        async def _read(args: dict[str, Any]) -> dict[str, Any]:
            num_raw = args.get("compactionNumber", 0)
            try:
                num = int(num_raw)
            except (TypeError, ValueError):
                raise ValueError("compactionNumber must be a positive integer")
            if num < 1:
                raise ValueError("compactionNumber must be a positive integer")
            entries = await store.read(session_id)
            for entry in entries:
                if (
                    entry.get("kind") == "compaction"
                    and int(entry.get("compactionNumber", 0)) == num  # type: ignore[index]
                ):
                    return entry  # type: ignore[return-value]
            raise ValueError(f"compaction {num} not found for session")

        return [
            {
                "name": "search_conversation_log",
                "description": (
                    "Substring search across the current conversation's archived "
                    "messages (including those collapsed by an earlier summary). "
                    "Returns the most recent matches first."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Substring to look for (case-insensitive)."},
                        "maxResults": {"type": "number", "description": "Cap on returned matches (default 5, max 20)."},
                    },
                    "required": ["query"],
                },
                "handler": _search,
            },
            {
                "name": "read_compaction_summary",
                "description": (
                    "Return the summary text produced by a past compaction of the "
                    "current session, by 1-indexed compaction number."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "compactionNumber": {
                            "type": "number",
                            "description": "1-indexed; matches stats.compaction_count.",
                        },
                    },
                    "required": ["compactionNumber"],
                },
                "handler": _read,
            },
        ]

    # ── Internals ───────────────────────────────────────────

    def _update_unit_state(self, msg: InferenceMessage) -> None:
        idx = len(self._messages)  # index AFTER the just-pushed msg
        role = msg.get("role")
        if role == "assistant":
            calls = msg.get("tool_calls") or []
            if isinstance(calls, list) and len(calls) > 0:
                self._pending_tool_calls += len(calls)
            else:
                self._unit_boundaries.append(idx)
        elif role == "tool":
            self._pending_tool_calls = max(0, self._pending_tool_calls - 1)
            if self._pending_tool_calls == 0:
                self._unit_boundaries.append(idx)
        elif role == "user":
            self._unit_boundaries.append(idx)
        # role == "system" never closes a unit.

    def _should_compact(self) -> bool:
        trigger_at = math.floor(self._threshold.compact_at * self._safety_ratio)
        return self._estimate_tokens(self._messages) >= trigger_at

    async def _run_compaction_once(self) -> None:
        async with self._compaction_lock:
            await self._auto_compact()

    async def _auto_compact(self) -> None:
        tail_reserve = self._preserve_recent
        if len(self._messages) <= tail_reserve + 1:
            return

        cutoff_max = len(self._messages) - tail_reserve
        boundary = -1
        for b in self._unit_boundaries:
            if b <= cutoff_max and b > boundary:
                boundary = b
        if boundary <= 0:
            return

        if boundary == 1 and self._messages[0].get("role") == "system":
            return

        to_compact = self._messages[:boundary]
        tail = self._messages[boundary:]

        try:
            summary = await self._compact_fn(to_compact, self._preamble)
        except Exception as exc:
            # Compaction failure is non-fatal — try again next addMessage.
            # Emit ``compaction_failed`` so operators can alert on a downed
            # summarizer instead of silently watching context grow unbounded.
            self._hooks.emit_fire_and_forget(
                "compaction_failed",
                {
                    "sessionId": self.sessionId,
                    "error": exc,
                    "attemptedMessages": len(to_compact),
                },
            )
            return

        sanitized = sanitize_for_prompt(summary, self._max_summary_chars)
        summary_message: InferenceMessage = {
            "role": "system",
            "content": f"[Conversation Summary]\n{sanitized}",
        }

        replaced_from = self._removed_from_head
        replaced_to = self._removed_from_head + boundary
        messages_compacted = boundary
        summary_tokens = math.ceil(len(sanitized) / 4)

        self._compaction_count += 1
        self._messages = [summary_message] + tail
        self._removed_from_head += boundary
        self._replay_unit_state()

        if self._store is not None:
            await self._store.append(
                self.sessionId,
                {
                    "kind": "compaction",
                    "ts": _now_iso(),
                    "compactionNumber": self._compaction_count,
                    "replacedRange": [replaced_from, replaced_to],
                    "messagesCompacted": messages_compacted,
                    "summary": sanitized,
                    "summaryTokens": summary_tokens,
                    "model": "n/a",
                },
            )

        self._hooks.emit_fire_and_forget(
            "memory_compacted",
            {
                "sessionId": self.sessionId,
                "compactionNumber": self._compaction_count,
                "messagesCompacted": messages_compacted,
                "summaryTokens": summary_tokens,
            },
        )

    def _replay_unit_state(self) -> None:
        self._unit_boundaries = []
        self._pending_tool_calls = 0
        for i, m in enumerate(self._messages):
            idx_after = i + 1
            role = m.get("role")
            if role == "assistant":
                calls = m.get("tool_calls") or []
                if isinstance(calls, list) and len(calls) > 0:
                    self._pending_tool_calls += len(calls)
                else:
                    self._unit_boundaries.append(idx_after)
            elif role == "tool":
                self._pending_tool_calls = max(0, self._pending_tool_calls - 1)
                if self._pending_tool_calls == 0:
                    self._unit_boundaries.append(idx_after)
            elif role == "user":
                self._unit_boundaries.append(idx_after)
