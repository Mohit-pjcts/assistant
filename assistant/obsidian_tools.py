"""Oni's own note-store — a dedicated Obsidian vault (PLAN.md Phase 27), the
"second brain" persistent note-store the user asked for, distinct from
`memory_store.py`'s small curated Facts. See `CONTEXT.md`'s Vault/Note
definitions and `docs/adr/0001-*`/`0002-*` for the two load-bearing decisions
this module implements; do not weaken either without re-reading them.

**Fully ungated — no `interrupt()` anywhere in this module** (ADR 0001). The
user's own reasoning: the vault is a real Obsidian vault they can open and
audit directly, so an in-dashboard approval step would just recreate the
friction the 2026-07-28 memory re-architecture already removed for a
structurally similar problem. The one narrow backstop instead of a gate:
`delete_vault_note` refuses to delete any Note lacking an `oni: true`
frontmatter marker, so it can never remove something the user wrote
themselves. **`update_vault_note` applies the same check**, deliberately
extended beyond what ADR 0001's own text literally says — the ADR only
names delete, but leaving update unprotected would make the delete
protection pointless (an unprotected full-body overwrite is just as
destructive as a delete). Treat this as part of the same standing rule, not
a separate weaker one.

**Oni decides autonomously when to write** (ADR 0002) — `research_agent`/
`life_admin_agent`'s own system prompts, not this module, carry that
behavior; nothing here restricts *when* these tools get called, only what
happens once they are. The one code-level backstop against that autonomy
turning into a runaway loop is `_MAX_WRITES_PER_TURN` below.

**Vault location:** `~/Documents/OniVault`, a vault dedicated to Oni's own
notes — never the user's personal vaults (`Courses`, `NovaWorks`) or this
project's own repo-root vault. As of 2026-08-06/07 this vault also holds
138 notes from a one-off Claude-Code-direct (not through Oni) population of
the user's `~/Documents/Courses` folder — none of those carry the `oni:
true` marker, so `delete_vault_note`'s authorship check already protects
all of them from Oni without this module needing to know they exist.
`write_vault_note` always creates new notes at the vault ROOT, never nested
into any of that pre-existing course-folder structure, since Oni has no
knowledge of (and no reason to participate in) that taxonomy.

**Search scope:** the vault directory only, recursively (not whole-disk
like `disk_tools.py`) — implemented as a directory-walk substring search,
not Spotlight/`mdfind`, since a Note written moments earlier might not be
Spotlight-indexed yet when immediately searched for (PLAN.md Phase 27,
Decision 11).

**Active linking is mandatory, not optional** (Decision 8): `write_vault_note`
itself searches existing Note titles for keyword overlap and appends a
"Related Notes" section with real `[[wikilinks]]` to what it finds — this is
enforced by the tool's own contract (it generates the links itself from
real filename matches), not left to the model to remember to do via a
separate `search_vault` call and hand-typed links, which would risk
hallucinated targets.

**Per-turn write cap** (Decision 10): `write_vault_note`/`update_vault_note`
combined are capped at `_MAX_WRITES_PER_TURN` calls per specialist
invocation, checked by counting prior tool-call attempts for either name in
the conversation's own message history via `InjectedState` — the same
mechanism `disk_tools.py`'s gated tools use to read `pre_approved_actions`,
just counting instead of set-membership. No `NoParallel*Writes`-style
middleware is needed the way `disk_tools.py`/`mac_tools.py` need one, since
nothing here calls `interrupt()` — the failure mode those middlewares guard
against (a second same-turn interrupt getting silently stranded) doesn't
apply to an ungated tool.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Annotated, NotRequired, TypedDict

from langchain_core.messages import AIMessage, AnyMessage
from langchain_core.tools import tool
from langgraph.graph.message import add_messages
from langgraph.prebuilt import InjectedState


class _AgentState(TypedDict):
    """Mirrors sub_agents.GatedAgentState's relevant shape — duplicated
    rather than imported to avoid a circular import, same rationale as
    disk_tools.py's/mac_tools.py's/write_tools.py's own local
    `_AgentState`."""

    messages: Annotated[list[AnyMessage], add_messages]
    pre_approved_actions: NotRequired[set[str]]


VAULT_DIR = Path.home() / "Documents" / "OniVault"

_MAX_WRITES_PER_TURN = 3
_MAX_SEARCH_RESULTS = 20
_MAX_READ_BYTES = 200_000
_MAX_RELATED_NOTES = 5
_SNIPPET_RADIUS = 80

_WRITE_TOOL_NAMES = {"write_vault_note", "update_vault_note"}

# Words too generic to drive relatedness matching between Note titles —
# kept short and hand-picked (not a general stopword list) since titles are
# short and this only needs to filter the handful of connective words that
# show up in almost every title.
_TITLE_STOPWORDS = {
    "with", "from", "into", "your", "about", "this", "that", "note", "notes",
    "overview", "and", "the", "for",
}


def _sanitize_title(title: str) -> str:
    """A Note's title IS its filename (minus `.md`) — Obsidian resolves
    `[[wikilinks]]` by filename. Strips whitespace and replaces the one
    character macOS actually forbids in a filename (`/`); deliberately not
    stripping the em dashes/colons/etc. every existing Note in this vault
    already uses in its title, since APFS allows them and disallowing them
    would make Oni's own Notes look inconsistent with the rest of the
    vault."""
    cleaned = title.strip().replace("/", "-")
    if not cleaned:
        msg = "title cannot be empty"
        raise ValueError(msg)
    return cleaned


def _note_path_for_new(title: str) -> Path:
    return VAULT_DIR / f"{_sanitize_title(title)}.md"


def _find_existing_note(title: str) -> Path | None:
    """Looks up a Note by title ANYWHERE in the vault tree (not just the
    root), since write_vault_note only ever creates at the root but read/
    update/delete need to reach every pre-existing Note too, including the
    138 course notes nested under Semester/Course subfolders. Exact
    filename-stem match, case-sensitive (Obsidian's own resolution is
    case-sensitive on a case-sensitive filesystem); if more than one file
    somehow shares a stem, the first match found is used — not specially
    disambiguated, since real Note titles in this vault are effectively
    unique by construction (course-code-prefixed or otherwise distinct)."""
    target = _sanitize_title(title)
    for path in VAULT_DIR.rglob("*.md"):
        if path.stem == target:
            return path
    return None


def _iter_notes() -> list[Path]:
    return sorted(VAULT_DIR.rglob("*.md"))


def _read_frontmatter_field(content: str, field: str) -> str | None:
    """Extracts a single scalar field (e.g. `oni: true`, `created:
    2026-08-07`) from a note's leading `---`-delimited frontmatter block.
    Deliberately not a general YAML parser (pyyaml is only an undeclared
    transitive dependency here, not a project-declared one) — every field
    this module reads or writes is a single unquoted scalar, which a plain
    line match handles correctly without that risk."""
    if not content.startswith("---"):
        return None
    end = content.find("\n---", 3)
    if end == -1:
        return None
    frontmatter = content[3:end]
    m = re.search(rf"^{re.escape(field)}:\s*(.+?)\s*$", frontmatter, re.MULTILINE)
    return m.group(1).strip() if m else None


def _is_oni_authored(content: str) -> bool:
    value = _read_frontmatter_field(content, "oni")
    return (value or "").lower() == "true"


def _strip_frontmatter(content: str) -> str:
    if not content.startswith("---"):
        return content
    end = content.find("\n---", 3)
    if end == -1:
        return content
    return content[end + 4 :].lstrip("\n")


def _related_notes(title: str, existing_titles: list[str]) -> list[str]:
    """The mechanism behind Decision 8 — see module docstring. Keyword
    overlap is TITLE-only (not body content): fast, and avoids surfacing
    noisy matches from a chatty note body that happens to share a common
    word with something unrelated."""
    words = {w for w in re.findall(r"[a-zA-Z]{4,}", title.lower()) if w not in _TITLE_STOPWORDS}
    if not words:
        return []
    scored: list[tuple[int, str]] = []
    for other in existing_titles:
        if other == title:
            continue
        other_words = set(re.findall(r"[a-zA-Z]{4,}", other.lower()))
        overlap = len(words & other_words)
        if overlap:
            scored.append((overlap, other))
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [t for _, t in scored[:_MAX_RELATED_NOTES]]


def _count_prior_writes_this_turn(messages: list[AnyMessage]) -> int:
    """Counts every prior AIMessage tool_call naming write_vault_note or
    update_vault_note in this conversation, regardless of whether that call
    succeeded — see module docstring's "Per-turn write cap" section for why
    attempts (not just successes) count toward the cap. Mirrors
    circuit_breaker.py's own choice to read tool_calls off the AIMessage
    rather than trust ToolMessage.name, for the same robustness reason."""
    count = 0
    for msg in messages:
        if not isinstance(msg, AIMessage):
            continue
        for call in msg.tool_calls or []:
            if call.get("name") in _WRITE_TOOL_NAMES:
                count += 1
    return count


def _frontmatter_block(*, created: str, updated: str | None = None) -> str:
    lines = ["---", "oni: true", f"created: {created}"]
    if updated:
        lines.append(f"updated: {updated}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


@tool
def search_vault(query: str) -> str:
    """Search Oni's own note vault (title and content) for `query` —
    substring match, case-insensitive. Scoped to the vault only (not the
    whole disk). Use this to check whether something related already exists
    before writing a new note, or to find a note to read/update/delete.

    Args:
        query: Search text.
    """
    if not VAULT_DIR.exists():
        return f"Error: vault directory '{VAULT_DIR}' does not exist."
    needle = query.lower()
    hits: list[str] = []
    for path in _iter_notes():
        try:
            content = path.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        title = path.stem
        haystack = content.lower()
        if needle not in title.lower() and needle not in haystack:
            continue
        idx = haystack.find(needle)
        snippet = ""
        if idx != -1:
            body = _strip_frontmatter(content)
            body_idx = body.lower().find(needle)
            if body_idx != -1:
                start = max(0, body_idx - _SNIPPET_RADIUS)
                end = min(len(body), body_idx + len(query) + _SNIPPET_RADIUS)
                snippet = " — …" + body[start:end].replace("\n", " ").strip() + "…"
        hits.append(f"[[{title}]]{snippet}")
    if not hits:
        return f"No notes found matching '{query}'."
    shown = hits[:_MAX_SEARCH_RESULTS]
    lines = "\n".join(shown)
    if len(hits) > len(shown):
        lines += f"\n... and {len(hits) - len(shown)} more (truncated)"
    return lines


@tool
def read_vault_note(title: str) -> str:
    """Read one note from Oni's own note vault by its exact title.

    Args:
        title: The note's title (matches its filename, without `.md`).
    """
    path = _find_existing_note(title)
    if path is None:
        return f"Error: no note titled '{title}' found in the vault."
    try:
        data = path.read_bytes()
    except OSError as exc:
        return f"Error: could not read '{title}': {exc}"
    if len(data) > _MAX_READ_BYTES:
        return f"Error: '{title}' is too large to read ({len(data)} bytes, cap {_MAX_READ_BYTES})"
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return f"Error: '{title}' is not a text file"


@tool
def write_vault_note(
    title: str,
    content: str,
    *,
    state: Annotated[_AgentState, InjectedState],
) -> str:
    """Create a NEW note in Oni's own note vault — a persistent store for
    information that doesn't need to be loaded every run but might be
    useful later. Redundancy across notes is fine; don't hold back for fear
    of duplicating something. This tool automatically searches existing
    note titles for related notes and links them in — you don't need to
    call search_vault yourself first or write your own [[wikilinks]] for
    that purpose. Do NOT include your own YAML frontmatter in `content` —
    it's added automatically. Fails if a note with this exact title already
    exists — use update_vault_note to change an existing one instead.

    Args:
        title: The new note's title (becomes its filename).
        content: The note's body (markdown, no frontmatter).
    """
    prior = _count_prior_writes_this_turn(state["messages"])
    if prior >= _MAX_WRITES_PER_TURN:
        return (
            f"Error: reached the per-turn cap of {_MAX_WRITES_PER_TURN} vault "
            "writes/updates. Stop here rather than continuing to write more this turn."
        )

    if not VAULT_DIR.exists():
        VAULT_DIR.mkdir(parents=True, exist_ok=True)

    path = _note_path_for_new(title)
    if path.exists():
        return f"Error: a note titled '{title}' already exists — use update_vault_note instead."

    existing_titles = [p.stem for p in _iter_notes()]
    related = _related_notes(path.stem, existing_titles)

    body = content.rstrip("\n") + "\n"
    if related:
        links = "\n".join(f"- [[{t}]]" for t in related)
        body += f"\n## Related Notes\n\n{links}\n"

    full = _frontmatter_block(created=date.today().isoformat()) + body
    path.write_text(full)

    if related:
        return f"Created '{path.stem}', linked to {len(related)} related note(s): {', '.join(related)}."
    return f"Created '{path.stem}' (no related notes found to link)."


@tool
def update_vault_note(
    title: str,
    content: str,
    *,
    state: Annotated[_AgentState, InjectedState],
) -> str:
    """Fully replace an existing note's body in Oni's own note vault — pass
    the COMPLETE new body, not a diff (it replaces everything, same as
    write_disk_file's own overwrite convention). Reads the note's current
    content first; if you need to preserve part of it, read_vault_note it
    yourself before calling this. Refuses to update a note that wasn't
    created by Oni (no `oni: true` marker) — same protection
    delete_vault_note has, so a note the user wrote themselves can't be
    silently overwritten either. Do NOT include your own YAML frontmatter
    in `content` — it's preserved/added automatically.

    Args:
        title: The existing note's exact title.
        content: The complete new body (markdown, no frontmatter).
    """
    prior = _count_prior_writes_this_turn(state["messages"])
    if prior >= _MAX_WRITES_PER_TURN:
        return (
            f"Error: reached the per-turn cap of {_MAX_WRITES_PER_TURN} vault "
            "writes/updates. Stop here rather than continuing to write more this turn."
        )

    path = _find_existing_note(title)
    if path is None:
        return f"Error: no note titled '{title}' found in the vault — use write_vault_note to create it."

    try:
        current = path.read_text()
    except (OSError, UnicodeDecodeError) as exc:
        return f"Error: could not read '{title}' before updating it: {exc}"

    if not _is_oni_authored(current):
        return (
            f"Error: '{title}' was not created by Oni (no 'oni: true' marker) — "
            "refusing to overwrite a note the user may have written themselves."
        )

    created = _read_frontmatter_field(current, "created") or date.today().isoformat()
    full = (
        _frontmatter_block(created=created, updated=date.today().isoformat())
        + content.rstrip("\n")
        + "\n"
    )
    path.write_text(full)
    return f"Updated '{title}' ({len(current)} -> {len(full)} bytes)."


@tool
def delete_vault_note(title: str) -> str:
    """Delete a note from Oni's own note vault. Refuses to delete a note
    that wasn't created by Oni (no `oni: true` marker) — this is the
    standing protection for anything the user wrote themselves.

    Args:
        title: The note's exact title.
    """
    path = _find_existing_note(title)
    if path is None:
        return f"Error: no note titled '{title}' found in the vault."

    try:
        content = path.read_text()
    except (OSError, UnicodeDecodeError) as exc:
        return f"Error: could not read '{title}' before deleting it: {exc}"

    if not _is_oni_authored(content):
        return (
            f"Error: '{title}' was not created by Oni (no 'oni: true' marker) — "
            "refusing to delete a note the user may have written themselves."
        )

    path.unlink()
    return f"Deleted '{title}'."


TOOLS = [search_vault, read_vault_note, write_vault_note, update_vault_note, delete_vault_note]


def build_obsidian_tools() -> list:
    return list(TOOLS)
