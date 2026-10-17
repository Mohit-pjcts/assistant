"""Vault sync API for the iPhone app (PLAN.md Phase 30, `docs/adr/0004-*`).

The phone keeps a Replica of the Vault's Notes; the Mac's Vault stays the
source of truth. This router is how the two meet. Everything lives under
`/vault` and **every route requires a bearer token** (ADR 0004: the token
protects `/vault/*` only — the rest of the API keeps today's access, and
Phase 31 is where that gets revisited).

**Who is acting.** These endpoints are the USER editing a Note from their
phone, not Oni. The `oni: true` authorship guard therefore does NOT apply
here — it lives in Oni's own tools (`obsidian_tools.py`), where it stops the
model from overwriting something the user wrote. The user may edit or delete
any Note from the app.

**Conflicts are decided by hash, never by timestamp.** Every Note is
identified by the SHA-256 of its bytes. The phone remembers the hash it last
synced and sends it back as `base_sha256` with a write or delete:

- hash still matches → the write goes through;
- hash differs → 409 (`stale`): the Mac's copy changed since the phone last
  looked. The phone then uploads its own version to `_conflicts/`
  (`POST /vault/conflicts`) — a Conflict copy — and keeps the Mac's version
  as the Note. Nothing is overwritten or discarded.
- **An edit beats a delete.** Deleting with a stale hash is a 409, and
  editing a Note that has since been deleted on the Mac recreates it.
- Re-sending a write whose content is already what's on disk succeeds
  quietly, so an offline queue that replays after a lost response is safe.

**Soft delete.** `DELETE /vault/note` moves the Note into `_trash/` (via
`obsidian_tools.move_to_trash`, the same path Oni's own delete takes). Only
`DELETE /vault/trash?confirm=true` removes anything for good, and
`DELETE /vault/conflicts` removes one Conflict copy the user has resolved.
Both are explicit user actions.

**Path rules** follow the project convention (resolve, then `relative_to`):
relative paths only, `.md` only, no traversal or hidden components (so
`.obsidian/` can never be read or written), no symlink escapes. `_conflicts/`
and `_trash/` are reserved: Notes cannot be written into or deleted out of
them through `/vault/note` — only through the dedicated routes below.

**Known, accepted race:** the hash check and the file replace are serialized
against other sync requests by a lock, but not against Obsidian or Oni's own
tools writing the same file in the same few milliseconds. The window is tiny
and a loser of that race is a lost edit to a single Note on a single-user
vault; closing it would need OS-level file locking Obsidian wouldn't honour.

The token lives in a gitignored file (`.vault_token`, mode 600), is read per
request (so rotating it needs no restart) and is created on first use.
`python -m assistant.vault_sync [--rotate]` prints it.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import os
import re
import secrets
import sys
import tempfile
import threading
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from assistant import obsidian_tools

TOKEN_PATH = Path(__file__).resolve().parent.parent / ".vault_token"

# Largest real Note today is ~55 KB; this is a ceiling against a runaway or
# hostile client, not an expected size.
MAX_NOTE_BYTES = 1_000_000
_MAX_QUERY_CHARS = 500

_WRITE_LOCK = threading.Lock()

# `<stem> (phone 2026-10-18 143012).md` / `<stem> (deleted 2026-10-18 143012).md`
# (optionally with a collision counter) — what the two reserved folders add to
# a name, so the original can be reconstructed for display and restore.
_CONFLICT_SUFFIX = re.compile(r" \(phone \d{4}-\d{2}-\d{2} \d{6}(?: \d+)?\)$")
_TRASH_SUFFIX = re.compile(r" \(deleted \d{4}-\d{2}-\d{2} \d{6}\)$")


# --- Token ------------------------------------------------------------------


def load_or_create_token(*, rotate: bool = False) -> str:
    """The Vault API's bearer token. Created (mode 600) on first use; with
    `rotate=True` replaced atomically. Read from disk each call so a rotation
    takes effect immediately. A token file that exists but is empty (a crash
    mid-write, a manual `touch`) is replaced, never accepted: an empty token
    would let an empty `Bearer ` header through."""
    if not rotate:
        with contextlib.suppress(OSError):
            existing = TOKEN_PATH.read_text().strip()
            if existing:
                return existing
    token = secrets.token_urlsafe(32)
    if not rotate and not TOKEN_PATH.exists():
        try:
            fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # Another request created it between our read and our create.
            existing = TOKEN_PATH.read_text().strip()
            if existing:
                return existing
        else:
            with os.fdopen(fd, "w") as fh:
                fh.write(token + "\n")
            return token
    tmp = TOKEN_PATH.with_name(TOKEN_PATH.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(token + "\n")
    tmp.replace(TOKEN_PATH)
    return token


def require_vault_token(authorization: str | None = Header(default=None)) -> None:
    """401 unless `Authorization: Bearer <token>` matches (constant-time)."""
    expected = load_or_create_token()
    if not expected:
        raise HTTPException(status_code=500, detail="Vault token is not configured.")
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        supplied.strip().encode(), expected.encode()
    ):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid Vault token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


router = APIRouter(prefix="/vault", dependencies=[Depends(require_vault_token)])


# --- Paths and files --------------------------------------------------------


def _root() -> Path:
    return obsidian_tools.VAULT_DIR


def _bad(detail: str, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def _clean_rel(rel: str) -> PurePosixPath:
    """Validates a Vault-relative Note path. Strict on purpose: the
    canonical form must round-trip unchanged, which rejects `a//b`, `./a`,
    trailing slashes and anything absolute or containing `..`."""
    if not isinstance(rel, str) or not rel or "\x00" in rel or "\\" in rel:
        raise _bad("Invalid path.")
    p = PurePosixPath(rel)
    if p.is_absolute() or str(p) != rel or any(part in (".", "..") for part in p.parts):
        raise _bad("Invalid path.")
    if any(part.startswith(".") for part in p.parts):
        raise _bad("Hidden files and folders are not part of the Vault API.")
    if p.suffix != ".md":
        raise _bad("Only Markdown (.md) Notes are supported.")
    return p


def _resolve(rel: PurePosixPath) -> Path:
    root = _root().resolve()
    full = (root / rel).resolve()
    try:
        full.relative_to(root)
    except ValueError as exc:
        raise _bad("Invalid path.") from exc
    return full


def _is_reserved(rel: PurePosixPath) -> bool:
    return bool(rel.parts) and rel.parts[0] in obsidian_tools.RESERVED_DIR_NAMES


def _note_rel(rel: str) -> PurePosixPath:
    """A Note path for WRITING: valid, and not inside a reserved folder."""
    p = _clean_rel(rel)
    if _is_reserved(p):
        raise _bad("_conflicts/ and _trash/ are managed through their own routes.", 403)
    return p


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _info(rel: PurePosixPath | str, path: Path, data: bytes) -> dict[str, Any]:
    st = path.stat()
    return {
        "path": str(rel),
        "sha256": _sha256(data),
        "mtime": int(st.st_mtime),
        "size": len(data),
    }


def _write_atomic(path: Path, data: bytes) -> None:
    """Writes beside the target and renames over it, so a reader (or a crash)
    never sees a half-written Note."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".oni-sync-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        Path(tmp_name).replace(path)
    except BaseException:
        with contextlib.suppress(OSError):
            Path(tmp_name).unlink()
        raise


