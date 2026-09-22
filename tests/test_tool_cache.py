"""Tests for assistant.tool_cache — the TTL cache backing mcp_tools.py's
read-only response caching (STEPS.md 151)."""

from __future__ import annotations

import time

from assistant.tool_cache import MISSING, TTLCache


def test_miss_on_empty_cache():
    cache = TTLCache(ttl_seconds=60)
    assert cache.get({"a": 1}) is MISSING


def test_hit_returns_the_cached_value():
    cache = TTLCache(ttl_seconds=60)
    cache.set({"tool": "x", "args": {"q": "hi"}}, "result-1")
    assert cache.get({"tool": "x", "args": {"q": "hi"}}) == "result-1"


def test_key_order_does_not_matter():
    """A dict with keys in a different order must still hit the same
    entry — sort_keys=True in the underlying JSON serialization."""
    cache = TTLCache(ttl_seconds=60)
    cache.set({"a": 1, "b": 2}, "result")
    assert cache.get({"b": 2, "a": 1}) == "result"


def test_different_keys_do_not_collide():
    cache = TTLCache(ttl_seconds=60)
    cache.set({"q": "a"}, "result-a")
    cache.set({"q": "b"}, "result-b")
    assert cache.get({"q": "a"}) == "result-a"
    assert cache.get({"q": "b"}) == "result-b"


def test_entry_expires_after_ttl():
    cache = TTLCache(ttl_seconds=0.05)
    cache.set({"q": "a"}, "result")
    assert cache.get({"q": "a"}) == "result"
    time.sleep(0.1)
    assert cache.get({"q": "a"}) is MISSING


def test_none_is_a_legitimate_cached_value_not_a_miss():
    cache = TTLCache(ttl_seconds=60)
    cache.set({"q": "a"}, None)
    assert cache.get({"q": "a"}) is None


def test_clear_removes_all_entries():
    cache = TTLCache(ttl_seconds=60)
    cache.set({"q": "a"}, "result")
    cache.clear()
    assert cache.get({"q": "a"}) is MISSING
