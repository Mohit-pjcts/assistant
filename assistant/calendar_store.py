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

Nothing here writes to the vault.
"""

from __future__ import annotations

import logging
import re
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

# The timetable note itself documents this: the HKU calendar spells the
# course CCHU9053, the rest of the vault (and the Deadlines table) CCCH9053.
# Normalised here so one course is one filter chip / one colour.
_COURSE_ALIASES = {"CCHU9053": "CCCH9053"}

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

KINDS = ("class", "tutorial", "exam", "deadline")


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
    code = _clean(raw).upper()
    return _COURSE_ALIASES.get(code, code)


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
        p for p in root.rglob(f"*{suffix}") if p.name.startswith("Semester") and p.is_file()
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
