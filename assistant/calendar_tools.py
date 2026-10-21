"""Oni's own semester calendar as agent tools — list, add, edit, remove.

Built at the user's request after a Stage run ("update these exams into my
calendar", with the exam schedule on screen) had nothing to write to: the
Calendar tab was a read-only view over vault notes. These tools write through
`calendar_store` (its docstring explains the single "Calendar — Added Events"
note every change lands in), the same code the dashboard's Add/Edit/Delete
buttons call, so the two can never disagree about what a valid event is.

**Owned by `life_admin_agent`** (next to the board tools), at the user's
request; they started on the supervisor itself. The cost of that: a
specialist call is an isolated `ainvoke()` that only sees the text the
supervisor hands it, so a screenshot of an exam timetable — an image in the
*user's* message — is invisible to it. The supervisor therefore has to read
the dates off the image and spell every event out in its instruction (its
prompt says so); a date the supervisor misreads or drops is lost at that
hop, where on the supervisor the model that saw the image wrote the rows.

**Fully ungated.** Same category as the board and the vault (board_tools.py
has the full reasoning): local, in-app, visible on the Calendar tab, and
reversible — one note, no external system, nobody else's calendar. This is NOT
Apple Calendar (mac_control_agent) or Google Calendar (life_admin_agent): those
touch other systems and keep their gates.
"""

from __future__ import annotations

from datetime import date

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from assistant import calendar_store

MAX_ADD = 40
MAX_LIST = 60


class CalendarEventSpec(BaseModel):
    """One event to add."""

    title: str = Field(description="What it is, e.g. 'Final exam' or 'Group Proposal due'.")
    date: str = Field(description="YYYY-MM-DD. The first day, for a multi-day window.")
    kind: str = Field(
        default="exam",
        description="exam | deadline | class | tutorial | study. Use exam for tests/finals/quizzes, "
        "deadline for assignments and submissions.",
    )
    course: str = Field(default="", description="Course code such as COMP2119, if there is one.")
    start_time: str | None = Field(default=None, description="HH:MM, 24-hour, Hong Kong time.")
    end_time: str | None = Field(default=None, description="HH:MM, 24-hour; needs start_time.")
    end_date: str | None = Field(default=None, description="YYYY-MM-DD, only for a multi-day window.")
    location: str | None = Field(default=None, description="Room or venue.")
    weight: str | None = Field(default=None, description="Grade weight, e.g. '40%'.")


def _line(e: calendar_store.CalendarEvent) -> str:
    when = e.date + (f" → {e.end_date}" if e.end_date else "")
    if e.start_time:
        when += f" {e.start_time}" + (f"–{e.end_time}" if e.end_time else "")
    elif e.tbc:
        when += " (time TBC)"
    extra = " · ".join(x for x in (e.location, e.weight) if x)
    return f"{when} | {e.kind} | {e.course} | {e.title}" + (f" | {extra}" if extra else "") + f"\n    id: {e.id}"


@tool
def oni_calendar_list(
    from_date: str = "", to_date: str = "", course: str = "", kind: str = ""
) -> str:
    """List events on Oni's own semester calendar (the dashboard's Calendar
    tab: classes, tutorials, exams, deadlines). Use it to find an event's `id`
    before editing or removing it, or to check what's already there before
    adding. NOT Apple Calendar and NOT Google Calendar.

    Args:
        from_date: YYYY-MM-DD, inclusive. Default: today.
        to_date: YYYY-MM-DD, inclusive. Default: no limit.
        course: Only this course code, e.g. COMP2119.
        kind: Only exam | deadline | class | tutorial | study.
    """
    try:
        start = date.fromisoformat(from_date) if from_date else date.today()
        end = date.fromisoformat(to_date) if to_date else None
    except ValueError:
        return "Error: from_date and to_date must be YYYY-MM-DD."
    events = [
        e
        for e in calendar_store.load_calendar().events
        if (e.end_date or e.date) >= start.isoformat()
        and (end is None or e.date <= end.isoformat())
        and (not course or e.course.upper() == course.upper())
        and (not kind or e.kind == kind)
    ]
    if not events:
        return "No matching events."
    shown = events[:MAX_LIST]
    out = "\n".join(_line(e) for e in shown)
    if len(events) > len(shown):
        out += f"\n… {len(events) - len(shown)} more; narrow with from_date/to_date/course/kind."
    return out


