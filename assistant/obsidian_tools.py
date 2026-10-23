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
happens once they are. This module used to cap `write_vault_note`/
`update_vault_note` at 3 combined calls per specialist invocation as a
backstop against that autonomy turning into a runaway loop — that cap has
since been removed outright (ADR 0003), not merely re-scoped; there is no
per-turn write ceiling of any kind anymore. See ADR 0003 for the full
reasoning, including the real scoping bug (the cap reset per specialist
delegation, not per true user turn, so it never actually enforced what it
claimed to) that prompted revisiting ADR 0002's own "should not be relaxed
without revisiting this decision" condition on it.

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
Decision 11). **Supplemented by semantic search (backlog Section 3
feature, STEPS.md 150)** as the vault grows past keyword matching's own
limits — `search_vault` runs the exact substring search first, then adds
`assistant/vault_search.py`'s embedding-similarity results for any note
the substring pass missed. See that module's own docstring for the local-
embedding-model design (no external API, no per-query cost).

**Active linking is mandatory, not optional** (Decision 8): `write_vault_note`
itself searches existing Note titles for keyword overlap and appends a
"Related Notes" section with real `[[wikilinks]]` to what it finds — this is
enforced by the tool's own contract (it generates the links itself from
real filename matches), not left to the model to remember to do via a
separate `search_vault` call and hand-typed links, which would risk
hallucinated targets.

**No per-turn write cap** (superseded Decision 10, see ADR 0003):
`write_vault_note`/`update_vault_note` used to be capped at 3 combined
calls per specialist invocation, but the cap was removed outright rather
than fixed — it was scoped per specialist `ainvoke()`, not per true user
turn, so Phase 25 workflow chaining could already exceed it in practice.

**Reserved folders and the Trash** (PLAN.md Phase 30, `docs/adr/0004-*`):
the Vault holds two folders that are not Notes — `_conflicts/` (a phone
edit that lost a sync race) and `_trash/` (anything deleted). Every walker
here skips them (`in_reserved_dir`), so Oni never searches, links to,
updates or deletes what is in them. `delete_vault_note` no longer unlinks
the file: it moves it into `_trash/` keeping its relative path, so a delete
by Oni is as recoverable as one from the phone. The `oni: true` authorship
check is unchanged and still the only guard.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path

from langchain_core.tools import tool

VAULT_DIR = Path.home() / "Documents" / "OniVault"

CONFLICTS_DIR_NAME = "_conflicts"
TRASH_DIR_NAME = "_trash"
RESERVED_DIR_NAMES = (CONFLICTS_DIR_NAME, TRASH_DIR_NAME)

_MAX_SEARCH_RESULTS = 20
_MAX_CHUNK_RESULTS = 8
_MAX_READ_BYTES = 200_000
_MAX_RELATED_NOTES = 5
_SNIPPET_RADIUS = 80

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
        if path.stem == target and not in_reserved_dir(path, VAULT_DIR):
            return path
    return None


