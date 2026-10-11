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
active trace id when one exists — read from the ambient OpenTelemetry span,
see `_TraceIdFilter`), and both a stderr stream and a
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
import threading
from pathlib import Path

from opentelemetry import trace

_LOG_DIR = Path.home() / "Library" / "Logs" / "PersonalAssistant"
_LOG_FILE = _LOG_DIR / "oni-backend.log"
_configured = False

# Per thread: True while a _TraceIdFilter is running its lookup on this thread
# (see the filter's docstring). Module-level rather than per filter instance, so
# the guard holds even if a second filter is ever attached.
_lookup_running = threading.local()


class _TraceIdFilter(logging.Filter):
    """Injects the active trace id (if any) into every record, so a log line
    can be correlated with its Langfuse trace without threading request
    context through every call site by hand. "-" when there is none.

    **Reads the ambient OpenTelemetry span directly and NEVER calls the
    Langfuse client** — `get_client().get_current_trace_id()` is what this used
    to do, on the belief that it was "a cheap ambient-OTEL-context read ...
    safe to call on every single log line". It reads that context, but it is not
    safe: outside a span it LOGS a warning ("Context error: No active span in
    current context", `langfuse/_client/client.py`'s `_get_current_otel_span`)
    through the `langfuse` logger, which propagates to the root handlers this
    filter sits on — so the warning came straight back through the filter, which
    asked again, and so on. Reproduced after a test run hung: ONE
    `logging.getLogger("assistant.write_tools").warning(...)` outside a span, with
    only the file handler attached, wrote 110 of those lines and ended in a
    RecursionError (swallowed by the old filter's `except Exception`); with both
    handlers attached, as `configure_logging` does in the live server, every
    level of the recursion doubles, which is a hang that fills the rotating log.
    The live backend was spared only because its project loggers rarely speak
    outside a traced request.

    Reading OTEL yields the same id with none of that: Langfuse v3's
    `get_current_trace_id()` is `opentelemetry.trace.get_current_span()` followed
    by `format(span_context.trace_id, "032x")` (checked against the installed SDK
    source, and by `tests/test_logging_trace_id.py` against a real client), and a
    span Langfuse starts is the current OTEL span. One difference, deliberately:
    this stamps the id of ANY active OTEL span, whether or not a Langfuse client
    is configured or tracing is enabled.

    Belt and braces: `_lookup_running` is a per-thread re-entrancy guard, so a
    record logged while this filter is mid-lookup — by a library, whatever it
    does — gets "-" and no lookup of its own. Recursion through this filter is
    impossible by construction, not just by the current lookup happening to be
    silent.

    Best-effort: no active span, or anything raising during the lookup, resolves
    to "-" — logging itself must never be why a request fails."""

    def filter(self, record: logging.LogRecord) -> bool:
        trace_id = "-"
        if not getattr(_lookup_running, "active", False):
            _lookup_running.active = True
            try:
                context = trace.get_current_span().get_span_context()
                if context.is_valid:
                    trace_id = format(context.trace_id, "032x")
            except Exception:
                pass
            finally:
                _lookup_running.active = False
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
