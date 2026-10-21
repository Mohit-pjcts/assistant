"""Semester calendar — classes, tutorials and deadlines, read straight from
the Obsidian vault's own notes (`obsidian_tools.VAULT_DIR`).

Built at the user's own direct request ("make a calendar space in oni, fill
it with all my classes/ttrs and deadlines"). There is deliberately **no
second copy of the data**: the calendar is a *view* over three kinds of note
that already exist in the vault, so correcting a date in the note (the user
fixed the COMP2119 quiz date this way) corrects the calendar the next time it
is fetched, and Oni's own vault search keeps seeing the same facts.

  - `<Semester> — Class Timetable.md`  weekly sessions, first/last date and
    excluded weeks per row (derived from the HKU `.ics` exports). Expanded
    here into one dated event per session.
  - `<Semester> — Deadlines.md`  the chronological deadline table, plus a
    "no date in the materials" bullet list that becomes the `undated` list.
  - `<Semester> — Tutorials.md`  optional, user-edited. Same two table
    shapes (weekly and dated) with an optional `Kind` column, for sessions
    the `.ics` files do not contain (tutorials, a TA slot, ...).

Parsing is by **column header, not position**, and every inconsistency is
reported in `warnings` (a weekday that does not match its date, a Sessions
count that disagrees with the expansion) rather than silently dropped, so a
typo in a note is visible in the dashboard instead of showing up as a
deadline on the wrong day.

**Writes (added later, at the user's request — Oni can now add, move and
remove calendar entries, and so can the dashboard):** every edit goes to ONE
note, `Calendar — Added Events.md`, never into the three notes above. Those are
hand-maintained tables (padded columns, multi-date cells, weekly rows that
expand to a dozen sessions), and rewriting a row in place would mean guessing
which source line produced a given event. Instead:

  - an *added* event is a row in that note's dated table (same shape and
    column headers the parser already reads, so a hand edit in Obsidian works);
  - *deleting* an event from any other note records its id under a
    `## Cancelled` heading, and `load_calendar` hides it;
  - *editing* one of those = cancel the original + add the changed copy.

So the original notes stay byte-for-byte untouched and every change is one
visible, revertable file. Fully ungated, like the board and the vault
(board_tools.py's docstring has the reasoning): local, in-app, reversible.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

# Read `obsidian_tools.VAULT_DIR` at call time instead of importing the name
# (the same rebinding gotcha diary_store.py documents): a test that
# monkeypatches the vault location then needs only one assignment.
from assistant import obsidian_tools

logger = logging.getLogger(__name__)

TIMETABLE_SUFFIX = "— Class Timetable.md"
DEADLINES_SUFFIX = "— Deadlines.md"
TUTORIALS_SUFFIX = "— Tutorials.md"

_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
        start=1,
    )
}
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

_DATE_RE = re.compile(
    r"\b(?:(?P<wd>Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?"
    r"(?P<d>\d{1,2})\s+"
    r"(?P<m>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"
    r"(?:,?\s+(?P<y>\d{4}))?\b",
    re.IGNORECASE,
)
_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})(?:\s*[–—-]\s*(\d{1,2}):(\d{2}))?")
_PAREN_RE = re.compile(r"\(([^)]*)\)")

# Column header -> canonical key. A table is recognised by which canonical
# keys it carries, not by its position or title.
_HEADER_KEYS = {
    "date": "date",
    "course code": "course",
    "course": "course",
    "course (calendar title)": "title",
    "item": "title",
    "day": "day",
    "time (hkt)": "time",
    "time": "time",
    "room": "room",
    "first date": "first",
    "last date": "last",
    "excluded weekly dates": "excluded",
    "sessions": "sessions",
    "weight": "weight",
    "kind": "kind",
}

# "study" is the user's own self-scheduled work blocks (the study plan), kept
# apart from the timetable's classes and tutorials.
KINDS = ("class", "tutorial", "study", "exam", "deadline")


@dataclass
class CalendarEvent:
    id: str
    date: str  # ISO start date
    title: str
    course: str
    kind: str  # one of KINDS
    end_date: str | None = None  # set for multi-day windows (inclusive)
    start_time: str | None = None  # "HH:MM", 24h HKT
    end_time: str | None = None
    location: str | None = None
    weight: str | None = None
    detail: str | None = None  # the full item text when `title` is shortened
    note: str | None = None  # e.g. "time not stated"
    tbc: bool = False  # a real session whose time/room is not in the vault
    source: str = ""


@dataclass
class CalendarData:
    events: list[CalendarEvent] = field(default_factory=list)
    undated: list[dict[str, str]] = field(default_factory=list)
    courses: list[dict[str, str]] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "events": [asdict(e) for e in self.events],
            "undated": self.undated,
            "courses": self.courses,
            "sources": self.sources,
            "warnings": self.warnings,
        }


# --- Markdown helpers ---------------------------------------------------------


def _clean(text: str) -> str:
    """Strip the Markdown a table cell carries: wikilinks, links, bold,
    code ticks, and collapse whitespace."""
    text = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.replace("**", "").replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def _split_row(line: str) -> list[str]:
    cells = re.split(r"(?<!\\)\|", line.strip())
    if cells and cells[0].strip() == "":
        cells = cells[1:]
    if cells and cells[-1].strip() == "":
        cells = cells[:-1]
    return [c.strip() for c in cells]


def _is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) for c in cells)


def _tables(text: str) -> list[tuple[list[str], list[list[str]]]]:
    """Every Markdown table in `text` as (header cells, body rows)."""
    out: list[tuple[list[str], list[list[str]]]] = []
    block: list[str] = []

    def flush() -> None:
        if len(block) >= 2:
            rows = [_split_row(line) for line in block]
            if len(rows) >= 2 and _is_separator(rows[1]):
                out.append((rows[0], rows[2:]))
        block.clear()

    for line in text.splitlines():
        if line.lstrip().startswith("|"):
            block.append(line)
        else:
            flush()
    flush()
    return out


def _canonical_header(header: list[str]) -> list[str | None]:
    return [_HEADER_KEYS.get(_clean(h).lower()) for h in header]


def _row_dict(keys: list[str | None], cells: list[str]) -> dict[str, str]:
    return {k: c for k, c in zip(keys, cells, strict=False) if k}


# --- Dates and times ----------------------------------------------------------


def _find_dates(text: str, warnings: list[str], where: str) -> list[tuple[date, int, int]]:
    """Every date in `text` as (date, match start, match end).

    A match without a year borrows the year of the next match that has one
    ("Mon 2 Nov – Fri 6 Nov 2026"). A leading weekday that disagrees with the
    date is reported, since it usually means a typo in the note."""
    matches = list(_DATE_RE.finditer(text))
    found: list[tuple[date, int, int]] = []
    for i, m in enumerate(matches):
        year = m.group("y")
        if year is None:
            for later in matches[i + 1 :]:
                if later.group("y"):
                    year = later.group("y")
                    break
        if year is None:
            continue
        try:
            d = date(int(year), _MONTHS[m.group("m").lower()[:3]], int(m.group("d")))
        except ValueError:
            warnings.append(f"{where}: impossible date {m.group(0)!r}")
            continue
        wd = m.group("wd")
        if wd and _WEEKDAYS[d.weekday()] != wd.lower()[:3]:
            warnings.append(
                f"{where}: {m.group(0)!r} is a {_WEEKDAYS[d.weekday()].title()}, not a {wd[:3].title()}"
            )
        found.append((d, m.start(), m.end()))
    return found


def _find_time(text: str) -> tuple[str | None, str | None]:
    m = _TIME_RE.search(text)
    if not m:
        return None, None
    start = f"{int(m.group(1)):02d}:{m.group(2)}"
    end = f"{int(m.group(3)):02d}:{m.group(4)}" if m.group(3) else None
    return start, end


def _course_code(raw: str) -> str:
    return _clean(raw).upper()


def _is_tbc(text: str) -> bool:
    return bool(re.search(r"\b(tbc|tba|not stated|to be confirmed)\b", text, re.IGNORECASE))


# --- Weekly sessions ----------------------------------------------------------


def _weekly_events(
    row: dict[str, str], source: str, warnings: list[str], default_kind: str
) -> list[CalendarEvent]:
    where = f"{source}: {row.get('course', '?')} {row.get('day', '')}"
    day = _clean(row.get("day", ""))[:3].lower()
    if day not in _WEEKDAYS:
        warnings.append(f"{where}: unrecognised weekday {row.get('day')!r}")
        return []
    first = _find_dates(row.get("first", ""), warnings, where)
    last = _find_dates(row.get("last", ""), warnings, where)
    if not first or not last:
        warnings.append(f"{where}: missing first/last date")
        return []
    start_d, end_d = first[0][0], last[0][0]
    excluded = {d for d, _, _ in _find_dates(row.get("excluded", ""), warnings, where)}
    time_text = row.get("time", "")
    start_t, end_t = _find_time(time_text)
    course = _course_code(row.get("course", ""))
    title = _clean(row.get("title", "")) or course
    # The two columns are literal Markdown, so "Introduction to data science"
    # is reused as-is; the kind column (Tutorials note) wins over the default.
    kind = _clean(row.get("kind", "")).lower() or default_kind
    if kind not in KINDS:
        warnings.append(f"{where}: unknown kind {kind!r}, shown as 'class'")
        kind = "class"
    room = _clean(row.get("room", ""))
    location = None if room in ("", "—", "-") else room
    events: list[CalendarEvent] = []
    d = start_d
    # Start from the first date, then step a week at a time (the first date
    # is by construction a `day`; a mismatch is already reported above).
    while d <= end_d:
        if d not in excluded and _WEEKDAYS[d.weekday()] == day:
            events.append(
                CalendarEvent(
                    id=f"{kind}:{course}:{d.isoformat()}:{start_t or ''}",
                    date=d.isoformat(),
                    title=title,
                    course=course,
                    kind=kind,
                    start_time=start_t,
                    end_time=end_t,
                    location=location,
                    tbc=start_t is None and _is_tbc(time_text),
                    source=source,
                )
            )
        d += timedelta(days=1 if _WEEKDAYS[d.weekday()] != day else 7)
    sessions = _clean(row.get("sessions", ""))
    if sessions.isdigit() and int(sessions) != len(events):
        warnings.append(f"{where}: note says {sessions} sessions, expanded to {len(events)}")
    return events


# --- Dated rows (deadlines, one-off sessions) ---------------------------------

_EXAM_WORDS = re.compile(r"\b(exam|test|quiz|mid-?term)\b", re.IGNORECASE)


def _short_title(item: str) -> str:
    """The item text up to its first parenthesis, semicolon or sentence end:
    deadline rows carry the whole brief in one cell."""
    head = re.split(r"\s+\(|;|\.\s", item, maxsplit=1)[0].strip(" ,")
    return (head[:90] + "…") if len(head) > 91 else head


def _dated_events(
    row: dict[str, str], source: str, warnings: list[str], default_kind: str | None
) -> list[CalendarEvent]:
    date_cell = row.get("date", "")
    course = _course_code(row.get("course", "")) or "—"
    item = _clean(row.get("title", ""))
    where = f"{source}: {course} {item[:40]}"
    notes = [n.strip() for n in _PAREN_RE.findall(date_cell) if n.strip()]
    bare = _PAREN_RE.sub("", date_cell)
    dates = _find_dates(bare, warnings, where)
    if not dates:
        warnings.append(f"{where}: no date found in {date_cell!r}")
        return []
    # An explicit Time column wins; otherwise a time can ride in the date cell
    # ("Wed 30 Sep 2026, 19:00" / "Thu 22 Oct 2026, 10:00–11:50").
    time_cell = _clean(row.get("time", ""))
    start_t, end_t = _find_time(time_cell or bare)
    kind = _clean(row.get("kind", "")).lower()
    if not kind:
        kind = default_kind or ("exam" if _EXAM_WORDS.search(item) else "deadline")
    if kind not in KINDS:
        warnings.append(f"{where}: unknown kind {kind!r}, shown as 'deadline'")
        kind = "deadline"
    tbc = _is_tbc(time_cell)
    weight = _clean(row.get("weight", "")) or None
    room = _clean(row.get("room", ""))
    location = None if room in ("", "—", "-") else room
    title = _short_title(item) or item
    detail = item if title != item else None
    note = "; ".join(notes) or None

    # "Mon 2 Nov – Fri 6 Nov 2026" is one window; "A and B" is two events.
    spans: list[tuple[date, date | None]] = []
    if len(dates) >= 2 and re.fullmatch(r"[–—-]", bare[dates[0][2] : dates[1][1]].strip()):
        spans.append((dates[0][0], dates[1][0]))
        for d, _, _ in dates[2:]:
            spans.append((d, None))
    else:
        spans.extend((d, None) for d, _, _ in dates)

    events = []
    for start_d, end_d in spans:
        events.append(
            CalendarEvent(
                id=f"{kind}:{course}:{start_d.isoformat()}:{title[:30]}",
                date=start_d.isoformat(),
                end_date=end_d.isoformat() if end_d and end_d != start_d else None,
                title=title,
                course=course,
                kind=kind,
                start_time=start_t,
                end_time=end_t,
                location=location,
                weight=weight,
                detail=detail,
                note=note,
                tbc=tbc,
                source=source,
            )
        )
    return events


# --- Undated bullets ----------------------------------------------------------

_UNDATED_HEADING = re.compile(
    r"no date|not yet placed|to be confirmed|\btbc\b|\btba\b", re.IGNORECASE
)


def _undated_items(text: str, source: str) -> list[dict[str, str]]:
    """Bullets under a heading like "Events with no date in the materials"."""
    items: list[dict[str, str]] = []
    in_section = False
    for line in text.splitlines():
        if line.startswith("#"):
            in_section = bool(_UNDATED_HEADING.search(line))
            continue
        if in_section and line.lstrip().startswith(("- ", "* ")):
            cleaned = _clean(line.lstrip()[2:])
            if cleaned:
                items.append({"text": cleaned, "source": source})
    return items


# --- Entry point ----------------------------------------------------------------


def _find_notes(suffix: str) -> list[Path]:
    root = obsidian_tools.VAULT_DIR
    if not root.is_dir():
        return []
    return sorted(
        p
        for p in root.rglob(f"*{suffix}")
        if p.name.startswith("Semester")
        and p.is_file()
        # A Conflict copy / trashed Note is not a live schedule source.
        and not obsidian_tools.in_reserved_dir(p, root)
    )


def _parse_note(text: str, source: str, data: CalendarData, default_kind: str | None) -> None:
    for header, rows in _tables(text):
        keys = _canonical_header(header)
        present = {k for k in keys if k}
        weekly = {"course", "day", "time", "first", "last"} <= present
        dated = {"date", "course", "title"} <= present
        if not (weekly or dated):
            continue
        for cells in rows:
            row = _row_dict(keys, cells)
            if weekly:
                data.events.extend(
                    _weekly_events(row, source, data.warnings, default_kind or "class")
                )
            else:
                data.events.extend(_dated_events(row, source, data.warnings, default_kind))
    data.undated.extend(_undated_items(text, source))


def load_calendar() -> CalendarData:
    """Parse every semester's timetable, deadlines and tutorials note in the
    vault into one calendar. A missing or unreadable note is skipped (and
    noted in `warnings`) so one bad file cannot blank the whole view."""
    data = CalendarData()
    for suffix in (TIMETABLE_SUFFIX, DEADLINES_SUFFIX, TUTORIALS_SUFFIX):
        for path in _find_notes(suffix):
            source = path.stem
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                data.warnings.append(f"{source}: could not read ({exc})")
                continue
            data.sources.append(source)
            _parse_note(text, source, data, "tutorial" if suffix == TUTORIALS_SUFFIX else None)

    # The same session can appear in two notes (a class listed in both the
    # timetable and the tutorials note); keep the first.
    _merge_added_events(data)

    seen: set[str] = set()
    unique: list[CalendarEvent] = []
    for e in data.events:
        if e.id in seen:
            continue
        seen.add(e.id)
        unique.append(e)
    unique.sort(key=lambda e: (e.date, e.start_time or "99:99", e.course, e.title))
    data.events = unique

    titles: dict[str, str] = {}
    for e in unique:
        if e.kind == "class" and e.course not in titles:
            titles[e.course] = e.title
    data.courses = [
        {"code": code, "title": titles.get(code, "")}
        for code in sorted({e.course for e in unique if e.course != "—"})
    ]
    return data


# --- Writing: the "Added Events" note -------------------------------------------

ADDED_TITLE = "Calendar — Added Events"
_ADDED_COLUMNS = ["Date", "Time (HKT)", "Course", "Item", "Room", "Kind", "Weight"]
_ADDED_INTRO = (
    "Events added from Oni's Calendar tab or by asking Oni, plus the ids of "
    "events hidden from the other calendar notes. Rows are safe to edit by "
    "hand; everything outside the two sections below is regenerated on the "
    "next change."
)
_CANCELLED_ID = re.compile(r"^\s*[-*]\s+`([^`]+)`")
_ISO_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
MAX_TITLE = 200
_REQUIRED = ("title", "date", "kind")

# One lock for the read-modify-write of the note: the dashboard and Oni can
# both save at once (the backend serves each request on a worker thread).
_write_lock = threading.Lock()


class CalendarEditError(ValueError):
    """A request the calendar refuses (bad date, unknown id, ...). The message
    is meant to be shown to the user or handed back to the model verbatim."""


def added_note_path() -> Path:
    return obsidian_tools.VAULT_DIR / f"{ADDED_TITLE}.md"


def _cell(value: str | None) -> str:
    """One table cell: a pipe would split the row and a newline would end it."""
    return re.sub(r"\s+", " ", (value or "").replace("|", "/")).strip()


def _date_cell(start: str, end: str | None) -> str:
    def one(iso: str) -> str:
        d = date.fromisoformat(iso)
        # Month names from our own table, not strftime: %b follows the locale.
        return f"{_WEEKDAYS[d.weekday()].title()} {d.day} {list(_MONTHS)[d.month - 1].title()} {d.year}"

    return one(start) if not end or end == start else f"{one(start)} – {one(end)}"


def _time_cell(start: str | None, end: str | None, tbc: bool) -> str:
    if start and end:
        return f"{start}–{end}"
    if start:
        return start
    return "TBC" if tbc else ""


def _read_added() -> tuple[list[dict[str, str]], list[str]]:
    """The note's event rows (cells keyed by canonical header) and cancelled ids."""
    path = added_note_path()
    if not path.is_file():
        return [], []
    text = path.read_text(encoding="utf-8")
    rows: list[dict[str, str]] = []
    for header, body in _tables(text):
        keys = _canonical_header(header)
        if {"date", "course", "title"} <= {k for k in keys if k}:
            rows.extend(_row_dict(keys, cells) for cells in body)
    cancelled: list[str] = []
    in_section = False
    for line in text.splitlines():
        if line.startswith("#"):
            in_section = line.lstrip("# ").strip().lower() == "cancelled"
            continue
        m = _CANCELLED_ID.match(line) if in_section else None
        if m and m.group(1) not in cancelled:
            cancelled.append(m.group(1))
    return rows, cancelled