def _sync_files(root: Path) -> list[Path]:
    """Every Markdown Note the phone may hold: hidden folders (`.obsidian/`,
    Obsidian's own `.trash/`), the reserved folders and symlinks excluded."""
    out: list[Path] = []
    for p in root.rglob("*.md"):
        rel = p.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if obsidian_tools.in_reserved_dir(p, root) or p.is_symlink() or not p.is_file():
            continue
        out.append(p)
    return sorted(out)


def _read_checked(path: Path) -> bytes:
    data = path.read_bytes()
    if len(data) > MAX_NOTE_BYTES:
        raise _bad("Note is too large.", 413)
    return data


def _list_reserved(folder: str) -> list[dict[str, Any]]:
    base = _root() / folder
    if not base.is_dir():
        return []
    entries = []
    for p in sorted(base.rglob("*.md")):
        if p.is_symlink() or not p.is_file():
            continue
        rel = p.relative_to(_root())
        data = p.read_bytes()
        entries.append(
            {**_info(rel.as_posix(), p, data), "original_path": _original_path(rel, folder)}
        )
    return entries


def _original_path(rel: Path, folder: str) -> str | None:
    """Best-effort: strips the reserved folder and the ` (phone …)` /
    ` (deleted …)` marker the folder added to the name."""
    inner = rel.relative_to(folder)
    suffix = _CONFLICT_SUFFIX if folder == obsidian_tools.CONFLICTS_DIR_NAME else _TRASH_SUFFIX
    stem = suffix.sub("", inner.stem)
    if folder == obsidian_tools.CONFLICTS_DIR_NAME and stem == inner.stem:
        return None
    return inner.with_name(stem + inner.suffix).as_posix()


