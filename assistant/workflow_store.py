"""Cross-app workflow run storage (PLAN.md Phase 25). Separate SQLite file
(`workflows.sqlite`), same dedicated-file precedent as `thread_store.py`/
`board_store.py`/`automation_store.py`/`phone_store.py`.

Two tables:
- `workflow_runs`: one row per approved, executing workflow — the goal, the
  owning thread, overall status, timestamps.
- `workflow_steps`: one row per step in that workflow's plan, in order. Each
  step records BOTH what was approved (`action`/`planned_summary`, written at
  plan time) and what actually executed (`executed_args`/`outcome`/`detail`,
  written after the step runs) side by side in the same row — this is what
  makes Phase 25's approved-vs-executed audit real: the comparison is a
  single row read, not a join or a diff reconstructed from two different
  logs. `executed_args`/`outcome`/`detail` all start NULL/empty and are
  filled in by `record_step_outcome` as the workflow actually runs; a step
  that never got to run (because an earlier step failed, per PLAN.md Phase
  25's "stop and report" decision) stays with `outcome` still unset, which
  is itself the record of "this step never ran."

Deliberately NOT enforcing a cap on steps per run here — PLAN.md's Phase 25
entry documents this as the user's own explicit choice (against the
recommendation to cap), with the accepted cost that a run's real backstop
against runaway chains is `supervisor.py`'s LangGraph `recursion_limit`, not
anything in this module.

Every function takes an optional db_path (resolved inside the function body
against DEFAULT_DB_PATH, not bound as a parameter default) — same convention
as every other `*_store.py` module here, for the same reason: a parameter
default binds once at function-definition time and would silently ignore a
later test monkeypatch.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

DEFAULT_DB_PATH = Path("workflows.sqlite")

_CREATE_RUNS_SQL = """
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
)
"""

_CREATE_STEPS_SQL = """
CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    action TEXT NOT NULL,
    planned_summary TEXT NOT NULL,
    executed_args TEXT,
    outcome TEXT,
    detail TEXT NOT NULL DEFAULT '',
    executed_at TEXT
)
"""

# Run-level status. "running" until every step has either executed or been
# short-circuited by an earlier failure (PLAN.md Phase 25's "stop at first
# failure" decision) — never re-derived from step rows on read, always
# written explicitly by complete_run so a run's own status is a fact, not an
# inference.
RUN_STATUS_RUNNING = "running"
RUN_STATUS_COMPLETED = "completed"
RUN_STATUS_FAILED = "failed"

# Step-level outcome, written once by record_step_outcome. "never_ran" is the
# explicit marker for a step this project's own "stop and report" rule
# skipped after an earlier failure — distinct from NULL (not yet reached in
# a still-running workflow) so a finished run's dashboard read never has to
# guess which of those two states an unset step is in.
STEP_OUTCOME_SUCCESS = "success"
STEP_OUTCOME_FAILED = "failed"
STEP_OUTCOME_NEVER_RAN = "never_ran"


@dataclass(frozen=True)
class WorkflowStep:
    id: str
    run_id: str
    step_index: int
    action: str
    planned_summary: str
    executed_args: dict[str, Any] | None
    outcome: str | None
    detail: str
    executed_at: str | None

    @property
    def diverged(self) -> bool:
        """True when this step actually ran but its outcome carries content
        that can't be mechanically verified against the plan (this module
        has no notion of what "matches" means for a given action — that's
        the caller's job, e.g. comparing executed_args to the original
        request). Exposed here only as a hook; PLAN.md Phase 25's own
        decision (D2) is that divergence is accepted and merely logged, not
        blocked, so no comparison logic lives in this storage module."""
        return self.outcome == STEP_OUTCOME_SUCCESS and self.executed_args is not None


@dataclass(frozen=True)
class WorkflowRun:
    id: str
    thread_id: str
    goal: str
    status: str
    created_at: str
    completed_at: str | None
    steps: list[WorkflowStep] = field(default_factory=list)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _resolve(db_path: Path | str | None) -> Path | str:
    return db_path if db_path is not None else DEFAULT_DB_PATH


def _row_to_step(row: aiosqlite.Row) -> WorkflowStep:
    d = dict(row)
    raw_args = d.pop("executed_args")
    d["executed_args"] = json.loads(raw_args) if raw_args is not None else None
    return WorkflowStep(**d)


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(_CREATE_RUNS_SQL)
        await db.execute(_CREATE_STEPS_SQL)
        await db.commit()
        db.row_factory = aiosqlite.Row
        yield db


async def create_run(
    thread_id: str,
    goal: str,
    steps: list[dict[str, str]],
    db_path: Path | str | None = None,
) -> WorkflowRun:
    """Persist a newly-APPROVED plan and start executing it. `steps` is the
    approved plan in order: each `{"action": ..., "summary": ...}`, exactly
    what the user saw on the confirmation card — this is the "approved"
    half of the approved-vs-executed audit, written once, up front, before
    any step actually runs.
    """
    db_path = _resolve(db_path)
    run_id = str(uuid.uuid4())
    now = _now()
    async with _connect(db_path) as db:
        await db.execute(
            "INSERT INTO workflow_runs (id, thread_id, goal, status, created_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, NULL)",
            (run_id, thread_id, goal, RUN_STATUS_RUNNING, now),
        )
        step_rows: list[WorkflowStep] = []
        for index, step in enumerate(steps):
            step_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO workflow_steps "
                "(id, run_id, step_index, action, planned_summary, executed_args, outcome, detail, executed_at) "
                "VALUES (?, ?, ?, ?, ?, NULL, NULL, '', NULL)",
                (step_id, run_id, index, step["action"], step["summary"]),
            )
            step_rows.append(
                WorkflowStep(
                    id=step_id,
                    run_id=run_id,
                    step_index=index,
                    action=step["action"],
                    planned_summary=step["summary"],
                    executed_args=None,
                    outcome=None,
                    detail="",
                    executed_at=None,
                )
            )
        await db.commit()
    return WorkflowRun(
        id=run_id,
        thread_id=thread_id,
        goal=goal,
        status=RUN_STATUS_RUNNING,
        created_at=now,
        completed_at=None,
        steps=step_rows,
    )


async def record_step_outcome(
    run_id: str,
    step_index: int,
    outcome: str,
    executed_args: dict[str, Any] | None = None,
    detail: str = "",
    db_path: Path | str | None = None,
) -> WorkflowStep:
    """Write what ACTUALLY happened for one step — the other half of the
    approved-vs-executed audit. `executed_args` should be the real arguments
    the gated tool executed with (captured via the same
    `additional_kwargs` marker mechanism `A2UI_SURFACE_KEY`/`PHONE_ACTION_KEY`
    already use to cross the specialist-call boundary — see supervisor.py),
    not a re-summary. Raises KeyError if run_id/step_index don't match an
    existing row.
    """
    db_path = _resolve(db_path)
    executed_at = _now()
    args_json = json.dumps(executed_args) if executed_args is not None else None
    async with _connect(db_path) as db:
        cursor = await db.execute(
            "UPDATE workflow_steps SET executed_args = ?, outcome = ?, detail = ?, executed_at = ? "
            "WHERE run_id = ? AND step_index = ?",
            (args_json, outcome, detail, executed_at, run_id, step_index),
        )
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError((run_id, step_index))
        rows = await db.execute_fetchall(
            "SELECT * FROM workflow_steps WHERE run_id = ? AND step_index = ?", (run_id, step_index)
        )
        return _row_to_step(rows[0])


async def complete_run(run_id: str, status: str, db_path: Path | str | None = None) -> WorkflowRun:
    """Mark a run's overall outcome — `RUN_STATUS_COMPLETED` (every step
    succeeded) or `RUN_STATUS_FAILED` (stopped at a failed step, per PLAN.md
    Phase 25's "stop and report, no rollback" decision). Raises KeyError if
    run_id doesn't exist."""
    db_path = _resolve(db_path)
    completed_at = _now()
    async with _connect(db_path) as db:
        cursor = await db.execute(
            "UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?",
            (status, completed_at, run_id),
        )
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(run_id)
        return await _get_run_locked(db, run_id)  # type: ignore[return-value]


async def _get_run_locked(db: aiosqlite.Connection, run_id: str) -> WorkflowRun | None:
    rows = await db.execute_fetchall("SELECT * FROM workflow_runs WHERE id = ?", (run_id,))
    if not rows:
        return None
    run_row = dict(rows[0])
    step_rows = await db.execute_fetchall(
        "SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index", (run_id,)
    )
    return WorkflowRun(
        id=run_row["id"],
        thread_id=run_row["thread_id"],
        goal=run_row["goal"],
        status=run_row["status"],
        created_at=run_row["created_at"],
        completed_at=run_row["completed_at"],
        steps=[_row_to_step(r) for r in step_rows],
    )


async def get_run(run_id: str, db_path: Path | str | None = None) -> WorkflowRun | None:
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        return await _get_run_locked(db, run_id)


async def list_runs(
    thread_id: str | None = None, db_path: Path | str | None = None
) -> list[WorkflowRun]:
    """All runs with their steps, most recent first — optionally scoped to
    one thread. Used by the dashboard's Workflows tab (PLAN.md Phase 25,
    decision D10) to show approved-vs-executed side by side."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        if thread_id is not None:
            rows = await db.execute_fetchall(
                "SELECT * FROM workflow_runs WHERE thread_id = ? ORDER BY created_at DESC", (thread_id,)
            )
        else:
            rows = await db.execute_fetchall("SELECT * FROM workflow_runs ORDER BY created_at DESC")
        runs: list[WorkflowRun] = []
        for run_row in rows:
            run_id = run_row["id"]
            step_rows = await db.execute_fetchall(
                "SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index", (run_id,)
            )
            runs.append(
                WorkflowRun(
                    id=run_id,
                    thread_id=run_row["thread_id"],
                    goal=run_row["goal"],
                    status=run_row["status"],
                    created_at=run_row["created_at"],
                    completed_at=run_row["completed_at"],
                    steps=[_row_to_step(r) for r in step_rows],
                )
            )
        return runs
