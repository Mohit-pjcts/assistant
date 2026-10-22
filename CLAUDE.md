# Project: Personal AI Assistant - Oni

## Goal

A general-purpose personal assistant, built on the Claude API + LangGraph: coding
help, research, life admin (email/calendar), Mac-native control, and voice
interaction. Personal project, published on GitHub — code quality, structure, and
the README matter. Treat it as a portfolio piece. The package is named `assistant`.

## How to use this file (every session)

1. Read the Current Status block below. It is an index: per-phase detail lives
   in `PLAN.md` (decisions, done-when) and `STEPS.md` (chronological record).
   Look there, not here, for history.
2. Open `PLAN.md` and read the ACTIVE phase's plan before doing any work.
   Do not build ahead of the active phase.
3. When all of the active phase's done-when criteria are met, say so explicitly
   and propose: the status update here, the status flip in PLAN.md, and a commit
   boundary (see Git rules). Status edits happen only with my approval.
4. Log work in `STEPS.md` as you go (see Build log section).
5. Keep this file lean: new status entries are 1–3 lines with a STEPS.md
   pointer. A rule that must outlive the phase goes in the durable sections
   below, not in the status block.

## Current Status

No phase is ACTIVE. Phases 1–32 are complete or code-complete (below).
Most recent work: Phase 32 (earbud voice) and iPhone polish (STEPS.md 180–194).

**Open items (all blocked on me, not on code):**
- Phase 25: its two original proof workflows (flight-chain, packing-chain) need
  first-run macOS Automation clicks for Messages/Photos/Contacts. `send_imessage`,
  `compose_whatsapp`, `photos_search`, `contacts_search` were never live-verified.
- Phase 21: Shortcuts 2–4 (Share to Oni, Sync Health, geofence) and the
  confirmation-gate Speak/Dictate/`/phone/resume` branch are not built on the device.
- Phase 26: no live browser verification of `render_local_media`/`render_web_media`.
- Phase 29: closed with live verification explicitly waived by me (STEPS.md 151);
  a deliberate exception to the done bar, not a lowered bar.
- Phase 31: NOT COMPLETE until I run the on-device checklist (PLAN.md D10).
- Rebuilt `Oni.app` (STEPS.md 158) is not installed: a fresh ad-hoc-signed bundle
  re-triggers macOS's Documents-folder prompt and the backend blocks on it.
  Install from `dashboard/src-tauri/target/release/bundle/macos/Oni.app`, click Allow.
- Phase 30 on-device Oni needs a VPN or Tailscale exit node (Anthropic 403s in
  Hong Kong); exit node set up on the Mac, unverified on the device.
- Nothing from several recent sessions is pushed; I commit and push myself.

**Phases (one line each; detail in PLAN.md / STEPS.md):**
- 1 single-agent CLI + tools + persistent memory (STEPS 1–8) · 2 Gmail/Calendar via
  MCP, async graph (9–20) · 3 supervisor + sub-agents, interrupt() confirmation
  gate (21–25) · 4 Mac control via osascript/`open`/shortcuts (29–33) · 5 voice I/O
  (37–43; daemon retired 2026-08-06, STEPS 123) · 6 cross-agent handoff fix
  (45–49) · 7 compaction + long-term memory (50–51) · 8 mlx-whisper STT (52–53) ·
  9 Tauri dashboard (54–61) · 10 proactivity + polish (briefing cut by me;
  thinking re-enabled, STEPS 74–78)
- 11 skills cleanup + vetting policy (62) · 12 Gmail/Google Calendar WRITE, gated
  (63–66) · 13 Apple Calendar + `open_url_in_brave` (69–70) · 14 UI rework, SSE
  streaming, Tauri owns backend lifecycle (71–72) · 15 multi-thread support (67–68)
  · 16 Langfuse v2→v3, prompt mgmt, evals, agents-as-tools rewrite (79–94,
  `PHASE16_LANGFUSE.md`) · 17 A2UI generative UI (92) · 18 render_ui for specialists
  + surface persistence (95) · 19 startup/cost/voice fixes + "Oni" redesign (96) ·
  20 Astryx redesign, uploads, kanban board, landing page (97)
