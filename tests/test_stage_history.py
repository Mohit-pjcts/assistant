"""Tests for assistant.stage_history (Stage's run history for the History
panel, STEPS.md 158) and the loopback guard (assistant.local_only) that every
one of its routes sits behind.

Offline and graph-free: the routes are mounted on a minimal FastAPI app and
read a temp directory laid out the way Stage lays out `stage/runs/` — one
`<runId>/steps.jsonl` per run (`run_start`, `step`, `helper`, `task_end`,
`run_end` lines, the shapes in `stage/src/contracts.ts`) and one
`explain-journal.jsonl` for Onstage.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from assistant import local_only, stage_history

A = "run-jev-2026-10-05T09-51-33-446Z-o03v"  # 09:51 on Oct 5, started by Oni (source "api")
B = "run-jev-2026-10-05T09-50-06-113Z-ihlm"  # 09:50 on Oct 5, one task failed, an older log
C = "run-llm-2026-10-06T08-00-00-000Z-abcd"  # Oct 6, still running (no run_end)
D = "run-jev-2026-10-04T10-00-00-000Z-zzzz"  # named Oct 4, but its run_start says Oct 7

T_A = "2026-10-05T09:51:34.668Z"
T_B = "2026-10-05T09:50:07.000Z"
T_C = "2026-10-06T08:00:00.500Z"
T_D = "2026-10-07T00:00:00.000Z"


def task(number: int, status: str = "done", **extra) -> dict:
    return {
        "id": f"t{number}",
        "agent": f"Mint-{number}",
        "app": "Calculator",
        "goal": f"goal {number}",
        "brain": "jev",
        "status": status,
        "steps": 3,
        "seconds": 1.5,
        "cost": {"decisionsUsd": 0, "helperUsd": 0.0001},
        "counts": {"decisions": 0, "actions": 3, "helperCalls": 1},
        "decideMs": [],
        "llmCalls": [],
        **extra,
    }


def run_start(run_id: str, t: str, tasks: list[dict], **extra) -> dict:
    return {
        "type": "run_start",
        "runId": run_id,
        "t": t,
        "command": "compute things",
        "brain": "jev",
        "tasks": tasks,
        **extra,
    }


def step(run_id: str, number: int, task_id: str = "t1") -> dict:
    return {
        "type": "step",
        "runId": run_id,
        "t": "2026-10-05T09:51:35.000Z",
        "taskId": task_id,
        "agent": "Mint-1",
        "step": number,
        "items": [{"i": 0, "id": "AXButton:2", "text": "2", "role": "AXButton", "state": "n/a"}],
        "decision": {"kind": "click", "item": 0, "gate": 0.99, "backend": "jev", "ms": 3},
        "acted": "click '2'",
        "results": [{"ok": True, "channel": "ax", "ms": 4, "cli": "click"}],
        "ms": {"observe": 1, "decide": 3, "act": 4},
    }


def helper(run_id: str) -> dict:
    return {
        "type": "helper",
        "runId": run_id,
        "t": "2026-10-05T09:51:35.100Z",
        "taskId": "t1",
        "agent": "Mint-1",
        "what": "verify",
        "detail": "achieved",
        "costUsd": 1.9e-05,
        "ms": 389,
    }


def task_end(run_id: str, t: str, a_task: dict) -> dict:
    return {"type": "task_end", "runId": run_id, "t": t, "task": a_task}


def run_end(run_id: str, t: str, tasks: list[dict]) -> dict:
    totals = {"tasks": len(tasks), "done": 1, "failed": 0, "seconds": 4.19, "decisionsUsd": 0}
    return {"type": "run_end", "runId": run_id, "t": t, "totals": totals, "tasks": tasks}


def write_log(base: Path, run_id: str, lines: list[dict], *, raw_prefix="", raw_suffix="") -> None:
    folder = base / run_id
    folder.mkdir(parents=True)
    body = "".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines)
    (folder / stage_history.STEPS_FILE).write_text(raw_prefix + body + raw_suffix)


@pytest.fixture()
def runs(tmp_path, monkeypatch):
    base = tmp_path / "runs"
    base.mkdir()
    monkeypatch.setenv(stage_history.RUNS_DIR_ENV, str(base))

    a_task = task(1, answer="446.4")
    write_log(
        base,
        A,
        [
            run_start(A, T_A, [task(1, "queued")], source="api", clientRunId="toolu_abc"),
            helper(A),
            step(A, 1),
            step(A, 2),
            task_end(A, "2026-10-05T09:51:37.594Z", a_task),
            run_end(A, "2026-10-05T09:51:37.637Z", [a_task]),
        ],
    )

    failed = task(
        2,
        "failed",
        exception={"code": "low_confidence", "reason": "could not find Tokyo"},
        llmCalls=["plan: no compiler for this goal"],
    )
    write_log(
        base,
        B,
        [
            run_start(B, T_B, [task(1, "queued"), task(2, "queued")]),
            step(B, 1),
            task_end(
                B, "2026-10-05T09:50:09.000Z", task(2, "failed", exception={"code": "stopped"})
            ),
            task_end(B, "2026-10-05T09:50:10.000Z", task(1)),
            task_end(B, "2026-10-05T09:50:11.000Z", failed),  # the last one for t2 wins
            run_end(B, "2026-10-05T09:50:12.000Z", [task(1), failed]),
        ],
        raw_prefix="this is not json\n",
        raw_suffix='{"type":"step","runId":"x"\n\n   \n["a", "list"]\n',
    )

    write_log(
        base,
        C,
        [
            run_start(C, T_C, [task(1, "running"), task(2, "queued")], source="hotkey"),
            task_end(C, "2026-10-06T08:00:03.000Z", task(1)),
            step(C, 1, "t2"),
        ],
        raw_suffix='{"type":"step","runId":"x","t":',  # a line Stage is still writing
    )

    write_log(base, D, [run_start(D, T_D, [task(1)], source="panel"), run_end(D, T_D, [task(1)])])

    (base / "run-no-log").mkdir()  # a run folder with nothing in it
    (base / "notes").mkdir()
    (base / "notes" / stage_history.STEPS_FILE).write_text("{}\n")  # not a run folder
    (base / "run-stray").write_text("a file, not a folder")
    return base


@pytest.fixture()
def client(runs) -> TestClient:
    app = FastAPI()
    app.include_router(stage_history.router)
    return TestClient(app)


def ids(response) -> list[str]:
    return [r["run_id"] for r in response.json()["runs"]]


# --- listing ----------------------------------------------------------------------


def test_runs_are_listed_newest_first_by_their_run_start_time(client):
    response = client.get("/stage/runs")
    assert response.status_code == 200
    # D is named for Oct 4 but its run_start says Oct 7: ordering uses the time
    # inside the log, not the folder name (which would put C first).
    assert ids(response) == [D, C, A, B]


def test_a_list_entry_carries_everything_the_panel_shows(client):
    entry = next(r for r in client.get("/stage/runs").json()["runs"] if r["run_id"] == A)
    assert entry == {
        "run_id": A,
        "started_at": T_A,
        "ended_at": "2026-10-05T09:51:37.637Z",
        "command": "compute things",
        "brain": "jev",
        "source": "api",
        "client_run_id": "toolu_abc",
        "status": "finished",
        "totals": {"tasks": 1, "done": 1, "failed": 0, "seconds": 4.19, "decisionsUsd": 0},
        "tasks": [
            {
                "id": "t1",
                "agent": "Mint-1",
                "app": "Calculator",
                "goal": "goal 1",
                "status": "done",
                "answer": "446.4",
                "exception": None,
                "seconds": 1.5,
                "steps": 3,
                "cost": {"decisionsUsd": 0, "helperUsd": 0.0001},
                "llmCalls": [],
            }
        ],
    }


def test_runs_from_before_source_and_client_id_were_logged_report_none(client):
    entry = next(r for r in client.get("/stage/runs").json()["runs"] if r["run_id"] == B)
    assert entry["source"] is None
    assert entry["client_run_id"] is None


def test_a_run_with_no_run_end_is_unfinished(client):
    entry = next(r for r in client.get("/stage/runs").json()["runs"] if r["run_id"] == C)
    assert entry["status"] == "unfinished"
    assert entry["ended_at"] is None
    assert entry["totals"] is None
    assert entry["source"] == "hotkey"


def test_a_tasks_final_state_is_its_last_task_end_else_how_the_run_planned_it(client):
    runs = {r["run_id"]: r for r in client.get("/stage/runs").json()["runs"]}
    b_tasks = {t["id"]: t for t in runs[B]["tasks"]}
    assert b_tasks["t2"]["status"] == "failed"
    assert b_tasks["t2"]["exception"] == {
        "code": "low_confidence",
        "reason": "could not find Tokyo",
    }
    assert b_tasks["t2"]["llmCalls"] == ["plan: no compiler for this goal"]
    assert b_tasks["t1"]["status"] == "done"
    # C never logged a task_end for t2: it falls back to the run_start's record.
    c_tasks = {t["id"]: t for t in runs[C]["tasks"]}
    assert (c_tasks["t1"]["status"], c_tasks["t2"]["status"]) == ("done", "queued")


def test_task_order_follows_the_run_start(client):
    entry = next(r for r in client.get("/stage/runs").json()["runs"] if r["run_id"] == B)
    assert [t["id"] for t in entry["tasks"]] == ["t1", "t2"]


def test_paging_with_limit_before_and_next(client):
    first = client.get("/stage/runs", params={"limit": 2}).json()
    assert [r["run_id"] for r in first["runs"]] == [D, C]
    assert first["next"] == C
    second = client.get("/stage/runs", params={"limit": 2, "before": first["next"]}).json()
    assert [r["run_id"] for r in second["runs"]] == [A, B]
    assert second["next"] is None  # nothing older


def test_paging_all_the_way_through_visits_every_run_once(client):
    seen: list[str] = []
    before = None
    for _ in range(10):
        params = {"limit": 1, **({"before": before} if before else {})}
        page = client.get("/stage/runs", params=params).json()
        seen += [r["run_id"] for r in page["runs"]]
        before = page["next"]
        if before is None:
            break
    assert seen == [D, C, A, B]


def test_next_is_none_when_the_last_page_ends_exactly_at_the_oldest_run(client):
    page = client.get("/stage/runs", params={"limit": 4}).json()
    assert [r["run_id"] for r in page["runs"]] == [D, C, A, B]
    assert page["next"] is None


def test_an_unknown_before_gives_an_empty_page_not_the_top_again(client):
    page = client.get("/stage/runs", params={"before": "run-jev-2020-01-01T00-00-00-000Z-gone"})
    assert page.status_code == 200
    assert page.json() == {"runs": [], "next": None}


def test_a_malformed_before_is_a_400(client):
    assert client.get("/stage/runs", params={"before": "../etc"}).status_code == 400
    assert client.get("/stage/runs", params={"before": "nope"}).status_code == 400


@pytest.mark.parametrize("limit", [0, -1, 501])
def test_limit_is_validated(client, limit):
    assert client.get("/stage/runs", params={"limit": limit}).status_code == 422


def test_folders_that_are_not_runs_are_not_listed(client):
    listed = ids(client.get("/stage/runs", params={"limit": 500}))
    assert "run-no-log" not in listed and "notes" not in listed and "run-stray" not in listed


def test_a_listing_never_parses_the_bulky_step_and_helper_lines(client, monkeypatch):
    real = stage_history._parse_line
    parsed: list[str] = []

    def spy(raw: str):
        parsed.append(raw)
        return real(raw)

    monkeypatch.setattr(stage_history, "_parse_line", spy)
    client.get("/stage/runs", params={"limit": 500})
    assert not any('"type":"step"' in raw or '"type":"helper"' in raw for raw in parsed)
    # ...while a run's detail view reads every line.
    parsed.clear()
    client.get(f"/stage/runs/{A}")
    assert any('"type":"step"' in raw for raw in parsed)


def test_a_run_whose_first_line_is_garbage_is_still_ordered_by_its_start_time(client):
    # B's file begins with a line that isn't JSON; its run_start is the second.
    first_line = (Path(stage_history.runs_dir()) / B / stage_history.STEPS_FILE).read_text()
    assert first_line.startswith("this is not json")
    assert ids(client.get("/stage/runs")).index(A) < ids(client.get("/stage/runs")).index(B)


def test_a_run_with_no_readable_run_start_falls_back_to_the_time_in_its_id(client, runs):
    odd = "run-jev-2026-10-08T12-00-00-000Z-odd1"  # newer than everything above
    write_log(runs, odd, [{"type": "step", "runId": odd}])
    page = client.get("/stage/runs").json()
    assert page["runs"][0]["run_id"] == odd
    assert page["runs"][0]["started_at"] is None  # nothing logged to report
    assert page["runs"][0]["status"] == "unfinished"


# --- one run ------------------------------------------------------------------------


def test_a_runs_detail_has_every_line_in_order_and_the_same_summary_as_the_list(client):
    detail = client.get(f"/stage/runs/{A}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["run_id"] == A
    assert [line["type"] for line in body["lines"]] == [
        "run_start",
        "helper",
        "step",
        "step",
        "task_end",
        "run_end",
    ]
    listed = next(r for r in client.get("/stage/runs").json()["runs"] if r["run_id"] == A)
    assert body["summary"] == listed


def test_detail_lines_are_the_logged_objects_whole(client):
    lines = client.get(f"/stage/runs/{A}").json()["lines"]
    assert lines[2] == step(A, 1)
    assert lines[1] == helper(A)
    assert lines[0]["source"] == "api" and lines[0]["clientRunId"] == "toolu_abc"


def test_malformed_lines_are_skipped_silently(client):
    lines = client.get(f"/stage/runs/{B}").json()["lines"]
    assert [line["type"] for line in lines] == [
        "run_start",
        "step",
        "task_end",
        "task_end",
        "task_end",
        "run_end",
    ]  # the prose line, the cut-off step, the blank lines and the bare list are gone


def test_a_run_still_being_written_serves_what_is_complete(client):
    body = client.get(f"/stage/runs/{C}").json()
    assert [line["type"] for line in body["lines"]] == ["run_start", "task_end", "step"]
    assert body["summary"]["status"] == "unfinished"


def test_an_unknown_run_is_a_404(client):
    response = client.get("/stage/runs/run-jev-2020-01-01T00-00-00-000Z-gone")
    assert response.status_code == 404


@pytest.mark.parametrize(
    "bad",
    ["notarun", "run-", "run-a.b", "run-a b", "RUN-x", "run-é", "run-a%0A"],
)
def test_a_run_id_that_is_not_run_dash_word_characters_is_a_400(client, bad):
    assert client.get(f"/stage/runs/{bad}").status_code == 400


def test_a_path_traversal_attempt_never_reads_outside_the_runs_folder(client, runs):
    secret = runs.parent / "secret"
    secret.mkdir()
    (secret / stage_history.STEPS_FILE).write_text('{"type":"run_start","t":"leak"}\n')
    for attempt in ("..%2Fsecret", "run-x%2F..%2F..%2Fsecret", "%2E%2E%2Fsecret"):
        response = client.get(f"/stage/runs/{attempt}")
        assert response.status_code in (400, 404)
        assert "leak" not in response.text


# --- Onstage --------------------------------------------------------------------------


def write_journal(base: Path, entries: list[dict], *, raw: str = "") -> None:
    text = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in entries)
    (base / stage_history.JOURNAL_FILE).write_text(text + raw)


def journal_entry(n: int) -> dict:
    return {
        "t": f"2026-10-05T04:3{n}:00.000Z",
        "question": f"question {n}",
        "app": "Calculator",
        "window": "Calculator",
        "steps": [{"say": f"say {n}", "shapes": 2}],
        "model": "claude-sonnet-5-5",
        "usd": 0.014,
        "ms": 5450,
        "captureMs": 553,
        "controls": 36,
    }


def test_the_onstage_journal_is_returned_newest_first_as_raw_objects(client, runs):
    write_journal(runs, [journal_entry(1), journal_entry(2), journal_entry(3)])
    entries = client.get("/stage/onstage").json()["entries"]
    assert entries == [journal_entry(3), journal_entry(2), journal_entry(1)]


def test_the_onstage_limit_keeps_the_newest_entries(client, runs):
    write_journal(runs, [journal_entry(n) for n in range(1, 6)])
    entries = client.get("/stage/onstage", params={"limit": 2}).json()["entries"]
    assert [e["question"] for e in entries] == ["question 5", "question 4"]


def test_onstage_skips_malformed_lines(client, runs):
    garbage = 'not json\n{"t":"cut off"\n[1, 2]\n\n'
    (runs / stage_history.JOURNAL_FILE).write_text(
        json.dumps(journal_entry(1)) + "\n" + garbage + json.dumps(journal_entry(2)) + "\n"
    )
    entries = client.get("/stage/onstage").json()["entries"]
    assert [e["question"] for e in entries] == ["question 2", "question 1"]


def test_onstage_with_no_journal_yet_is_empty(client):
    assert client.get("/stage/onstage").json() == {"entries": []}


@pytest.mark.parametrize("limit", [0, 501])
def test_the_onstage_limit_is_validated(client, limit):
    assert client.get("/stage/onstage", params={"limit": limit}).status_code == 422


# --- where the logs are -----------------------------------------------------------------


def test_with_no_runs_folder_everything_is_simply_empty(tmp_path, monkeypatch):
    monkeypatch.setenv(stage_history.RUNS_DIR_ENV, str(tmp_path / "does-not-exist"))
    app = FastAPI()
    app.include_router(stage_history.router)
    client = TestClient(app)
    assert client.get("/stage/runs").json() == {"runs": [], "next": None}
    assert client.get("/stage/onstage").json() == {"entries": []}
    assert client.get(f"/stage/runs/{A}").status_code == 404


def test_the_default_folder_is_stage_runs_in_this_repo(monkeypatch):
    monkeypatch.delenv(stage_history.RUNS_DIR_ENV, raising=False)
    repo = Path(stage_history.__file__).resolve().parents[1]
    assert stage_history.runs_dir() == repo / "stage" / "runs"
    assert (repo / "stage" / "src").is_dir()  # that really is where Stage lives


def test_the_folder_is_read_per_request_so_it_can_be_pointed_elsewhere(
    client, runs, tmp_path, monkeypatch
):
    assert client.get("/stage/runs").json()["runs"]
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    monkeypatch.setenv(stage_history.RUNS_DIR_ENV, str(empty))
    assert client.get("/stage/runs").json()["runs"] == []


# --- loopback only -----------------------------------------------------------------------

ROUTES = ["/stage/runs", f"/stage/runs/{A}", "/stage/onstage"]


def app_client(**kwargs) -> TestClient:
    app = FastAPI()
    app.include_router(stage_history.router)

    @app.get("/guarded")
    def guarded(_: None = Depends(local_only.require_local_client)) -> dict:
        return {"ok": True}

    return TestClient(app, **kwargs)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize(
    "address", ["203.0.113.9", "192.168.1.20", "100.101.102.103", "2001:db8::1"]
)
def test_a_client_that_is_not_this_computer_is_refused_on_every_route(runs, route, address):
    response = app_client(client=(address, 5000)).get(route)
    assert response.status_code == 403
    assert "History is only available on this Mac" in response.json()["detail"]
    assert A not in response.text  # nothing of the log leaks into the refusal


@pytest.mark.parametrize("route", ROUTES)
def test_the_in_process_test_client_counts_as_this_computer(runs, route):
    assert app_client().get(route).status_code == 200


@pytest.mark.parametrize(
    ("address", "base_url"),
    [
        ("127.0.0.1", "http://127.0.0.1:8000"),
        ("127.0.0.1", "http://localhost:8000"),
        ("::ffff:127.0.0.1", "http://127.0.0.1:8000"),
    ],
)
def test_loopback_clients_reaching_this_computer_by_its_own_name_are_allowed(
    runs, address, base_url
):
    assert (
        app_client(client=(address, 5000), base_url=base_url).get("/stage/runs").status_code == 200
    )


def test_an_ipv6_loopback_client_using_the_bracketed_host_is_allowed(runs):
    """TestClient can't take an IPv6 base_url, so the Host header is set by hand."""
    client = app_client(client=("::1", 5000))
    assert client.get("/stage/runs", headers={"host": "[::1]:8000"}).status_code == 200


@pytest.mark.parametrize("host", ["evil.example", "mac.tailnet.ts.net", "192.168.1.5:8000"])
def test_a_loopback_client_asking_for_someone_elses_hostname_is_refused(runs, host):
    """A reverse proxy on this Mac (`tailscale serve`) or a web page using DNS
    rebinding connects from 127.0.0.1 but arrives with a foreign Host."""
    client = app_client(client=("127.0.0.1", 5000), base_url=f"http://{host}")
    assert client.get("/stage/runs").status_code == 403


def test_an_unknown_client_address_is_refused(runs):
    assert app_client(client=("not-an-address", 5000)).get("/stage/runs").status_code == 403


def test_the_guard_helper_can_be_attached_to_any_route(runs):
    assert app_client(client=("203.0.113.9", 1)).get("/guarded").status_code == 403
    assert app_client().get("/guarded").status_code == 200