@tool
def oni_calendar_add(events: list[CalendarEventSpec]) -> str:
    """Add one or more events to Oni's own semester calendar (the dashboard's
    Calendar tab). Use this for 'put these exams in my calendar', 'add my
    final on 12 Dec', a schedule read off a screenshot, etc. Put ALL the events
    in one call. All-or-nothing: if any one is invalid nothing is added and the
    error names it. Dates are YYYY-MM-DD and times are Hong Kong time. Check
    oni_calendar_list first so you don't add something that is already there.
    NOT Apple Calendar or Google Calendar.
    """
    if len(events) > MAX_ADD:
        return f"Error: at most {MAX_ADD} events per call; split it into smaller calls."
    try:
        added = calendar_store.add_events([e.model_dump() for e in events])
    except calendar_store.CalendarEditError as exc:
        return f"Error: {exc}. Nothing was added."
    return f"Added {len(added)} event(s):\n" + "\n".join(_line(e) for e in added)


@tool
def oni_calendar_edit(
    event_id: str,
    title: str | None = None,
    date: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    end_date: str | None = None,
    kind: str | None = None,
    course: str | None = None,
    location: str | None = None,
    weight: str | None = None,
) -> str:
    """Change one event on Oni's own semester calendar — move an exam, fix a
    time or room, rename it. Pass the `id` from oni_calendar_list and ONLY the
    fields to change. Works on any event, including ones that came from the
    vault's timetable/deadlines notes (those notes are left untouched; the
    change is stored separately). To clear a time pass an empty string for
    start_time and end_time.
    """
    changes = {
        k: v
        for k, v in {
            "title": title, "date": date, "start_time": start_time, "end_time": end_time,
            "end_date": end_date, "kind": kind, "course": course, "location": location,
            "weight": weight,
        }.items()
        if v is not None
    }
    # "" means clear, for the optional fields; the store treats None as unset.
    for k in ("start_time", "end_time", "end_date", "location", "weight"):
        if changes.get(k) == "":
            changes[k] = None
    if not changes:
        return "Error: nothing to change — pass at least one field."
    try:
        new = calendar_store.update_event(event_id, changes)
    except calendar_store.CalendarEditError as exc:
        return f"Error: {exc}"
    return "Updated:\n" + _line(new)


@tool
def oni_calendar_remove(event_ids: list[str]) -> str:
    """Remove events from Oni's own semester calendar by `id` (from
    oni_calendar_list). Events added through Oni are deleted; events that come
    from the vault's timetable/deadlines notes are hidden instead (those notes
    are never rewritten). Only remove what the user asked you to remove. NOT
    Apple Calendar or Google Calendar.
    """
    if len(event_ids) > MAX_ADD:
        return f"Error: at most {MAX_ADD} events per call."
    done: list[str] = []
    errors: list[str] = []
    for event_id in event_ids:
        try:
            done.append(_line(calendar_store.delete_event(event_id)))
        except calendar_store.CalendarEditError as exc:
            errors.append(str(exc))
    out = f"Removed {len(done)} event(s)." + ("\n" + "\n".join(done) if done else "")
    if errors:
        out += "\nCould not remove:\n" + "\n".join(errors)
    return out


TOOLS = [oni_calendar_list, oni_calendar_add, oni_calendar_edit, oni_calendar_remove]


def build_calendar_tools() -> list:
    return list(TOOLS)