- 21 phone channel + `phone_agent` (103–112; core flow + both `phone_actions`
  live-verified on the iPhone) · 22 messaging: `send_imessage`/`compose_whatsapp`
  (105), `read_imessages` via `chat.db` (148) · 23 full-disk Mac file access,
  `disk_tools.py` (106) · 24 unattended pre-approved automations (107) · 25
  cross-app workflow chaining, mechanism live-verified (117–118) · 26 A2UI Basic
  Catalog parity, `render_form`, media tools (119, 147–148; thin test coverage) ·
  27 Obsidian Vault note-store (124–127, ADRs 0001–0003) · 28 Obsidian-violet
  reskin, Project tree, radial selector (128–134) · 29 "Instrument" design-system
  replacement, Astryx removed (135–140, 151) · 30 native SwiftUI iPhone Vault app +
  on-device Oni (164–171, ADR 0004) · 31 Mac-connected Oni on iPhone, 7 stages
  (172–179, ADR 0005) · 32 earbud-button voice (180–191, 194)
- Not numbered phases: memory re-architecture to a daily review queue (115);
  UI scale control (120); prompt caching (121); `render_ui` retry-loop incident →
  circuit breaker + `ActiveTurnBanner` (122); nine-item reliability backlog (151–152:
  WAL mode, `logging_config.py`, MCP timeout, `idempotency_store.py`,
  `tool_cache.py`, `SpecialistResult`, `activity_log.py`, `conversation_search.py`,
  `/health/integrations`); History panel rebuilt with full tool tracing (158);
  iPhone menu/Calendar/icon polish (192).

**Standing lessons from past phases:**
- A script that calls a specialist directly verifies the specialist, never the
  supervisor's routing. "Live-verified" means what was actually exercised, via the
  real running backend (Phase 27 found a real misroute and a real accidental
  delete this way).
