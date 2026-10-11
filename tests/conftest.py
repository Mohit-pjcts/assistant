"""Shared pytest fixtures and session-wide test isolation.

**The trace store.** Every agent graph records its tool calls into
`traces.sqlite` (the History panel's data, STEPS.md 158), so any test that runs
a real graph — test_server, test_a2ui, test_supervisor, test_stage — would
otherwise write into the repo's real file. The other stores are kept out of
reach by environment redirects at the top of the files that need them; this one
is done once, here, instead of asking each of those files to remember:
`trace_store` resolves its path on every call, so repointing `DEFAULT_DB_PATH`
per test is enough. A test that wants a specific file (test_trace_store,
test_tool_trace) simply sets its own, which wins.

**Logging.** Importing `assistant.server` — several test modules do, some while
pytest is still collecting — calls `configure_logging`, which attaches handlers
for the user's REAL `~/Library/Logs/PersonalAssistant/oni-backend.log` to the
root logger for the rest of the process. Anything a test makes log would land in
the log a human reads to debug the live backend, rotating its real history out
(a runaway test run did exactly that, 2026-10-07). So, before any test module is
collected, the log directory is a throwaway temp directory.

That run was a feedback loop in `logging_config._TraceIdFilter`, which asked
Langfuse for the trace id on every record (fixed at the source: the filter now
reads OpenTelemetry directly and cannot recurse; `tests/test_logging_trace_id.py`
covers it). This file used to also stub the filter's Langfuse lookup out; that
stub is gone on purpose — it would have hidden exactly the regression those tests
exist to catch.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from assistant import logging_config, trace_store

_TEST_LOG_DIR = Path(tempfile.mkdtemp(prefix="oni-test-logs-"))
logging_config._LOG_DIR = _TEST_LOG_DIR
logging_config._LOG_FILE = _TEST_LOG_DIR / "oni-backend.log"


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TEST_LOG_DIR, ignore_errors=True)


@pytest.fixture(autouse=True)
def _isolated_trace_store(tmp_path_factory, monkeypatch):
    monkeypatch.setattr(
        trace_store, "DEFAULT_DB_PATH", tmp_path_factory.mktemp("traces") / "traces.sqlite"
    )
