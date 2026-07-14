"""Mac-native control tools: osascript bridge behind a hard allowlist.

Every action here is a fixed AppleScript (or `open`/`shortcuts` CLI) template
invoked as an argv list — never a free-form script built from model output.
Where a template needs model-supplied data (a reminder title, a shortcut
name), that value is passed as one of osascript's own positional `argv`
items, which the *script* reads via `on run argv` — never string-interpolated
into the script source itself. This is the same principle as tools.py's shell
tool: argv-list execution only, never building executable text out of
untrusted input.

Threat-model CHECKPOINT (PLAN.md Phase 4 step 1, approved 2026-07-12):
open_app, Music playback control/read, and Reminders/Notes read+create are
all private, reversible, and local-only — ungated. `run_shortcut` is gated
behind a LangGraph interrupt() (CLAUDE.md's standing confirmation rule)
regardless of which name is requested, because a Shortcut's actual behavior
is invisible to this codebase and can change any time the user edits it in
the Shortcuts app.

Phase 13 CHECKPOINT (PLAN.md Phase 13, approved 2026-07-15) extends this
allowlist with two more Mac-native capabilities, reusing the exact pattern
above:

- Apple Calendar (Calendar.app — local/iCloud/Exchange calendars on this
  Mac, NOT Google Calendar, which life_admin_agent/write_tools.py handles
  separately via MCP): reads ungated, create/update gated via interrupt()
  showing verbatim event details, same rule as write_tools.py's calendar
  wrappers including its read-back-before-gating requirement for update
  (an opaque event id alone isn't human-vettable). Implemented via
  Calendar.app's AppleScript dictionary through osascript — same mechanism
  as Reminders/Notes above, not a literal EventKit/Swift bridge (this
  codebase has no such dependency and the plan's "EventKit/osascript"
  phrasing is read as shorthand for "Calendar.app's native surface").
  AppleScript dates are constructed from numeric year/month/day/
  seconds-since-midnight argv components (never a locale-dependent string
  parse of a date), verified live against a real Calendar.app instance —
  see STEPS.md for the verification transcript. Calendar.app events have no
  explicit per-event timezone field (only "Time Zone Support" in the app's
  own settings, out of scope here), so every created/updated event is
  anchored to whatever timezone this Mac is currently set to; tools accept
  an explicit IANA timezone for the caller's input values and convert to
  the Mac's local system timezone before constructing the AppleScript date.

- open_url_in_brave: `open -a "Brave Browser" <url>`, url as argv, narrow
  open/navigate-only scope — explicitly NOT browser automation (no
  clicking/typing/form-fill). CHECKPOINT DECISION (2026-07-15, see STEPS.md):
  the plan called the injection-to-navigation path (a malicious page's
  content causing the agent to open an attacker-chosen URL) the load-bearing
  decision here, and recommended gating navigation to non-allowlisted
  domains. The user was asked directly and chose to leave this tool
  UNGATED — identical treatment to open_app, no domain allowlist, no
  confirmation gate of any kind. This is a DELIBERATE, EXPLICITLY ACCEPTED
  GAP against the plan's own done-when criteria, not an oversight — do not
  "fix" it by adding a gate without discussion, and do not treat its
  absence as evidence the injection-navigation risk was judged low; it was
  judged real and accepted anyway. Revisit if this decision changes.
"""

from __future__ import annotations

import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.tools import tool
from langgraph.types import interrupt

_TIMEOUT_SECONDS = 15


