"""Tests for assistant.calendar_store — the Calendar view's parser over the
vault's timetable / deadlines / tutorials notes — and the thin `GET /calendar`
endpoint around it.

Everything runs against a throwaway vault in `tmp_path` (the real OniVault is
never read or written). The note text below copies the real notes' table
shapes, including the awkward date cells ("Week of Mon 2 Nov – Fri 6 Nov 2026
(probably Fri 6 Nov; time not stated)"), because those are what the parser
exists to survive.
"""

from __future__ import annotations

from datetime import date

import pytest

from assistant import calendar_store, obsidian_tools

SEM = "Semester 3 (2026-27)"

TIMETABLE = """\
---
oni: true
---

# Semester 3 — Class Timetable

## 2026-27 Semester 1
| Course code | Course (calendar title) | Section | Day | Time (HKT) | Room | Recurrence | First date | Last date | Sessions | Excluded weekly dates |
|---|---|---|---|---|---|---|---|---|---|---|
| COMP2119 | Introduction to data structures and algorithms | 1A | Tue | 13:00–14:50 | CYPP2 | weekly | Tue 1 Sep 2026 | Tue 24 Nov 2026 | 12 | Tue 13 Oct 2026 |
| CCHU9053 | Contested Words, Disputed Symbols | 1A | Wed | 15:00–16:50 | Centennial Campus CPD-LG.08 | weekly | Wed 2 Sep 2026 | Wed 16 Sep 2026 | 2 | Wed 9 Sep 2026 |

### Sem 1 by weekday
| Day | Time (HKT) | Course code | Room |
|---|---|---|---|
| Tue | 13:00–14:50 | COMP2119 | CYPP2 |
"""

DEADLINES = """\
# Semester 3 — All Deadlines

## Chronological list
| Date | Course | Item | Weight |
| --- | --- | --- | --- |
| Wed 30 Sep 2026, 19:00 | COMP2119 | WA1 — Recursion and Algorithm Analysis (one PDF, Moodle) | part of 10% (3 WAs) |
| Thu 22 Oct 2026, 10:00–11:50 | COMP2501 | Mid-term exam (2-hour in-class Moodle quiz; no make-up) | 20% |
| Tue 27 Oct 2026, 13:00–14:50 | COMP2119 | In-class quiz (lecture slot, CYPP2; date confirmed by Mohit) | 20% |
| Fri 18 Sep 2026 (time not stated) | AILT9009 | Group Proposal (~300 words, one per group) | 20% |
| Week of Mon 2 Nov – Fri 6 Nov 2026 (probably Fri 6 Nov; time not stated) | AILT9009 | Individual AI Portfolio and Group Poster Project | 20% and 40% |
| Thu 26 Nov 2026 and Mon 30 Nov 2026 (in class) | COMP2501 | Optional in-class project presentations | bonus |
| Fri 4 Dec 2026, 17:00 (hard copy) and 23:59 (Turnitin soft copy) | CCCH9053 | Case Study final report, group, 6,000 words. The brief says 17:00. | 20% |

## Events with no date in the materials
- **MATH2014 final exam** (50%): "in the exam period".
- **COMP2119 final exam** (60%): date not stated.

## Late and missed-work rules by course
- A bullet under a heading that is not an undated section.
"""

TUTORIALS = """\
## Weekly sessions
| Course | Item | Day | Time (HKT) | Room | First date | Last date | Excluded weekly dates | Kind |
|---|---|---|---|---|---|---|---|---|
| COMP1117 | STA tutorial | Tue | 12:00–12:50 | — | Tue 15 Sep 2026 | Tue 29 Sep 2026 | — | tutorial |

## Dated sessions
| Date | Time (HKT) | Course | Item | Room | Kind |
|---|---|---|---|---|---|
| Wed 16 Sep 2026 | TBC | MATH2014 | Tutorial 1 (week of 16 Sep; slot not in the materials) | — | tutorial |

## Not yet placed (your slot is not in the vault)
- **AILT9009 tutorials:** group not recorded.
"""


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    (root / SEM).mkdir(parents=True)
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", root)

    def write(name: str, text: str) -> None:
        (root / SEM / name).write_text(text, encoding="utf-8")

    return write