def _write_added(rows: list[dict[str, str]], cancelled: list[str]) -> None:
    path = added_note_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    created = date.today().isoformat()
    if path.is_file():
        m = re.search(r"^created:\s*(\S+)", path.read_text(encoding="utf-8"), re.MULTILINE)
        created = m.group(1) if m else created
    keys = ["date", "time", "course", "title", "room", "kind", "weight"]
    lines = [
        "---",
        "oni: true",
        f"created: {created}",
        f"updated: {date.today().isoformat()}",
        "type: calendar",
        "tags: [calendar]",
        "---",
        "",
        f"# {ADDED_TITLE}",
        "",
        _ADDED_INTRO,
        "",
        "## Events",
        "| " + " | ".join(_ADDED_COLUMNS) + " |",
        "|" + "---|" * len(_ADDED_COLUMNS),
    ]
    for row in rows:
        lines.append("| " + " | ".join(_cell(row.get(k)) for k in keys) + " |")
    lines += ["", "## Cancelled", ""]
    lines += [f"- `{cid}`" for cid in cancelled] or ["_Nothing hidden._"]
    # Temp file + rename in the same directory: Obsidian (or a crash) never
    # sees a half-written note.
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".calendar-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _row_events(row: dict[str, str], source: str) -> list[CalendarEvent]:
    return _dated_events(row, source, [], None)


