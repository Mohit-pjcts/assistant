"""PATH for helper programs the backend shells out to (ffmpeg).

When the backend is started by Oni.app (a GUI app) it inherits launchd's
minimal `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew's `ffmpeg` is not
found and `/voice/transcribe` fails with `FileNotFoundError: 'ffmpeg'` even
though the same call works from a terminal (found live, Phase 32, STEPS.md 184).
Fixing it where the program is launched is the robust place: it works for any
caller and needs no change to the Tauri shell.
"""

from __future__ import annotations

import os

# Homebrew on Apple Silicon, then Intel / MacPorts-style locations.
_EXTRA_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")


def ensure_tool_path() -> None:
    """Append Homebrew's bin directories to this process's PATH when they exist
    and are missing. Idempotent; appended (not prepended) so anything already on
    PATH still wins."""
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for directory in _EXTRA_DIRS:
        if directory not in parts and os.path.isdir(directory):
            parts.append(directory)
    os.environ["PATH"] = os.pathsep.join(parts)
