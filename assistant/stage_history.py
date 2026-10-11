"""Read-only view of Stage's own run history for the dashboard's History panel
(STEPS.md 158): every Backstage run (the hotkey's and the panel's as well as
the ones Oni started) and every Onstage question.

**Reads Stage's files, not its HTTP API.** Stage keeps only its last 20 runs
in memory (`stage/src/server.ts`'s `MAX_RUNS`) and may not be running at all
when the user opens History; the durable record is on disk, already in this
repo: `stage/runs/<runId>/steps.jsonl` (one JSON object per line — `run_start`,
`step`, `helper`, `task_end`, `run_end`, see `stage/src/contracts.ts`'s
`LogLine`) and `stage/runs/explain-journal.jsonl` (one Onstage question per
line). The directory is `STAGE_RUNS_DIR` when set, else `<repo>/stage/runs`.

Lines that don't parse are skipped silently: a run still in progress has a
half-written last line, and one bad line must not hide the rest of a run.

**Cost.** `step` lines are the bulk of a log (about 3.5 KB each, every control
on screen), so listing runs never parses them: the list needs only `run_start`,
`task_end` and `run_end`, and a line's type is read off its first few
characters, so a `step`/`helper` line is skipped without a JSON parse. Ordering
needs just each run's first line (its start time). A single run's detail does
parse everything — that is what the panel asked to see.

**Safety.** Stage logs contain screen contents, so every route here is
loopback-only (`local_only.require_local_client`). A run id is matched against
`^run-[\\w-]+$` (ASCII only: no dot, no slash) before it is ever joined onto a
path; nothing from the request is joined unchecked.

This is an `APIRouter` in its own module rather than routes in `server.py`: it
needs no graph and no app state, so it can be mounted on a minimal app and
tested alone.
"""

from __future__ import annotations

import json
import os
import re
from collections import deque
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from assistant.local_only import require_local_client

RUNS_DIR_ENV = "STAGE_RUNS_DIR"
STEPS_FILE = "steps.jsonl"
JOURNAL_FILE = "explain-journal.jsonl"

_RUN_ID = re.compile(r"run-[\w-]+", re.ASCII)
# "run-jev-2026-10-05T09-51-33-446Z-o03v": the time Stage stamped the run with,
# a fallback ordering key for a log whose first line isn't a readable run_start.
_TIME_IN_RUN_ID = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z")
# A log line's type, read without parsing the line (Stage writes `type` first).
_LINE_TYPE = re.compile(r'\s*\{\s*"type"\s*:\s*"(\w+)"')
_BULKY_TYPES = frozenset({"step", "helper"})
_TASK_FIELDS = (
    "id",
    "agent",
    "app",
    "goal",
    "status",
    "answer",
    "exception",
    "seconds",
    "steps",
    "cost",
    "llmCalls",
)


def runs_dir() -> Path:
    """Where Stage writes its logs. Read per call so a test (or a relocated
    Stage) can point `STAGE_RUNS_DIR` somewhere else."""
    override = os.environ.get(RUNS_DIR_ENV)
    return Path(override) if override else Path(__file__).resolve().parents[1] / "stage" / "runs"


def _parse_line(raw: str) -> dict[str, Any] | None:
    raw = raw.strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _read_lines(path: Path, *, skip_bulky: bool = False) -> Iterator[dict[str, Any]]:
    """Every parseable JSON object in a .jsonl file, in order, streamed line by
    line. A missing or unreadable file yields nothing. `skip_bulky` drops
    `step`/`helper` lines before parsing them (see the module docstring)."""
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                if skip_bulky:
                    match = _LINE_TYPE.match(raw)
                    if match and match.group(1) in _BULKY_TYPES:
                        continue
                line = _parse_line(raw)
                if line is not None:
                    yield line
    except OSError:
        return


class _SummaryBuilder:
    """Folds a run's log lines, one at a time, into the summary the list shows.
    Shared by the list (which feeds it only the lines it needs) and the detail
    view (which feeds it all of them), so the two can't disagree."""

    def __init__(self, run_id: str) -> None:
        self._run_id = run_id
        self._start: dict[str, Any] | None = None
        self._end: dict[str, Any] | None = None
        self._task_ends: dict[str, dict[str, Any]] = {}

    def feed(self, line: dict[str, Any]) -> None:
        kind = line.get("type")
        if kind == "run_start" and self._start is None:
            self._start = line
        elif kind == "run_end":
            self._end = line
        elif kind == "task_end":
            task = line.get("task")
            if isinstance(task, dict) and task.get("id") is not None:
                self._task_ends[str(task["id"])] = task  # the last one per task wins

    def summary(self) -> dict[str, Any]:
        start = self._start or {}
        end = self._end or {}
        # A task's final state is its last task_end; one with none (a log cut
        # short) falls back to how the run planned it.
        tasks: list[dict[str, Any]] = []
        seen: set[str] = set()
        for planned in start.get("tasks") or []:
            if not isinstance(planned, dict):
                continue
            task_id = str(planned.get("id"))
            seen.add(task_id)
            tasks.append(self._task_ends.get(task_id, planned))
        tasks.extend(task for task_id, task in self._task_ends.items() if task_id not in seen)
        return {
            "run_id": self._run_id,
            "started_at": start.get("t"),
            "ended_at": end.get("t"),
            "command": start.get("command"),
            "brain": start.get("brain"),
            "source": start.get("source"),
            "client_run_id": start.get("clientRunId"),
            "status": "finished" if self._end is not None else "unfinished",
            "totals": end.get("totals"),
            "tasks": [{key: task.get(key) for key in _TASK_FIELDS} for task in tasks],
        }


