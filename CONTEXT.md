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