def _merge_added_events(data: CalendarData) -> None:
    """Fold the Added Events note into `data`: hide the cancelled events from
    the other notes, then add the note's own rows."""
    path = added_note_path()
    if not path.is_file():
        return
    source = path.stem
    try:
        text = path.read_text(encoding="utf-8")
        _, cancelled = _read_added()
    except (OSError, UnicodeDecodeError) as exc:
        data.warnings.append(f"{source}: could not read ({exc})")
        return
    data.sources.append(source)
    hidden = set(cancelled)
    present = {e.id for e in data.events}
    for cid in cancelled:
        if cid not in present:
            data.warnings.append(f"{source}: cancelled event {cid!r} no longer exists")
    data.events = [e for e in data.events if e.id not in hidden]
    _parse_note(text, source, data, None)


# --- Public edit API -------------------------------------------------------------


def _check_fields(
    *, title: str, date_iso: str, end_date: str | None, kind: str,
    start_time: str | None, end_time: str | None,
) -> None:
    if not title.strip():
        raise CalendarEditError("an event needs a title")
    if len(title) > MAX_TITLE:
        raise CalendarEditError(f"title is longer than {MAX_TITLE} characters")
    try:
        start = date.fromisoformat(date_iso)
        end = date.fromisoformat(end_date) if end_date else None
    except ValueError as exc:
        raise CalendarEditError(f"dates must be YYYY-MM-DD ({exc})") from exc
    if end and end < start:
        raise CalendarEditError("end_date is before date")
    if kind not in KINDS:
        raise CalendarEditError(f"kind must be one of {', '.join(KINDS)}")
    for label, t in (("start_time", start_time), ("end_time", end_time)):
        if t and not _ISO_TIME.match(t):
            raise CalendarEditError(f"{label} must be HH:MM, 24-hour (got {t!r})")
    if end_time and not start_time:
        raise CalendarEditError("end_time needs a start_time")