- Every new capability must be named in the supervisor prompt (and the
  specialist's own), or it refuses to delegate: the same routing-blindness bug hit
  `render_ui`, the board, the Vault and iMessage read. `prompts.get_prompt()`
  prefers Langfuse's remote "production" prompt, so re-run
  `scripts/sync_prompts_to_langfuse.py` after any prompt edit or the edit has no effect.
- Never mark a phase COMPLETE without live verification unless I explicitly waive it.
- Editing files a live `--reload`/`--watch` process serves can break it mid-edit.
- Known test environment gaps (jsdom): no `window.matchMedia`, `AnimationEvent`,
  `setPointerCapture`, `createSVGPoint`; `localStorage` is a Node stub. Defend or fake.
- `test_server.py`/`test_supervisor.py` make real Anthropic calls per test. Run
  changed tests individually; I'm cost-conscious. Known pre-existing flake: the
  `threads.sqlite` active-thread-pointer test.

## Load-bearing decisions — do not undo without discussion

- **Agent constructor:** `langchain.agents.create_agent` (NOT
  `langgraph.prebuilt.create_react_agent`) — takes `system_prompt`, `middleware`,
  and `checkpointer` directly.
- **Model:** `ChatAnthropic(model="claude-sonnet-5")` for the main agent; Haiku
  for cheap routing/simple sub-tasks.
- **`checkpoint_ns`:** SqliteSaver requires BOTH `thread_id` and `checkpoint_ns`
  in `config["configurable"]` (STEPS.md 3.2). This lives in exactly one place —
  `make_thread_config()` in agent.py. Never build invocation config dicts by hand.
  It also sets `recursion_limit` 50 (up from LangGraph's 25), the only backstop on
  workflow length (Phase 25).
- **Checkpointer lifecycle:** main.py owns the `with get_checkpointer()` block
  for the process lifetime and passes it into `build_agent()`. agent.py never
  creates its own.
- **Architecture:** supervisor with specialists as plain `@tool`s that each call
  `ainvoke()` on their own compiled graph (agents-as-tools, STEPS.md 94). Each
  specialist call is isolated and cannot see earlier specialists' output in the
  same turn; `supervisor.py` forwards prior results verbatim with provenance
  labels (Phase 25).
- **Required middleware on EVERY `create_agent(...)` in supervisor.py/
  sub_agents.py.** Omitting any of these doesn't break the agent, it silently
  reintroduces the failure each one closes:
  - `ThinkingBlockRepairMiddleware` (`thinking_repair.py`). Extended thinking is
    on (`thinking=THINKING_CONFIG`, adaptive, `display: "summarized"` — without
    it claude-sonnet-5 returns empty thinking). `langchain-anthropic` 1.4.8 has
    an SSE-chunk-merging bug that can drop a streamed thinking block's required
    `thinking` field, which the API then rejects on replay; live-reproduced. The
    middleware adds `"thinking": ""` (fabricates nothing). `compaction.py`/
    `memory_extraction.py`'s Haiku calls stay `thinking={"type": "disabled"}`.
  - `AnthropicPromptCachingMiddleware` (STEPS.md 121). Prompt caching had never
    been enabled (0 cache hits in 1,000 generations); now live-verified at ~99%
    cache read on input. Not applied to the single-shot Haiku calls (open follow-up).
  - `RepeatedToolFailureCircuitBreaker` (`circuit_breaker.py`, STEPS.md 122).
    After 3 identical consecutive failing calls of one tool it returns a synthetic
    AIMessage instead of calling the model (a real turn retried `render_ui` 43
    times in ~28 minutes). Also updates `active_turns.py` for the dashboard's
    `ActiveTurnBanner`; I always want visibility into background work.
  - `ToolTraceMiddleware(<agent name>)` (`tool_trace.py`, `trace_store.py` →
    `traces.sqlite`, STEPS.md 158). A specialist's graph is a throwaway
    `ainvoke()`, so this is the ONLY record of its inner tool calls and model
    turns, and feeds the History panel. Best-effort; never changes a call.
    `supervisor._run_delegation` sets the `TRACE_CONTEXT` contextvar.
  - **Loopback-only:** `GET /history/trace` and every `/stage/*` endpoint use
    `assistant/local_only.py`'s `require_local_client` (client address AND Host
    header, 403 otherwise) because the backend binds 0.0.0.0 with no auth. Keep
    any new endpoint exposing full tool I/O or screen contents behind it.
  - `logging_config._TraceIdFilter` must read the OpenTelemetry span directly,
    never Langfuse's `get_current_trace_id()` (it logs a warning outside a span,
    re-entering the filter; this wedged the live backend with a 5 MB/s log flood).
- **Active-thread pointer, not a fixed `THREAD_ID`** (Phase 15):
  `thread_store.py` (`threads.sqlite`) holds a thread registry plus a single-row
  active pointer. `/chat` and `/resume` accept an optional explicit `thread_id`
  that bypasses the pointer, which is the fix for concurrent clients colliding.
  Per-run random IDs would silently defeat cross-session persistence. Bootstrap
  seeds `LEGACY_DEFAULT_THREAD_ID = "cli-default-thread"` so old history is kept.
  Projects (Phase 28): nullable `project_id` on `threads`; deleting a Project
  unassigns its Threads, never cascades.
- **Web search:** `TavilySearch` from `langchain-tavily`. Do not reintroduce the
  deprecated `TavilySearchResults` or `langchain-community`.
- **Tool errors are data, not exceptions:** failures (denylist rejections
  included) return as normal ToolMessages the model can read and explain.
