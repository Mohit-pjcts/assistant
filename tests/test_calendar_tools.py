"""Tests for assistant.calendar_tools — Oni's own semester calendar as
supervisor tools. Everything runs against a throwaway vault; no model calls."""

from __future__ import annotations

import pytest

from assistant import calendar_store, calendar_tools, obsidian_tools


@pytest.fixture(autouse=True)
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", tmp_path / "vault")
    return tmp_path / "vault"


EXAMS = [
    {"title": "COMP2119 Final exam", "date": "2026-12-12", "kind": "exam", "course": "COMP2119",
     "start_time": "09:30", "end_time": "12:30", "location": "Hong Kong Stadium"},
    {"title": "MATH2014 Final exam", "date": "2026-12-15", "kind": "exam", "course": "MATH2014"},
]


def _id_of(listing: str, title: str) -> str:
    lines = listing.splitlines()
    i = next(i for i, ln in enumerate(lines) if title in ln)
    return lines[i + 1].split("id: ", 1)[1]


def test_add_then_list_shows_every_event_with_its_id():
    out = calendar_tools.oni_calendar_add.invoke({"events": EXAMS})
    assert out.startswith("Added 2 event(s)") and "2026-12-12 09:30–12:30" in out
    listing = calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01"})
    assert "COMP2119 Final exam" in listing and "MATH2014 Final exam" in listing
    assert _id_of(listing, "MATH2014").startswith("exam:MATH2014:2026-12-15:")


def test_list_filters_by_course_kind_and_range():
    calendar_tools.oni_calendar_add.invoke({"events": EXAMS})
    only = calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01", "course": "math2014"})
    assert "MATH2014" in only and "COMP2119" not in only
    assert calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01", "kind": "class"}) == "No matching events."
    assert "MATH2014" not in calendar_tools.oni_calendar_list.invoke(
        {"from_date": "2026-01-01", "to_date": "2026-12-13"}
    )


def test_list_defaults_to_upcoming_events_only():
    calendar_tools.oni_calendar_add.invoke(
        {"events": [{"title": "Long ago", "date": "2020-01-01"}]}
    )
    assert calendar_tools.oni_calendar_list.invoke({}) == "No matching events."


def test_a_bad_event_is_an_error_string_and_adds_nothing():
    out = calendar_tools.oni_calendar_add.invoke(
        {"events": [EXAMS[0], {"title": "Bad", "date": "12/12"}]}
    )
    assert out.startswith("Error:") and "Nothing was added" in out
    assert not calendar_store.added_note_path().exists()


def test_the_add_cap_is_enforced():
    many = [{"title": f"e{i}", "date": "2026-12-12"} for i in range(calendar_tools.MAX_ADD + 1)]
    assert "at most" in calendar_tools.oni_calendar_add.invoke({"events": many})


def test_edit_changes_only_the_named_fields_and_can_clear_a_time():
    calendar_tools.oni_calendar_add.invoke({"events": EXAMS})
    listing = calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01"})
    eid = _id_of(listing, "COMP2119")

    out = calendar_tools.oni_calendar_edit.invoke({"event_id": eid, "date": "2026-12-14"})
    assert out.startswith("Updated:") and "2026-12-14 09:30–12:30" in out and "Hong Kong Stadium" in out

    new_id = _id_of(out, "COMP2119")
    cleared = calendar_tools.oni_calendar_edit.invoke(
        {"event_id": new_id, "start_time": "", "end_time": ""}
    )
    assert "09:30" not in cleared


def test_edit_with_nothing_to_change_or_a_bad_id_is_an_error_string():
    assert calendar_tools.oni_calendar_edit.invoke({"event_id": "x"}).startswith("Error: nothing")
    assert "no calendar event" in calendar_tools.oni_calendar_edit.invoke(
        {"event_id": "x", "title": "y"}
    )


def test_remove_reports_what_went_and_what_could_not():
    calendar_tools.oni_calendar_add.invoke({"events": EXAMS})
    eid = _id_of(calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01"}), "COMP2119")
    out = calendar_tools.oni_calendar_remove.invoke({"event_ids": [eid, "nope"]})
    assert out.startswith("Removed 1 event(s).") and "Could not remove" in out and "nope" in out
    assert "COMP2119" not in calendar_tools.oni_calendar_list.invoke({"from_date": "2026-01-01"})


def test_life_admin_owns_the_tools_and_the_supervisor_delegates_with_text():
    from assistant import supervisor as sup
    from assistant.sub_agents import LIFE_ADMIN_SYSTEM_PROMPT_FALLBACK

    names = {t.name for t in calendar_tools.build_calendar_tools()}
    assert names == {"oni_calendar_list", "oni_calendar_add", "oni_calendar_edit", "oni_calendar_remove"}
    for name in names:
        assert name in LIFE_ADMIN_SYSTEM_PROMPT_FALLBACK
    prompt = sup.SUPERVISOR_SYSTEM_PROMPT_FALLBACK
    # routing: the disambiguation that stops "my exams" going to Apple Calendar
    assert "belongs to life_admin_agent" in prompt
    assert "DEFAULT for anything about the user's courses" in prompt
    # the cost of the move: a specialist never sees the image, so the
    # supervisor must put every event into the instruction as text
    assert "NEVER sees an attached image" in prompt
    assert "EVERY event into the instruction as text" in prompt
    # and the supervisor no longer holds the tools itself
    assert "You also hold Oni's OWN semester calendar" not in prompt
