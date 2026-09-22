"""A small in-memory TTL cache for read-only external tool calls — one of
the items scoped from a reliability/orchestration backlog audit (STEPS.md
151). Prompt caching (`AnthropicPromptCachingMiddleware`, wired in
2026-08-04) already closes the big line-item this kind of caching usually
targets — re-prefilling the system prompt on every call — so this is
narrower: it saves real wall-clock latency and real external API quota
(Gmail/Calendar's own rate limits) on a genuinely repeated identical
read within a short window, e.g. "what's on my calendar today" asked
twice in the same conversation, or a specialist re-reading the same inbox
search after a handoff.

Deliberately a plain in-memory dict, not a persistent store: the value
being cached (an email search result, a calendar listing) goes stale on
its own within minutes regardless of process lifetime, so there is no
reason to survive a restart — a fresh, empty cache on every process start
is the correct behavior, not a gap.

Not thread-safe by design — this project's tool-calling path is a single
asyncio event loop (never multiple OS threads touching this cache
concurrently), matching every other piece of in-memory state in this
codebase (e.g. `active_turns.py`'s own registry).
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

_MISSING = object()


class TTLCache:
    """A tiny cache: `key -> (expires_at, value)`. `key` must be a plain,
    JSON-serializable structure (a tool name + its args dict is the
    intended shape) — hashed internally so callers never have to worry
    about dict key ordering or hashability themselves."""

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl_seconds = ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}

    @staticmethod
    def _hash_key(key: Any) -> str:
        # sort_keys=True so argument-order differences (which don't change
        # the actual request) still hit the same cache entry.
        serialized = json.dumps(key, sort_keys=True, default=str)
        return hashlib.sha256(serialized.encode()).hexdigest()

    def get(self, key: Any) -> Any:
        """Returns the cached value, or the sentinel `_MISSING` (importable
        as `tool_cache.MISSING`) if there's no live entry — never `None`,
        since a cached call could legitimately have returned `None`."""
        hashed = self._hash_key(key)
        entry = self._store.get(hashed)
        if entry is None:
            return _MISSING
        expires_at, value = entry
        if time.monotonic() >= expires_at:
            del self._store[hashed]
            return _MISSING
        return value

    def set(self, key: Any, value: Any) -> None:
        hashed = self._hash_key(key)
        self._store[hashed] = (time.monotonic() + self._ttl_seconds, value)

    def clear(self) -> None:
        """Test-only escape hatch — production code never needs to clear
        this early, entries just expire on their own."""
        self._store.clear()


MISSING = _MISSING