def _row_from(fields: dict[str, Any]) -> dict[str, str]:
    return {
        "date": _date_cell(fields["date"], fields.get("end_date")),
        "time": _time_cell(fields.get("start_time"), fields.get("end_time"), bool(fields.get("tbc"))),
        "course": _cell(fields.get("course")) or "—",
        "title": _cell(fields["title"]),
        "room": _cell(fields.get("location")) or "—",
        "kind": fields["kind"],
        "weight": _cell(fields.get("weight")),
    }


def _fields_of(event: CalendarEvent) -> dict[str, Any]:
    """An event as editable fields. The title is the full item text when the
    parser shortened it, so an edit that doesn't touch the title keeps it."""
    return {
        "title": event.detail or event.title,
        "date": event.date,
        "end_date": event.end_date,
        "course": "" if event.course == "—" else event.course,
        "kind": event.kind,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "location": event.location,
        "weight": event.weight,
        "tbc": event.tbc,
    }


def _validated_row(fields: dict[str, Any]) -> tuple[dict[str, str], CalendarEvent]:
    _check_fields(
        title=fields["title"], date_iso=fields["date"], end_date=fields.get("end_date"),
        kind=fields["kind"], start_time=fields.get("start_time"), end_time=fields.get("end_time"),
    )
    row = _row_from(fields)
    events = _row_events(row, added_note_path().stem)
    if len(events) != 1:
        raise CalendarEditError("could not store that event")
    return row, events[0]