def _run_osascript(script: str, args: list[str] | None = None, *, empty_ok: bool = False) -> str:
    """Run a fixed AppleScript template via `osascript -e <script> <args>`.

    `args` are passed as the script's own argv (read via `on run argv`) —
    never interpolated into `script`, which is always a hardcoded constant
    defined in this module, never model-provided text.

    `empty_ok`: when True, a genuinely empty stdout is returned as "" rather
    than falling back to the "(done)" placeholder — needed by callers (e.g.
    calendar_list_events) where an empty result is meaningful data ("no
    events in range"), not the absence of output from a fire-and-forget
    action.
    """
    try:
        result = subprocess.run(
            ["osascript", "-e", script, *(args or [])],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {_TIMEOUT_SECONDS}s"
    except FileNotFoundError:
        return "Error: osascript not found (not running on macOS?)"

    if result.returncode != 0:
        return f"Error: {result.stderr.strip() or 'osascript failed'}"
    stripped = result.stdout.strip()
    if stripped:
        return stripped
    return "" if empty_ok else "(done)"


# --- Open app (plain `open` CLI, no AppleScript needed) --------------------


@tool
def open_app(name: str) -> str:
    """Open (launch or bring to front) a macOS application by name.

    Args:
        name: The application's name, e.g. "Safari" or "Music".
    """
    try:
        result = subprocess.run(
            ["open", "-a", name],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {_TIMEOUT_SECONDS}s"

    if result.returncode != 0:
        return f"Error: could not open '{name}': {result.stderr.strip()}"
    return f"Opened '{name}'"


# --- Music ------------------------------------------------------------

_MUSIC_PLAY = 'tell application "Music" to play'
_MUSIC_PAUSE = 'tell application "Music" to pause'
_MUSIC_NEXT = 'tell application "Music" to next track'
_MUSIC_PREVIOUS = 'tell application "Music" to previous track'
_MUSIC_NOW_PLAYING = """
tell application "Music"
    if player state is playing or player state is paused then
        return (name of current track) & " — " & (artist of current track) & " (" & (player state as text) & ")"
    else
        return "Nothing playing"
    end if
end tell
"""


@tool
def music_play() -> str:
    """Resume/play the current track in Music.app."""
    return _run_osascript(_MUSIC_PLAY)


@tool
def music_pause() -> str:
    """Pause playback in Music.app."""
    return _run_osascript(_MUSIC_PAUSE)


@tool
def music_next_track() -> str:
    """Skip to the next track in Music.app."""
    return _run_osascript(_MUSIC_NEXT)


@tool
def music_previous_track() -> str:
    """Go back to the previous track in Music.app."""
    return _run_osascript(_MUSIC_PREVIOUS)


@tool
def music_now_playing() -> str:
    """Report the currently playing (or paused) track in Music.app."""
    return _run_osascript(_MUSIC_NOW_PLAYING)


_MUSIC_PLAY_SONG = """
on run argv
    set songName to item 1 of argv
    set artistName to item 2 of argv
    tell application "Music"
        if artistName is "" then
            set theTracks to (every track of library playlist 1 whose name contains songName)
        else
            set theTracks to (every track of library playlist 1 whose name contains songName and artist contains artistName)
        end if
        if (count of theTracks) is 0 then
            return "No match found for: " & songName
        end if
        set theTrack to item 1 of theTracks
        play theTrack
        return "Playing: " & (name of theTrack) & " — " & (artist of theTrack)
    end tell
end run
"""

_MUSIC_PLAY_PLAYLIST = """
on run argv
    set playlistName to item 1 of argv
    tell application "Music"
        if not (exists playlist playlistName) then
            return "No playlist found named: " & playlistName
        end if
        play playlist playlistName
        return "Playing playlist: " & playlistName
    end tell
end run
"""


@tool
def music_play_song(song: str, artist: str = "") -> str:
    """Search the Music library for a song by name (optionally narrowed by
    artist) and play the first match.

    Args:
        song: Song title, or a substring of it, to search for.
        artist: Optional artist name to narrow the search.
    """
    return _run_osascript(_MUSIC_PLAY_SONG, [song, artist])


@tool
def music_play_playlist(name: str) -> str:
    """Play a playlist in Music.app by its exact name.

    Args:
        name: The playlist's exact name, as it appears in Music.app.
    """
    return _run_osascript(_MUSIC_PLAY_PLAYLIST, [name])


# --- Reminders --------------------------------------------------------

_REMINDERS_LIST = """
on run argv
    set listName to item 1 of argv
    tell application "Reminders"
        if listName is "" then
            set targetList to default list
        else
            set targetList to list listName
        end if
        set output to ""
        repeat with r in (reminders of targetList whose completed is false)
            set output to output & (name of r) & "\n"
        end repeat
        return output
    end tell
end run
"""

_REMINDERS_CREATE = """
on run argv
    set listName to item 1 of argv
    set theTitle to item 2 of argv
    set theNotes to item 3 of argv
    tell application "Reminders"
        if listName is "" then
            set targetList to default list
        else
            set targetList to list listName
        end if
        if theNotes is "" then
            make new reminder in targetList with properties {name:theTitle}
        else
            make new reminder in targetList with properties {name:theTitle, body:theNotes}
        end if
    end tell
    return "Created reminder: " & theTitle
end run
"""


@tool
def reminders_list(list_name: str = "") -> str:
    """List incomplete reminders in a Reminders list.

    Args:
        list_name: The Reminders list to read, or empty for the default list.
    """
    return _run_osascript(_REMINDERS_LIST, [list_name])


@tool
def reminders_create(title: str, list_name: str = "", notes: str = "") -> str:
    """Create a new reminder.

    Args:
        title: The reminder's title.
        list_name: The Reminders list to add it to, or empty for the default list.
        notes: Optional notes/body text.
    """
    return _run_osascript(_REMINDERS_CREATE, [list_name, title, notes])


# --- Notes --------------------------------------------------------------

_NOTES_LIST = """
tell application "Notes"
    set output to ""
    repeat with n in notes
        set output to output & (name of n) & "\n"
    end repeat
    return output
end tell
"""

_NOTES_CREATE = """
on run argv
    set theTitle to item 1 of argv
    set theBody to item 2 of argv
    tell application "Notes"
        make new note with properties {name:theTitle, body:theBody}
    end tell
    return "Created note: " & theTitle
end run
"""


@tool
def notes_list() -> str:
    """List the titles of all notes in Notes.app."""
    return _run_osascript(_NOTES_LIST)


@tool
def notes_create(title: str, body: str = "") -> str:
    """Create a new note.

    Args:
        title: The note's title.
        body: Optional note body text.
    """
    return _run_osascript(_NOTES_CREATE, [title, body])


# --- Apple Calendar (Calendar.app — Phase 13) -------------------------------
#
# NOT Google Calendar — see write_tools.py for that. Every date passed to or
# read from Calendar.app is built/parsed via numeric year/month/day/
# seconds-since-midnight components, never a locale-dependent AppleScript
# string-date parse; see this module's docstring for why. Read-back-before-
# gating for update mirrors write_tools.py's rule: an opaque event id alone
# is not human-vettable.

_CALENDAR_LIST_EVENTS = """
on run argv
    set daysAhead to (item 1 of argv) as integer
    set calName to item 2 of argv
    set startDate to (current date) - (1 * days)
    set endDate to (current date) + (daysAhead * days)
    set output to ""
    tell application "Calendar"
        if calName is "" then
            set calList to calendars
        else
            set calList to {calendar calName}
        end if
        repeat with cal in calList
            set theEvents to (every event of cal whose start date > startDate and start date < endDate)
            repeat with ev in theEvents
                set evLoc to ""
                try
                    set evLoc to location of ev
                    if evLoc is missing value then set evLoc to ""
                end try
                set output to output & (summary of ev) & "|" & ((start date of ev) as string) & "|" & ((end date of ev) as string) & "|" & (name of cal) & "|" & (id of ev) & "|" & evLoc & "\n"
            end repeat
        end repeat
    end tell
    return output
end run
"""

_CALENDAR_GET_EVENT = """
on run argv
    set theId to item 1 of argv
    tell application "Calendar"
        repeat with cal in calendars
            set theEvents to (every event of cal whose id is theId)
            if (count of theEvents) > 0 then
                set ev to item 1 of theEvents
                set evLoc to ""
                try
                    set evLoc to location of ev
                    if evLoc is missing value then set evLoc to ""
                end try
                set evDesc to ""
                try
                    set evDesc to description of ev
                    if evDesc is missing value then set evDesc to ""
                end try
                set sDate to start date of ev
                set eDate to end date of ev
                return (summary of ev) & "|" & (sDate as string) & "|" & (eDate as string) & "|" & (name of cal) & "|" & evLoc & "|" & evDesc & "|" & (year of sDate) & "|" & (month of sDate as integer) & "|" & (day of sDate) & "|" & (time of sDate) & "|" & (year of eDate) & "|" & (month of eDate as integer) & "|" & (day of eDate) & "|" & (time of eDate)
            end if
        end repeat
        return "NOTFOUND"
    end tell
end run
"""

_CALENDAR_CREATE_EVENT = """
on run argv
    set calName to item 1 of argv
    set evTitle to item 2 of argv
    set evLoc to item 3 of argv
    set evDesc to item 4 of argv
    set sDate to current date
    set day of sDate to 1
    set year of sDate to (item 5 of argv) as integer
    set month of sDate to (item 6 of argv) as integer
    set day of sDate to (item 7 of argv) as integer
    set time of sDate to (item 8 of argv) as integer
    set eDate to current date
    set day of eDate to 1
    set year of eDate to (item 9 of argv) as integer
    set month of eDate to (item 10 of argv) as integer
    set day of eDate to (item 11 of argv) as integer
    set time of eDate to (item 12 of argv) as integer
    tell application "Calendar"
        tell calendar calName
            set newEvent to make new event with properties {summary:evTitle, start date:sDate, end date:eDate, location:evLoc, description:evDesc}
            return id of newEvent
        end tell
    end tell
end run
"""

_CALENDAR_UPDATE_EVENT = """
on run argv
    set theId to item 1 of argv
    set newTitle to item 2 of argv
    set newLoc to item 3 of argv
    set newDesc to item 4 of argv
    set sDate to current date
    set day of sDate to 1
    set year of sDate to (item 5 of argv) as integer
    set month of sDate to (item 6 of argv) as integer
    set day of sDate to (item 7 of argv) as integer
    set time of sDate to (item 8 of argv) as integer
    set eDate to current date
    set day of eDate to 1
    set year of eDate to (item 9 of argv) as integer
    set month of eDate to (item 10 of argv) as integer
    set day of eDate to (item 11 of argv) as integer
    set time of eDate to (item 12 of argv) as integer
    tell application "Calendar"
        repeat with cal in calendars
            set theEvents to (every event of cal whose id is theId)
            if (count of theEvents) > 0 then
                set ev to item 1 of theEvents
                set summary of ev to newTitle
                set location of ev to newLoc
                set description of ev to newDesc
                set start date of ev to sDate
                set end date of ev to eDate
                return "updated"
            end if
        end repeat
        return "NOTFOUND"
    end tell
end run
"""


def _iso_datetime_argv(iso_str: str, tz_name: str) -> list[str]:
    """Convert an ISO 8601 datetime + IANA timezone into (year, month, day,
    seconds-since-midnight) argv components in the Mac's LOCAL system
    timezone. Calendar.app's AppleScript `date` type has no explicit
    per-event timezone property, so every event this module writes is
    anchored to whatever timezone this Mac is currently set to, regardless
    of what zone the caller's input was expressed in — this function does
    the conversion once, up front, so the AppleScript templates never need
    to reason about timezones at all.

    Raises ValueError (bad ISO string) or ZoneInfoNotFoundError (bad tz
    name) — callers catch both and return the failure as tool-result text,
    per CLAUDE.md's "tool errors are data, not exceptions" rule.
    """
    dt = datetime.fromisoformat(iso_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(tz_name))
    local = dt.astimezone()
    seconds_since_midnight = local.hour * 3600 + local.minute * 60 + local.second
    return [str(local.year), str(local.month), str(local.day), str(seconds_since_midnight)]


def _calendar_get_event(event_id: str) -> dict | None:
    """Read back an event's REAL current content by id — used before every
    update gate, mirroring write_tools.py's _read_back_event. Returns None
    if the event can't be found or the response can't be parsed; callers
    must refuse to proceed rather than show a gate with guessed content."""
    raw = _run_osascript(_CALENDAR_GET_EVENT, [event_id], empty_ok=True)
    if not raw or raw.startswith("Error:") or raw == "NOTFOUND":
        return None
    parts = raw.split("|")
    if len(parts) != 14:
        return None
    (
        title,
        start_display,
        end_display,
        calendar_name,
        location,
        description,
        s_year,
        s_month,
        s_day,
        s_time,
        e_year,
        e_month,
        e_day,
        e_time,
    ) = parts
    return {
        "title": title,
        "start": start_display,
        "end": end_display,
        "calendar": calendar_name,
        "location": location,
        "description": description,
        "start_components": [s_year, s_month, s_day, s_time],
        "end_components": [e_year, e_month, e_day, e_time],
    }


def _format_calendar_events(raw: str) -> str:
    lines = [line for line in raw.split("\n") if line.strip()]
    if not lines:
        return "No events found in that range."
    formatted = []
    for line in lines:
        parts = line.split("|")
        if len(parts) < 5:
            continue
        title, start, end, cal, event_id = parts[0], parts[1], parts[2], parts[3], parts[4]
        location = parts[5] if len(parts) > 5 else ""
        entry = f"- {title} | {start} → {end} | calendar={cal} | id={event_id}"
        if location:
            entry += f" | location={location}"
        formatted.append(entry)
    return "\n".join(formatted)


@tool
def calendar_list_events(days_ahead: int = 7, calendar_name: str = "") -> str:
    """List upcoming events on Apple Calendar (Calendar.app — the local/
    iCloud/Exchange calendars on this Mac, NOT Google Calendar; use the
    life-admin specialist's tools for Google Calendar).

    Args:
        days_ahead: How many days forward from now to look (default 7).
        calendar_name: Restrict to one calendar by its exact name, or empty
            for all calendars.
    """
    raw = _run_osascript(_CALENDAR_LIST_EVENTS, [str(days_ahead), calendar_name], empty_ok=True)
    if raw.startswith("Error:"):
        return raw
    return _format_calendar_events(raw)


@tool
def calendar_create_event(
    title: str,
    start: str,
    end: str,
    timezone: str,
    calendar_name: str,
    location: str = "",
    notes: str = "",
) -> str:
    """Create an event on Apple Calendar (Calendar.app — NOT Google
    Calendar). Requires the user's explicit confirmation showing the exact
    event details before creating.

    Args:
        title: Event title.
        start: Start time, ISO 8601 (e.g. '2026-07-20T15:00:00').
        end: End time, ISO 8601.
        timezone: IANA timezone name the start/end times above are IN (e.g.
            'America/Los_Angeles') — converted to this Mac's own system
            timezone before creating, since Calendar.app events have no
            separate per-event timezone field.
        calendar_name: Exact name of the Calendar.app calendar to create the
            event on (e.g. 'Home', 'Work') — use calendar_list_events to see
            valid names.
        location: Optional location text.
        notes: Optional notes/description text.
    """
    try:
        start_components = _iso_datetime_argv(start, timezone)
        end_components = _iso_datetime_argv(end, timezone)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        return f"Error: could not parse start/end/timezone: {exc}"

    approved = interrupt(
        {
            "action": "calendar_create_event",
            "calendar_name": calendar_name,
            "title": title,
            "start": start,
            "end": end,
            "timezone": timezone,
            "location": location,
            "description": notes,
            "voice_approvable": False,
        }
    )
    if not approved:
        return "Cancelled — user did not confirm."

    result = _run_osascript(
        _CALENDAR_CREATE_EVENT,
        [calendar_name, title, location, notes, *start_components, *end_components],
    )
    if result.startswith("Error:"):
        return result
    return f"Created event '{title}' on calendar '{calendar_name}' (id={result})"


@tool
def calendar_update_event(
    event_id: str,
    title: str | None = None,
    start: str | None = None,
    end: str | None = None,
    timezone: str | None = None,
    location: str | None = None,
    notes: str | None = None,
) -> str:
    """Update an existing Apple Calendar event by id (from
    calendar_list_events). Requires the user's explicit confirmation showing
    BOTH the event's real current content (read back first — an event id
    alone isn't identifiable) and the exact requested changes. Only pass the
    fields you want to change; all others stay as they are.

    Args:
        event_id: Id of the event to update (from calendar_list_events).
        title: New title, if changing.
        start: New start time (ISO 8601), if changing.
        end: New end time (ISO 8601), if changing.
        timezone: IANA timezone the new start/end above are IN — required if
            either start or end is provided.
        location: New location, if changing.
        notes: New notes/description, if changing.
    """
    current = _calendar_get_event(event_id)
    if current is None:
        return f"Error: could not read back event {event_id!r} to confirm — refusing to proceed blind."

    if (start is not None or end is not None) and not timezone:
        return "Error: timezone is required when changing start or end."

    changes: dict[str, str] = {}
    if title is not None:
        changes["title"] = title
    if start is not None:
        changes["start"] = start
    if end is not None:
        changes["end"] = end
    if location is not None:
        changes["location"] = location
    if notes is not None:
        changes["description"] = notes
    if not changes:
        return "Nothing to update — no fields were provided."

    approved = interrupt(
        {
            "action": "calendar_update_event",
            "event_id": event_id,
            "current": {
                "title": current["title"],
                "start": current["start"],
                "end": current["end"],
                "calendar": current["calendar"],
                "location": current["location"],
                "description": current["description"],
            },
            "changes": changes,
            "voice_approvable": False,
        }
    )
    if not approved:
        return "Cancelled — user did not confirm."

    final_title = title if title is not None else current["title"]
    final_location = location if location is not None else current["location"]
    final_notes = notes if notes is not None else current["description"]
    try:
        start_components = _iso_datetime_argv(start, timezone) if start is not None else current["start_components"]
        end_components = _iso_datetime_argv(end, timezone) if end is not None else current["end_components"]
    except (ValueError, ZoneInfoNotFoundError) as exc:
        return f"Error: could not parse start/end/timezone: {exc}"

    result = _run_osascript(
        _CALENDAR_UPDATE_EVENT,
        [event_id, final_title, final_location, final_notes, *start_components, *end_components],
    )
    if result.startswith("Error:"):
        return result
    if result == "NOTFOUND":
        return f"Error: event {event_id!r} no longer exists."
    return f"Updated event '{final_title}' (id={event_id})"


# --- Browser: open-only navigation in Brave (Phase 13) ----------------------
#
# NARROW scope, deliberately: open/navigate only, no clicking/typing/
# form-fill/scraping — that's a separate, sandboxed project if ever. See this
# module's docstring for the 2026-07-15 checkpoint decision that this tool
# ships UNGATED, an explicitly accepted gap against the plan's own
# injection-navigation requirement, not an oversight.


@tool
def open_url_in_brave(url: str) -> str:
    """Open a URL in Brave Browser — opens/navigates only, no clicking,
    typing, form-filling, or scraping.

    Args:
        url: The URL to open, including scheme (e.g. 'https://example.com').
    """
    try:
        result = subprocess.run(
            ["open", "-a", "Brave Browser", url],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {_TIMEOUT_SECONDS}s"

    if result.returncode != 0:
        return f"Error: could not open '{url}' in Brave: {result.stderr.strip()}"
    return f"Opened in Brave: {url}"


# --- Shortcuts -------------------------------------------------------------

# There is no scriptable way to author a Shortcut's actual logic — the
# `shortcuts` CLI only supports list/run/view, and the create-shortcut URL
# scheme does NOT accept a name (or any other) parameter: confirmed
# empirically (not assumed from docs) by opening it with `?name=...` and
# visually checking the editor — it comes up with a blank "Title"
# placeholder regardless. So create_shortcut only ever opens a blank editor
# for the user to build and save themselves; it can't pre-fill anything or
# finish the job unattended, which is also why it's ungated (same reasoning
# as open_app — nothing real exists until the user manually completes it).


@tool
def create_shortcut() -> str:
    """Open the Shortcuts app's editor to start creating a new Shortcut.
    This only opens a blank editor — you cannot pre-fill a name or actions,
    and the user must build and save it themselves; nothing is created
    automatically."""
    try:
        result = subprocess.run(
            ["open", "shortcuts://create-shortcut"],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {_TIMEOUT_SECONDS}s"

    if result.returncode != 0:
        return f"Error: could not open the Shortcuts editor: {result.stderr.strip()}"
    return (
        "Opened a blank Shortcut in the Shortcuts editor — name it and add "
        "actions yourself, then save it."
    )


@tool
def run_shortcut(name: str) -> str:
    """Run a named macOS Shortcut. Always asks for confirmation first — a
    Shortcut's actual behavior isn't visible to this tool, so every name is
    gated the same way regardless of what it sounds like it does.

    Args:
        name: The exact name of the Shortcut to run, as it appears in the
            Shortcuts app.
    """
    approved = interrupt(
        {
            "action": "run_shortcut",
            "name": name,
            "spoken_prompt": f"Permission to run the '{name}' shortcut?",
        }
    )
    if not approved:
        return "Cancelled — user did not confirm."

    try:
        result = subprocess.run(
            ["shortcuts", "run", name],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"Error: shortcut timed out after {_TIMEOUT_SECONDS}s"
    except FileNotFoundError:
        return "Error: 'shortcuts' CLI not found (requires macOS 12+)"

    if result.returncode != 0:
        return f"Error: shortcut '{name}' failed: {result.stderr.strip()}"
    return result.stdout.strip() or f"Ran shortcut: {name}"


UNGATED_TOOLS = [
    open_app,
    music_play,
    music_pause,
    music_next_track,
    music_previous_track,
    music_now_playing,
    music_play_song,
    music_play_playlist,
    reminders_list,
    reminders_create,
    notes_list,
    notes_create,
    create_shortcut,
    calendar_list_events,
    # Deliberately ungated — see this module's docstring, 2026-07-15 checkpoint.
    open_url_in_brave,
]

GATED_TOOLS = [run_shortcut, calendar_create_event, calendar_update_event]

TOOLS = UNGATED_TOOLS + GATED_TOOLS
