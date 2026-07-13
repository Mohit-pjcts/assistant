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
"""

from __future__ import annotations

import subprocess

from langchain_core.tools import tool
from langgraph.types import interrupt

_TIMEOUT_SECONDS = 15


def _run_osascript(script: str, args: list[str] | None = None) -> str:
    """Run a fixed AppleScript template via `osascript -e <script> <args>`.

    `args` are passed as the script's own argv (read via `on run argv`) —
    never interpolated into `script`, which is always a hardcoded constant
    defined in this module, never model-provided text.
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
    return result.stdout.strip() or "(done)"


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
]

GATED_TOOLS = [run_shortcut]

TOOLS = UNGATED_TOOLS + GATED_TOOLS
