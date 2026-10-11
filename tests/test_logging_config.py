"""Tests for assistant.logging_config — the app-level structured logging
gap found during the reliability/orchestration backlog audit (STEPS.md
151). Covers the two real, non-obvious behaviors: idempotent configuration
(no duplicate handlers piling up across repeated calls, e.g. --reload) and
the trace-id filter's fail-soft behavior (a dash with no active span, or when
the lookup itself fails). The filter's feedback-loop fix — it reads OpenTelemetry
directly and never calls the Langfuse client — has its own file,
test_logging_trace_id.py.
"""

from __future__ import annotations

import logging

from opentelemetry.sdk.trace import TracerProvider

import assistant.logging_config as logging_config


def _reset():
    logging_config._configured = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)


def test_configure_logging_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(logging_config, "_LOG_DIR", tmp_path)
    monkeypatch.setattr(logging_config, "_LOG_FILE", tmp_path / "oni-backend.log")
    _reset()
    try:
        logging_config.configure_logging("test")
        count_after_first = len(logging.getLogger().handlers)
        logging_config.configure_logging("test")
        count_after_second = len(logging.getLogger().handlers)
        assert count_after_first == count_after_second
        assert count_after_first > 0
    finally:
        _reset()


def test_configure_logging_creates_log_dir_and_writes(tmp_path, monkeypatch):
    log_dir = tmp_path / "nested" / "logs"
    monkeypatch.setattr(logging_config, "_LOG_DIR", log_dir)
    monkeypatch.setattr(logging_config, "_LOG_FILE", log_dir / "oni-backend.log")
    _reset()
    try:
        logging_config.configure_logging("test")
        logging.getLogger("oni.test").info("hello")
        for handler in logging.getLogger().handlers:
            handler.flush()
        assert (log_dir / "oni-backend.log").exists()
        content = (log_dir / "oni-backend.log").read_text()
        assert "hello" in content
        assert "[test]" in content
    finally:
        _reset()


def _record() -> logging.LogRecord:
    return logging.LogRecord("x", logging.INFO, __file__, 1, "msg", None, None)


def test_trace_id_filter_defaults_to_dash_with_no_active_span():
    record = _record()
    result = logging_config._TraceIdFilter().filter(record)
    assert result is True
    assert record.trace_id == "-"


def test_trace_id_filter_uses_the_active_otel_spans_trace_id():
    tracer = TracerProvider().get_tracer("test")  # the OTEL SDK, no exporter
    with tracer.start_as_current_span("work") as span:
        record = _record()
        logging_config._TraceIdFilter().filter(record)
        expected = format(span.get_span_context().trace_id, "032x")
    assert record.trace_id == expected


def test_trace_id_filter_never_raises_when_the_lookup_fails(monkeypatch):
    class _BrokenOtel:
        @staticmethod
        def get_current_span():
            raise RuntimeError("boom")

    monkeypatch.setattr(logging_config, "trace", _BrokenOtel)
    record = _record()
    result = logging_config._TraceIdFilter().filter(record)
    assert result is True
    assert record.trace_id == "-"
