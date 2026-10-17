"""Daily diary entries — one Note per day, stored in Oni's own Obsidian
vault (`obsidian_tools.VAULT_DIR`), under a dedicated `Diary/` subfolder.

Built at the user's own direct request ("I want to diary everyday and give
Oni access to every diary entry so she can know more about me"), scoped via
two explicit choices: entries live in the existing vault (not a new store),
and are authored through a dedicated journal box in the dashboard (not a
back-and-forth conversation with Oni).

**Deliberately NOT written through `obsidian_tools.write_vault_note`/
`update_vault_note`** — those are Oni's own agent tools and always stamp
`oni: true` on what they write, which is exactly the marker
`obsidian_tools.delete_vault_note`/`update_vault_note` use to decide
whether ONI is allowed to overwrite or delete a note. A diary entry is the
user's own writing, not Oni's — stamping it `oni: true` would silently
strip the one protection ADR 0001 gives the user's own content (Oni's
`delete_vault_note`/`update_vault_note` would then be able to touch it).
This module's own frontmatter carries `diary: true` instead, and never
`oni: true` — so Oni can read and search every entry (via `search_vault`,
which walks the whole vault tree, Diary/ included, no code change needed
there) but can never modify or delete one, the same standing guarantee the
vault already gives any note the user wrote by hand.

**One Note per calendar day, full-replace semantics** — writing again for a
day that already has an entry overwrites it (the journal box is edited-in-
place, not an append log), matching how a single day's diary page normally
works. Entries for OTHER days are untouched by a write to today's.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

# A plain `from ... import VAULT_DIR` is its own separate binding in this
# module's namespace (the same gotcha vault_search.py has, per
# test_obsidian_tools.py's own fixture docstring) — a test that
# monkeypatches obsidian_tools.VAULT_DIR must also reassign
# diary_store.VAULT_DIR directly, not rely on this import alone.
from assistant.obsidian_tools import VAULT_DIR

DIARY_SUBDIR = "Diary"

_MAX_SNIPPET_CHARS = 200


@dataclass
class DiaryEntry:
    entry_date: str  # ISO date (YYYY-MM-DD), also the note's filename stem
    content: str
    created_at: str
    updated_at: str | None


def _diary_dir() -> None:
    (VAULT_DIR / DIARY_SUBDIR).mkdir(parents=True, exist_ok=True)


def _path_for(entry_date: date):
    return VAULT_DIR / DIARY_SUBDIR / f"{entry_date.isoformat()}.md"


def _frontmatter_field(content: str, field: str) -> str | None:
    if not content.startswith("---"):
        return None
    end = content.find("\n---", 3)
    if end == -1:
        return None
    m = re.search(rf"^{re.escape(field)}:\s*(.+?)\s*$", content[3:end], re.MULTILINE)
    return m.group(1).strip() if m else None


def _strip_frontmatter(content: str) -> str:
    if not content.startswith("---"):
        return content
    end = content.find("\n---", 3)
    if end == -1:
        return content
    return content[end + 4 :].lstrip("\n")


def _render(entry_date: date, content: str, *, created: str, updated: str | None) -> str:
    lines = ["---", "diary: true", f"date: {entry_date.isoformat()}", f"created: {created}"]
    if updated:
        lines.append(f"updated: {updated}")
    lines.append("---")
    frontmatter = "\n".join(lines) + "\n\n"
    return frontmatter + content.rstrip("\n") + "\n"


def write_diary_entry(content: str, entry_date: date | None = None) -> DiaryEntry:
    """Create today's (or a given day's) diary entry, or fully replace it if
    one already exists for that day."""
    entry_date = entry_date or date.today()
    _diary_dir()
    path = _path_for(entry_date)
    today_iso = date.today().isoformat()

    created = today_iso
    updated: str | None = None
    if path.exists():
        existing = path.read_text()
        created = _frontmatter_field(existing, "created") or today_iso
        updated = today_iso

    path.write_text(_render(entry_date, content, created=created, updated=updated))
    return DiaryEntry(
        entry_date=entry_date.isoformat(), content=content.rstrip("\n"), created_at=created, updated_at=updated
    )


def get_diary_entry(entry_date: date) -> DiaryEntry | None:
    path = _path_for(entry_date)
    if not path.exists():
        return None
    raw = path.read_text()
    return DiaryEntry(
        entry_date=entry_date.isoformat(),
        content=_strip_frontmatter(raw).rstrip("\n"),
        created_at=_frontmatter_field(raw, "created") or entry_date.isoformat(),
        updated_at=_frontmatter_field(raw, "updated"),
    )


def list_diary_entries() -> list[DiaryEntry]:
    """All entries, newest day first. ISO filenames sort lexically in
    calendar order, so a reversed filename sort is enough — no need to
    parse the frontmatter `date` field just to order the list."""
    diary_dir = VAULT_DIR / DIARY_SUBDIR
    if not diary_dir.exists():
        return []
    entries: list[DiaryEntry] = []
    for path in sorted(diary_dir.glob("*.md"), reverse=True):
        raw = path.read_text()
        entries.append(
            DiaryEntry(
                entry_date=path.stem,
                content=_strip_frontmatter(raw).rstrip("\n"),
                created_at=_frontmatter_field(raw, "created") or path.stem,
                updated_at=_frontmatter_field(raw, "updated"),
            )
        )
    return entries


def delete_diary_entry(entry_date: date) -> bool:
    """User-initiated deletion of their own entry — same "curating your own
    data" reasoning as board_store's delete, no confirmation gate needed
    (this is dashboard-only; Oni itself has no delete access here at all,
    see module docstring)."""
    path = _path_for(entry_date)
    if not path.exists():
        return False
    path.unlink()
    return True