- **`load_dotenv()` is called inside tools.py** (needs TAVILY_API_KEY at import
  time) as well as main.py. Idempotent; keep both.
- **CLI output stays non-streaming** (`main.py` calls `graph.ainvoke()`;
  `_render_content()` guards non-string `.content`). Only the dashboard streams
  (SSE in `server.py`'s `/chat`/`/resume`), and voice now goes through that path.
- **SQLite stores use WAL mode** (`thread_store`, `memory_store`, `workflow_store`,
  `board_store`, the checkpointer, `activity_log`). New multi-writer stores should too.
- **Domain vocabulary:** `CONTEXT.md` defines Vault (`~/Documents/OniVault`),
  Thread, Project (hierarchy Oni → Project → Thread). Don't reuse "vault" for
  anything else. ADRs live in `docs/adr/` (0001–0005).

## Security model — never weaken without explicit discussion

Threat model: web/email content + shell/file/side-effect tools = prompt
injection. Adversarial text arrives in context as tool results and can try to
induce harmful actions. Mitigation lives on the EXECUTION side, not in
filtering content.

- Shell: `shlex.split()` → argv list → `subprocess.run(shell=False)`. Never
  `shell=True`, never raw string execution.
- Denylist blocks: `rm`/`sudo`/`su`/`osascript`; shell interpreters invoked
  with `-c`; shell metacharacters (`| ; && $(` backtick) checked as SUBSTRINGS
  within tokens (`ls&&rm` is one token to shlex); sensitive system paths,
  including Desktop/Documents/Downloads/Pictures/Movies. This only catches
  literal path arguments, not paths a script computes at runtime.
- **Shell confirmation gate:** `execute_shell_command` interrupts when argv
  invokes python/python3/node/perl/ruby with inline code (`-c`/`-e`), the one
  pattern where code was never written to a file first. Running a file the agent
  wrote via `write_file` stays ungated (STEPS.md 32).
- File tools: confined to `workspace/` anchored at the project root (not cwd);
  traversal rejected via resolve-then-relative_to; dotfiles hard-blocked.
  `disk_tools.py` (Phase 23, full-disk) has its own credential-path denylist,
  deliberately NARROWER than the shell one (which blocks Desktop/Documents/
  Downloads wholesale); its writes/deletes are gated.
- **Confirmation rule (standing):** side-effectful EXTERNAL actions require my
  explicit confirmation; read-only ones don't. Gated: sending email, modifying
  Gmail labels (incl. archiving), creating/updating/deleting a Google Calendar
  event, creating/deleting a Gmail filter, Apple Calendar create/update,
  `run_shortcut`, `send_imessage`, disk writes/deletes. Each is a LOCAL wrapper
  tool that calls `interrupt()` itself and shows the real content verbatim.
  The gate can't sit on raw MCP tools (separate Node process); raw write tool
  names are never added to a model's tool list (`sub_agents.py`'s
  `_select_life_admin_tools`, `write_tools.py`'s docstring).
  - **Voice approval:** email sends, calendar create/update and filter writes are
    text-only, never voice-approvable (free-text is hard to vet by ear). The phone
    handler checks `voice_approvable: False` and auto-declines. Google Calendar
    **delete** IS voice-approvable (no free-text payload, STEPS.md 63); Gmail
    filter delete is NOT (STEPS.md 64). The dashboard has no voice gate path:
    every gate there is click-only, whatever channel the turn came from.
  - **Deliberate, user-requested weakenings (ungated, not oversights):**
    `open_url_in_brave` (Phase 13), `run_shortcut_on_phone` (Phase 21, STEPS.md
    112), Apple Calendar `calendar_delete_event` (STEPS.md 146). Different from the
    Google Calendar delete, which stays gated. Also ungated by design: local,
    reversible in-app stores (kanban `board_tools.py`; Vault tools per ADR
    0001/0002, with `oni: true` authorship checks on update and delete).
  - **Memory writes** go through an async review queue instead of `interrupt()`
    (2026-07-28): `memory_review_agent.py` runs daily (or `POST /memory/review/
    run-now`), queueing candidates into `pending_facts`; nothing becomes a recalled
    fact until I approve in the Memory panel. Principle unchanged (no durable
    write without my approval), only where it happens moved. Its source-restriction
    and isolated-extraction design (`memory_extraction.py` docstring) is
    load-bearing.
  - **Bundled workflows (Phase 25):** `propose_workflow` takes ONE approval for
    several gated actions; it clears action NAMES, not exact payloads (my call,
    against the recommendation), with an audit log of approved vs executed args.
    Prior specialist results forward verbatim, so untrusted content can reach
    `open_url_in_brave`.
  - **Unattended automations (Phase 24):** `pre_approved_actions` bypass, restricted
    to messaging-shaped actions (`send_imessage`/`send_email`), invoking one
    specialist directly. Spend/cost caveats under Cost.
  - **Idempotency:** `idempotency_store.py` guards `send_email`/`send_imessage`
    against concurrent duplicate resumes.
- **iPhone / tailnet access:** no new auth and no Face ID on Approve (ADR 0005,
  against my recommendation); `/voice/*` is open on the tailnet like the rest of
  the Mac API. The phone's `/vault/*` sync is behind a bearer token
  (`vault_sync.py`). `GET /calendar` is readable from the phone; add/edit/delete
  stay loopback-only (`tests/test_calendar_access.py`). The on-device Oni holds the
  Mac's API key in the iPhone Keychain with no app lock (ADR 0004, against my
  recommendation). Voice turns that hit a gate say it's waiting on the screen.
