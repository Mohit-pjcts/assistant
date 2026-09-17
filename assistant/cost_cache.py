"""Durable last-known-good fallback for `/cost` (server.py).

Langfuse's own metrics API rate-limits at 100 requests/window, and a real
live stretch (2026-08-08/09) burned through it. The user's own direct
ask, after an earlier version of this fix still just showed a bare error:
never do that — show the last real numbers this backend actually read
for each window, say how stale they are, and say how long until the
limit clears. A plain in-process module variable would lose all of this
on every backend restart (which the `--reload` watcher triggers
constantly during dev, and did during this same fix's own build — see
server.py's `/cost` docstring); this persists to a small JSON file
instead, so a request seconds after a restart still has real history to
fall back on.

Deliberately a flat JSON file, not a new SQLite store (thread_store.py's/
board_store.py's own pattern) — this holds exactly one small object
(three window snapshots plus one rate-limit record), is never queried by
anything but this module, and never grows.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_CACHE_PATH = Path(__file__).resolve().parent.parent / "cost_cache.json"


def _load() -> dict[str, Any]:
    try:
        return json.loads(_CACHE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save(data: dict[str, Any]) -> None:
    """Write-to-temp-then-`os.replace()` instead of a direct write — fixes
    real corruption risk (a crash mid-write leaving a truncated,
    unparseable file that then fails every future `_load()`, silently
    losing all cached history) since `os.replace()` is atomic on the same
    filesystem. Does NOT fix the separate lost-update race between two
    concurrent `_save()` calls (both can still read the same old data,
    mutate independently, and whichever `os.replace()` lands second wins,
    silently dropping the first's update) — left as-is, consistent with
    this module's own best-effort framing (see module docstring); full
    locking was judged not worth it for a file this small and low-stakes."""
    try:
        fd, tmp_path = tempfile.mkstemp(dir=_CACHE_PATH.parent, prefix=".cost_cache_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(data))
            os.replace(tmp_path, _CACHE_PATH)
        except OSError:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except OSError:
        pass  # best-effort — a failed write only costs the NEXT fallback, not this request


def save_window(window_key: str, row: dict[str, Any]) -> str:
    """Persist a successfully-read window's raw Langfuse row. Returns the
    ISO `read_at` stamp stored alongside it. Also clears any standing
    rate-limit record — Langfuse's limit is account-wide, not per-window,
    so one successful call proves the account isn't limited anymore."""
    data = _load()
    windows = data.setdefault("windows", {})
    read_at = datetime.now(UTC).isoformat()
    windows[window_key] = {"row": row, "read_at": read_at}
    data["rate_limit"] = None
    _save(data)
    return read_at


def get_window(window_key: str) -> dict[str, Any] | None:
    return _load().get("windows", {}).get(window_key)


def get_rate_limit() -> dict[str, Any] | None:
    return _load().get("rate_limit")


def save_rate_limit(message: str, retry_after_seconds: int | None, reset_at: str | None) -> None:
    data = _load()
    data["rate_limit"] = {
        "message": message,
        "retry_after_seconds": retry_after_seconds,
        "reset_at": reset_at,
    }
    _save(data)


def rate_limit_active(rate_limit: dict[str, Any] | None) -> bool:
    """True while `rate_limit`'s own `reset_at` hasn't passed yet — lets
    `/cost` skip calling Langfuse again inside a KNOWN cooldown instead of
    spending another request just to get the same 429 back."""
    if not rate_limit or not rate_limit.get("reset_at"):
        return False
    try:
        reset_at = datetime.fromisoformat(str(rate_limit["reset_at"]).replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(UTC) < reset_at