def _by_kind(data, kind):
    return [e for e in data.events if e.kind == kind]


# --- weekly sessions ------------------------------------------------------------


def test_weekly_rows_expand_to_one_event_per_session_minus_excluded_weeks(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    data = calendar_store.load_calendar()

    comp = [e for e in data.events if e.course == "COMP2119"]
    assert len(comp) == 12  # 13 Tuesdays 1 Sep..24 Nov, less the 13 Oct gap
    assert "2026-10-13" not in {e.date for e in comp}
    assert comp[0].date == "2026-09-01"
    assert comp[-1].date == "2026-11-24"
    assert (comp[0].start_time, comp[0].end_time, comp[0].location) == ("13:00", "14:50", "CYPP2")
    assert all(e.kind == "class" for e in comp)
    assert data.warnings == []  # the Sessions column agrees with the expansion


def test_the_calendar_course_code_alias_is_normalised(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    data = calendar_store.load_calendar()
    ccch = [e for e in data.events if e.course == "CCCH9053"]
    assert [e.date for e in ccch] == ["2026-09-02", "2026-09-16"]
    assert not any(e.course == "CCHU9053" for e in data.events)


def test_the_by_weekday_summary_tables_are_not_counted_twice(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    data = calendar_store.load_calendar()
    assert len(data.events) == 12 + 2


def test_a_sessions_count_that_disagrees_is_reported_not_hidden(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE.replace("| 12 |", "| 11 |"))
    data = calendar_store.load_calendar()
    assert any("note says 11 sessions, expanded to 12" in w for w in data.warnings)
    assert len([e for e in data.events if e.course == "COMP2119"]) == 12


# --- dated rows -------------------------------------------------------------------


def test_the_comp2119_quiz_is_on_27_oct_in_the_lecture_slot(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    quiz = next(e for e in data.events if e.title == "In-class quiz")
    assert quiz.date == "2026-10-27"
    assert date.fromisoformat(quiz.date).strftime("%a") == "Tue"
    assert (quiz.start_time, quiz.end_time, quiz.course) == ("13:00", "14:50", "COMP2119")
    assert quiz.kind == "exam"
    assert quiz.weight == "20%"
    assert data.warnings == []


def test_times_in_the_date_cell_are_read_and_a_missing_time_is_left_empty(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    wa1 = next(e for e in data.events if e.title.startswith("WA1"))
    assert (wa1.date, wa1.start_time, wa1.end_time) == ("2026-09-30", "19:00", None)
    proposal = next(e for e in data.events if e.title == "Group Proposal")
    assert (proposal.start_time, proposal.note) == (None, "time not stated")
    # `tbc` marks a session whose Time column says so; a deadline with no time
    # is ordinary (it shows as all-day) and already carries the note above.
    assert proposal.tbc is False


def test_exam_words_make_an_exam_and_everything_else_a_deadline(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    assert {e.title for e in _by_kind(data, "exam")} == {"Mid-term exam", "In-class quiz"}
    assert "Group Proposal" in {e.title for e in _by_kind(data, "deadline")}


def test_a_week_of_range_is_one_window_with_an_end_date(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    portfolio = next(e for e in data.events if e.title.startswith("Individual AI Portfolio"))
    assert (portfolio.date, portfolio.end_date) == ("2026-11-02", "2026-11-06")
    assert portfolio.note == "probably Fri 6 Nov; time not stated"


def test_two_dates_joined_by_and_are_two_events(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    talks = [e for e in data.events if e.title == "Optional in-class project presentations"]
    assert [e.date for e in talks] == ["2026-11-26", "2026-11-30"]
    assert all(e.end_date is None for e in talks)


def test_a_long_item_keeps_a_short_title_and_the_full_text_as_detail(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    data = calendar_store.load_calendar()
    report = next(e for e in data.events if e.course == "CCCH9053")
    assert report.title == "Case Study final report, group, 6,000 words"
    assert report.detail == "Case Study final report, group, 6,000 words. The brief says 17:00."
    assert report.start_time == "17:00"  # first time only; "23:59" is in the parenthetical


def test_a_weekday_that_does_not_match_its_date_is_reported(vault):
    vault(
        "Semester 3 — Deadlines.md",
        "| Date | Course | Item | Weight |\n|---|---|---|---|\n"
        "| Mon 27 Oct 2026 | COMP2119 | In-class quiz | 20% |\n",
    )
    data = calendar_store.load_calendar()
    assert any("27 Oct 2026" in w and "Tue" in w and "not a Mon" in w for w in data.warnings)
    assert data.events[0].date == "2026-10-27"  # the date wins; the weekday is the typo


def test_a_row_with_no_date_is_skipped_with_a_warning(vault):
    vault(
        "Semester 3 — Deadlines.md",
        "| Date | Course | Item | Weight |\n|---|---|---|---|\n| soon | COMP2119 | Mystery | 5% |\n",
    )
    data = calendar_store.load_calendar()
    assert data.events == []
    assert any("no date found" in w for w in data.warnings)


# --- tutorials note ---------------------------------------------------------------


def test_the_tutorials_note_adds_tutorial_events_and_tbc_slots(vault):
    vault("Semester 3 — Tutorials.md", TUTORIALS)
    data = calendar_store.load_calendar()
    sta = [e for e in data.events if e.course == "COMP1117"]
    assert [e.date for e in sta] == ["2026-09-15", "2026-09-22", "2026-09-29"]
    assert all(e.kind == "tutorial" and e.start_time == "12:00" for e in sta)
    assert all(e.location is None for e in sta)  # "—" is no room, not a room called "—"
    math = next(e for e in data.events if e.course == "MATH2014")
    assert (math.kind, math.date, math.start_time, math.tbc) == (
        "tutorial",
        "2026-09-16",
        None,
        True,
    )
    assert math.title == "Tutorial 1"


def test_an_unknown_kind_falls_back_with_a_warning(vault):
    vault(
        "Semester 3 — Tutorials.md",
        TUTORIALS.replace("| tutorial |\n\n## Dated", "| lab |\n\n## Dated"),
    )
    data = calendar_store.load_calendar()
    assert any("unknown kind 'lab'" in w for w in data.warnings)
    assert {e.kind for e in data.events if e.course == "COMP1117"} == {"class"}


# --- undated list, courses, whole-vault behaviour -----------------------------------


def test_undated_items_come_only_from_a_no_date_section(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    vault("Semester 3 — Tutorials.md", TUTORIALS)
    data = calendar_store.load_calendar()
    texts = [u["text"] for u in data.undated]
    assert texts == [
        'MATH2014 final exam (50%): "in the exam period".',
        "COMP2119 final exam (60%): date not stated.",
        "AILT9009 tutorials: group not recorded.",
    ]
    assert not any("not an undated section" in t for t in texts)


def test_courses_are_unique_sorted_and_titled_from_class_rows(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    vault("Semester 3 — Tutorials.md", TUTORIALS)
    data = calendar_store.load_calendar()
    codes = [c["code"] for c in data.courses]
    assert codes == sorted(set(codes))
    titles = {c["code"]: c["title"] for c in data.courses}
    assert titles["COMP2119"] == "Introduction to data structures and algorithms"
    assert titles["COMP1117"] == ""  # tutorial-only course: no class title to borrow


def test_events_are_sorted_by_date_then_time(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    vault("Semester 3 — Deadlines.md", DEADLINES)
    vault("Semester 3 — Tutorials.md", TUTORIALS)
    events = calendar_store.load_calendar().events
    keys = [(e.date, e.start_time or "99:99") for e in events]
    assert keys == sorted(keys)


def test_course_notes_named_deadlines_are_not_mistaken_for_the_semester_note(vault, tmp_path):
    """`COMP2119 — Deadlines and Assessment.md` does not end in "— Deadlines.md"
    and does not start with "Semester"; neither may be picked up."""
    vault("COMP2119 — Deadlines and Assessment.md", DEADLINES)
    vault("Notes — Deadlines.md", DEADLINES)
    assert calendar_store.load_calendar().events == []


def test_a_missing_vault_is_an_empty_calendar(tmp_path, monkeypatch):
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", tmp_path / "does-not-exist")
    data = calendar_store.load_calendar()
    assert (data.events, data.undated, data.courses, data.warnings) == ([], [], [], [])


def test_an_unreadable_note_is_skipped_and_reported(vault, tmp_path):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    vault("Semester 3 — Class Timetable.md", "")
    bad = obsidian_tools.VAULT_DIR / SEM / "Semester 3 — Tutorials.md"
    bad.write_bytes(b"\xff\xfe\x00 not utf-8 \xc3\x28")
    data = calendar_store.load_calendar()
    assert any("Tutorials" in w and "could not read" in w for w in data.warnings)
    assert any(e.title == "In-class quiz" for e in data.events)  # the other notes still load


# --- endpoint --------------------------------------------------------------------------


def _client(**kwargs):
    from fastapi.testclient import TestClient

    from assistant import server

    return TestClient(server.app, **kwargs)  # no `with`: the real lifespan must not run


def test_the_endpoint_serves_the_parsed_calendar(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    body = _client(base_url="http://127.0.0.1:8000").get("/calendar").json()
    assert set(body) == {"events", "undated", "courses", "sources", "warnings"}
    quiz = next(e for e in body["events"] if e["title"] == "In-class quiz")
    assert (quiz["date"], quiz["start_time"], quiz["kind"]) == ("2026-10-27", "13:00", "exam")
    assert body["sources"] == ["Semester 3 — Deadlines"]


def test_the_endpoint_rereads_the_notes_on_every_call(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    client = _client(base_url="http://127.0.0.1:8000")
    first = next(
        e for e in client.get("/calendar").json()["events"] if e["title"] == "In-class quiz"
    )
    assert first["date"] == "2026-10-27"
    vault("Semester 3 — Deadlines.md", DEADLINES.replace("Tue 27 Oct 2026", "Tue 3 Nov 2026"))
    second = next(
        e for e in client.get("/calendar").json()["events"] if e["title"] == "In-class quiz"
    )
    assert second["date"] == "2026-11-03"


def test_only_this_computer_may_read_the_calendar(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    assert _client(client=("203.0.113.9", 4242)).get("/calendar").status_code == 403
    assert (
        _client(client=("127.0.0.1", 4242), base_url="http://evil.example")
        .get("/calendar")
        .status_code
        == 403
    )
    assert (
        _client(client=("127.0.0.1", 4242), base_url="http://127.0.0.1:8000")
        .get("/calendar")
        .status_code
        == 200
    )


# --- writing: the "Added Events" note ---------------------------------------------

EXAM = {
    "title": "COMP2119 Final exam",
    "date": "2026-12-12",
    "kind": "exam",
    "course": "COMP2119",
    "start_time": "09:30",
    "end_time": "12:30",
    "location": "Hong Kong Stadium",
}


def _added_text(root=None):
    return calendar_store.added_note_path().read_text(encoding="utf-8")


def test_added_events_appear_in_the_calendar_and_land_in_one_note(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    before = (obsidian_tools.VAULT_DIR / SEM / "Semester 3 — Deadlines.md").read_bytes()

    [added] = calendar_store.add_events([EXAM])

    data = calendar_store.load_calendar()
    final = next(e for e in data.events if e.title == "COMP2119 Final exam")
    assert (final.date, final.start_time, final.end_time) == ("2026-12-12", "09:30", "12:30")
    assert (final.kind, final.course, final.location) == ("exam", "COMP2119", "Hong Kong Stadium")
    assert final.id == added.id and final.source == calendar_store.ADDED_TITLE
    assert calendar_store.ADDED_TITLE in data.sources
    assert data.warnings == []
    # the hand-maintained note is never rewritten
    assert (obsidian_tools.VAULT_DIR / SEM / "Semester 3 — Deadlines.md").read_bytes() == before
    text = _added_text()
    assert text.startswith("---\noni: true\n") and "Sat 12 Dec 2026" in text


def test_a_multi_day_window_and_a_tbc_time_round_trip(vault):
    calendar_store.add_events(
        [
            {"title": "Project week", "date": "2026-11-02", "end_date": "2026-11-06", "course": "AILT9009"},
            {"title": "MATH2014 Final", "date": "2026-12-15", "kind": "exam", "course": "MATH2014"},
        ]
    )
    events = {e.title: e for e in calendar_store.load_calendar().events}
    assert (events["Project week"].date, events["Project week"].end_date) == ("2026-11-02", "2026-11-06")
    assert events["Project week"].kind == "deadline"  # the default
    assert events["MATH2014 Final"].start_time is None


def test_a_bad_event_adds_nothing_and_names_the_culprit(vault):
    with pytest.raises(calendar_store.CalendarEditError, match=r"event 2 \('Bad'\).*YYYY-MM-DD"):
        calendar_store.add_events([EXAM, {"title": "Bad", "date": "12/12/2026"}])
    assert not calendar_store.added_note_path().exists()


@pytest.mark.parametrize(
    "patch, message",
    [
        ({"kind": "party"}, "kind must be one of"),
        ({"start_time": "9:30"}, "HH:MM"),
        ({"end_date": "2026-12-01"}, "before date"),
        ({"title": "  "}, "needs a title"),
        ({"start_time": None, "end_time": "10:00"}, "needs a start_time"),
    ],
)
def test_validation_messages(vault, patch, message):
    with pytest.raises(calendar_store.CalendarEditError, match=message):
        calendar_store.add_events([{**EXAM, **patch}])


def test_pipes_and_newlines_in_text_cannot_break_the_table(vault):
    calendar_store.add_events([{**EXAM, "title": "Exam | part A\nand B", "location": "Room 1 | 2"}])
    [e] = [e for e in calendar_store.load_calendar().events if e.course == "COMP2119"]
    assert e.title == "Exam / part A and B" and e.location == "Room 1 / 2"


def test_editing_an_added_event_changes_its_row_in_place(vault):
    [added] = calendar_store.add_events([EXAM])
    new = calendar_store.update_event(added.id, {"date": "2026-12-14", "start_time": "14:30", "end_time": "17:30"})
    events = [e for e in calendar_store.load_calendar().events if e.course == "COMP2119"]
    assert [(e.date, e.start_time) for e in events] == [("2026-12-14", "14:30")]
    assert new.date == "2026-12-14"
    assert _added_text().count("Final exam") == 1


def test_editing_an_event_from_another_note_hides_the_original_and_adds_a_copy(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    mid = next(e for e in calendar_store.load_calendar().events if e.title.startswith("Mid-term exam"))
    new = calendar_store.update_event(mid.id, {"date": "2026-10-23", "location": "MWT2"})

    mids = [e for e in calendar_store.load_calendar().events if e.title.startswith("Mid-term exam")]
    assert len(mids) == 1
    [moved] = mids
    assert (moved.date, moved.location, moved.weight) == ("2026-10-23", "MWT2", "20%")
    assert moved.title.startswith("Mid-term exam") and moved.start_time == "10:00"
    assert moved.id == new.id and moved.source == calendar_store.ADDED_TITLE
    assert f"`{mid.id}`" in _added_text()


def test_an_edit_that_keeps_the_id_still_shows_once(vault):
    # only the room changes, so the replacement has the cancelled original's id
    vault("Semester 3 — Deadlines.md", DEADLINES)
    quiz = next(e for e in calendar_store.load_calendar().events if e.title == "In-class quiz")
    calendar_store.update_event(quiz.id, {"location": "KK101"})
    quizzes = [e for e in calendar_store.load_calendar().events if e.title == "In-class quiz"]
    assert [(q.location, q.source) for q in quizzes] == [("KK101", calendar_store.ADDED_TITLE)]


def test_deleting_one_session_of_a_weekly_class_hides_only_that_session(vault):
    vault("Semester 3 — Class Timetable.md", TIMETABLE)
    sessions = [e for e in calendar_store.load_calendar().events if e.course == "COMP2119"]
    gone = calendar_store.delete_event(sessions[2].id)
    after = [e for e in calendar_store.load_calendar().events if e.course == "COMP2119"]
    assert len(after) == len(sessions) - 1 and gone.id not in {e.id for e in after}


def test_deleting_an_added_event_removes_its_row(vault):
    [a, b] = calendar_store.add_events([EXAM, {**EXAM, "title": "Other", "date": "2026-12-13"}])
    calendar_store.delete_event(a.id)
    assert [e.title for e in calendar_store.load_calendar().events] == ["Other"]
    assert b.id in {e.id for e in calendar_store.load_calendar().events}


def test_unknown_ids_are_refused(vault):
    with pytest.raises(calendar_store.CalendarEditError, match="no calendar event"):
        calendar_store.delete_event("exam:X:2026-01-01:nope")
    with pytest.raises(calendar_store.CalendarEditError, match="no calendar event"):
        calendar_store.update_event("exam:X:2026-01-01:nope", {"title": "x"})


def test_changing_an_unknown_field_is_refused(vault):
    [a] = calendar_store.add_events([EXAM])
    with pytest.raises(calendar_store.CalendarEditError, match="cannot change"):
        calendar_store.update_event(a.id, {"id": "hacked"})


def test_a_cancelled_id_that_no_longer_exists_is_a_warning(vault):
    vault("Semester 3 — Deadlines.md", DEADLINES)
    mid = next(e for e in calendar_store.load_calendar().events if e.title.startswith("Mid-term exam"))
    calendar_store.delete_event(mid.id)
    vault("Semester 3 — Deadlines.md", DEADLINES.replace("Mid-term exam", "Midterm"))
    assert any("no longer exists" in w for w in calendar_store.load_calendar().warnings)


def test_hand_edits_to_the_added_note_survive_the_next_change(vault):
    calendar_store.add_events([EXAM])
    path = calendar_store.added_note_path()
    path.write_text(
        path.read_text(encoding="utf-8").replace("Hong Kong Stadium", "Rm 301"), encoding="utf-8"
    )
    calendar_store.add_events([{**EXAM, "title": "Other", "date": "2026-12-13"}])
    locs = {e.title: e.location for e in calendar_store.load_calendar().events}
    assert locs == {"COMP2119 Final exam": "Rm 301", "Other": "Hong Kong Stadium"}


def test_the_added_note_keeps_its_created_date(vault):
    calendar_store.add_events([EXAM])
    path = calendar_store.added_note_path()
    path.write_text(path.read_text(encoding="utf-8").replace(f"created: {date.today().isoformat()}", "created: 2026-01-02"), encoding="utf-8")
    calendar_store.add_events([{**EXAM, "title": "Other", "date": "2026-12-13"}])
    assert "created: 2026-01-02" in _added_text()


# --- the edit endpoints -------------------------------------------------------------


def _local():
    return _client(base_url="http://127.0.0.1:8000")


def test_post_patch_delete_round_trip_over_http(vault):
    c = _local()
    created = c.post("/calendar/events", json={"title": "Final", "date": "2026-12-12", "kind": "exam", "course": "COMP2119"})
    assert created.status_code == 200
    eid = created.json()["id"]

    patched = c.patch("/calendar/events", params={"id": eid}, json={"start_time": "09:30", "end_time": "12:30"})
    assert patched.status_code == 200 and patched.json()["start_time"] == "09:30"
    assert [e["start_time"] for e in c.get("/calendar").json()["events"]] == ["09:30"]

    assert c.delete("/calendar/events", params={"id": patched.json()["id"]}).status_code == 200
    assert c.get("/calendar").json()["events"] == []


def test_a_refused_edit_is_a_400_with_the_reason(vault):
    c = _local()
    r = c.post("/calendar/events", json={"title": "x", "date": "tomorrow"})
    assert r.status_code == 400 and "YYYY-MM-DD" in r.json()["detail"]
    assert c.delete("/calendar/events", params={"id": "nope"}).status_code == 400


def test_a_patch_can_clear_a_time_with_an_explicit_null(vault):
    c = _local()
    eid = c.post("/calendar/events", json={"title": "Final", "date": "2026-12-12", "start_time": "09:30"}).json()["id"]
    r = c.patch("/calendar/events", params={"id": eid}, json={"start_time": None})
    assert r.status_code == 200 and r.json()["start_time"] is None


def test_only_this_computer_may_edit_the_calendar(vault):
    remote = _client(client=("203.0.113.9", 4242))
    assert remote.post("/calendar/events", json={"title": "x", "date": "2026-12-12"}).status_code == 403
    assert remote.patch("/calendar/events", params={"id": "a"}, json={}).status_code == 403
    assert remote.delete("/calendar/events", params={"id": "a"}).status_code == 403
    assert not calendar_store.added_note_path().exists()