def in_reserved_dir(path: Path, root: Path) -> bool:
    """True if `path` sits under one of the Vault's reserved top-level
    folders (`_conflicts/`, `_trash/`) relative to `root`. `root` is passed
    in, not read from `VAULT_DIR`, because `vault_search.py` and
    `calendar_store.py` each hold their own binding of the vault root."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return False
    return bool(parts) and parts[0] in RESERVED_DIR_NAMES


def move_to_trash(path: Path, root: Path | None = None) -> Path:
    """Moves a Note into `<root>/_trash/`, keeping its relative path so a
    restore knows where it came from. A name already in the Trash is not
    overwritten: ` (deleted YYYY-MM-DD HHMMSS)` is added before the
    extension. Returns the Trash path. Raises ValueError for a path outside
    the Vault or already inside a reserved folder."""
    base = VAULT_DIR if root is None else root
    try:
        rel = path.relative_to(base)
    except ValueError as exc:
        msg = f"'{path}' is not inside the vault"
        raise ValueError(msg) from exc
    if in_reserved_dir(path, base):
        msg = f"'{rel}' is already in a reserved folder"
        raise ValueError(msg)
    dest = base / TRASH_DIR_NAME / rel
    if dest.exists():
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        dest = dest.with_name(f"{dest.stem} (deleted {stamp}){dest.suffix}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    path.replace(dest)
    return dest


def _iter_notes() -> list[Path]:
    return sorted(p for p in VAULT_DIR.rglob("*.md") if not in_reserved_dir(p, VAULT_DIR))


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


def _frontmatter_block(*, created: str, updated: str | None = None) -> str:
    lines = ["---", "oni: true", f"created: {created}"]
    if updated:
        lines.append(f"updated: {updated}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


@tool
def search_vault(query: str) -> str:
    """Search Oni's own note vault (title and content) for `query` —
    substring match, case-insensitive, plus a semantic supplement so a
    paraphrase or synonym-shaped query (not just an exact phrase) can still
    find a relevant note; a result marked "(semantic match...)" means it
    didn't literally contain your search text but is topically related, and
    one marked "(best match under 'Heading')" shows the passage inside the
    note (anywhere in it) that matched, found by keyword + meaning together.
    Scoped to the vault only (not the whole disk). Use this to check
    whether something related already exists before writing a new note, or
    to find a note to read/update/delete.

    Args:
        query: Search text.
    """
    if not VAULT_DIR.exists():
        return f"Error: vault directory '{VAULT_DIR}' does not exist."
    needle = query.lower()
    hits: list[str] = []
    exact_titles: set[str] = set()
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
        exact_titles.add(title)

    # Semantic search supplements, never replaces, the exact substring
    # search above — a course code or other exact term is still found
    # precisely by it; this only adds notes a paraphrase/synonym-shaped
    # query would otherwise miss entirely. Deferred import: vault_search.py
    # imports VAULT_DIR from this module, so a module-level import here
    # would be circular.
    from assistant.vault_search import semantic_search

    semantic_hits = [
        (title, score) for title, score in semantic_search(query) if title not in exact_titles
    ]

    # Chunk-level hybrid (BM25 + dense, vault_index.py) is ADDED for notes the two passes above did
    # not list: it reaches text anywhere in a note, and a natural-language question that never matches
    # as a verbatim substring. Failing soft keeps search_vault exactly as it was if the index breaks.
    from assistant import vault_index

    listed = exact_titles | {title for title, _ in semantic_hits}
    try:
        chunk_hits = [
            (chunk, score) for chunk, score in vault_index.search(query, top_k=_MAX_CHUNK_RESULTS + len(listed))
            if chunk.title not in exact_titles
        ]
    except Exception:  # noqa: BLE001
        chunk_hits = []
    chunk_titles = {chunk.title for chunk, _ in chunk_hits[:_MAX_CHUNK_RESULTS]}
    semantic_hits = [(t, sc) for t, sc in semantic_hits if t not in chunk_titles]

    if not hits and not semantic_hits and not chunk_hits:
        return f"No notes found matching '{query}'."

    shown = hits[:_MAX_SEARCH_RESULTS]
    lines = "\n".join(shown) if shown else ""
    if len(hits) > len(shown):
        lines += f"\n... and {len(hits) - len(shown)} more (truncated)"

    if chunk_hits:
        chunk_lines = "\n".join(
            f"[[{c.title}]] (best match" + (f" under '{c.heading}'" if c.heading else "") + f"): …{_chunk_snippet(c.text, c.title, c.heading)}…"
            for c, _ in chunk_hits[:_MAX_CHUNK_RESULTS]
        )
        lines = f"{lines}\n{chunk_lines}" if lines else chunk_lines

    if semantic_hits:
        semantic_lines = "\n".join(
            f"[[{title}]] (semantic match, no exact text overlap, score={score:.2f})"
            for title, score in semantic_hits
        )
        lines = f"{lines}\n{semantic_lines}" if lines else semantic_lines

    return lines


def _chunk_snippet(text: str, title: str, heading: str, limit: int = 200) -> str:
    body = text[len(title) + 1 :]
    if heading and body.startswith(heading):
        body = body[len(heading) + 1 :]
    return " ".join(body.split())[:limit].strip()


@tool
def read_vault_note(title: str, query: str = "", section: str = "") -> str:
    """Read one note from Oni's own note vault by its exact title.

    A note longer than about 20,000 characters is returned cut, with its outline and an exact
    instruction for the rest, unless it is one Oni wrote itself. To read part of any note without
    fetching all of it, pass `section` (a heading in the note) or `query` (what you are looking for).

    Args:
        title: The note's title (matches its filename, without `.md`).
        query: Optional. Return only the passages of this note that best match these words.
        section: Optional. Return only the section under this heading (takes precedence over query).
    """
    path = _find_existing_note(title)
    if path is None:
        return f"Error: no note titled '{title}' found in the vault."
    try:
        data = path.read_bytes()
    except OSError as exc:
        return f"Error: could not read '{title}': {exc}"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return f"Error: '{title}' is not a text file"

    from assistant import vault_index

    body = vault_index.strip_frontmatter(text)
    if section:
        found = vault_index.read_section(body, section)
        if found is None:
            heads = ", ".join(h for _, _, h in vault_index.outline(body)) or "(no headings)"
            return f"Error: no heading matching '{section}' in '{title}'. Headings: {heads}"
        return f"[Section '{section}' of '{title}', {len(found)} of {len(body)} characters]\n\n{found}"
    if query:
        relpath = str(path.relative_to(VAULT_DIR))
        try:
            passages = vault_index.read_relevant(relpath, query)
        except Exception:  # noqa: BLE001 - fall through to a plain read rather than fail the call
            passages = None
        if passages:
            return (f"[Passages of '{title}' matching '{query}', not the whole note ({len(body)} characters). "
                    f"Call again with section=... or without query for more.]\n\n{passages}")
        # no passage matched (or the note is not indexed): fall through and read it normally
    if len(text) <= vault_index.FULL_READ_CHARS or _is_oni_authored(text):
        if len(data) > _MAX_READ_BYTES:
            return f"Error: '{title}' is too large to read ({len(data)} bytes, cap {_MAX_READ_BYTES})"
        return text
    cut = text.rfind("\n\n", 0, vault_index.FULL_READ_CHARS)
    cut = cut if cut > vault_index.FULL_READ_CHARS // 2 else vault_index.FULL_READ_CHARS
    heads = vault_index.outline(body)
    toc = "\n".join(f"{'  ' * (lvl - 1)}- {head}" for lvl, _, head in heads[:60]) or "(no headings)"
    return (
        f"{text[:cut]}\n\n[CUT: showing {cut} of {len(text)} characters of '{title}'. This is a partial view: "
        f"do not base update_vault_note on it. Outline:\n{toc}\n"
        f"Fetch more with read_vault_note(title, section='<heading>') or read_vault_note(title, query='<what you need>').]"
    )


@tool
def write_vault_note(title: str, content: str) -> str:
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
    if not VAULT_DIR.exists():
        VAULT_DIR.mkdir(parents=True, exist_ok=True)

    path = _note_path_for_new(title)
    # Whole-tree check, not just the root — a title colliding with one of
    # the 138 pre-existing nested course notes must also be refused, not
    # just a collision with something Oni itself wrote at the root.
    if _find_existing_note(title) is not None:
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
def update_vault_note(title: str, content: str) -> str:
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
    """Delete a note from Oni's own note vault — it is moved to the vault's
    trash folder, not erased, so the user can restore it. Refuses to delete
    a note that wasn't created by Oni (no `oni: true` marker) — this is the
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

    try:
        move_to_trash(path)
    except OSError as exc:
        return f"Error: could not move '{title}' to the trash: {exc}"
    return f"Deleted '{title}' (moved to the vault's trash; the user can restore it)."


TOOLS = [search_vault, read_vault_note, write_vault_note, update_vault_note, delete_vault_note]


def build_obsidian_tools() -> list:
    return list(TOOLS)
