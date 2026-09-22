"""App-level structured logging — found missing during an architecture
audit (STEPS.md 151), not a design choice being revisited. `observability.
py`/`prompts.py`/`write_tools.py` already used the standard `logging.
getLogger(__name__)` pattern, but nothing ever configured a root handler —
Python's default root level is WARNING, so every INFO/DEBUG call from those
modules was silently dropped, and even WARNING/ERROR only reached the bare
`logging.lastResort` stderr handler: no timestamp, no file destination, no
way to tie a line back to the Langfuse trace it happened during. Most of
what actually reached a human was scattered `print()` calls instead
(server.py's nightly memory-review job is the clearest example — a failure
there only ever reached stdout, with nothing to correlate it against the
Langfuse trace for that run).

This module closes exactly that gap: one `configure_logging()` call at
process startup, a real formatter (timestamp, level, logger name, the
active Langfuse trace id when one exists), and both a stderr stream and a
file destination — `~/Library/Logs/PersonalAssistant/oni-backend.log`,
the same directory the dev launcher's own shell-redirected `oni-dev.log`
already uses (STEPS.md 123), so a human debugging this Mac has one place
to look rather than two conventions. Deliberately does NOT touch existing
`print()` call sites — swapping every print for a logger call is a
separate, larger mechanical pass; this lands the infrastructure plus the
highest-value call sites (unattended/background work with no other
visibility) first.
"""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

from assistant.observability import get_client

_LOG_DIR = Path.home() / "Library" / "Logs" / "PersonalAssistant"
_LOG_FILE = _LOG_DIR / "oni-backend.log"
_configured = False


class _TraceIdFilter(logging.Filter):
    """Injects the active Langfuse trace id (if any) into every record, so
    a log line can be correlated with its Langfuse trace without threading
    request context through every call site by hand. `get_current_trace_id()`
    is a cheap ambient-OTEL-context read (verified against the installed
    SDK source, not assumed) — safe to call on every single log line.
    Best-effort: a missing/misconfigured Langfuse client or no active span
    both resolve to the literal string "-" rather than raising — logging
    itself must never be why a request fails."""

    def filter(self, record: logging.LogRecord) -> bool:
        trace_id = "-"
        try:
            client = get_client()
            if client is not None:
                current = client.get_current_trace_id()
                if current:
                    trace_id = current
        except Exception:
            pass
        record.trace_id = trace_id
        return True


def configure_logging(name: str) -> None:
    """Call once per process at startup (main.py/server.py) — same
    one-call-per-entry-point convention as observability.configure_client().
    `name` identifies which entry point this is ("cli"/"dashboard"), folded
    into every line's format so a shared log file stays attributable when
    multiple processes append to it concurrently.

    Idempotent: a second call (e.g. `--reload`'s dev-server re-exec) is a
    silent no-op rather than piling up duplicate handlers on every reload,
    which would otherwise print every line N times after N reloads."""
    global _configured
    if _configured:
        return
    _configured = True

    _LOG_DIR.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(
        f"%(asctime)s [{name}] %(levelname)s %(name)s trace=%(trace_id)s %(message)s"
    )
    trace_filter = _TraceIdFilter()

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    stream_handler.addFilter(trace_filter)

    # 5MB x 3 backups — small, personal-single-user volume; this is meant
    # to survive long enough to debug a recent incident, not serve as a
    # permanent audit trail (Langfuse/LangSmith already own that).
    file_handler = logging.handlers.RotatingFileHandler(
        _LOG_FILE, maxBytes=5_000_000, backupCount=3
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(trace_filter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(stream_handler)
    root.addHandler(file_handler)
