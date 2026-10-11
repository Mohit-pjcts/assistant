"""Tests for the log trace-id filter after its feedback-loop fix
(`assistant/logging_config.py`'s `_TraceIdFilter`).

**The incident.** The filter used to ask the Langfuse client for the current
trace id on every log record. Outside a span `get_current_trace_id()` itself
LOGS a warning ("Context error: No active span in current context") through a
logger that propagates to the root handlers the filter sits on, so the warning
came back through the filter, which asked again. One warning outside a span
wrote 110 lines and ended in a RecursionError with one handler attached; the
live server attaches two (stderr stream + rotating file), so every level
doubled — a hang. A test run did hang, for ten minutes, flooding the real
backend log.

**What these tests pin down**
- The filter never calls the Langfuse client, and a warning outside any span is
  exactly one line, promptly, with BOTH handlers. The real-SDK reproduction runs
  in a throwaway child process: building a real client sets the process-global
  OTEL provider and starts threads (not something to do in the shared pytest
  process), and a regression must fail fast, not hang this run.
- Inside an active OTEL span the line carries that span's trace id as 32 hex
  digits — which is what Langfuse's own `get_current_trace_id()` returns there.
- The re-entrancy guard holds, is per thread, and is always released.

Offline: nothing leaves this machine (the child's Langfuse client points at a
dead local port) and nothing is written to the real log (every test redirects
`_LOG_DIR`).
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

import assistant.logging_config as logging_config
from assistant import observability

REPO_ROOT = Path(__file__).resolve().parents[1]
HEX_32 = re.compile(r"[0-9a-f]{32}")


@pytest.fixture()
def both_handlers(tmp_path, monkeypatch):
    """`configure_logging()` exactly as the live server runs it — the stderr
    stream AND the rotating file on the root logger — against a temp directory.
    Yields the log file's path; puts the root logger back afterwards."""
    log_file = tmp_path / "oni-backend.log"
    monkeypatch.setattr(logging_config, "_LOG_DIR", tmp_path)
    monkeypatch.setattr(logging_config, "_LOG_FILE", log_file)
    monkeypatch.setattr(logging_config, "_configured", False)
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    for handler in saved_handlers:
        root.removeHandler(handler)
    logging_config.configure_logging("test")
    assert len(root.handlers) == 2  # the stream and the file: the shape that doubled the loop
    try:
        yield log_file
    finally:
        for handler in list(root.handlers):
            root.removeHandler(handler)
            handler.close()
        for handler in saved_handlers:
            root.addHandler(handler)
        root.setLevel(saved_level)


def written(log_file: Path) -> list[str]:
    for handler in logging.getLogger().handlers:
        handler.flush()
    return log_file.read_text().splitlines() if log_file.exists() else []


# --- a warning outside any span: one line, promptly, no Langfuse call ---------------


class ChattyLangfuse:
    """Stands in for the Langfuse client with its real misbehavior: outside a
    span, `get_current_trace_id()` logs a warning through the `langfuse` logger.
    Capped, so a regression fails the assertions below instead of hanging the
    run."""

    CAP = 40

    def __init__(self) -> None:
        self.calls = 0

    def get_current_trace_id(self) -> None:
        self.calls += 1
        if self.calls <= self.CAP:
            logging.getLogger("langfuse").warning(
                "Context error: No active span in current context. Operations that "
                "depend on an active span will be skipped."
            )


def test_one_warning_outside_any_span_is_exactly_one_line_with_both_handlers(
    both_handlers, monkeypatch
):
    client = ChattyLangfuse()
    # Wherever a re-introduced lookup might fetch the client from.
    monkeypatch.setattr(observability, "get_client", lambda: client)
    monkeypatch.setattr(logging_config, "get_client", lambda: client, raising=False)

    started = time.monotonic()
    logging.getLogger("assistant.write_tools").warning("MCP tools not found")
    elapsed = time.monotonic() - started

    assert client.calls == 0, "the log filter must never call the Langfuse client"
    lines = written(both_handlers)
    assert len(lines) == 1, lines
    assert lines[0].endswith("MCP tools not found")
    assert " trace=- " in lines[0]
    assert elapsed < 2


