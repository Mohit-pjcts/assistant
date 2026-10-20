# Oni

Personal AI assistant (Claude API + LangGraph). This file exists to keep this
project's several distinct persistence mechanisms from being conflated —
they sound similar in casual conversation ("memory", "notes", "files") but
are structurally different concepts.

## Language

**Workspace**:
The sandboxed directory (`workspace/`) that `tools.py`'s `read_file`/
`write_file` are confined to — the project's original, most restrictive file
area. Traversal outside it is rejected.
_Avoid_: vault, disk

**Fact**:
A single durable, curated piece of information about the user, stored in
`memory_store.py`'s `long_term_memory.sqlite`. Queued via nightly batch
review, approved explicitly, and recalled in full on a thread's first
genuine turn. Small in number by design — a curated profile, never a large
corpus.
_Avoid_: note, memory (ambiguous — see Vault, Note)

**Vault**:
`~/Documents/OniVault` — a dedicated Obsidian vault that exists purely as
Oni's own note-store (PLAN.md Phase 27). Distinct from the user's personal
Obsidian vaults (`Courses`, `NovaWorks`) and from this repo's own local
vault — none of those are read or written by Oni. Unlike a Fact, nothing in
the Vault is ever loaded wholesale into context; it's retrieved on demand
via search.
_Avoid_: workspace, disk (the whole-Mac surface `disk_tools.py` covers)

**Note**:
A single markdown file inside the Vault. May be authored by Oni (carries an
`oni: true` frontmatter marker) or by the user directly in the Obsidian app.
Notes link to each other via `[[wikilinks]]`; redundancy across notes is
accepted by design, not treated as a defect — the Vault trades curation
(which Facts have) for volume and connectivity.
_Avoid_: fact, memory

**Conflict copy**:
A version of a Note that lost a sync race — the phone edited it while the
Mac's copy had also changed. Kept in the Vault's `_conflicts/` folder until
the user resolves it; Oni never searches, links to, or edits what is in that
folder. Nothing is ever discarded automatically.
_Avoid_: duplicate, backup

**Trash**:
The Vault's `_trash/` folder, where a Note deleted from the phone is moved
instead of being removed. Oni never searches, links to, or edits what is in
it, and nothing leaves it except the user restoring a Note or emptying it by
hand. A Note edited elsewhere since the delete is restored, not trashed.
_Avoid_: recycle bin, archive

**Replica**:
The phone app's own copy of the Vault's Notes — the Mac's Vault stays the
source of truth. Holds only the top-level folders the user has switched on,
and only Markdown Notes, never Obsidian's own settings. Edits made offline
reach the Vault at the next sync. Not a second Vault: it has no
independent identity.
_Avoid_: vault (on the phone), mirror, backup

**Thread**:
A single conversation with Oni — the checkpointed unit `thread_store.py`
(Phase 15) registers and `/chat`/`/resume` operate on. Predates this file;
named here for the first time because Project (below) now sits above it.
Always lives on the Mac and is shared with the dashboard.
_Avoid_: conversation; and **chat**, which now means something narrower (below)

**Project**:
A named grouping of Threads in the dashboard's sidebar — `Oni → Project →
Thread`, replacing the old flat thread list (dashboard redesign port,
PLAN.md). Deliberately NOT named "Vault" despite the mockup's own code using
that word for this same tree — that would collide with the Vault entry
above.
_Avoid_: vault, folder

**Chat**:
A conversation held with the on-device Oni inside the iPhone app (Phase 30).
Stored only on the phone, uses only the five Vault tools, and cannot become a
Thread or move to the Mac. The Oni tab's "This iPhone" side lists Chats; its
"Mac" side lists Threads (Phase 31).
_Avoid_: thread, conversation

**Detached turn**:
A turn started from the iPhone app that the Mac keeps running if the phone's
connection drops (Phase 31). The stream is only an observer; the app finds the
finished answer, or a gate waiting for it, when it reopens. Dashboard turns are
not detached — closing their connection still cancels them.
_Avoid_: background job, queued turn