def _time_from_run_id(run_id: str) -> str | None:
    match = _TIME_IN_RUN_ID.search(run_id)
    if match is None:
        return None
    day, hour, minute, second, millis = match.groups()
    return f"{day}T{hour}:{minute}:{second}.{millis}Z"


def _started_at(steps: Path, run_id: str) -> str:
    """When a run started, for ordering: its run_start line's time, else the
    time in its id, else "" (sorts oldest). Reads only the first line."""
    for line in _read_lines(steps):
        if line.get("type") == "run_start" and isinstance(line.get("t"), str):
            return line["t"]
        break
    return _time_from_run_id(run_id) or ""


def _discover(base: Path) -> list[tuple[str, str]]:
    """(started_at, run_id) for every run on disk with a log, newest first."""
    try:
        with os.scandir(base) as entries:
            names = [entry.name for entry in entries]
    except OSError:
        return []
    found = [
        (_started_at(base / name / STEPS_FILE, name), name)
        for name in names
        if _RUN_ID.fullmatch(name) and (base / name / STEPS_FILE).is_file()
    ]
    found.sort(reverse=True)
    return found


def list_runs(limit: int, before: str | None = None) -> dict[str, Any]:
    """`{runs, next}`: up to `limit` run summaries, newest first, starting just
    after run `before` (None: from the newest). `next` is the id to pass as
    `before` for the following page, or None at the end. An unknown `before`
    gives an empty page rather than restarting from the top, so a client
    paging through a log directory that changed under it can't loop."""
    base = runs_dir()
    ordered = _discover(base)
    if before is not None:
        ids = [run_id for _, run_id in ordered]
        if before not in ids:
            return {"runs": [], "next": None}
        ordered = ordered[ids.index(before) + 1 :]
    page = ordered[:limit]
    runs = []
    for _, run_id in page:
        builder = _SummaryBuilder(run_id)
        for line in _read_lines(base / run_id / STEPS_FILE, skip_bulky=True):
            builder.feed(line)
        runs.append(builder.summary())
    return {"runs": runs, "next": page[-1][1] if page and len(ordered) > limit else None}


def read_run(run_id: str) -> dict[str, Any] | None:
    """`{run_id, summary, lines}` for one run — every parseable line of its log,
    in order — or None if there is no such run. `run_id` must already have
    passed `_RUN_ID`."""
    path = runs_dir() / run_id / STEPS_FILE
    if not path.is_file():
        return None
    builder = _SummaryBuilder(run_id)
    lines = []
    for line in _read_lines(path):
        lines.append(line)
        builder.feed(line)
    return {"run_id": run_id, "summary": builder.summary(), "lines": lines}


def list_onstage(limit: int) -> dict[str, Any]:
    """`{entries}`: the `limit` most recent Onstage journal entries, newest
    first, as Stage wrote them. Only the tail is kept in memory, however long
    the journal has grown."""
    newest: deque[dict[str, Any]] = deque(maxlen=limit)
    newest.extend(_read_lines(runs_dir() / JOURNAL_FILE))
    return {"entries": list(reversed(newest))}


router = APIRouter(prefix="/stage", dependencies=[Depends(require_local_client)])


def _checked_run_id(run_id: str) -> str:
    if not _RUN_ID.fullmatch(run_id):
        raise HTTPException(
            status_code=400, detail="run_id must look like run-<letters, digits, ->"
        )
    return run_id


@router.get("/runs")
def get_runs(limit: int = Query(50, ge=1, le=500), before: str | None = None) -> dict[str, Any]:
    if before is not None:
        _checked_run_id(before)
    return list_runs(limit, before)


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    run = read_run(_checked_run_id(run_id))
    if run is None:
        raise HTTPException(status_code=404, detail=f"No Stage run with id {run_id}")
    return run


@router.get("/onstage")
def get_onstage(limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
    return list_onstage(limit)