def glob_escape(text: str) -> str:
    """Escapes glob metacharacters in a Note stem used inside a pattern."""
    return re.sub(r"([\[\]*?])", r"[\1]", text)


# --- Request bodies ---------------------------------------------------------


class PutNote(BaseModel):
    path: str
    content: str
    base_sha256: str | None = None


class ConflictUpload(BaseModel):
    path: str
    content: str


class TrashRestore(BaseModel):
    path: str


# --- Routes -----------------------------------------------------------------


@router.get("/ping")
def ping() -> dict[str, Any]:
    """Cheap authenticated check for the app's pairing screen."""
    root = _root()
    return {
        "ok": True,
        "vault": root.name,
        "notes": len(_sync_files(root)) if root.is_dir() else 0,
        "server_time": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


@router.get("/manifest")
def manifest() -> dict[str, Any]:
    """Every syncable Note: relative path, SHA-256, mtime (epoch seconds),
    size. The phone diffs this against what it last synced."""
    root = _root()
    notes = []
    if root.is_dir():
        for p in _sync_files(root):
            try:
                notes.append(_info(p.relative_to(root).as_posix(), p, p.read_bytes()))
            except OSError:
                continue  # vanished or unreadable mid-walk: next sync picks it up
    return {"notes": notes}


@router.get("/note")
def get_note(path: str = Query(...)) -> dict[str, Any]:
    """One Note's text. Also reads inside `_conflicts/` and `_trash/` (a
    read, so the app can show a Conflict copy or a trashed Note)."""
    rel = _clean_rel(path)
    target = _resolve(rel)
    if not target.is_file():
        raise _bad("No such note.", 404)
    data = _read_checked(target)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _bad("Note is not UTF-8 text.", 415) from exc
    return {**_info(rel, target, data), "content": text}


@router.put("/note")
def put_note(body: PutNote) -> dict[str, Any]:
    """Create or update a Note. See the module docstring for the hash rules."""
    rel = _note_rel(body.path)
    new_bytes = body.content.encode("utf-8")
    if len(new_bytes) > MAX_NOTE_BYTES:
        raise _bad("Note is too large.", 413)
    target = _resolve(rel)
    with _WRITE_LOCK:
        recreated = False
        if target.is_file():
            current = target.read_bytes()
            current_hash = _sha256(current)
            if current_hash == _sha256(new_bytes):
                return {**_info(rel, target, current), "recreated": False}
            if body.base_sha256 is None:
                raise HTTPException(
                    409, detail={"code": "exists", "current_sha256": current_hash}
                )
            if body.base_sha256 != current_hash:
                raise HTTPException(
                    409, detail={"code": "stale", "current_sha256": current_hash}
                )
        elif target.exists():
            raise _bad("Path is not a note.", 409)
        else:
            # A base hash with no file means the Note was deleted on the Mac
            # since the phone last synced it. The phone's edit wins: recreate.
            recreated = body.base_sha256 is not None
        try:
            _write_atomic(target, new_bytes)
        except OSError as exc:
            raise _bad(f"Could not write the note: {exc.strerror or exc}", 500) from exc
        return {**_info(rel, target, new_bytes), "recreated": recreated}


@router.delete("/note")
def delete_note(path: str = Query(...), base_sha256: str = Query(...)) -> dict[str, Any]:
    """Soft delete: move the Note to `_trash/`. A stale hash is a 409 — an
    edit made on the Mac since the phone last synced beats the delete."""
    rel = _note_rel(path)
    target = _resolve(rel)
    with _WRITE_LOCK:
        if not target.is_file():
            raise HTTPException(404, detail={"code": "missing"})
        current_hash = _sha256(_read_checked(target))
        if current_hash != base_sha256:
            raise HTTPException(409, detail={"code": "stale", "current_sha256": current_hash})
        try:
            dest = obsidian_tools.move_to_trash(target, _root().resolve())
        except (OSError, ValueError) as exc:
            raise _bad(f"Could not move the note to the trash: {exc}", 500) from exc
    return {"path": str(rel), "trashed_as": dest.relative_to(_root().resolve()).as_posix()}


@router.post("/conflicts")
def upload_conflict(body: ConflictUpload) -> dict[str, Any]:
    """Store the phone's version of a Note that lost a sync race. Idempotent:
    uploading the same content for the same Note again returns the existing
    copy instead of making another."""
    rel = _note_rel(body.path)
    data = body.content.encode("utf-8")
    if len(data) > MAX_NOTE_BYTES:
        raise _bad("Note is too large.", 413)
    digest = _sha256(data)
    root = _root().resolve()
    folder = root / obsidian_tools.CONFLICTS_DIR_NAME / Path(*rel.parent.parts)
    with _WRITE_LOCK:
        if folder.is_dir():
            for existing in folder.glob(f"{glob_escape(rel.stem)} (phone *).md"):
                if existing.is_file() and _sha256(existing.read_bytes()) == digest:
                    return _info(existing.relative_to(root).as_posix(), existing, data)
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        dest = folder / f"{rel.stem} (phone {stamp}).md"
        counter = 1
        while dest.exists():
            counter += 1
            dest = folder / f"{rel.stem} (phone {stamp} {counter}).md"
        try:
            _write_atomic(dest, data)
        except OSError as exc:
            raise _bad(f"Could not store the conflict copy: {exc.strerror or exc}", 500) from exc
        return _info(dest.relative_to(root).as_posix(), dest, data)


@router.get("/conflicts")
def list_conflicts() -> dict[str, Any]:
    return {"conflicts": _list_reserved(obsidian_tools.CONFLICTS_DIR_NAME)}


@router.delete("/conflicts")
def resolve_conflict(path: str = Query(...)) -> dict[str, Any]:
    """The user has resolved this Conflict copy: remove it."""
    rel = _clean_rel(path)
    if rel.parts[0] != obsidian_tools.CONFLICTS_DIR_NAME or len(rel.parts) < 2:
        raise _bad("Not a conflict copy.", 403)
    target = _resolve(rel)
    with _WRITE_LOCK:
        if not target.is_file():
            raise _bad("No such conflict copy.", 404)
        target.unlink()
    return {"path": str(rel), "removed": True}


@router.get("/trash")
def list_trash() -> dict[str, Any]:
    return {"trash": _list_reserved(obsidian_tools.TRASH_DIR_NAME)}


@router.post("/trash/restore")
def restore_from_trash(body: TrashRestore) -> dict[str, Any]:
    """Move a trashed Note back to where it came from. 409 if something is
    already there — it is never overwritten."""
    rel = _clean_rel(body.path)
    if rel.parts[0] != obsidian_tools.TRASH_DIR_NAME or len(rel.parts) < 2:
        raise _bad("Not a trashed note.", 403)
    original = _original_path(Path(*rel.parts), obsidian_tools.TRASH_DIR_NAME)
    if original is None:
        raise _bad("Cannot work out where this note came from.", 409)
    source = _resolve(rel)
    dest = _resolve(_note_rel(original))
    with _WRITE_LOCK:
        if not source.is_file():
            raise _bad("No such trashed note.", 404)
        if dest.exists():
            raise HTTPException(409, detail={"code": "exists"})
        dest.parent.mkdir(parents=True, exist_ok=True)
        source.replace(dest)
    return {"path": original, "sha256": _sha256(dest.read_bytes())}


@router.delete("/trash")
def empty_trash(confirm: bool = Query(False)) -> dict[str, Any]:
    """Permanently remove everything in `_trash/`. Requires `confirm=true`."""
    if not confirm:
        raise _bad("Pass confirm=true to empty the trash permanently.")
    base = _root() / obsidian_tools.TRASH_DIR_NAME
    removed = 0
    with _WRITE_LOCK:
        if base.is_dir():
            for p in sorted(base.rglob("*"), key=lambda q: len(q.parts), reverse=True):
                if p.is_symlink() or p.is_file():
                    p.unlink()
                    removed += 1
                elif p.is_dir():
                    with contextlib.suppress(OSError):
                        p.rmdir()
    return {"removed": removed}


@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=_MAX_QUERY_CHARS)) -> dict[str, Any]:
    """The Mac's semantic search (`vault_search.py`) for the phone, which has
    only keyword search of its own. Returns titles with their Vault-relative
    path and score; the phone reads the text from its own Replica."""
    from assistant import vault_search

    root = _root()
    by_stem: dict[str, str] = {}
    for p in _sync_files(root) if root.is_dir() else []:
        by_stem.setdefault(p.stem, p.relative_to(root).as_posix())
    hits = []
    for title, score in vault_search.semantic_search(q):
        if title in by_stem:
            hits.append({"title": title, "path": by_stem[title], "score": round(float(score), 4)})
    return {"hits": hits}


def main(argv: list[str]) -> int:
    rotate = "--rotate" in argv
    token = load_or_create_token(rotate=rotate)
    print("Vault API token" + (" (rotated)" if rotate else "") + ":")
    print(token)
    print("\nPaste it into the Oni iPhone app once. Serve the backend over HTTPS with:")
    print("  tailscale serve --bg 8000")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