- New tools (MCP-loaded included) are evaluated against this threat model
  before joining the agent. MCP tools MERGE into TOOLS; they never replace
  Phase 1's hand-secured tools.
- **Skill-vetting policy (Phase 11):** a Claude Code skill is instruction-bearing
  content, the same threat model as any untrusted input. No skill is installed
  without reading it first. High/Medium-risk community skills are declined by
  default. Bulk/marketplace installs are never used (one once brought in ~1,840
  unreviewed skills plus the High-Risk `browser-use`; STEPS.md 62). First-party
  skills are preferred over community ones.
- **`run_claude_code` is a named, bounded exception to this whole section
  (2026-08-06):** `claude_code_tool.py`'s `run_claude_code` (`coding_agent`'s
  delegate) runs a real Claude Code CLI session (`claude --print
  --dangerously-skip-permissions`) rooted at `$HOME`, with none of this project's
  denylists, confinement, or gates: it can read/write/delete anything under
  `$HOME` and run any command. Chosen deliberately: a subprocess can't answer
  Claude Code's own permission prompts. It bills the Claude.ai subscription, not
  the Console key. **Access hardening remains declined at my request**; instead
  STEPS.md 149 added live visibility and a kill switch (`claude_code_live.py`
  registry, `--session-id`, `POST /claude-code-sessions/{id}/stop`), since a
  session can run up to 30 minutes unattended. Unimplemented hardening options are
  listed in the module docstring.

## Tech stack

- Python 3.12 venv at `.venv`; `requires-python = ">=3.11"`. Package installed
  editable (`pip install -e .`).
- LangGraph + LangChain (1.x); `langchain-mcp-adapters`.
- Anthropic SDK — Claude API (pay-per-token via Console account), NOT the
  Pro/Max subscription.