# The incident, with the real SDK: a real Langfuse client (dummy keys; nothing is
# listening at the address, so nothing can leave this machine), both handlers,
# one warning outside a span. Run in a child process: see the module docstring.
CHILD = textwrap.dedent(
    """
    import json, logging, os, sys, time
    from pathlib import Path

    log_dir = Path(sys.argv[1])
    import assistant.logging_config as logging_config

    logging_config._LOG_DIR = log_dir
    logging_config._LOG_FILE = log_dir / "oni-backend.log"

    from assistant import observability

    client = observability.get_client()
    assert client is not None, "the dummy-key Langfuse client was not built"

    # The premise: outside a span the real SDK logs this warning. Counted by a
    # handler on the `langfuse` logger alone, before any of this project's
    # logging is set up.
    class Count(logging.Handler):
        n = 0

        def emit(self, record):
            type(self).n += "Context error" in record.getMessage()

    sdk_logger = logging.getLogger("langfuse")
    probe = Count()
    sdk_logger.addHandler(probe)
    assert client.get_current_trace_id() is None
    sdk_logger.removeHandler(probe)

    logging_config.configure_logging("child")  # both handlers, as in the live server
    # Both stay installed (the filter runs once per handler, which is what doubled the
    # loop); the stream one just writes to /dev/null, so a regression can't flood the
    # parent's memory while it waits to time out. The file handler is bounded by rotation.
    for handler in logging.getLogger().handlers:
        if type(handler) is logging.StreamHandler:
            handler.setStream(open(os.devnull, "w"))

    started = time.monotonic()
    logging.getLogger("assistant.write_tools").warning("outside any span")
    elapsed = time.monotonic() - started

    with client.start_as_current_span(name="regression-probe"):
        expected = client.get_current_trace_id()
        logging.getLogger("assistant.write_tools").warning("inside a span")

    for handler in logging.getLogger().handlers:
        handler.flush()
    lines = (log_dir / "oni-backend.log").read_text().splitlines()
    print(json.dumps({"premise": Count.n, "expected": expected, "elapsed": elapsed, "lines": lines}))
    sys.stdout.flush()
    os._exit(0)  # skip the SDK's atexit flush: there is nothing to send, and nowhere to send it
    """
)


def test_the_incident_does_not_recur_with_a_real_langfuse_client(tmp_path):
    env = {
        **os.environ,
        "PYTHONPATH": str(REPO_ROOT),
        "LANGFUSE_PUBLIC_KEY": "pk-lf-regression-test",
        "LANGFUSE_SECRET_KEY": "sk-lf-regression-test",
        "LANGFUSE_HOST": "http://127.0.0.1:9",
        "LANGFUSE_BASE_URL": "http://127.0.0.1:9",
        "LANGFUSE_TRACING_ENABLED": "true",
    }
    env.pop("OTEL_SDK_DISABLED", None)
    try:
        done = subprocess.run(
            [sys.executable, "-c", CHILD, str(tmp_path)],
            env=env,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,  # the child takes about a second; a hang is a regression
        )
    except subprocess.TimeoutExpired:
        pytest.fail("the child process hung: the log filter is feeding back on itself again")
    assert done.returncode == 0, done.stderr[-3000:]
    report = json.loads(done.stdout.strip().splitlines()[-1])

    if report["premise"] != 1:
        pytest.skip(
            "the installed Langfuse no longer logs a warning outside a span, so this "
            "cannot reproduce the incident; the in-process tests still guard the filter"
        )
    lines = report["lines"]
    assert not any("Context error" in line for line in lines), lines
    outside = [line for line in lines if line.endswith("outside any span")]
    assert len(outside) == 1 and " trace=- " in outside[0], lines
    assert report["elapsed"] < 5
    # Inside a real Langfuse span the line carries exactly the id the SDK reports.
    assert HEX_32.fullmatch(report["expected"]), report["expected"]
    inside = [line for line in lines if line.endswith("inside a span")]
    assert len(inside) == 1 and f" trace={report['expected']} " in inside[0], lines


# --- inside an active span ---------------------------------------------------------------


def test_inside_an_otel_span_the_line_carries_the_trace_id_as_32_hex(both_handlers):
    provider = TracerProvider()  # the OTEL SDK with no exporter: nothing is sent anywhere
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("work") as span:
        logging.getLogger("assistant.test").warning("inside")
        expected = format(span.get_span_context().trace_id, "032x")
    logging.getLogger("assistant.test").warning("after")

    assert HEX_32.fullmatch(expected)
    inside, after = written(both_handlers)
    assert inside.endswith("inside") and f" trace={expected} " in inside
    assert after.endswith("after") and " trace=- " in after  # the span ended: no stale id


