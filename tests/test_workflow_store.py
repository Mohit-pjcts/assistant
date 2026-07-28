"""Tests for assistant.workflow_store — PLAN.md Phase 25's cross-app
workflow run storage. Runnable directly against a real temp SQLite file,
matching tests/test_thread_store.py's/tests/test_memory_store.py's
convention (no mocking of the DB layer itself)."""

import tempfile
from pathlib import Path

import pytest

from assistant.workflow_store import (
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_RUNNING,
    STEP_OUTCOME_FAILED,
    STEP_OUTCOME_NEVER_RAN,
    STEP_OUTCOME_SUCCESS,
    complete_run,
    create_run,
    get_run,
    list_runs,
    record_step_outcome,
)

_PLAN = [
    {"action": "calendar_create_event", "summary": "Create 'Flight to SF' on July 30, 9am-11am"},
    {"action": "send_imessage", "summary": "Text Rishabh: landed, see you soon"},
]


async def _fresh_db(tmp: str) -> Path:
    return Path(tmp) / "workflows.sqlite"


async def test_create_run_persists_the_approved_plan_verbatim() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run = await create_run("thread-1", "Text Rishabh after landing", _PLAN, db_path=db_path)
        assert run.status == RUN_STATUS_RUNNING
        assert run.thread_id == "thread-1"
        assert len(run.steps) == 2
        assert run.steps[0].action == "calendar_create_event"
        assert run.steps[0].planned_summary == _PLAN[0]["summary"]
        # Nothing executed yet — the "approved" half exists before any
        # "executed" half does.
        assert run.steps[0].executed_args is None
        assert run.steps[0].outcome is None
        assert run.steps[1].step_index == 1


async def test_record_step_outcome_stores_the_real_executed_arguments() -> None:
    """The load-bearing audit guarantee: what actually executed is
    recorded distinctly from what was planned, in the SAME row."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run = await create_run("thread-1", "goal", _PLAN, db_path=db_path)
        real_args = {"calendar_name": "Home", "title": "Flight to SF", "start": "2026-07-30T09:00:00"}
        updated = await record_step_outcome(
            run.id, 0, STEP_OUTCOME_SUCCESS, executed_args=real_args, db_path=db_path
        )
        assert updated.outcome == STEP_OUTCOME_SUCCESS
        assert updated.executed_args == real_args

        fetched = await get_run(run.id, db_path=db_path)
        assert fetched is not None
        assert fetched.steps[0].executed_args == real_args
        assert fetched.steps[0].planned_summary == _PLAN[0]["summary"]  # plan untouched
        assert fetched.steps[1].outcome is None  # second step still unexecuted


async def test_a_divergent_executed_payload_is_still_recorded_not_blocked() -> None:
    """PLAN.md Phase 25 decision D2: divergence between the approved
    summary and the executed arguments is accepted, not prevented — this
    module's job is only to make it VISIBLE after the fact, never to
    reject it."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run = await create_run("thread-1", "goal", _PLAN, db_path=db_path)
        # The plan said "Text Rishabh"; the executed args show a different
        # recipient entirely — storage must not reject this.
        diverged_args = {"recipient": "someone-else@example.com", "message": "different text"}
        updated = await record_step_outcome(
            run.id, 1, STEP_OUTCOME_SUCCESS, executed_args=diverged_args, db_path=db_path
        )
        assert updated.executed_args == diverged_args
        assert updated.diverged is True


async def test_stop_at_first_failure_leaves_later_steps_never_ran() -> None:
    """PLAN.md Phase 25 decision D6: stop at the first failure, report what
    did/didn't happen, no rollback. The store's job is to make "never ran"
    distinguishable from "not reached yet" once the run is finalized."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run = await create_run("thread-1", "goal", _PLAN, db_path=db_path)
        await record_step_outcome(
            run.id, 0, STEP_OUTCOME_FAILED, detail="osascript failed: list not found", db_path=db_path
        )
        await record_step_outcome(run.id, 1, STEP_OUTCOME_NEVER_RAN, db_path=db_path)
        finished = await complete_run(run.id, RUN_STATUS_FAILED, db_path=db_path)

        assert finished.status == RUN_STATUS_FAILED
        assert finished.completed_at is not None
        assert finished.steps[0].outcome == STEP_OUTCOME_FAILED
        assert finished.steps[0].detail == "osascript failed: list not found"
        assert finished.steps[1].outcome == STEP_OUTCOME_NEVER_RAN
        assert finished.steps[1].executed_args is None


async def test_complete_run_unknown_id_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        with pytest.raises(KeyError):
            await complete_run("does-not-exist", RUN_STATUS_COMPLETED, db_path=db_path)


async def test_record_step_outcome_unknown_step_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run = await create_run("thread-1", "goal", _PLAN, db_path=db_path)
        with pytest.raises(KeyError):
            await record_step_outcome(run.id, 99, STEP_OUTCOME_SUCCESS, db_path=db_path)


async def test_list_runs_most_recent_first_scoped_by_thread() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        run_a = await create_run("thread-1", "goal A", _PLAN, db_path=db_path)
        run_b = await create_run("thread-2", "goal B", _PLAN, db_path=db_path)
        run_c = await create_run("thread-1", "goal C", _PLAN, db_path=db_path)

        all_runs = await list_runs(db_path=db_path)
        assert [r.id for r in all_runs] == [run_c.id, run_b.id, run_a.id]

        thread_1_runs = await list_runs(thread_id="thread-1", db_path=db_path)
        assert {r.id for r in thread_1_runs} == {run_a.id, run_c.id}
        assert all(r.thread_id == "thread-1" for r in thread_1_runs)


async def test_get_run_unknown_id_returns_none() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = await _fresh_db(tmp)
        assert await get_run("nope", db_path=db_path) is None