def add_events(items: list[dict[str, Any]]) -> list[CalendarEvent]:
    """Add events. `items` keys: title, date (YYYY-MM-DD) and optionally
    kind (default "deadline"), course, start_time, end_time (HH:MM, HKT),
    end_date, location, weight. All or nothing: one bad item adds none."""
    if not items:
        raise CalendarEditError("no events to add")
    prepared = []
    for i, item in enumerate(items, start=1):
        try:
            prepared.append(_validated_row({"kind": "deadline", **item}))
        except (CalendarEditError, KeyError) as exc:
            label = f"event {i}" if len(items) > 1 else "event"
            detail = f"missing {exc}" if isinstance(exc, KeyError) else str(exc)
            raise CalendarEditError(f"{label} ({item.get('title', '?')!r}): {detail}") from exc
    with _write_lock:
        rows, cancelled = _read_added()
        rows.extend(r for r, _ in prepared)
        _write_added(rows, cancelled)
    return [e for _, e in prepared]


def _find(event_id: str) -> CalendarEvent:
    for e in load_calendar().events:
        if e.id == event_id:
            return e
    raise CalendarEditError(f"no calendar event with id {event_id!r}")


def update_event(event_id: str, changes: dict[str, Any]) -> CalendarEvent:
    """Change fields of an event. An event from the Added Events note is
    edited in place; one from any other note is hidden and re-added with the
    change (see the module docstring)."""
    allowed = set(_fields_of(CalendarEvent("", "", "", "", "class"))) - {"tbc"}
    unknown = set(changes) - allowed
    if unknown:
        raise CalendarEditError(f"cannot change {', '.join(sorted(unknown))}")
    # An explicit null for a required field means "unchanged", not "blank it".
    changes = {k: v for k, v in changes.items() if v is not None or k not in _REQUIRED}
    with _write_lock:
        event = _find(event_id)
        fields = _fields_of(event)
        fields.update(changes)
        if changes.get("start_time"):
            fields["tbc"] = False
        row, new = _validated_row(fields)
        rows, cancelled = _read_added()
        if event.source == added_note_path().stem:
            idx = next(
                (i for i, r in enumerate(rows) if any(e.id == event_id for e in _row_events(r, event.source))),
                None,
            )
            if idx is None:
                raise CalendarEditError(f"no calendar event with id {event_id!r}")
            rows[idx] = row
        else:
            if event_id not in cancelled:
                cancelled.append(event_id)
            rows.append(row)
        _write_added(rows, cancelled)
    return new


def delete_event(event_id: str) -> CalendarEvent:
    """Remove an event: its row if it was added here, else hide it."""
    with _write_lock:
        event = _find(event_id)
        rows, cancelled = _read_added()
        if event.source == added_note_path().stem:
            kept = [r for r in rows if not any(e.id == event_id for e in _row_events(r, event.source))]
            if len(kept) == len(rows):
                raise CalendarEditError(f"no calendar event with id {event_id!r}")
            rows = kept
        elif event_id not in cancelled:
            cancelled.append(event_id)
        _write_added(rows, cancelled)
    return event
