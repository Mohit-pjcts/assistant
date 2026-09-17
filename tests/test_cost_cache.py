"""Tests for assistant.cost_cache — the durable last-known-good fallback
for /cost under a Langfuse rate limit. Minimal coverage: one test for the
atomic-write corruption fix, not a full round-trip battery (the module is
simple enough to verify by inspection otherwise).
"""

from pathlib import Path

import assistant.cost_cache as cost_cache


def test_load_fails_soft_on_a_corrupted_cache_file(monkeypatch, tmp_path: Path) -> None:
    """The actual scenario the atomic-write fix targets: a truncated/
    unparseable file (e.g. from a crash mid-write) must not raise — it
    should fail soft to an empty dict, same as a missing file."""
    cache_path = tmp_path / "cost_cache.json"
    cache_path.write_text("{not valid json")
    monkeypatch.setattr(cost_cache, "_CACHE_PATH", cache_path)

    assert cost_cache._load() == {}


if __name__ == "__main__":
    import tempfile

    class _FakeMonkeypatch:
        def setattr(self, obj, name, value):
            setattr(obj, name, value)

    with tempfile.TemporaryDirectory() as tmp:
        test_load_fails_soft_on_a_corrupted_cache_file(_FakeMonkeypatch(), Path(tmp))
    print("OK: test_load_fails_soft_on_a_corrupted_cache_file")