- **Memory:** `conversation_memory.sqlite` (checkpointer, memory.py) plus a
  SEPARATE `long_term_memory.sqlite` (`memory_store.py`: facts, `pending_facts`,
  per-thread `review_cursor`). Facts are deliberately NOT a vector store (Chroma
  rejected at Phase 7: a single user's fact count stays small); revisit if that
  stops holding. Recall (`recall_memory_node`) fires only on a thread's first
  genuine turn and loads the FULL profile (`list_facts`), not keyword-scored
  `recall_facts`: a low-content opener like "hi" shares no keyword and silently
  recalled nothing (a real bug). `supervisor._context_prefix_messages` searches
  the whole thread for the recalled-facts message to forward into specialists.
  Extraction is the daily review queue above, not per-turn.
- **Vault** (`obsidian_tools.py`, on the supervisor): `~/Documents/OniVault`.
  `vault_search.py` adds local semantic search (`sentence-transformers`/
  `all-MiniLM-L6-v2`, no API cost, content-hashed `.npz` cache), a SEPARATE
  decision from the facts one because the Vault is hundreds of notes.
  `conversation_search.py` does the same for past threads (`GET /search/
  conversations`).
- Packaging: pyproject.toml is the source of truth (the `assistant` console
  script); requirements.txt is a flat mirror. Keep both in sync.
- `cost_cache.py`: flat JSON fallback for `/cost` (Langfuse's metrics API
  rate-limits at 100 requests/window), atomic temp-file swap, gitignored. The `$`
  figure is LangSmith's token-count × price estimate, not an Anthropic invoice.
- Clients: Tauri dashboard (`dashboard/`, owns backend lifecycle), iPhone app
  (`ios/Oni` + `ios/OniCore`, `IOS_SETUP.md`), phone Shortcuts (`PHONE_SETUP.md`).
  `ios/OniCore` has its own Swift tests.

## Verification discipline

Check installed reality before coding against it — this has caught four real
bugs already (deprecated Tavily class, create_agent choice, checkpoint_ns,
message content shape; STEPS.md 5.2 / 6.2 / 3.2 / 8.2).

- Verify a library's actual installed API and deprecation state before writing
  code against it.
- Smoke-test new integration points with a real call before building on them.
- Throwaway scripts must not pollute real state: redirect workspace/DB paths to
  temp locations and clean up anything written.
- Interactive entry points (main.py-style) get verified by hand, not test files.
- Report "verified" only for what was actually exercised (see Standing lessons).

## Conventions

- Type hints on signatures; docstrings on public functions/classes.
- Separate modules for agent/tool/graph/CLI.
- Secrets: `.env` (gitignored) holds real values; `.env.example` (committed)
  holds placeholders ONLY — real keys landed in .env.example once (STEPS.md 5.1),
  so check which file you're writing to. OAuth credential and token files are
  gitignored the moment they exist; verify with `git check-ignore`. Current keys:
  ANTHROPIC_API_KEY, TAVILY_API_KEY, LANGSMITH_API_KEY (plus Langfuse and
  ElevenLabs; see `.env.example`).
- A README exists and is refreshed at each phase completion.

## Cost

The Claude API is pay-per-token, separate from any Pro/Max subscription.
Default to Haiku where Sonnet-level reasoning isn't needed. Flag the token/cost
impact of any design choice that could get expensive (long system prompts on
every call, verbose tool outputs fed back into context, unnecessary agent
loops). Anything that runs unattended requires a confirmed Console spend cap and
a per-run/per-month cost estimate BEFORE it is scheduled.

## Git — IMPORTANT

I commit and push myself. Never run `git add`, `git commit`, or `git push` on
your own initiative, and never auto-commit at the end of a task. When work
reaches a good save point, tell me: what changed, why it's a sensible boundary,
and a suggested commit message — then I run the commands. If I say "commit
this," confirm what's being committed first. Completing a phase's done-when
criteria is always a commit boundary.

## Build log — STEPS.md

Every step, decision (with rationale), bug fix, and notable command goes in
STEPS.md: numbered top-level groups in chronological order, numbered sub-steps
(5.1, 5.2, ...) grouping multi-step arcs, per-entry date & time, append at the
bottom. Superseded decisions stay in the log with a pointer to what superseded
them (see 2.2 → 5.2). Keep the "why" in every entry, not just the "what."