def test_a_nested_span_keeps_the_traces_id(both_handlers):
    provider = TracerProvider()
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("outer") as outer, tracer.start_as_current_span("inner"):
        logging.getLogger("assistant.test").warning("deep inside")
        expected = format(outer.get_span_context().trace_id, "032x")
    [line] = written(both_handlers)
    assert f" trace={expected} " in line


# --- the re-entrancy guard ---------------------------------------------------------------


class Recorder(logging.Handler):
    """Records (message, trace id) of every record that reaches it."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[tuple[str, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.seen.append((record.getMessage(), record.trace_id))


@pytest.fixture()
def wired():
    """A private logger with TWO handlers sharing one real `_TraceIdFilter` — the
    shape `configure_logging` builds — each recording what reaches it."""
    logger = logging.getLogger("oni.test.reentrancy")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    shared = logging_config._TraceIdFilter()
    handlers = [Recorder(), Recorder()]
    for handler in handlers:
        handler.addFilter(shared)
        logger.addHandler(handler)
    yield logger, handlers
    for handler in handlers:
        logger.removeHandler(handler)


def span_with(trace_id: int) -> NonRecordingSpan:
    return NonRecordingSpan(
        SpanContext(
            trace_id=trace_id,
            span_id=1,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
    )


def lookup_returning(get_current_span):
    """Swaps the OTEL module the filter reads for a stand-in, for one test."""
    return SimpleNamespace(get_current_span=get_current_span)


def test_a_record_logged_while_the_lookup_runs_gets_a_dash_and_no_lookup_of_its_own(
    wired, monkeypatch
):
    logger, handlers = wired
    lookups: list[int] = []

    def chatty_lookup():
        lookups.append(1)
        if len(lookups) <= 40:  # capped: a missing guard fails the asserts, not the run
            logger.warning("chatter %d", len(lookups))
        return span_with(0xABC)

    monkeypatch.setattr(logging_config, "trace", lookup_returning(chatty_lookup))
    logger.warning("the original record")

    assert len(lookups) == 2  # once per handler for the original; none for the chatter
    for handler in handlers:
        assert dict(handler.seen) == {
            "the original record": format(0xABC, "032x"),
            "chatter 1": "-",
            "chatter 2": "-",
        }
        assert len(handler.seen) == 3  # nothing cascaded


def test_the_guard_is_released_even_when_the_lookup_raises(wired, monkeypatch):
    logger, (first, _) = wired

    def broken():
        raise RuntimeError("boom")

    monkeypatch.setattr(logging_config, "trace", lookup_returning(broken))
    logger.warning("the lookup fails")
    assert first.seen == [("the lookup fails", "-")]  # and the record still got through

    monkeypatch.setattr(logging_config, "trace", lookup_returning(lambda: span_with(0xBEEF)))
    logger.warning("the lookup works again")
    assert first.seen[-1] == ("the lookup works again", format(0xBEEF, "032x"))


def test_the_guard_is_per_thread(wired, monkeypatch):
    """A record logged on ANOTHER thread while one thread is mid-lookup must
    still get its own lookup: a flag shared across threads would hand it "-"."""
    logger, (first, _) = wired
    worker_id: list[int] = []
    parked, release = threading.Event(), threading.Event()

    def lookup():
        if threading.get_ident() == worker_id[0]:
            parked.set()  # this thread is now INSIDE the filter, holding its guard
            assert release.wait(10)
            return otel_trace.INVALID_SPAN
        return span_with(0xABC)

    monkeypatch.setattr(logging_config, "trace", lookup_returning(lookup))

    def work():
        worker_id.append(threading.get_ident())
        logger.warning("worker record")

    worker = threading.Thread(target=work)
    worker.start()
    try:
        assert parked.wait(10), "the worker never reached the lookup"
        logger.warning("main record")
    finally:
        release.set()
        worker.join(10)

    assert not worker.is_alive()
    assert dict(first.seen) == {
        "main record": format(0xABC, "032x"),  # a lookup of its own, despite the worker's guard
        "worker record": "-",  # INVALID_SPAN
    }


# --- the filter's own contract -----------------------------------------------------------


def test_the_filter_never_raises_and_keeps_the_record(monkeypatch):
    class Odd:
        """A span whose context lookup blows up in a way no OTEL version should."""

        def get_span_context(self):
            raise AttributeError("no context")

    monkeypatch.setattr(logging_config, "trace", lookup_returning(Odd))
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "msg", None, None)
    assert logging_config._TraceIdFilter().filter(record) is True
    assert record.trace_id == "-"
