"""``ConversationLogStore`` — JSONL-on-disk persistence for ``CompactionMemory``.

Mirror of the TypeScript runtime's conversation log store:

* :class:`InMemoryConversationLogStore` — test double, no IO.
* :class:`LocalConversationLogStore` — JSONL files under a fixed base
  directory. Filenames are SHA-256 hashes of the session id, so the disk
  layout is path-traversal-safe even if a caller pipes attacker-controlled
  input as the session id.

A sidecar ``_sessions.json`` keeps the human-readable ↔ hashed-filename map
so :meth:`list_sessions` can return original ids.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, List, Optional, TypedDict, Union

from .conversation_memory import InferenceMessage


class _MessageEntry(TypedDict):
    kind: str  # "message"
    ts: str
    msg: InferenceMessage


class _CompactionEntry(TypedDict):
    kind: str  # "compaction"
    ts: str
    compactionNumber: int
    replacedRange: list[int]
    messagesCompacted: int
    summary: str
    summaryTokens: int
    model: str


class _ResetEntry(TypedDict):
    kind: str  # "reset"
    ts: str


LogEntry = Union[_MessageEntry, _CompactionEntry, _ResetEntry]


class ConversationLogStore(ABC):
    """Abstract JSONL log per session id."""

    @abstractmethod
    async def append(self, session_id: str, entry: LogEntry) -> None:
        ...

    @abstractmethod
    async def exists(self, session_id: str) -> bool:
        ...

    @abstractmethod
    async def read(self, session_id: str) -> List[LogEntry]:
        ...

    @abstractmethod
    async def search_messages(
        self, session_id: str, query: str, max_results: int
    ) -> List[InferenceMessage]:
        ...

    @abstractmethod
    async def list_sessions(self) -> List[str]:
        ...

    @abstractmethod
    async def delete(self, session_id: str) -> None:
        ...


def _search_entries(
    entries: List[LogEntry], query: str, max_results: int
) -> List[InferenceMessage]:
    if not query:
        return []
    needle = query.lower()
    out: list[InferenceMessage] = []
    # Walk in reverse so the most recent matches come first.
    for entry in reversed(entries):
        if entry.get("kind") != "message":
            continue
        msg = entry.get("msg")  # type: ignore[index]
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str) and needle in content.lower():
            out.append(msg)  # type: ignore[arg-type]
            if len(out) >= max_results:
                break
    return out


class InMemoryConversationLogStore(ConversationLogStore):
    """In-process log store. Tests prefer this over disk for speed."""

    def __init__(self) -> None:
        self._logs: dict[str, list[LogEntry]] = {}

    async def append(self, session_id: str, entry: LogEntry) -> None:
        self._logs.setdefault(session_id, []).append(entry)

    async def exists(self, session_id: str) -> bool:
        return session_id in self._logs

    async def read(self, session_id: str) -> List[LogEntry]:
        return list(self._logs.get(session_id, []))

    async def search_messages(
        self, session_id: str, query: str, max_results: int
    ) -> List[InferenceMessage]:
        return _search_entries(await self.read(session_id), query, max_results)

    async def list_sessions(self) -> List[str]:
        return list(self._logs.keys())

    async def delete(self, session_id: str) -> None:
        self._logs.pop(session_id, None)


class LocalConversationLogStore(ConversationLogStore):
    """JSONL-on-disk log. One file per session, named by SHA-256 hash.

    **Concurrency.** Appends, deletes, and index writes on a single instance
    are serialized via ``self._lock`` — ten concurrent ``append()`` calls
    produce ten lines in call order with no interleaving. Concurrent writers
    across *processes* sharing the same ``base_dir`` remain unsafe; use
    distinct ``base_dir``s per process to avoid ``_sessions.json`` races.
    """

    def __init__(self, *, base_dir: Optional[Path] = None) -> None:
        if base_dir is None:
            base_dir = Path.home() / ".nookplot" / "conversations"
        self._base_dir: Path = Path(base_dir).resolve()
        self._index_loaded = False
        self._index: dict[str, str] = {}
        self._lock = asyncio.Lock()

    def _file_for(self, session_id: str) -> str:
        digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        return f"{digest[:32]}.jsonl"

    def _index_path(self) -> Path:
        return self._base_dir / "_sessions.json"

    async def _ensure_index_locked(self) -> None:
        """Caller must already hold ``self._lock``."""
        if self._index_loaded:
            return
        self._base_dir.mkdir(parents=True, exist_ok=True)
        try:
            raw = self._index_path().read_text(encoding="utf-8")
            obj = json.loads(raw)
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(k, str) and isinstance(v, str):
                        self._index[k] = v
        except FileNotFoundError:
            pass
        except json.JSONDecodeError:
            # Corrupted index — start fresh, will be overwritten on next persist.
            self._index = {}
        self._index_loaded = True

    async def _ensure_index(self) -> None:
        if self._index_loaded:
            return
        async with self._lock:
            await self._ensure_index_locked()

    async def _persist_index_locked(self) -> None:
        """Caller must already hold ``self._lock``."""
        self._base_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._index_path().with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._index, indent=2), encoding="utf-8")
        os.replace(tmp, self._index_path())

    async def _path_for_locked(self, session_id: str) -> Path:
        """Caller must already hold ``self._lock``."""
        await self._ensure_index_locked()
        if session_id not in self._index:
            self._index[session_id] = self._file_for(session_id)
            await self._persist_index_locked()
        return self._base_dir / self._index[session_id]

    async def append(self, session_id: str, entry: LogEntry) -> None:
        # Serialize against other append/delete calls on this instance so
        # concurrent awaits produce lines in call order with no interleaving.
        async with self._lock:
            path = await self._path_for_locked(session_id)
            self._base_dir.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry))
                f.write("\n")

    async def exists(self, session_id: str) -> bool:
        await self._ensure_index()
        if session_id not in self._index:
            return False
        return (self._base_dir / self._index[session_id]).exists()

    async def read(self, session_id: str) -> List[LogEntry]:
        await self._ensure_index()
        if session_id not in self._index:
            return []
        path = self._base_dir / self._index[session_id]
        if not path.exists():
            return []
        out: list[LogEntry] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    # Truncated tail or corrupted line — skip rather than crash.
                    continue
        return out

    async def search_messages(
        self, session_id: str, query: str, max_results: int
    ) -> List[InferenceMessage]:
        return _search_entries(await self.read(session_id), query, max_results)

    async def list_sessions(self) -> List[str]:
        await self._ensure_index()
        return list(self._index.keys())

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            await self._ensure_index_locked()
            fname = self._index.pop(session_id, None)
            if not fname:
                return
            try:
                (self._base_dir / fname).unlink()
            except FileNotFoundError:
                pass
            await self._persist_index_locked()

    async def _debug_list_files(self) -> List[str]:
        """Test helper — list every JSONL file currently on disk."""
        try:
            return [p.name for p in self._base_dir.iterdir() if p.suffix == ".jsonl"]
        except FileNotFoundError:
            return []
