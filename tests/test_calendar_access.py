"""STEPS.md 192: the iPhone may READ the calendar, never write it.

`GET /calendar` was loopback-only; the user asked for the calendar on the phone
(STEPS.md 192), so the read is open like the board and memory reads. Add, edit
and delete stay loopback-only. A foreign client is simulated the way
test_stage_history.py does it: `TestClient(client=(address, port))`.
"""

import atexit
import os
import shutil
import tempfile

import pytest

_tmpdir = tempfile.mkdtemp(prefix="assistant_test_calendar_access_")
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)
os.environ.setdefault("ASSISTANT_CONVERSATION_DB_PATH", os.path.join(_tmpdir, "conversation_memory.sqlite"))
os.environ.setdefault("ASSISTANT_MEMORY_DB_PATH", os.path.join(_tmpdir, "long_term_memory.sqlite"))

from fastapi.testclient import TestClient  # noqa: E402

from assistant import calendar_store, server  # noqa: E402

PHONE = ("100.101.102.103", 5000)


@pytest.fixture(autouse=True)
def _empty_calendar(monkeypatch):
    monkeypatch.setattr(calendar_store, "load_calendar", lambda: calendar_store.CalendarData())


def test_a_remote_client_can_read_the_calendar():
    response = TestClient(server.app, client=PHONE).get("/calendar")
    assert response.status_code == 200
    assert set(response.json()) >= {"events", "undated", "courses"}


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("post", "/calendar/events", {"json": {"title": "x", "date": "2026-10-22"}}),
        ("patch", "/calendar/events?id=a", {"json": {"title": "y"}}),
        ("delete", "/calendar/events?id=a", {}),
    ],
)
def test_a_remote_client_cannot_write_the_calendar(method, path, kwargs):
    response = getattr(TestClient(server.app, client=PHONE), method)(path, **kwargs)
    assert response.status_code == 403
