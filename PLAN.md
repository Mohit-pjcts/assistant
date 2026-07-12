# Project Plan — Personal AI Assistant

Companion to CLAUDE.md: rules live there, the six phase plans live here. Work
only the ACTIVE phase (per CLAUDE.md's Current Status). A phase is complete
when every done-when item is met; completion means a STEPS.md entry, a status
update in both files (with the user's approval), and a commit boundary (the
user runs git).

Steps marked CHECKPOINT require stopping and waiting for the user's input
before proceeding.

---

## Phase 1 — Foundations — COMPLETE (2026-07-08/09)

**Objective:** a single LangGraph agent with tool-calling and persistent
conversation memory, runnable as a CLI loop.

**Delivered:** memory.py (SqliteSaver context manager), tools.py (Tavily
search + sandboxed file r/w + denylisted shell exec behind the documented
security model), agent.py (create_agent on Sonnet 5, make_thread_config),
main.py (fixed-THREAD_ID CLI loop, clean exits on exit/EOF/SIGINT, per-turn
error handling), tests/ (17 tool tests + memory round-trip). Full record:
STEPS.md groups 1–8. Durable decisions promoted into CLAUDE.md's load-bearing
list.

**Done-when (all met):** a tool call round-trips through the graph; a denylist
rejection surfaces as a ToolMessage rather than a crash; memory persists
across separate process launches; clean exit on exit/EOF/SIGINT; an API error
doesn't kill the loop.

---

## Phase 2 — Gmail via MCP — COMPLETE (2026-07-10/11)

**Objective:** the agent can search and read my Gmail (read-only) via a
locally-run community Gmail MCP server behind my own Google Cloud OAuth app.
Google Calendar (read-only) follows as a mini-phase once Gmail is proven.

**Delivered:** mcp_tools.py (async MCP tool loading, merged into TOOLS at
startup); Gmail via `ArtyMcLabin/Gmail-MCP-Server` (OAuth grant itself scoped
to `gmail.readonly`); Calendar via `nspady/google-calendar-mcp` (OAuth grant
is NOT scope-restricted — no self-hosted server found supports that; enforced
read-only instead via an `ENABLED_TOOLS` server allowlist plus a
`tool_interceptors` hard block on write-tool calls, which caught a real gap
where the server ignored its own allowlist for `manage-accounts`); a second
interceptor confining Gmail's `download_attachment`/`download_email` to
`workspace/` (they write from a separate process, outside tools.py's own
sandbox); a third capping `maxResults` on list/search tools (cost). Required
migrating main.py/agent.py/memory.py to async (`graph.ainvoke()`,
`AsyncSqliteSaver`) — MCP-loaded tools only support async invocation, so this
wasn't optional. README.md added. Full record: STEPS.md groups 9–20.

**Scope rules:**
- MCP ADDS tools; it never replaces Phase 1's TOOLS.
- Read-only Gmail scope (`gmail.readonly`) ONLY. Send/modify is a future,
  separately-approved step that will sit behind the confirmation gate — not
  this phase, regardless of how convenient it would be.
- Self-hosted auth only: no Composio/Klavis/hosted MCP platforms. The
  credential chain stays entirely on my machine.
- Google Cloud Console steps are done by ME. Provide exact instructions,
  then wait.

**Steps:**
0. Pre-work — venv rebuild on Python 3.12 (decided 2026-07-09): delete
   `.venv`, recreate with python3.12, reinstall requirements + editable
   install, rerun both test files to confirm green on 3.12. Set
   `requires-python = ">=3.11"` in pyproject.toml. Flag anything
   version-related that breaks instead of silently working around it.
1. Verify `langchain-mcp-adapters` (`MultiServerMCPClient`) against its real
   docs/README — current API shape, transport config, tool loading. Not from
   memory. Pin the version in deps.
2. Research current, maintained community Gmail MCP servers (stdio transport
   preferred; configurable scopes; local token storage). Present 1–2 options
   with trade-offs. CHECKPOINT: wait for the user's pick.
3. Provide the exact Google Cloud Console setup: project creation, enable
   Gmail API, OAuth consent screen (external, user as test user), Desktop-app
   OAuth client, where credentials/token files will land. CHECKPOINT: the
   user does this part. Gitignore credential/token files immediately and
   verify with `git check-ignore`.
4. Propose the async integration plan BEFORE touching code — MCP tool loading
   is async; main.py/agent.py are sync and were verified by hand. CHECKPOINT:
   wait for approval. Then implement, and re-verify main.py's hand-verified
   behaviors (clean exits on exit/EOF/SIGINT, per-turn error handling)
   afterward.
5. Wire the MCP-loaded Gmail tools into the agent alongside the existing
   TOOLS list; update the system prompt minimally (email capability exists,
   read-only).
6. Smoke test end-to-end against the real inbox: search, read a specific
   thread, summarize unread. Confirm results flow through the graph into
   final answers. Cap how much email content is pulled into context (cost).
7. Mini-phase — Google Calendar MCP (read-only), same pattern: server
   research CHECKPOINT → user's console steps → wire → smoke test.
8. Write the first README.md: what this is, architecture sketch, setup (env
   vars, OAuth flow), roadmap pointer. Portfolio-quality.
9. STEPS.md updated throughout; propose the Phase 2 commit boundary.

**Done-when (met, with one caveat):** the agent correctly answers "summarize
my unread emails" and "what's on my calendar this week" from the CLI ✓;
Gmail's scope verified read-only in the OAuth consent ✓ — **Calendar's is
not**, by necessity (see Delivered above), read-only enforced at the
tool-allowlist/interceptor layer instead of the OAuth grant; token files
confirmed gitignored ✓; Phase 1 tests pass on the 3.12 venv ✓ (28 tests
total); README exists ✓.

---

## Phase 3 — Multi-agent split — COMPLETE (2026-07-11)

**Objective:** supervisor + sub-agents (coding, research, life-admin) behind
the same CLI, with observability in place before the complexity arrives.

**Delivered:** LangSmith tracing enabled (`LANGCHAIN_TRACING_V2`,
`LANGCHAIN_PROJECT=personal-assistant`, `LANGSMITH_ENDPOINT` — the account
is on LangSmith's APAC region); a hand-rolled outer `StateGraph`
(`assistant/supervisor.py`) routing via LangGraph's `Command`-based
handoff-tool pattern to three sub-agents (`assistant/sub_agents.py`:
coding, research, life-admin), each a `create_agent(...)` graph embedded as
a node; `checkpoint_ns` nests automatically per sub-agent under the shared
checkpointer, verified against real checkpoint rows; a dummy
confirmation-gated tool (`assistant/interrupts.py`) demonstrates the
standing confirmation rule via a real `langgraph.types.interrupt()`, wired
into `coding_agent` and surfaced as a y/n prompt in `main.py`'s loop.
`agent.py` trimmed to just `make_thread_config()`. Full record: STEPS.md
groups 21–25.

**Scope note:** step 3's Haiku evaluation is deliberately deferred —
`research_agent` (the best candidate, simplest single-tool role) stays on
Sonnet 5 for now; a follow-up pass using real LangSmith trace data will
decide whether to switch it, not part of this phase's completion.

**Steps:**
0. Enable LangSmith tracing first (`LANGCHAIN_TRACING_V2=true`; key already
   in .env) — observability before multi-agent debugging, not after.
1. Design checkpoint: compare LangGraph's supervisor pattern/library vs a
   hand-rolled graph of `create_agent` sub-agents with tool-call handoffs.
   Present trade-offs. CHECKPOINT: wait for the user's pick.
2. Define sub-agents and tool ownership: coding (file/shell), research (web
   search), life-admin (Gmail/Calendar MCP). Mac-control is a Phase 4 stub.
3. Models: supervisor on Sonnet 5; evaluate Haiku for the simplest
   sub-agent(s); measure the cost difference on real traces before locking in.
4. Memory: single shared checkpointer across the graph; verify
   thread/checkpoint namespacing across subgraphs (checkpoint_ns now
   genuinely matters — see STEPS.md 3.2).
5. Wire LangGraph interrupts to implement the standing confirmation rule
   (CLAUDE.md security model), demonstrated on a dummy side-effect tool, so
   the gate exists before any real side-effectful capability is added.
6. Regression: every Phase 1/2 capability still works through the
   supervisor; traces confirm requests route to the right sub-agent.

**Done-when (all met):** one CLI entry point routes correctly across three
sub-agents on real tasks ✓; traces visible in LangSmith ✓ (cross-checked
against real trace trees, not just final-answer correctness); the
interrupt/confirmation gate demonstrably fires ✓ (both confirm and decline
paths, end-to-end through the CLI); all prior tests pass ✓ (30/30 across 4
test files, plus every Phase 1/2 manual transcript re-verified against the
new graph).

---

## Phase 4 — Mac-native control — COMPLETE (2026-07-12/13)

**Objective:** the agent can operate the Mac for a defined, allowlisted set
of actions — and nothing else.

**Delivered:** `assistant/mac_tools.py` — an `osascript`/`open`/`shortcuts`-CLI
bridge behind a hard allowlist, argv-only subprocess execution throughout,
model-supplied values passed as osascript's own argv rather than
interpolated into script source (STEPS.md 30–31). Ungated: `open_app`,
Music playback control + read, Reminders/Notes read+create, `create_shortcut`
(opens a blank Shortcuts editor — no scriptable way to author a Shortcut's
actual logic exists, confirmed empirically rather than assumed, STEPS.md 33).
Gated behind a LangGraph interrupt regardless of name: `run_shortcut`. New
`mac_control_agent` sub-agent wired into the supervisor with its ownership
described in the routing prompt from the same edit that added the node
(STEPS.md 31.2, applying the routing lesson from STEPS.md 25). Reviewing
this phase's own non-allowlisted-refusal test also surfaced and closed a
real, pre-existing gap in Phase 1's shell tool — `osascript` denial,
home-directory sensitive paths, and a confirmation gate on inline
interpreter code (`python3 -c`, etc.) that doesn't touch normal
script-running usage (STEPS.md 32). 40 tests total project-wide, all
passing; every allowlisted action verified live against the real machine,
including the actual macOS Automation permission dialogs.

**Scope note:** `create_shortcut` was added mid-phase, beyond the original
step-1 checkpoint's allowlist, after the user asked for shortcut-creation
access. Deliberately scoped down from "fully automate Shortcut creation"
(which would mean authoring arbitrary automation with zero human review —
ruled out, same "no free-form scripting from model output" line the
original checkpoint drew for AppleScript) to "open a blank editor, user
finishes and saves it" — a discussed narrowing, not the literal original
ask (STEPS.md 33).

**Steps:**
1. Threat-model checkpoint FIRST: osascript means the agent controls the
   machine; the blast radius exceeds workspace/. Define the action allowlist
   (open app, Music play/pause/track, Reminders/Notes read + create, run
   named Shortcuts). Anything destructive or visible to other people goes
   behind the Phase 3 confirmation gate. CHECKPOINT: user approves the
   allowlist before implementation.
2. Implement the osascript bridge as a tool: argv-only subprocess with a
   timeout, script templates per allowlisted action — no free-form
   AppleScript execution from model output, ever.
3. Add as the mac-control sub-agent; its system prompt describes only the
   allowlisted capabilities.
4. Manually verify each allowlisted action, plus at least one blocked
   non-allowlisted attempt.

**Done-when (all met):** every allowlisted action works from the CLI ✓ —
verified live against the real machine: `open_app`, Music
play/pause/next/previous/now_playing, Reminders/Notes read+create
round-tripped for real (test artifacts cleaned up afterward),
`create_shortcut` opened the real Shortcuts editor, `run_shortcut` exercised
through the actual interactive y/n prompt; non-allowlisted requests are
refused with a readable message ✓ — "empty the Trash," "lock my screen" both
got clean refusals naming the actual allowlist; the confirmation gate fires
on gated actions ✓ — `run_shortcut`'s confirm/decline verified three ways
(isolated graph, full supervisor handoff routing, real CLI prompt), plus the
shell tool's new inline-code gate as a bonus beyond the original scope;
STEPS.md updated ✓ (groups 29–33).

---

## Phase 5 — Voice I/O — NOT STARTED

**Objective:** speak to the assistant and hear it answer; the text CLI stays
fully intact.

**Steps:**
1. STT decision at phase start: default plan is faster-whisper running
   locally (small/base model) — verify wheel availability on our Python
   first (this is why the venv is 3.12). Fall back to a cloud STT only if
   local proves painful. CHECKPOINT: confirm the choice with the user.
2. Mic capture with push-to-talk (hold or press to record) — explicitly NOT
   a wake word yet.
3. TTS: macOS `say` first (zero dependencies); note an upgrade path to a
   nicer TTS API later if wanted.
4. Voice is a wrapper around the SAME agent invoke path — no separate agent
   logic. A flag or parallel entry point; text mode untouched.
5. Stretch, only after push-to-talk works end-to-end: wake word
   (openwakeword / porcupine).

**Done-when:** hold-to-talk → transcription → agent → spoken response works
end-to-end; the text CLI is unchanged; latency is acceptable in real use.

---

## Phase 6 — Proactivity + polish — NOT STARTED

**Objective:** the assistant does something useful unprompted, and the repo
is portfolio-finished.

**Steps:**
1. Morning briefing: a separate entry point (e.g. `assistant.briefing`) that
   runs one agent turn — today's calendar + unread email summary — delivered
   via notification/`say`/terminal; scheduled with launchd.
2. Unattended-cost gate BEFORE scheduling anything: estimate per-run and
   per-month token cost; confirm the Console spend cap is set. CHECKPOINT:
   nothing runs on a schedule without the user's sign-off on both.
3. Interface decision at phase start: menu bar app (rumps) vs CLI + hotkey —
   decide then, not now.
4. Repo polish: README refresh (architecture diagram, demo GIF), pytest
   adoption for the existing test files, optional GitHub Actions to run the
   suite.
5. Final cost review: measure real daily spend from traces/Console; adjust
   model assignments if needed. Includes the Haiku evaluation deferred from
   Phase 3 step 3 (STEPS.md 24/25): `research_agent` is the best candidate
   (simplest, single-tool role) — decide using real LangSmith trace data,
   not before it exists.

**Done-when:** the briefing fires on schedule for a week without
intervention; the spend cap is verified; the README and repo are presentable
enough to send to a recruiter without a warning attached.
