"""Full-disk file search/read/write (PLAN.md Phase 23) — **the largest
security-model change in this project's history**, reached only after a
grilling session surfaced the prompt-injection blast-radius implications
directly and the user confirmed the choice explicitly, twice (once for
read, once again for write/delete, after the framing was made concrete).
See PLAN.md's own Phase 23 entry for the full reasoning; do not weaken or
extend this module without re-reading it.

Read (search + content) is UNGATED outside a hard credential-path
denylist. Write/overwrite/delete outside `workspace/` is GATED via
`interrupt()` — real path, real content/diff, shown verbatim — same
standing rule as every other side-effectful tool in this project
(CLAUDE.md's security model). Reads/writes WITHIN `workspace/` are
unaffected by any of this; use `tools.py`'s `read_file`/`write_file` for
those, unchanged.

**This module's denylist was ORIGINALLY DELIBERATELY NARROWER than
`tools.py`'s shell-tool denylist** (that list used to broadly restrict a
general-purpose command-EXECUTION primitive, blocking `/etc`, `/System`,
`/Library`, `/private`, `/var`, `/Applications`, and even the user's own
Desktop/Documents/Downloads/Pictures/Movies wholesale). At the user's
explicit direct request (2026-07-28, "give coding_agent permission to my
whole Mac except the very sensitive folders"), `tools.py`'s shell denylist
was relaxed to match this module's scope exactly — both now target
CREDENTIAL/SECRET material specifically: SSH keys, cloud credentials,
Keychain files, browser cookie/password stores, and `.env`-shaped files
anywhere on disk (matched by name, not a fixed path, since a stray `.env`
can live in any project folder). Reads/writes/shell commands outside these
specific paths — including Desktop/Documents/Downloads/Pictures and
former system-path blocks like `/etc`/`/System`/`/Library` — are now
intentionally allowed across all of `coding_agent`'s tools. The two
denylists still aren't a single shared implementation (this module checks
a resolved `Path`; `tools.py`'s shell tool checks raw argv token
substrings, since a shell argument isn't necessarily a valid path on its
own) — keep them in sync by hand if this credential list ever changes.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Annotated, NotRequired, TypedDict

from langchain_core.messages import AnyMessage
from langchain_core.tools import tool
from langgraph.graph.message import add_messages
from langgraph.prebuilt import InjectedState
from langgraph.types import interrupt


class _AgentState(TypedDict):
    """Mirrors sub_agents.GatedAgentState's relevant shape — duplicated
    rather than imported to avoid a circular import, same rationale as
    mac_tools.py's/write_tools.py's own local `_AgentState`."""

    messages: Annotated[list[AnyMessage], add_messages]
    pre_approved_actions: NotRequired[set[str]]


_TIMEOUT_SECONDS = 20
_MAX_SEARCH_RESULTS = 50
_MAX_READ_BYTES = 200_000

_HOME = Path.home()

# Credential/secret-DIRECTORY prefixes — a path is blocked if it starts
# with any of these, resolved (symlinks followed) before comparison so a
# symlink can't be used to dodge the check.
_CREDENTIAL_DIR_PREFIXES = (
    str(_HOME / ".ssh"),
    str(_HOME / ".aws"),
    str(_HOME / ".gnupg"),
    str(_HOME / ".docker"),
    str(_HOME / "Library" / "Keychains"),
    "/Library/Keychains",
    "/System/Library/Keychains",
    str(_HOME / "Library" / "Cookies"),
    str(_HOME / "Library" / "Safari"),
    str(_HOME / "Library" / "Application Support" / "Google" / "Chrome"),
    str(_HOME / "Library" / "Application Support" / "BraveSoftware"),
    str(_HOME / "Library" / "Application Support" / "Firefox"),
)

# Credential-shaped FILENAMES, blocked anywhere on disk regardless of
# directory — a stray .env/id_rsa can live in any project folder, not
# just under the prefixes above.
_CREDENTIAL_FILENAMES = {
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    ".netrc",
    ".npmrc",
    ".pgpass",
    ".git-credentials",
}

# Lowercased once at import time — macOS's default APFS filesystem is
# case-insensitive-but-preserving, so `~/.SSH/ID_RSA` resolves to the same
# real file as `~/.ssh/id_rsa` but wouldn't match either check above
# without folding case on both sides.
_CREDENTIAL_DIR_PREFIXES_LOWER = tuple(p.lower() for p in _CREDENTIAL_DIR_PREFIXES)
_CREDENTIAL_FILENAMES_LOWER = {n.lower() for n in _CREDENTIAL_FILENAMES}


def _is_credential_path(path: Path) -> bool:
    """True if `path` (already resolved by the caller) is credential/
    secret-shaped and must never be searched, read, written, or deleted
    by this module's tools. Case-insensitive, matching APFS's own
    case-insensitive-but-preserving default behavior."""
    resolved = str(path).lower()
    if any(resolved.startswith(prefix) for prefix in _CREDENTIAL_DIR_PREFIXES_LOWER):
        return True
    name_lower = path.name.lower()
    if name_lower in _CREDENTIAL_FILENAMES_LOWER:
        return True
    if name_lower.startswith(".env"):
        return True
    return False


@tool
def search_disk(query: str, directory: str = "") -> str:
    """Search the WHOLE Mac filesystem (not just the workspace) for files
    matching `query`, using Spotlight (`mdfind`) — matches filenames and,
    for types Spotlight indexes content for, file content too. Results
    inside a credential/secret path (SSH keys, cloud credentials, Keychain
    files, browser cookie/password stores, .env-shaped files anywhere) are
    always hidden, never shown even as a bare filename.

    Args:
        query: Search text (filename or content, Spotlight-style).
        directory: Optional path to scope the search to (e.g.
            "~/Desktop"); empty searches the whole disk.
    """
    argv = ["mdfind"]
    if directory:
        argv += ["-onlyin", str(Path(directory).expanduser())]
    argv.append(query)
    try:
        result = subprocess.run(
            argv, shell=False, capture_output=True, text=True, timeout=_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        return f"Error: search timed out after {_TIMEOUT_SECONDS}s"
    except FileNotFoundError:
        return "Error: mdfind not found (not running on macOS?)"

    if result.returncode != 0:
        return f"Error: {result.stderr.strip() or 'mdfind failed'}"

    all_paths = [line for line in result.stdout.splitlines() if line.strip()]
    # Resolve each result before the credential check — matches read/write/
    # delete's own pattern, so a symlink into a denylisted directory can't
    # show its (otherwise-innocuous-looking) name in search results.
    visible = [p for p in all_paths if not _is_credential_path(Path(p).resolve())]
    hidden_count = len(all_paths) - len(visible)
    if not visible:
        base = "No matching files found."
        return base + (
            f" ({hidden_count} result(s) hidden — credential/secret paths are never shown)"
            if hidden_count
            else ""
        )
    shown = visible[:_MAX_SEARCH_RESULTS]
    lines = "\n".join(shown)
    if len(visible) > len(shown):
        lines += f"\n... and {len(visible) - len(shown)} more (truncated)"
    if hidden_count:
        lines += f"\n({hidden_count} result(s) hidden — credential/secret paths are never shown)"
    return lines


@tool
def read_disk_file(path: str) -> str:
    """Read a text file anywhere on the Mac's filesystem (not just the
    workspace). Refuses credential/secret paths (SSH keys, cloud
    credentials, Keychain files, browser cookie/password stores, .env-
    shaped files anywhere) even though this tool otherwise has full-disk
    read access — see this module's own docstring for why that boundary
    stays even here.

    Args:
        path: Absolute path, or one starting with ~ for the home directory.
    """
    try:
        resolved = Path(path).expanduser().resolve()
    except OSError as exc:
        return f"Error: could not resolve '{path}': {exc}"

    if _is_credential_path(resolved):
        return f"Error: '{path}' is a credential/secret path and cannot be read"
    if not resolved.exists():
        return f"Error: '{path}' does not exist"
    if not resolved.is_file():
        return f"Error: '{path}' is not a file"

    try:
        data = resolved.read_bytes()
    except OSError as exc:
        return f"Error: could not read '{path}': {exc}"
    if len(data) > _MAX_READ_BYTES:
        return f"Error: '{path}' is too large to read ({len(data)} bytes, cap {_MAX_READ_BYTES})"
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return f"Error: '{path}' is not a text file"


@tool
def write_disk_file(
    path: str,
    content: str,
    *,
    state: Annotated[_AgentState, InjectedState],
) -> str:
    """Write or overwrite a file ANYWHERE on the Mac's filesystem (not
    just the workspace) — requires the user's explicit confirmation
    showing the exact path and the exact new content before writing,
    UNLESS the supervisor already got upfront confirmation for
    "write_disk_file" this turn. For a path inside the workspace, use
    write_file instead (ungated, sandboxed) — this tool is specifically
    for the outside-workspace case.

    Args:
        path: Absolute path, or one starting with ~ for the home directory.
        content: The new, full text content to write (replaces the whole
            file if it already exists).
    """
    try:
        resolved = Path(path).expanduser().resolve()
    except OSError as exc:
        return f"Error: could not resolve '{path}': {exc}"

    if _is_credential_path(resolved):
        return f"Error: '{path}' is a credential/secret path and cannot be written"

    existed = resolved.exists()
    if existed and not resolved.is_file():
        return f"Error: '{path}' exists and is not a file (e.g. a directory)"
    previous_content = None
    if existed:
        try:
            previous_content = resolved.read_text()
        except (UnicodeDecodeError, OSError):
            previous_content = "(existing content is not readable as text)"

    if "write_disk_file" not in (state.get("pre_approved_actions") or set()):
        approved = interrupt(
            {
                "action": "write_disk_file",
                "path": str(resolved),
                "existed": existed,
                "previous_content": previous_content,
                "new_content": content,
                "voice_approvable": False,
            }
        )
        if not approved:
            return "Cancelled — user did not confirm."

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content)
    return f"Wrote {len(content)} characters to '{resolved}'"


@tool
def delete_disk_file(
    path: str,
    *,
    state: Annotated[_AgentState, InjectedState],
) -> str:
    """Delete a file ANYWHERE on the Mac's filesystem (not just the
    workspace) — requires the user's explicit confirmation showing the
    exact path and its current content before deleting, UNLESS the
    supervisor already got upfront confirmation for "delete_disk_file"
    this turn.

    Args:
        path: Absolute path, or one starting with ~ for the home directory.
    """
    try:
        resolved = Path(path).expanduser().resolve()
    except OSError as exc:
        return f"Error: could not resolve '{path}': {exc}"

    if _is_credential_path(resolved):
        return f"Error: '{path}' is a credential/secret path and cannot be deleted"
    if not resolved.exists():
        return f"Error: '{path}' does not exist"
    if not resolved.is_file():
        return f"Error: '{path}' is not a file (e.g. a directory) — refusing to delete"

    try:
        content_preview = resolved.read_text()
    except (UnicodeDecodeError, OSError):
        content_preview = "(binary or unreadable content)"

    if "delete_disk_file" not in (state.get("pre_approved_actions") or set()):
        approved = interrupt(
            {
                "action": "delete_disk_file",
                "path": str(resolved),
                "content": content_preview,
                "voice_approvable": False,
            }
        )
        if not approved:
            return "Cancelled — user did not confirm."

    resolved.unlink()
    return f"Deleted '{resolved}'"


UNGATED_TOOLS = [search_disk, read_disk_file]
GATED_TOOLS = [write_disk_file, delete_disk_file]
TOOLS = UNGATED_TOOLS + GATED_TOOLS


def build_disk_tools() -> list:
    return list(TOOLS)
