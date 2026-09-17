# Project: Personal AI Assistant - Oni

## Goal

A general-purpose personal assistant, built on the Claude API + LangGraph: coding
help, research, life admin (email/calendar), Mac-native control, and voice
interaction. Personal project, published on GitHub — code quality, structure, and
the README matter. Treat it as a portfolio piece. The package is named `assistant`.

## How to use this file (every session)

1. Read the Current Status block below.
2. Open `PLAN.md` and read the ACTIVE phase's plan before doing any work.
   Do not build ahead of the active phase.
3. When all of the active phase's done-when criteria are met, say so explicitly
   and propose: the status update here, the status flip in PLAN.md, and a commit
   boundary (see Git rules). Status edits happen only with my approval.
4. Log work in `STEPS.md` as you go (see Build log section).

## Current Status

- **Phase 21 — Phone conversational channel + `phone_agent`: CORE FLOW +
  BOTH PHONE_ACTIONS BRANCHES LIVE-VERIFIED INSIDE "ASK ONI"** (opened +
  built 2026-07-25, STEPS.md 103–104; live-verified on the real iPhone
  STEPS.md 108–110). `/phone/turn`/`/phone/resume`/`/phone/health-sync`
  (server.py), `phone_agent` (sub_agents.py/phone_tools.py/
  phone_store.py) wired into the supervisor as a sixth specialist. The
  Action Button flow AND both `phone_actions` branches are now
  genuinely proven live inside the actual "Ask Oni" Shortcut, not just
  tested: a real Dictate→POST→real graph→Speak round trip; a real
  `open_url` phone_action that actually opened Safari; and a real
  `open_app` phone_action that actually launched a named app (Shortcuts'
  "Ask Each Time" field turns `Open App`'s normally-fixed picker into a
  bindable variable). The `open_app` mechanism was first proven in a
  separate standalone test (STEPS.md 109, at the time misreported as
  already wired into "Ask Oni" and corrected once the user clarified),
  then actually integrated and re-verified there (STEPS.md 110) — "the
  technique works" and "it's integrated" are different claims, kept
  distinct this time. Built interactively with the user, including a
  real on-device bug found and fixed along the way (an empty JSON body
  key in the Shortcut, diagnosed by checking `last_active_at` on the
  server side before/after to confirm the request wasn't even arriving).
  `phone_agent` also gained `run_shortcut_on_phone` (STEPS.md 111) —
  built GATED at first (mirroring `mac_control_agent`'s own
  `run_shortcut`), then **explicitly UNGATED at the user's direct
  request** (STEPS.md 112, same category as `open_url_in_brave`'s own
  Phase 13 decision — a deliberate, documented weakening). Fixing its
  tests surfaced a real, live-diagnosed supervisor/model quirk (not a
  code bug): it sometimes retries a no-longer-gated action name against
  `request_gated_action_confirmation` using a similar-sounding
  still-gated one instead of delegating directly — resolved with a
  deterministic unit test for the tool's own guarantee plus a live test
  tolerant of that specific path. Still open: the confirmation-gate
  Speak/Dictate/`/phone/resume` branch (still needed for OTHER gated
  actions reachable via "Ask Oni"), and Shortcuts 2-4 (Share to Oni,
  Sync Health, the geofence trigger) — none built on the device yet.
  Real scope correction found mid-build: "iPhone file/photo search"
  turned out not to be buildable
  as `phone_agent` tools at all (no synchronous mid-turn channel to the
  phone) — see PLAN.md's Phase 21 entry.
  **Phase 22 (messaging cluster) is CODE COMPLETE for send-only**
  (`send_imessage`/`compose_whatsapp` in `mac_tools.py`, STEPS.md 105) —
  unverified against the real apps (a live Automation-permission click is
  needed, blocked while working autonomously), and iMessage READ
  deliberately not built (Messages.app's AppleScript dictionary doesn't
  reliably expose it; the real alternative, direct `chat.db` SQLite
  access, is left as an open decision rather than guessed at). A real
  routing gap found while wiring Phase 22 in — the supervisor had no way
  to know a request came from the phone, risking "open Spotify" acting on
  the Mac instead — is fixed (`_PHONE_CHANNEL_MARKER`, server.py) and
  live-verified with a natural, non-explicit phrasing.
  **Phase 23 (full-disk Mac file access) is FILE OPS COMPLETE and
  LIVE-VERIFIED** (`assistant/disk_tools.py` — search/read/write/delete,
  a real `/chat`→gate→`/resume`→real-file-write round trip proved live,
  STEPS.md 106) — plain file I/O needs no macOS permission dialog, unlike
  most of this session's other work. Photos.app search/export is code
  complete but unverified (same Automation-permission wall). A real
  correction to this phase's own written plan was found before coding:
  the new credential-path denylist is deliberately NARROWER than
  `tools.py`'s shell-tool denylist (which blocks Desktop/Documents/
  Downloads wholesale — reusing it would have defeated this phase's own
  purpose), not a superset of it as originally planned.
  **Phase 24 (unattended pre-approved automations) is CODE COMPLETE
  with its central mechanism LIVE-VERIFIED** (`assistant/
  automation_store.py`, `server.py`'s `/automations`/`/automations/
  {id}/fire`, dashboard Automations tab — STEPS.md 107): a real
  registered automation fires through the real graph with a `"fired"`
  outcome and genuinely zero `interrupt()` calls, proving the
  `pre_approved_actions` bypass actually works rather than hanging
  forever waiting for a confirmation nobody's there to give. Deliberately
  scoped to invoke ONE specialist directly rather than a full supervisor
  turn (an unverified `InjectedState`-across-subgraph-boundary question
  wasn't worth resting the highest-risk feature in this plan on) and
  restricted to messaging-shaped actions only
  (`send_imessage`/`send_email`), not the full `GATED_ACTIONS` set — see
  STEPS.md 107 for both decisions' full reasoning. **All four planned
  phases (21-24) from the grilling session are now code-complete.**
  Remaining work across all of them is exclusively real-device
  verification the user needs to do by hand: building the Shortcuts in
  `PHONE_SETUP.md`, clicking through Messages.app's/Photos.app's
  one-time Automation permission dialogs, and arming a real geofence
  trigger.
  Phase 20 (Astryx redesign integration: theme, chat, uploads, kanban
  board, landing page, STEPS.md 97) is the most recently fully-completed
  phase, opened, built, and documented in one session (2026-07-24/25).
- **Memory re-architecture (2026-07-28, STEPS.md 115), not a numbered
  phase — a same-session rework of Phase 7 Part B at the user's direct
  request.** Per-turn extraction (the old interrupt()-gated
  `extract_and_propose_memory_node`) replaced by
  `assistant/memory_review_agent.py`, a once-a-day (midnight) batch pass
  that queues candidates into a new `pending_facts` review queue
  (`memory_store.py`) for approve/decline in the dashboard's Memory panel
  (`GET /memory/pending`, `POST /memory/pending/{id}/approve|decline`, plus
  an on-demand `POST /memory/review/run-now`) instead of blocking the live
  conversation. Recall (`recall_memory_node`) now fires only on a thread's
  first genuine turn instead of every turn. See the Security model
  section's Confirmation rule bullet and the Tech stack section's Memory
  bullet for the full architecture; `memory_extraction.py`'s module
  docstring has the complete before/after reasoning including the
  deliberate citation-verification scope cut this required. 296/298 tests
  pass (17 new/rewritten across memory_store/memory_extraction/
  memory_review_agent/server/supervisor + frontend); the 2 failures are
  pre-existing and unrelated (a Langfuse rate-limit 429, and an
  already-documented `threads.sqlite` state-pollution flake confirmed via
  `git stash` to reproduce identically on unmodified `main`).
- **Phase 25 — Cross-app workflow chaining: MECHANISM CODE COMPLETE +
  LIVE-VERIFIED (opened + built 2026-07-28, STEPS.md 117-118).** Scoped
  via a `/grill-with-docs` session after an initial pass over-narrowed
  the ask to a single flight-confirmation example; corrected once the
  user pushed back to the actual ask — a general mechanism for a
  request needing 2+ side-effectful actions across specialists, not one
  demo scenario. The real defect this phase fixes: since the Phase 16
  Part B agents-as-tools rewrite, every specialist call is an isolated,
  fresh `ainvoke()` that can't see what an earlier specialist call in
  the SAME turn returned — the supervisor has always had to re-type
  every concrete value (time, address, phone number) into each next
  instruction, invisibly, until a multi-app chain actually needs it.
  Load-bearing decisions locked at the grilling checkpoint, each the
  user's own explicit call (full ADR-style reasoning in PLAN.md's Phase
  25 entry): bundled pre-approval clears action NAMES, not exact
  payloads — chosen against the recommendation, and it amplifies an
  ALREADY-accepted "supervisor display vs. specialist construction could
  diverge" risk `supervisor.py` itself documents for today's
  single-action upfront path, rather than introducing a new risk
  category; an audit log records approved-vs-executed with NO cap on
  steps per workflow — also against the recommendation, requiring an
  explicit `recursion_limit` (`agent.py`'s `make_thread_config`, 50, up
  from LangGraph's default 25) as the only remaining backstop; prior
  specialists' results forward to the next one VERBATIM with provenance
  labels rather than being supervisor-summarized (summarizing was
  rejected as self-defeating — it's the exact lossy re-transcription
  being fixed), with the accepted consequence that untrusted content can
  now reach `mac_control_agent`'s deliberately-ungated
  `open_url_in_brave`. A live probe of Reminders.app's real AppleScript
  dictionary (during scoping, before any code) found location-triggered
  reminders are a genuine platform impossibility, not a scope choice —
  no location/geofence property exists on a reminder at all — so the
  phase's proof workflows use time-based reminders instead.
  **Built the same day** (STEPS.md 118): `assistant/workflow_store.py`
  (new dedicated-file store), `supervisor.py`'s `propose_workflow` tool
  + cross-specialist handoff (`_prior_specialist_results_this_turn`) +
  executed-argument capture (`_extract_gated_action_executions`,
  requiring ZERO changes to any existing gated tool's own code) +
  `_record_workflow_progress`, two new `mac_tools.py` primitives
  (`reminders_create` gained a due-date/alert, new `contacts_search`),
  `server.py`'s `GET /workflows` + the phone channel's explicit
  dashboard-approval message (decision D8), and a new dashboard
  Workflows tab. **Live-verified against the real graph, not just unit-
  tested:** a real `/chat` → ONE interrupt bundling two real gated
  actions → `/resume` → both real side effects executed → a real
  recorded audit showing executed args next to the approved plan —
  deliberately proven with `write_disk_file`/`delete_disk_file` (already
  permission-granted) rather than `calendar_create_event`/
  `send_imessage`, per decision D11. Prompts re-synced to Langfuse
  (Phase 18's exact lesson reproduced live again: a new prompt-guard
  test failed against the stale remote "production" prompt until
  re-synced). 330/332 backend tests pass, 86/86 frontend (2 pre-existing
  unrelated backend failures; all lint/build clean modulo already-
  documented pre-existing findings).
  **Still open, blocked purely on the user, not on more code:** the two
  ORIGINAL proof workflows (flight-chain, packing-chain) depend on
  `send_imessage`/`photos_search`/`contacts_search`, none ever
  live-verified against the real Messages.app/Photos.app/Contacts.app —
  each needs its own first-run macOS Automation permission click.
  See PLAN.md's Phase 25 entry for the full decision set, steps, and
  done-when criteria.
- **Phase 26 — A2UI full Basic Catalog parity, `render_form`, and media
  rendering: CODE COMPLETE, UNVERIFIED, TEST COVERAGE GAP (built
  2026-08-04, STEPS.md 119, PLAN.md's own Phase 26 entry).** Found as
  uncommitted working-tree changes at the start of the session that
  wrote this status entry — not opened via a scoping session the way
  Phases 21–25 were; reconstructed from the diff and each new piece's
  own in-code rationale. Replaces Phase 17/18's ad-hoc 8-type `render_ui`
  vocabulary (`assistant/a2ui.py`) with Google's real A2UI v0.9 Basic
  Catalog (18 component types incl. new `Icon`/`Video`/`AudioPlayer`/
  `Tabs`/`Modal`/`Slider`/`DateTimeInput`, real `dataModel`/path-binding,
  a breaking `TextField`/`CheckBox`/`ChoicePicker`/`Button` field-shape
  change from the old project-invented one) plus a real, live-diagnosed
  WebKit-vs-Chrome base64 data-URI bug fix. New `render_form` tool (flat
  field-list contract expanding into a full `render_ui` surface) wired
  into the supervisor/`research_agent`/`life_admin_agent`. New
  `assistant/media_tools.py` — `render_local_media`/`render_web_media`
  fix a real diagnosed failure (a shelled-out `base64` call silently
  truncating a real screenshot's bytes into a broken image); the web
  variant fetches server-side behind an SSRF guard so the browser never
  makes an outbound request. New `render_board_ui` (board_tools.py)
  data-binds real `board_store` rows into a surface instead of the model
  retyping them, read by a new frontend `BoardSurfaceView`. Also fixed a
  real, live-reproduced supervisor bug (seen against the kanban board
  and a Roth/Traditional IRA thread): a delegated specialist's already-
  rendered surface was invisible to the supervisor's own model (lived
  only in `additional_kwargs`), so it would sometimes render the same
  content a second time — fixed via a visible note on the specialist
  tool's own content. **Does not meet this project's normal done bar,
  flagged rather than glossed over:** no live verification exists for
  any of the new tools; backend/frontend test COUNTS are unchanged from
  Phase 25 despite the large new surface area (`tests/test_a2ui.py` only
  updated to the new shapes, not extended; no `test_media_tools.py`
  exists at all — zero coverage of the SSRF guard, both size caps, and
  every rejection path; `A2UIRenderer.test.tsx` likewise only updated,
  not extended for the 7 new node types or `BoardSurfaceView`); 2 new
  `prettier` findings introduced (`A2UIRenderer.tsx`/`.test.tsx`), not
  yet fixed. Nothing here is committed — sits on top of Phase 25's
  `67dc534` as unstaged modifications plus one untracked file
  (`assistant/media_tools.py`). See PLAN.md's Phase 26 entry and
  STEPS.md 119 for full detail and the remaining done-when list.
- **Dashboard-wide UI scale control (Cmd/Ctrl +/-), built 2026-08-04,
  STEPS.md 120 — not a numbered phase, small and unrelated to Phase 26,
  logged separately.** New `dashboard/src/lib/uiScale.tsx`
  (`UiScaleProvider`/`useUiScale`) scales the app's root font size
  (0.8x-1.6x, `localStorage`-persisted) in response to Cmd/Ctrl
  `+`/`-`/`0`, wired in at the top of `main.tsx`'s provider tree.
  `tsc`/`prettier`/`npm run build` clean; no test file exists for it and
  it has not been live-verified in the real running dashboard. Not
  committed.
- **Anthropic prompt caching wired into all 6 agent models, 2026-08-04,
  STEPS.md 121 — a real gap found and closed, not a new phase.** A
  latency question led to a real Langfuse pull showing prompt caching
  had never been enabled anywhere in the codebase (0 cache hits across
  1,000 generations). Fixed via `langchain_anthropic.middleware.
  AnthropicPromptCachingMiddleware` added to the supervisor's and all 5
  sub-agents' middleware lists; live-verified against the real API
  (`cache_read_input_tokens` covering ~99% of input on a real
  `coding_agent` call). New load-bearing rule added alongside the
  thinking-repair one above. Full backend suite + `ruff` clean, no test
  regressions. Not committed.
- **Real incident diagnosed and fixed: a stuck 43-retry `render_ui` loop
  (~28 minutes, one turn), 2026-08-04, STEPS.md 122 — a bug fix plus a
  new standing capability, not a new phase.** Same Langfuse investigation
  as the caching entry above, continued: found a real trace where the
  supervisor retried an identical failing `render_ui` call 43 times
  because it tried to embed a real photo it had no tool to produce,
  exhausted its 4096-token output budget every time, and never stopped.
  Three fixes: (1) supervisor.py's system prompt now explicitly says it
  has no media tool and must delegate real image/video requests to
  `research_agent`/`mac_control_agent`; (2) new
  `assistant/circuit_breaker.py`'s `RepeatedToolFailureCircuitBreaker`
  (wired into all 6 agents, new load-bearing rule) stops ANY tool-calling
  loop that fails identically 3+ times in a row, independent of root
  cause; (3) at the user's own direct, standing request ("I always want
  to know if there's a process going on in the background... this is
  just a waste of my money") — a new `assistant/active_turns.py`
  registry + `GET /activity/active` + a persistent dashboard
  `ActiveTurnBanner` (visible from every tab) showing any in-flight turn
  across every channel (dashboard/voice/phone/automation), with a
  visible warning once a tool is retrying. 342/343 backend tests pass (1
  pre-existing, unrelated failure); 89/89 frontend (3 new); `ruff`/`tsc`/
  `prettier`/build all clean. Not live-verified against the original
  failing request or in the real Tauri window (component/unit-tested
  only) — not committed. See STEPS.md 122 for the full incident record.
- Complete: Phase 1 — single-agent CLI with tools + persistent memory
  (STEPS.md groups 1–8)
- Complete: Phase 2 — Gmail + Calendar via MCP (READ-ONLY), async graph
  migration (STEPS.md groups 9–20)
- Complete: Phase 3 — supervisor + 3 sub-agents, LangGraph handoff routing,
  interrupt-based confirmation gate (STEPS.md groups 21–25)
- Complete: Phase 4 — Mac-native control via osascript/`open`/`shortcuts`
  bridge + mac_control_agent, plus a shell-tool hardening pass
  (STEPS.md groups 29–33)
- Complete: Phase 5 — voice I/O: local STT, Option+Return hotkey daemon
  (pynput + rumps), spoken confirmation gate, launchd autostart
  (STEPS.md groups 37–43)
- Complete: Phase 6 — cross-agent handoff routing fixed (loop-back through a
  re-evaluating supervisor, turn-scoped handoff cap) (STEPS.md groups 45–49)
- Complete: Phase 7 — short-term compaction + long-term automatic-write memory
  behind a layered, Opus-red-teamed security design (STEPS.md groups 50–51)
- Complete: Phase 8 — STT swapped to mlx-whisper large-v3 (6–8x latency win;
  accuracy question left open) (STEPS.md groups 52–53)
- Complete: Phase 9 — Tauri desktop dashboard as a peer client of the graph
  (chat/history/memory/cost panels, gated-action GUI) (STEPS.md groups 54–61)
- Complete: Phase 10 — Proactivity + polish (resumed 2026-07-15 after the
  write-access/browser/UI arc below; status flip to COMPLETE approved by
  the user 2026-07-16). Tauri backend/voice-daemon process-lifecycle
  re-confirmed live, not rebuilt. Morning briefing CUT from scope entirely
  (user's explicit call), not deferred. Extended thinking CLOSED (STEPS.md
  74) — re-enabled on all 5 agent models behind a verified repair
  middleware for the bug that originally forced it off (see Load-bearing
  decisions below). Haiku eval CLOSED (STEPS.md 75, research_agent stays
  on Sonnet 5); pytest adopted, CI declined (STEPS.md 76); README fully
  refreshed (STEPS.md 77); voice accuracy accepted as-is, user's explicit
  call (STEPS.md 78).
- **PARKED: Phase 10** — proactivity + polish, parked 2026-07-14 to run the
  write-access/browser/UI arc; its deferred-debt checklist is recorded in
  PLAN.md's Phase 10 park note (voice accuracy, extended-thinking re-enable,
  Haiku eval, backend lifecycle, README/pytest/CI, the briefing itself).
  Resumed 2026-07-15 and completed 2026-07-16 — see Phase 10's own entry
  below for the full resolution.
- Complete: Phase 11 — skills cleanup + vetting policy: removed the
  High-Risk `browser-use` skill, the ~1,840-skill `antigravity-awesome-skills`
  bulk install, and the full `anthropics/skills` clone; kept only
  `frontend-design` and `find-skills`; confirmed no skill artifacts in git
  history or settings; standing vetting policy added to the Security model
  section below (STEPS.md group 62).
- Complete: Phase 12 — Email + Google Calendar WRITE access: gated
  send_email/modify_gmail_labels/create+update+delete_calendar_event/
  create+delete_gmail_filter tools (`assistant/write_tools.py`), each a
  local wrapper calling `interrupt()` itself with verbatim content (raw MCP
  write tools never reach a model's tool list); per-turn write cap +
  no-parallel-writes guard; `InterruptGate.tsx` per-action renderers.
  Verified live against real Gmail/Calendar (STEPS.md 66) with two
  explicitly accepted gaps: `update_calendar_event` unit-tested only (not
  live), and the injection-shaped-request scenario not run live. Surfaced
  Phase 15 as a spinoff (shared fixed `THREAD_ID` collides across
  concurrent clients) (STEPS.md groups 63–66).
- Complete: Phase 13 — Mac-native cluster: Apple Calendar (read ungated,
  create/update gated) via Calendar.app's AppleScript dictionary through
  `osascript` (argv-only, read-back-before-gating for update, mirrors
  `write_tools.py`'s Phase 12 pattern) + `open_url_in_brave` (argv-only,
  open/navigate only, no automation). Extended `mac_control_agent` rather
  than a new sub-agent; added `NoParallelMacWrites` now that it carries 3
  gated tools; both `SUPERVISOR_SYSTEM_PROMPT` and
  `MAC_CONTROL_SYSTEM_PROMPT` disambiguate Apple Calendar from Google
  Calendar explicitly. **Accepted gap, chosen deliberately by the user at
  the checkpoint, not an oversight:** `open_url_in_brave` ships fully
  ungated — no domain allowlist, no confirmation gate — against this
  phase's own original "must be gated, allowlisted, or both" requirement;
  the injection-to-navigation scenario was still tested live against a
  real exploitable surface (a malicious instruction in a Note's title) and
  the model declined to act on it, but that is observed behavior, not a
  code-level guarantee. Live-verified end to end (real API calls, real
  Calendar.app, real Brave), catching and fixing one real bug along the
  way (AppleScript's `missing value` leaking into the confirmation gate as
  literal text). A same-day follow-up traced a "can't tell Apple/Google
  Calendar apart" report to stale long-lived server/voice-daemon processes
  never restarted after this phase's code landed (not a code bug); fixed
  by restarting them, plus cleanup of an unrelated stale scratch server
  left over from Phase 12 (STEPS.md groups 69–70).
- Complete: Phase 14 — UI rework: full visual redesign (dark/light theme,
  Operator/Signal/Alarm rail-grammar token system, Space Grotesk/IBM Plex
  typography) across all panels + sidebar + gate; the 3 missing
  InterruptGate renderers (`run_shortcut`, Apple Calendar
  create/update); the gate-UX-friction fix
  (`MAC_CONTROL_SYSTEM_PROMPT` aligned with `LIFE_ADMIN_SYSTEM_PROMPT`);
  Phase 12's two carried-forward live-verification gaps closed
  (`update_calendar_event` live round-trip, the injection-shaped-request
  scenario); plus a mid-phase expansion — Tauri now owns the Python
  backend's + voice daemon's process lifecycle, and `/chat`/`/resume`
  stream via SSE with stop-mid-run. All live-verified in the real window
  (STEPS.md 71–72). One accepted, non-blocking gap: Tauri's quit-time
  process-cleanup is code-reviewed but not live-fire-verified (no way to
  drive a native macOS window from an agent session) — left for the user
  to confirm at their convenience.
- Complete: Phase 15 — multi-thread conversation support: replaced the
  single fixed `THREAD_ID` with an active-thread pointer + registry
  (`assistant/thread_store.py`, separate `threads.sqlite`); `/chat`/
  `/resume` gained an optional explicit `thread_id` (the actual fix for the
  Phase 12 collision, STEPS.md 66) alongside new `/threads` list/create/
  switch/rename/delete endpoints; CLI `--new` + `/new`/`/threads`/`/switch`;
  voice's fail-closed local "start a new conversation" trigger phrase plus
  per-turn active-thread resolution. Extended beyond the phase's original
  locked scope at the user's direct request: thread delete
  (`DELETE /threads/{id}`, reassigns the pointer or creates a replacement
  thread if none remain) and a persistent Claude-style `ThreadSidebar`
  (visible from every tab, not just History) for new/switch/rename/delete —
  superseding the original History-tab-only picker. Every piece — the
  collision fix, the voice trigger, thread switching, rename, and delete —
  confirmed live (real launchd daemon, real Tauri window), not just
  tests (STEPS.md groups 67–68).
- Complete: Phase 16 — Langfuse integration: v2 wired in first (all three
  pillars — tracing, prompt management, evaluations), then migrated to v3
  (status flip approved 2026-07-24 — STEPS.md 93). Demo/portfolio phase,
  additive to LangSmith (Phase 3), which stays untouched (`/cost` keeps
  using it). Full narrative in `PHASE16_LANGFUSE.md`; chronological detail
  in STEPS.md 79–91.
  **Observability/tracing:** `assistant/observability.py` wires
  `tracing_context()` into all three call sites (CLI, voice, dashboard SSE)
  via `agent.make_thread_config()`, no-op when Langfuse isn't configured.
  v2's real EOL/import blocker (langfuse/langfuse#9758, cannot import
  against this project's LangChain 1.x) was resolved with a verified
  `sys.modules` compatibility shim, scoped Part-A-only and deleted at the
  v3 migration. v3 (Part B) replaced the shim with v3's uniform
  `propagate_attributes()`/`tracing_context()` model; fixed the OTEL
  auto-instrumentation duplicate-span problem
  (`blocked_instrumentation_scopes`); confirmed the SSE-cancellation path
  leaves Langfuse in a clean state (one documented, accepted gap: the
  specific mid-cancel GENERATION span never exports — no functional
  impact, LangSmith remains cost/token source of truth); confirmed live
  that v3 fixes v2's frozen-schema output-token/cost bug.
  **Prompt management:** 6 system/summary prompts migrated
  (`assistant/prompts.py`, `scripts/sync_prompts_to_langfuse.py`), each
  with a mandatory local fallback; `memory_extraction.py`'s
  `_EXTRACTION_PROMPT` deliberately excluded (structural
  source-restriction guarantee, not instruction-based).
  **Evaluations:** confirmation-gate approve/decline outcomes logged as
  Langfuse scores (`observability.score_gate_outcome()`), fired as a
  background task at all three resume points.
  **Distributed tracing spike (Part A.5, mentor-directed):** peeled
  `research_agent` into its own HTTP service (`assistant/fa_service.py`),
  reproduced a real cross-process trace-nesting break, fixed it first the
  v2 way then replaced that with real OTEL `traceparent` propagation
  (`observability.inject_trace_headers()`/`attached_parent_context()`).
  Streaming relay + real abort-on-stop built on `adispatch_custom_event`
  (the channel Phase 17's A2UI surfaces reuse) and live-verified both
  directions. A `/code-review max` pass on the full Part B diff found and
  fixed 15 issues. 183/183 tests pass; `ruff check .` clean.
  **Also in Part B's finalization commit, not logged until STEPS.md 94
  (found retroactively 2026-07-24):** `supervisor.py`/`sub_agents.py`
  rewritten from Command-handoff routing (specialists as `StateGraph`
  nodes reached via `Command(graph=Command.PARENT)`) to an agents-as-tools
  design (each specialist a plain `@tool` calling `ainvoke()` on its own
  compiled graph) — fixes a real flat-trace/parallel-firing bug this
  surfaced in Langfuse, verified live via spike before landing. See
  STEPS.md 94 for the full reconstruction; this is now the current
  architecture (Architecture diagram above).
- Complete: Phase 17 — A2UI generative UI integration (2026-07-23):
  agents can present rich, optionally interactive UI in the dashboard
  instead of plain text, using a constrained subset of Google's A2UI v0.9
  component vocabulary. Chronological detail in STEPS.md 92.
  **Part A (display-only):** `assistant/a2ui.py`'s `render_ui` tool
  validates a component tree (Text/Badge/Divider/Image/Column/Row/List/
  Card) against a strict allowlist, then forwards it through the same
  `adispatch_custom_event` channel Phase 16's streaming relay already
  proved out; `server.py` relays it as a new non-terminal `{type: a2ui,
  ...}` SSE frame; `A2UIRenderer.tsx` (registry-dispatch, mirroring
  `InterruptGate.tsx`'s pattern) renders it inline in `ChatPanel`.
  `render_ui`'s own text summary persists to history; the live render
  itself is ephemeral by design.
  **Part B (interactive):** adds TextField/CheckBox/ChoicePicker/Button.
  `Button.action` is structurally locked to exactly `{name: <str>}` — no
  `functionCall`, no nested payload — enforced both server- and
  client-side. A submission POSTs to `/a2ui/action`, framed as a PLAIN,
  non-synthetic user turn (same trust level as typed chat, same
  `is_genuine_human_turn` machinery every other turn-boundary feature
  depends on). No new side-effect path: any real action the agent takes in
  response still goes through the existing, unmodified `interrupt()`-gated
  tools — verified live by watching the memory-write confirmation gate
  fire correctly off a form submission.
  **Scope, deliberate (v1 only — extended in Phase 18):** v1 is
  supervisor-only — the custom-event channel is proven at the supervisor's
  own graph level, not yet re-verified across a nested specialist subgraph
  boundary. Remote `Image` URLs rejected (`data:` URIs only); Modal/Tabs/
  Video/AudioPlayer/Slider/DateTimeInput excluded from v1's vocabulary.
  204 backend tests pass (15 new), 54 frontend tests pass (18 new);
  `tsc`/`ruff`/`prettier`/`build` all clean.
- Complete: Phase 18 — extend render_ui to specialists; persist A2UI
  surfaces across reload (2026-07-24, STEPS.md 95). The two follow-ons
  from Phase 17's own deliberate v1 scope limits, built the same session
  they were raised in, at the user's direct request.
  **render_ui extended:** `research_agent` and `life_admin_agent`
  (`sub_agents.py`) now carry `render_ui` too — NOT `coding_agent`/
  `mac_control_agent` (output isn't card-shaped), same kind of deliberate
  scope call Phase 17 made for "supervisor-only." The nested-boundary risk
  Phase 17 left open was resolved with a REAL live test
  (`test_render_ui_available_on_delegated_specialist_and_persists`,
  `tests/test_a2ui.py`), not just reasoned through: a delegated
  specialist's own render_ui call — one level of nesting deeper than
  `research_fa_token`'s existing proof — still surfaces live via SSE.
  Surfaced a real live bug along the way: the supervisor refused to
  delegate a render_ui-shaped request at all (no visibility into a
  specialist's actual bound tools) — fixed via a supervisor prompt update,
  which also surfaced that `prompts.get_prompt()` prefers Langfuse's
  remote "production" prompt over an edited local fallback whenever
  reachable, so all six prompts needed re-syncing
  (`scripts/sync_prompts_to_langfuse.py`) for the fix to actually take
  effect.
  **Persistence:** `render_ui` now returns a `Command` (matching
  `request_gated_action_confirmation`'s pattern) carrying the full surface
  in `additional_kwargs[A2UI_SURFACE_KEY]` (a2ui.py) — read back by
  `server.py`'s `/history`. A second-order fix was needed for delegated
  specialists specifically: their own render_ui ToolMessage lives only in
  an isolated, discarded `ainvoke()` result, so `_invoke_agent_graph`/
  `call_specialist` (`supervisor.py`) now forward any surfaces found there
  onto the specialist-delegation tool's own ToolMessage. Without this fix
  a sub-agent's surface would have rendered live and then silently
  vanished on reload. The Phase 16 A.5 HTTP research path (off by default)
  left as a documented, accepted gap — no A2UI relay exists in
  `fa_service.py`, real separate scope for a non-default path.
  **Frontend:** `HistoryMessage.surfaces` (api.ts); `HistoryPanel.tsx`
  renders inline per-row; `ChatPanel.tsx`'s `attachPersistedSurfaces()`
  replays the live `pendingA2uiRef` grouping logic so a reload looks
  identical to the live turn.
  209/209 backend tests pass (5 new), 56/56 frontend tests pass (2 new);
  `tsc`/`ruff`/`prettier`/`build` all clean (2 pre-existing, unrelated
  ruff findings confirmed via `git stash`, not introduced here).
- Complete: Phase 19 — startup/cost/voice fixes + "Oni" dashboard redesign
  (2026-07-24, STEPS.md 96). Four asks in one session: three real bugs
  plus a UI redesign import via the `DesignSync` MCP tool (`claude.ai/
  design` project "Oni assistant UI design",
  `Oni Dashboard - Final.dc.html`). Two user decisions locked the
  redesign's scope: keep the app's EXISTING color tokens (layout only from
  the mock, not its hex palette), and build the full right context rail
  except the Today/calendar card, wired to live data.
  **Startup race:** every launch looked like a fresh empty chat because
  Tauri showed its window before `uvicorn` was listening
  (`src-tauri/src/lib.rs`'s non-blocking `spawn_backend()`) while
  `api.ts`'s mount-time fetches had no retry. Fixed with `api.ts`'s new
  `fetchWithRetry()` (retries a thrown network error only, ~15s window)
  on `fetchThreads`/`fetchHistory`/`fetchCost`, plus a belt-and-suspenders
  `wait_for_backend()` TCP-readiness poll in `lib.rs` before the window
  appears.
  **Cost panel showing 0:** diagnosed live before touching any code
  (CLAUDE.md's verification discipline) — turned out to have NO code fix.
  `all_time`/`week` were already correct; `today` was 0 because the
  LangSmith account had hit its own monthly trace-ingestion quota
  (confirmed via a real 429, "Monthly unique traces usage limit
  exceeded") — nothing had landed since 2026-07-18.
  `_get_run_stats_sync`/`/cost` (`server.py`) already correctly reflect
  LangSmith's true state; documented the finding directly in the code and
  rewrote `CostPanel.tsx`'s disclaimer to say precisely what the `$`
  figure is (LangSmith's own token-count × its price-list estimate, never
  a literal Anthropic invoice pull). Flagged as an account/billing
  decision for the user (upgrade the plan, or wait for the monthly
  reset), not something fixable in code.
  **Voice breaking the interrupt gate:** voice and the dashboard share one
  active thread; voice's `_process_turn` always started a FRESH
  `ainvoke()` even when the dashboard had a pending `interrupt()` open,
  silently orphaning it (confirmed via LangGraph's own `is_resuming`
  logic). Fixed by having voice check `graph.aget_state(config)` first and
  decline rather than clobber a pending gate. Separately, `ChatPanel.tsx`
  gained a 4s idle poll (paused during any live SSE stream or pending
  gate) against `/threads`' `last_active_at` marker, so an external write
  surfaces without a manual refresh.
  **"Oni" redesign:** a new `agent_activity` SSE frame
  (`supervisor.py`/`server.py`) reuses the exact `adispatch_custom_event`
  relay already proven (Phases 16–18) to cross the nested-`ainvoke()`
  specialist boundary — `_AgentActivityRelay` reports a specialist's own
  inner tool calls, `call_specialist` dispatches the outer
  supervisor->specialist boundary, one uniform stream for both.
  Live-verified the nested-boundary reliance with a real test
  (`test_activity_frames_surface_across_the_delegated_specialist_boundary`),
  not just reasoned through. `App.tsx` restructured into a three-column
  shell (left `ThreadSidebar` · center chat/tabs · new right context
  rail); a new `useAgentActivity()` hook lives in `App`, not `ChatPanel`,
  so the rail survives a tab switch that unmounts `ChatPanel`. New
  components (`AgentActivityGraph.tsx`, `ToolCallTimeline.tsx`,
  `StatusPill.tsx`, `CostSummaryCard.tsx`) all on the app's EXISTING color
  tokens, never the mock's own hex values. Header title changed to "Oni";
  package name stays `assistant`.
  **Live-verified in the real, already-running app**, not just tests — a
  real hazard (freeing port 8000 for a verification backend killed the
  user's own live backend process) was found and handled transparently;
  the replacement came up and the live Tauri window recovered on its own,
  an incidental confirmation of the startup-race fix. A real
  test-isolation bug (`ChatPanel.test.tsx` never mocked `fetchThreads`,
  silently depending on a live backend once Part C added a call to it)
  was found by deliberately killing the test backend, not assumed safe,
  and fixed.
  210/210 backend tests pass (1 new), 61/61 frontend tests pass (5 new);
  `tsc`/`ruff`/`prettier`/`build` all clean (2 pre-existing, unrelated
  ruff findings confirmed via `git stash`, identical to Phase 18's own,
  not introduced here).
- Complete: Phase 20 — Astryx redesign integration: theme, chat, uploads,
  kanban board, landing page (2026-07-24/25, STEPS.md 97). Opened and
  built in one long session, no phase previously ACTIVE; docs written up
  in a closeout pass at the user's direct request, same pattern as
  Phase 17's own (STEPS.md 93). Explored first in a throwaway sandbox
  (`oni/`, gitignored, never committed) against the desktop wallpaper's
  ember palette, then integrated into the real `dashboard/` app across a
  run of escalating asks in the same conversation.
  **Theme:** `dashboard/src/themes/oniMatcha/oniMatchaTheme.ts` —
  `defineTheme({ extends: matchaTheme, ... })`, keeping matcha's own
  shape/typography while overriding every color token (including the
  ones matcha bakes its green directly into — shadows, overlays, the
  gray family) with the sandbox's ember palette; applied app-wide via
  `AstryxThemeBridge.tsx`, sharing the app's existing theme toggle.
  **Chat redesign:** `ChatPanel.tsx`/`InterruptGate.tsx`/
  `A2UIRenderer.tsx` migrated to Astryx components as a pure
  presentation swap — `InterruptGate.tsx`'s security-critical
  verbatim-payload contract (every `data-testid`, every per-action
  field) left untouched, verified by the full existing test file passing
  with zero test edits. Astryx's flagship contentEditable composer input
  swapped for a real `<TextArea>` in the `input` slot (a documented,
  deliberate trade-off — keeps `ChatPanel.test.tsx`'s placeholder-based
  queries working, skips the flagship input's token-chip/mention
  affordances for this panel specifically).
  **File/photo uploads:** new `POST /uploads` (`server.py`) — image MIME
  allowlist (HEIC explicitly rejected, no new dependency added for it), a
  size cap, and server-side downsampling to a 1568px long edge before
  storing/encoding (a real cost decision — cuts an unresized 4K
  screenshot from ~4784 to ~1560 visual tokens against Claude's own
  high-resolution vision tier). Every generated path still routed through
  `tools.py`'s existing `_resolve_in_workspace()`, not trusted for being
  server-generated. `memory_extraction.py` gained `_text_only_content()`
  so a multimodal turn's base64 image blob can't get stringified into an
  extraction prompt. Verified end-to-end against real Claude vision.
  **Kanban board, real backend + full agent access:**
  `assistant/board_store.py` (new, mirrors `thread_store.py`'s own
  pattern — separate `board.sqlite`, durable human-readable "ONI-N" refs
  via a `ref_counter` table) + `GET/POST/PATCH/DELETE /board/tasks[/{id}]`
  (`server.py`) + `assistant/board_tools.py`, given to `life_admin_agent`
  deliberately UNGATED — the standing confirmation rule (Security model
  below) covers side-effectful EXTERNAL actions; the board is local,
  in-app, and fully reversible, the same category that rule already
  excludes, documented directly in the module's own docstring. A real,
  live-found gap fixed along the way: the supervisor initially refused to
  delegate board requests at all (same "no visibility into a specialist's
  bound tools" class of bug Phase 18 hit for `render_ui`) —
  `SUPERVISOR_SYSTEM_PROMPT_FALLBACK`'s routing line now names the board
  explicitly, re-synced to Langfuse. `InProgressTasksCard.tsx` (new)
  polls the same live data for the right rail (kept on shadcn, not
  migrated to Astryx, matching History/Memory/Cost/ThreadSidebar).
  **Landing page:** adapted from the Astryx Playground's "AI Chat
  Landing" template (`astryx.atmeta.com/playground`) into a new Home tab
  (`dashboard/src/components/home/HomePage.tsx`), now the default tab —
  greeting, cursive heading, category filter, suggestion-card grid, and
  composer kept and fully wired to the real chat pipeline via
  `ChatPanel.tsx`'s new `initialMessage`/`onConsumeInitialMessage`
  hand-off (auto-sends through the same, already-tested `handleSend`
  path a typed message takes, consumed exactly once). The template's
  non-functional demo content — a fake @mention team roster, a
  `/command` palette, "Sensitive"/"Deep Mode" tokens, a dead settings
  menu — deliberately dropped rather than shipped as UI that does
  nothing in a single-user personal assistant. Extracting the design's
  source hit an unrelated data-exfiltration guard blocking the
  Playground tab's own tool-text-output channel (root-caused, not
  guessed around — full detail in STEPS.md 97); worked around by reading
  the Monaco editor's content directly via screenshots instead, then
  cross-checked against the actually-installed `@astryxdesign/core`
  source for every component/prop used. Live-verified against the real
  running app via both submission paths (typed + Enter, and clicking a
  suggestion card), each producing a real streamed reply from the live
  backend.
  **Layout/font fixes**, from direct user feedback mid-session: removed
  a `max-w-2xl` cap that left empty space between columns, widened the
  right rail (`w-72`→`w-96`), and scoped the cursive display font to
  large headings only — briefly over-applied onto small uppercase tab
  labels, self-corrected to match the pattern Astryx's own built-in
  `gothic` theme already uses.
  218/218 backend tests pass (8 new), 64/64 frontend tests pass (3 new);
  `tsc`/`ruff`/`prettier`/`build` all clean (2 pre-existing, unrelated
  ruff findings confirmed via `git stash`, identical to Phases 18/19's
  own, not introduced here).

Roadmap history: renumbered 2026-07-13 (handoff-fix/memory/voice-upgrade/
dashboard inserted ahead of the original polish phase). On 2026-07-14 Phase
10 was parked and Phases 11–14 added: 11 skills-cleanup, 12 email+calendar
WRITE, 13 Apple Calendar + open-URL-in-Brave, 14 UI rework. Phase 15
(multi-thread conversation support) added the same day, discovered mid-Phase
12 (STEPS.md 66) — the shared fixed `THREAD_ID` collides across concurrent
clients; kept as its own phase rather than folded into 12. Phase 13
completed 2026-07-15 (STEPS.md groups 69–70). Phase 14 completed
2026-07-15 (STEPS.md groups 71–72). Phase 10 resumed 2026-07-15 now that
the write-access/browser/UI arc (11–15) is complete, and its status flip to
COMPLETE was approved by the user 2026-07-16. Phase 16 (Langfuse v2→v3)
opened 2026-07-16, functionally complete by 2026-07-18 (STEPS.md 90–91);
its status flip to COMPLETE was approved 2026-07-24 (STEPS.md 93), in the
same pass that added Phase 17 (A2UI generative UI, built 2026-07-23,
documented 2026-07-24). Phase 18 (render_ui extended to specialists +
A2UI surface persistence) opened, built, and documented the same day,
2026-07-24 (STEPS.md 95). Phase 19 (startup/cost/voice fixes + "Oni"
dashboard redesign) opened, built, and documented the same day,
2026-07-24 (STEPS.md 96). Phase 20 (Astryx redesign integration: theme,
chat, uploads, kanban board, landing page) opened and built the same
day, 2026-07-24, spanning into 2026-07-25; documented in a closeout pass
at the user's request (STEPS.md 97). Phases 21–24 scoped 2026-07-25 via a
`/grill-with-docs` session, ahead of any code: 21 phone conversational
channel + `phone_agent` (Action Button voice trigger, Share Sheet intake,
health/location, iPhone file+photo search, `open_app`/`open_url`), 22
messaging cluster (iMessage read+send + WhatsApp send-only, Mac + iPhone),
23 full-disk Mac file + Photos access (the largest security-model change
in the project's history — see its own PLAN.md entry), 24 unattended
pre-approved automations (a new, deliberately narrow exception to the
standing confirmation gate). All four are PLANNED, not ACTIVE — see
PLAN.md for full scope, none built yet. Phase 25 (cross-app workflow
chaining) opened AND built 2026-07-28 via its own `/grill-with-docs`
session (STEPS.md 117-118) — the first pass over-narrowed to a single
flight-confirmation example, corrected once the user clarified they
wanted the general cross-app-chaining capability itself, not one demo
scenario. Its mechanism is code-complete and live-verified; its two
original proof workflows remain blocked on the user's own permission
grants (Messages/Photos/Contacts), not on any further code. See PLAN.md.
Phase 26 (A2UI full Basic Catalog parity, `render_form`, media
rendering) was built 2026-08-04 without its own prior scoping session —
found as uncommitted changes and documented after the fact (STEPS.md
119). Code complete but does not meet this project's normal done bar:
no live verification, no growth in test coverage despite a large new
surface area, not yet committed. See PLAN.md's own Phase 26 entry.
Phase 27 (Obsidian vault: Oni's own note-store) was scoped 2026-08-06 via
its own `/grill-with-docs` session (STEPS.md 124) and built + live-
verified the next day (STEPS.md 126-127). Phase 28 (dashboard redesign:
Obsidian-violet reskin, Project-grouped thread tree, radial chat
selector, agent-activity physics upgrade) was scoped 2026-08-08 via its
own `/grill-with-docs` session (STEPS.md 128), porting a standalone
mockup (`instrument/`) built in an earlier session — PLANNED, not built.
See PLAN.md.
- **The Phase 5 menu-bar voice daemon is RETIRED, replaced by in-app
  voice I/O in the dashboard (2026-08-06, STEPS.md 123)** — not a
  numbered phase, a same-session architecture change at the user's
  direct request ("this is not how I envisioned voice I/O to work...
  more like how Claude/ChatGPT have voice I/O... I have to refresh the
  chat to see my voice input"), confirmed explicitly before removal:
  keep the old always-on hotkey daemon alongside the new version, or
  retire it — the user chose retire. `assistant/voice_daemon.py`
  (rumps menu bar app, pynput global Option+Return hotkey, its own
  `graph.ainvoke()` loop, spoken confirmation answers) is deleted
  outright; `voice_io.py` trimmed to just `transcribe_file` (dropped
  `Recorder`, buffer `transcribe()`, `speak()`, TTS voice resolution,
  `parse_confirmation` — all daemon-only); the `assistant-voice`
  console script and the `pynput`/`rumps`/`sounddevice`/`numpy`
  dependencies removed; `src-tauri/src/lib.rs`'s voice-daemon spawn/kill
  code removed (Rust still builds clean); the launchd plist deleted.
  The replacement needed almost no new code: `server.py`'s
  `/voice/transcribe` and `ChatPanel.tsx`'s mic-button recorder were
  ALREADY built, for Phase 21's iPhone-access feature, and simply hidden
  inside Tauri (`!isTauri()`) because the Mac's separate daemon existed
  at the time. Un-hiding that one gate was the actual fix — a voice
  turn now flows through `ChatPanel.tsx`'s own `handleSend`, identical
  to typing, so it streams live into the open chat with no separate
  sync mechanism, which is exactly what fixes "have to refresh to see
  my voice input" (the old daemon wrote turns via an isolated
  `ainvoke()` outside this panel's own SSE stream). Added spoken
  replies via the browser's own Web Speech API (`speakReply`,
  `window.speechSynthesis`) rather than a new backend TTS endpoint —
  fires only for a turn that actually originated by voice, mirroring
  Claude/ChatGPT's own voice-mode behavior.
  **Deliberately not rebuilt, called out explicitly rather than
  silently dropped:** the daemon's spoken-confirmation-answer path — a
  voice-originated turn that hits a gate now shows the same click-only
  `InterruptGate` card a typed turn would (this project's standing rule
  that free-text gate content is never voice-approvable already covered
  most of what mattered here; what's actually lost is answering a
  SIMPLE gate, like a calendar-event delete, by saying "yes" instead of
  clicking) — and the daemon's local "start a new conversation" trigger
  phrase for switching threads by voice, with no equivalent in the new
  path (the dashboard's own New Thread button is the replacement).
  The PHONE channel's own voice interaction (Shortcuts' Speak/Dictate
  round trip, `/phone/turn`/`/phone/resume`) is entirely unrelated to
  this daemon and is untouched — it still checks `voice_approvable` on
  gate payloads exactly as before.
  **Also fixed in the same session, found first:** `/Applications/
  Oni.app` (a compiled AppleScript applet, not a `tauri build` release
  bundle — a prior session's deliberate live-reload-over-packaging
  trade-off) used to open a visible Terminal window to run `npm run
  tauri dev`; recompiled to launch the same script via `do shell
  script "nohup ... &"` instead, so Oni now runs with no Terminal
  window at all, output going to `~/Library/Logs/PersonalAssistant/
  oni-dev.log` instead. A live investigation into the menu-bar hotkey
  not registering after that relaunch (Input Monitoring/Accessibility
  showed `Python` already enabled; a daemon restart was the leading
  hypothesis, since trust granted after a process's event tap already
  exists doesn't apply retroactively) was never concluded — superseded
  by the daemon's retirement before a final retest. A separately
  reported "Cmd+Q leaves the backend/voice daemon orphaned" finding
  from earlier in this same investigation was very likely a testing
  artifact (synthetic AppleScript keystrokes/`quit` commands don't
  reliably reach a real quit path) rather than a real bug — `lib.rs`'s
  quit handling already matches both `RunEvent::ExitRequested` and
  `RunEvent::Exit` specifically because of an earlier, separately
  live-diagnosed version of this exact bug; flagged here since that
  earlier "confirmed" claim was reported to the user before being
  corrected.
  340/341 backend tests pass (1 failure is the pre-existing
  `threads.sqlite` active-thread-pointer flake, this run triggered by
  this same session's own permission-probe test traffic, not this
  change); 99/99 frontend tests pass; `tsc`/`ruff`/`prettier`/Rust build/
  `npm run build` all clean. Not live human-tested (needs a real
  microphone and a real ear, neither available to the agent session
  that built this) — Oni is running with the daemon gone, live testing
  is the user's own next step. Not committed.
- **Phase 27 (Obsidian vault: Oni's own note-store) — CODE COMPLETE,
  LIVE-VERIFIED (scoped 2026-08-06 via a `/grill-with-docs` session,
  STEPS.md 124; built 2026-08-07 STEPS.md 126; a real incident found and
  fixed during live verification, corrected the same day, STEPS.md
  127).** A
  "second brain"-style persistent note-store, distinct from
  `memory_store.py`'s small curated Facts, searchable/writable/updatable/
  deletable via new `assistant/obsidian_tools.py` — fully ungated
  (`docs/adr/0001-*`), with Oni deciding for itself when something's worth
  saving rather than waiting to be asked (`docs/adr/0002-*`). **Ownership
  note (corrected during a later bug-fix pass, found as real doc drift,
  confirmed intentional):** originally wired into `research_agent`/
  `life_admin_agent` only (PLAN.md's own Phase 27 Decision 3); a later,
  uncommitted change moved these tools onto the supervisor itself instead
  (`supervisor.py:216,1315`'s own `build_obsidian_tools()` call) —
  `sub_agents.py` no longer references obsidian tools at all. The scoping
  session was the
  first time `/grill-with-docs`'s own named `/domain-modeling` dependency
  was actually installed rather than missing (Phase 25's own scoping
  session, STEPS.md 117, had to fall back to logging decisions directly in
  STEPS.md/PLAN.md for lack of it) — produced this project's first
  `CONTEXT.md` and first two ADRs.
  **Two deliberate departures from the locked design, made while
  building:** `update_vault_note` was given the same `oni: true`
  authorship check `delete_vault_note` has, even though the ADR only names
  delete — an unguarded full-body overwrite is exactly as destructive as
  an unguarded delete; and the "must link related notes" rule (Decision 8)
  is enforced mechanically inside `write_vault_note` itself (keyword
  overlap against existing titles, real `[[wikilinks]]` appended
  automatically) rather than by asking the model to call `search_vault`
  first and hand-type links, which would have risked a hallucinated
  target. **First live-verification pass was real but too narrow, and
  said so only after a second pass caught it (STEPS.md 127, full
  incident record):** a throwaway script that called `research_agent`
  directly (bypassing the supervisor's own routing decision) proved the
  TOOLS work — a real turn saving a fact, a real follow-up recalling it,
  a real refused deletion, all against a temp checkpointer + temp vault,
  never touching real state. Running an actual 7-prompt conversational
  suite through the REAL running backend afterward — the test that
  actually exercises the supervisor's own routing, which the isolated
  script structurally could not — found it misrouted every vault request
  to `mac_control_agent`'s Apple Notes.app tools instead (a real Apple
  Note was actually created), the exact routing-blindness class Phases
  18/20 already hit for `render_ui`/the board, recurring here despite an
  earlier attempt to guard against it. Fixed with an explicit
  disambiguation rule in the supervisor's prompt. Re-running the suite
  against the fix then surfaced a SECOND, more serious bug: a "delete"
  request correctly reached `delete_vault_note` this time, and it
  **actually deleted a real, pre-existing course note** — because all 138
  notes from the same session's earlier course-population work
  (STEPS.md 125) had been mistakenly marked `oni: true`, silently
  defeating the authorship check for the vault's entire real content the
  whole time; the tool's own code was correct throughout, the data it
  trusted was not. Recovered the deleted note byte-for-byte from this
  session's own prior tool-call history, corrected the same mistake
  across all 137 other notes, and re-confirmed live against the fixed
  backend and fixed data that the identical delete request now correctly
  refuses. One gap left open: the per-turn write cap (3 writes/turn) is
  unit-tested but wasn't live-provoked through a real 4th-write attempt,
  judged not worth chasing given how simple the mechanism is. 24 new
  tests plus 35 existing `test_supervisor.py`/`test_sub_agents.py` tests
  unaffected; 364/365 backend tests pass suite-wide (1 pre-existing,
  unrelated `threads.sqlite` flake); `ruff check .` clean (1 pre-existing,
  unrelated finding in `supervisor.py`); all 7 prompts re-synced to
  Langfuse twice (once per prompt-fix round). Not committed. **Standing
  lesson, worth carrying into every future phase's own verification:** a
  script that bypasses the supervisor to call a specialist directly
  verifies the specialist, never the supervisor's own routing decision —
  "live-verified" should mean what was actually exercised, not what
  logically ought to work given passing unit tests.
  Separately, and not part of this phase's own code: `~/Documents/
  OniVault` was also manually seeded the same session with 138 notes
  summarizing `~/Documents/Courses`, done directly by Claude Code (not
  through Oni, to avoid Console API spend) at the user's explicit request
  — see STEPS.md 125-127 for that work (125 for the population itself,
  127 for the `oni: true`-mislabeling bug found in it and fixed), which
  predates and is unrelated to this phase's own build.
- **Phase 28 (dashboard redesign: Obsidian-violet reskin, Project-grouped
  thread tree, radial chat selector, agent-activity physics upgrade) —
  ALL 5 STEPS CODE-COMPLETE, a real fix pass done after the first
  status-flip proposal turned out to be premature, re-proposed for
  COMPLETE, not yet approved (scoped 2026-08-08 via a `/grill-with-docs`
  session, STEPS.md 128; build started same day, STEPS.md 129-133; fix
  pass STEPS.md 134).**
  Ports `instrument/instrument.html` (a standalone,
  gitignored, already-built interactive mockup) into the real
  `dashboard/` app. Before the grilling session itself: independently
  live-verified the mockup's one self-reported open gap (radial-node
  drag-to-reposition, previously reasoned-not-observed due to a sandbox
  limitation) using a separate Playwright/Chromium instance — the drag
  genuinely works. Also found, unprompted by the mockup's own README, a
  real terminology collision: the mockup names its sidebar data structure
  `VAULT`, colliding with `CONTEXT.md`'s existing Vault term
  (`~/Documents/OniVault`, Phase 27). Resolved during scoping —
  `CONTEXT.md` now also defines `Thread` and `Project`; hierarchy is
  `Oni → Project → Thread`, no Vault-like umbrella noun. Key decisions
  locked (full reasoning in PLAN.md's Phase 28 entry): a new `projects`
  table + nullable `project_id` FK on `thread_store.py`'s existing
  `threads` table, one Project per Thread; manual-only assignment (no
  agent/supervisor involvement, both a menu action AND tree drag-and-drop
  are in scope); deleting a Project unassigns rather than cascade-deletes
  its Threads (directly informed by Phase 27's own real accidental-delete
  incident); `oniMatchaTheme` fully replaced by a new violet theme with
  genuinely new light AND dark tuples (the mockup only ever designed
  dark); radial-view project "bubbles" get an animated per-project hue
  drift with no fixed color (the user's own idea), while the tree
  sidebar/settings-panel legend keeps a stable round-robin-assigned tint;
  one phase, five pieces, explicitly sequenced (data model → tree sidebar
  → palette → activity-graph physics → radial selector) with per-piece
  test coverage and live verification required throughout, an explicit
  lesson carried over from Phase 26's own thin-coverage retrospective. No
  ADR opened — every decision considered was judged too easy to reverse
  to warrant one; recorded as prose in PLAN.md instead.
  **Step 1 (`projects` table + API) is built and live-verified**
  (STEPS.md 129): new `Project` dataclass + `projects` table +
  `project_id` FK in `thread_store.py` (with an ALTER TABLE migration
  path for pre-existing databases), `GET/POST/PATCH/DELETE /projects` +
  `PATCH /threads/{id}/project` in `server.py`. 22/22 new
  `test_thread_store.py` cases and 6/6 new `test_server.py` cases pass;
  `ruff` clean. An unplanned but genuine live-verification event: this
  Mac's own real, long-running Oni backend (`uvicorn --reload`) picked up
  the edit automatically and migrated the REAL production `threads.sqlite`
  live — confirmed non-destructive (all 73 pre-existing threads intact,
  correctly ungrouped) and the live server still healthy afterward.
  **Step 2 (Project-grouped tree sidebar) is also built** (STEPS.md 130):
  new `dashboard/src/components/ui/dropdown-menu.tsx` (this project's
  first dropdown menu, wraps `@base-ui/react/menu`); `ThreadSidebar.tsx`
  rewritten with collapsible project folders, both locked assignment
  mechanisms (a "Move to project" menu + tree drag-and-drop, both calling
  one shared handler), and project create/rename/delete — every
  pre-existing behavior/test-id preserved (verified, not assumed). A real
  query-ambiguity bug (a project's own tree-header label collided with
  its identically-named dropdown menu item under a plain text query,
  silently toggling collapse instead of assigning) was found and fixed by
  switching to role-scoped queries. 19 new frontend tests, 108/108 pass
  suite-wide; `tsc`/`prettier`/`build` clean. Also confirmed live-building
  cleanly in the user's own already-running Tauri dev app
  (`vite --watch`, zero errors).
  **Step 3 (full violet palette reskin) is also built** (STEPS.md 131):
  `oniMatchaTheme` replaced outright by `oniObsidianTheme` (new
  directory, old one deleted); every new light-mode color value verified
  against real WCAG contrast ratios via a small `contrast.py` script, not
  eyeballed (several initial picks failed AA and were darkened before
  landing); a real terminology collision found (this app's own
  pre-existing `--signal` token, Phase 14's "pending approval" color,
  coincidentally shares a name with the mockup's own unrelated `--signal`
  = "the violet accent" — no actual code collision resulted, documented
  in both files regardless); `--operator` moves to the new violet accent
  (it always just tracked the theme's own accent) while `--signal`/
  `--alarm` deliberately do not, per `index.css`'s own pre-existing
  rationale for keeping them decoupled. A real, pre-existing `astryx
  theme build` tooling bug (classic vs. automatic JSX runtime mismatch,
  unrelated to this phase, present since the theme was first generated)
  was found and fixed with a one-line explicit React import. Confirmed
  live in the user's running Tauri app. The user was asked directly
  before this step given its all-at-once visual impact; approved.
  **Step 4 (`AgentActivityGraph` physics upgrade) is also built**
  (STEPS.md 132): organic drift, dispatch/response particles,
  scramble-decode tool names, hover-highlight, all reconciled with the
  real `useAgentActivity()` data (the mockup's own demo-only random
  timer dropped entirely) — `activeTool` needed to actually be passed
  down as a prop for the first time. A real React/rAF conflict (JSX
  props fighting ref-driven position mutation, would have caused a
  visible snap-back glitch) was caught and fixed before shipping. 8 new
  tests (a jsdom `animationend` limitation confirmed directly and
  documented rather than worked around with a misleading test); 116/116
  pass suite-wide; confirmed live in the user's running Tauri app.
  **Step 5 (radial chat selector) is also built** (STEPS.md 133): a new
  DOM-free `radialSimulation.ts` holding the actual repel/link/center
  physics (ported verbatim from the mockup, 12 tests exercising the math
  directly — not just reasoned through) plus `RadialChatSelector.tsx`
  (SVG rendering, pointer-capture drag, the full Filters/Groups/Display/
  Forces settings panel), wired to real `projects`/`threads` data
  including a case the mockup never had (an ungrouped thread, linked
  directly to the hub). **A real unverified premise from this section's
  own Decision 8 was caught and corrected while building on it:** "the
  real app's right rail collapses below ~1040px" was never actually true
  of `dashboard/src` — the real mechanism is a 768px (`md:`) off-canvas
  drawer, traced directly to `App.tsx`; the settings panel now matches
  that real pattern instead of an invented one. Several real bugs found
  and fixed (an uncontrolled-input reset gap; two confirmed jsdom API
  gaps — `setPointerCapture`, `createSVGPoint`/`getScreenCTM` — defended
  against the same way the mockup's own code already did); a transient
  live JSX syntax error, visible in the running dev server's own log
  mid-edit, self-resolved once the edit completed (disclosed, not
  glossed over — a real risk of editing files a live `--reload`/
  `--watch` process is actively serving). 25 new tests across both new
  files, 141/141 pass suite-wide; confirmed live-building cleanly
  afterward. **One honestly-disclosed remaining gap:** the narrow-window
  settings-panel fallback is built but not independently visually
  verified at a real narrow width — the phase's own status-flip proposal
  in PLAN.md names this explicitly rather than claiming full
  live-verification it doesn't have.
  **That first status-flip proposal turned out to be premature**
  (STEPS.md 134): the user came back with `instrument/FIX_PLAN.md`/
  `DESIGN.md` and real reference screenshots, diagnosing three concrete
  bugs the live result actually had — a light-mode default reading as
  generic (not Obsidian), the radial graph rendering all 73 real
  (all-ungrouped) production threads with zero strategy (illegible
  node-soup), and the settings panel docking left/over the sidebar
  instead of right. Root-caused, not guessed at, each: bug 3 traced to
  `App.tsx`'s legitimate mobile-drawer wrapper around `<ThreadSidebar>`
  carrying a `transform` utility, which creates a CSS containing block
  that trapped the radial overlay's `position:fixed` inside a 256px box
  instead of the viewport — fixed with `createPortal(...,
  document.body)`. Bug 2's fix was **redirected by the user away from
  every option originally offered** (all three hid data) toward a
  better, proven approach shown via a real screenshot of their own
  Obsidian vault: never hide data, grow the canvas with node count
  (`computeGraphDimensions`), add real pan/zoom (wheel-to-zoom centered
  on the cursor, drag-to-pan the background), and hide text only once
  zoomed out far enough to be illegible (a `radial-hide-labels` CSS
  class toggled by zoom level) — exactly Obsidian's own graph-view
  behavior. Bug 1 fixed per the user's own choice between FIX_PLAN's two
  proposed paths: default fresh installs to dark (not "system"), since
  the violet theme is dark-only by design; existing preferences
  untouched. A fourth confirmed test-environment gap this session
  surfaced while testing the theme fix: this environment's own
  `localStorage` global is a non-functional Node.js native stub without
  a `--localstorage-file` flag, silently shadowing jsdom's real one —
  worked around with a small in-memory fake, same pattern as the
  session's other confirmed gaps (AnimationEvent, setPointerCapture,
  createSVGPoint/getScreenCTM). Every fix re-verified live via real
  Playwright screenshots against the real 73-thread production database
  (no Chrome-extension access in this session) — dynamic canvas
  confirmed, zoom/LOD confirmed at three zoom levels, panel docking
  confirmed via a measured 1440×900 bounding rect, dark-by-default
  confirmed even with the OS forced to light. 157/157 tests pass
  suite-wide (152 + 5 new theme tests); `tsc`/`prettier`/`build` clean.
  All five steps are code-complete and tested; the flip to COMPLETE is
  re-proposed in PLAN.md, now genuinely re-verified against the
  reference rather than re-asserted from memory, awaiting the user's
  explicit approval per this file's own standing rule.
- **Phase 29 (full "Instrument" design-system replacement, not a
  re-skin) — OPENED, ACTIVE, all 4 stages code-complete, NOT
  live-verified (2026-08-08).**
  The user judged Phase 28's live result "almost exactly the same" as
  before — Phase 28 deliberately re-skinned colors/fonts onto the
  EXISTING Astryx+shadcn architecture rather than replacing it; this
  phase replaces it: zero-chrome chat (no message bubble at all — a
  real one exists today, confirmed via a codebase survey, not assumed),
  one shared `.instrument-card` primitive everywhere a card-shaped
  object appears (kanban, gate confirmations, generative-UI, memory,
  cost), and the full ten-technique motion grammar from
  `instrument/instrument.html` (reveal-line, spotlight+tilt, draw-on,
  trailing cursor, scramble-in, count-up, scanning border, animated tree
  collapse, the already-built radial select). Scoped directly from the
  user's own complete design brief, not a fresh `/grill-with-docs`
  session — the brief left no real ambiguity, only sequencing. Full
  survey findings, the 4-stage build plan, and the specific bugs
  `instrument/DESIGN.md`'s own §12 already found once (never
  `transform:scale()` on an animated SVG circle, never
  `grid-template-rows` for the tree collapse, never bare `transition` +
  class-toggle) are in PLAN.md's own Phase 29 entry. Astryx removal
  (`@astryxdesign/core` usage) is confirmed cleanly isolated to exactly
  6 files — the other 10+ panels have zero Astryx dependency already.
  **Stage 1 (Foundation) is built and live-verified (STEPS.md 135):**
  Instrument Serif/Sans fonts installed; the six semantic tokens (void/
  paper/accent-signal/moss/rust/graphite) wired as real Tailwind
  utilities (`--accent-signal` deliberately NOT named `--signal` — the
  literal name collides with Phase 14's own pre-existing amber
  "pending-approval" rail-grammar token); `.reveal`/`.instrument-card`/
  `.instrument-card-scanning` CSS primitives plus a real `InstrumentCard`
  React component (pointer-tracked spotlight+tilt, not yet adopted
  anywhere — that's Stages 2-3); a new 9-item vertical `NavRail`
  replacing the horizontal tab bar entirely; frame columns resized to
  `instrument/DESIGN.md` §3's own proportions (thread list 216px, right
  rail 260px). 157/157 tests pass unaffected; `tsc`/`build` clean;
  confirmed live via a real Playwright screenshot (serif heading font,
  working rail, resized columns all visibly correct — the right rail's
  own cards still show old shadcn styling, expected, Stage 3's job).
  **Stage 2 (Astryx removal + chat zero-chrome) is built and verified
  (STEPS.md 136), started only after the user explicitly approved
  proceeding.** This was the phase's single largest, most structurally
  consequential piece — not a re-skin: `@astryxdesign/*` deleted
  outright (package.json, `node_modules`, all CSS imports, 48 packages
  removed via `npm install`), `AstryxThemeBridge.tsx` and the entire
  `themes/` directory (`oniObsidian`/`matcha`) deleted, `main.tsx` no
  longer wraps `<App>` in a theme bridge. All 6 files that used Astryx
  rebuilt on shadcn/Tailwind + `InstrumentCard`: `ChatPanel.tsx` (the
  real message bubble that contradicted "zero chrome" is gone, matching
  `instrument/instrument.html`'s own `.msg`/`.who`/`.body` CSS exactly),
  `InterruptGate.tsx` (done first and most carefully — every
  `data-testid` and verbatim-content renderer byte-identical, all 23
  `ChatPanel.test.tsx` tests pass unmodified, including the injection-
  shaped-payload tests), `A2UIRenderer.tsx` (all 18 A2UI Basic Catalog
  component renderers on native HTML, `ModalNode` rebuilt with
  `createPortal` per Phase 28's own containing-block lesson, all 12
  `A2UIRenderer.test.tsx` tests pass unmodified), `KanbanBoard.tsx` (no
  test file — verified by drag-mechanics + API-call contract instead;
  draggable cards deliberately use a plain `.instrument-card`-classed
  div rather than the component, since drag hit-testing needs a real
  external ref the component doesn't expose), and `HomePage.tsx` (both
  tests pass unmodified). New shared primitives: `ui/chip.tsx`,
  `ui/dialog.tsx`, `lib/relativeTime.ts`. A real jsdom gap found and
  fixed along the way: `InstrumentCard`'s mousemove-driven tilt called
  `window.matchMedia` unconditionally, which jsdom doesn't implement —
  guarded, same class of environment gap as Phase 28's own four.
  157/157 tests pass (unchanged count, no regressions); `tsc`/
  `prettier`/`build` all clean. **Not live-verified in the real running
  app** — no connected browser this session; the user's own auto-
  reloading dev environment already has this live, pending their own
  look. **Stage 3 (card-primitive rollout to Memory/Cost) is also built
  and verified (STEPS.md 137):** `MemoryPanel.tsx`'s and
  `CostPanel.tsx`/`CostSummaryCard.tsx`'s shadcn `Card` usages (neither
  file ever used Astryx) rebuilt on `InstrumentCard`; new shared
  `lib/useCountUp.ts` adds the design's own count-up technique to every
  dollar/token/run figure, deliberately compatible with this file's own
  prior no-sparkline decision (animates the number, no trend line) and
  structurally safe in tests (jsdom has no `window.matchMedia`, so the
  hook's initial-value-is-already-correct design keeps
  `CostPanel.test.tsx`'s synchronous assertions passing). All 157 tests
  still pass; `tsc`/`prettier`/`build` clean.
  **Stage 4 (signature motion techniques) is also built and verified,
  with two deliberate departures from the literal spec (STEPS.md 138)
  — ALL FOUR STAGES of Phase 29 are now code-complete:** new
  `BrandMark.tsx` (hand-drawn SVG draw-on, ported verbatim from
  `instrument.html`'s own path data) in `App.tsx`'s header; rail-icon
  redraw-on-switch confirmed structurally impossible against
  lucide-react's actual API (no internal `<path>` access for
  `pathLength` injection — `NavRail.tsx`'s own Stage 1 comment already
  flagged this, now confirmed) and deliberately not built; new
  `TrailingCursor.tsx` (global rAF-lerp cursor, `pointer:fine` +
  reduced-motion gated) mounted once app-wide; the tree's collapse
  adapted rather than built exactly per spec — the literal
  always-mounted `max-height` technique conflicts with
  `ThreadSidebar.test.tsx`'s own real, pre-existing a11y requirement
  that a collapsed project's threads leave the DOM entirely, so only
  EXPAND got an animated `.reveal` entrance, collapse stays instant.
  157/157 tests pass unchanged; `tsc`/`prettier`/`build` clean.
  **Not live-verified in the real running app across the ENTIRE
  phase** — no connected browser existed in any session that built any
  of Stages 1-4. Per this project's own Phase 26 precedent, that means
  this phase does NOT meet the normal done bar yet — no COMPLETE status
  flip should be proposed until the user has looked at the real,
  already-live app themselves.
- **A real live bug fix, same day: the new global trailing cursor
  (Stage 4) was hiding the real OS cursor and making it disappear in
  parts of the real app, reported directly by the user (STEPS.md 139).**
  Root cause of the decorative overlay's own rendering gap wasn't
  confirmed (no connected browser to inspect it). Fixed by no longer
  hiding the real cursor at all — the dot/ring now render additively on
  top of it, a deliberate departure from `DESIGN.md`'s own literal spec,
  chosen because it structurally guarantees the reported symptom can't
  recur. 157/157 tests pass; `tsc`/`prettier`/`build` clean.
- **Home and Chat tabs merged into one, at the user's own direct
  request — not part of Phase 29's own four stages (STEPS.md 140).**
  `HomePage.tsx`'s landing view (greeting, category filter, suggestion
  cards) moved verbatim into `ChatPanel.tsx` itself as a new `isNewChat`
  branch, replacing the empty message log on a genuinely new/empty
  thread; the SAME composer (attach/mic/send) already at the bottom of
  the panel serves both states, so the mic is available on the landing
  view for free. Sending a message (typed, spoken, or a suggestion-card
  click) switches into normal chat mode instantly — `handleSend` already
  appends the user's message synchronously before the network call.
  `App.tsx`'s separate `"home"` tab and its `pendingHomeMessage` cross-
  tab hand-off are gone; `NavRail.tsx` drops the `"home"` nav item (8
  destinations now, not 9). `HomePage.tsx`/`HomePage.test.tsx` deleted
  outright — its 2 tests ported into `ChatPanel.test.tsx` against the
  real merged component. 159/159 tests pass (one earlier isolated
  failure in an unrelated, untouched file — `RadialChatSelector.test
  .tsx`'s own already-documented `localStorage`/jsdom gap — confirmed as
  a pre-existing flake via 3 clean full-suite reruns, not a regression
  from this change); `tsc`/`prettier`/`build` clean. Not live-verified —
  same standing gap, no connected browser this session.

This block is the only part of this file that changes routinely; everything
below is durable.

## Load-bearing decisions — do not undo without discussion

- **Agent constructor:** `langchain.agents.create_agent` (NOT
  `langgraph.prebuilt.create_react_agent`) — the current non-deprecated
  constructor on our LangChain 1.x install; takes `system_prompt`, `middleware`,
  and `checkpointer` directly.
- **Model:** `ChatAnthropic(model="claude-sonnet-5")` for the main agent; Haiku
  for cheap routing/simple sub-tasks once those exist (Phase 3).
- **`checkpoint_ns`:** SqliteSaver requires BOTH `thread_id` and `checkpoint_ns`
  in `config["configurable"]` (STEPS.md 3.2). This lives in exactly one place —
  `make_thread_config()` in agent.py. Never build invocation config dicts by hand.
- **Checkpointer lifecycle:** main.py owns the `with get_checkpointer()` block
  for the process lifetime and passes it into `build_agent()`. agent.py never
  creates its own.
- **Extended thinking: enabled (`thinking={"type": "adaptive"}`) on all 5
  agent models, ALWAYS paired with `ThinkingBlockRepairMiddleware`
  (superseded Phase 10, 2026-07-15, STEPS.md 74 — reverses the Phase 1/
  Studio-era `thinking={"type": "disabled"}` fix from STEPS.md 28):
  `langchain-anthropic`==1.4.8 (still latest on PyPI, no upstream fix
  exists) has a confirmed SSE-chunk-merging bug that can drop a streamed
  thinking block's required `thinking` field, which Anthropic's API then
  rejects on replay (`messages.N.content.0.thinking.thinking: Field
  required`) — live-reproduced against the real API at this decision
  point, not just cited from the old record. Only affects streaming callers
  (LangGraph Studio, and since Phase 14, the dashboard's `/chat`/`/resume`
  SSE path via `astream_events`) — the CLI's non-streaming `ainvoke()` was
  never at risk either way. (Voice was in this same non-streaming category
  too, when it ran as its own daemon calling `ainvoke()` directly; since
  its 2026-08-06 retirement in favor of in-app voice, a voice turn goes
  through the dashboard's own streaming `/chat` call like any other turn,
  so it's now covered by this same middleware rather than exempt from the
  bug it guards against.) Rather than disable thinking
  project-wide again, `assistant/thinking_repair.py`'s
  `ThinkingBlockRepairMiddleware` patches the exact malformed shape
  (adds `"thinking": ""`, which fabricates nothing — that's the same value
  Anthropic's own non-streaming path already returns for an empty thinking
  block) on every model response before it can reach graph state.
  Live-verified against the real API (unpatched replay 400s, patched
  replay succeeds) and against the real graph end-to-end (a genuine
  two-hop streamed turn — supervisor → research_agent → back through the
  Phase 6 loop-back → coding_agent — completed cleanly with 0 malformed
  blocks surviving in the persisted history). **Any new model construction
  in supervisor.py/sub_agents.py that enables thinking MUST include this
  middleware in its middleware list** — the bug is in the underlying
  library, not one call site, so a new agent added without it is
  vulnerable the moment its own multi-turn tool loop replays a thinking
  block. `compaction.py`/`memory_extraction.py`'s Haiku calls stay
  `thinking={"type": "disabled"}` deliberately (single-shot classification/
  summarization, no orchestration reasoning to gain).
- **Prompt caching: `AnthropicPromptCachingMiddleware` in every agent
  model's middleware list (added 2026-08-04, STEPS.md 121)** — found
  missing, not a design choice being revisited: a real Langfuse pull (1,000
  generations, 14 days) showed `input_cache_read`/`input_cache_creation`
  at exactly 0 everywhere and a `cache_control` grep across `assistant/`
  came back empty, meaning every one of the supervisor's and all 5
  sub-agents' large, mostly-static system prompts was being fully
  re-prefilled on every single call, including consecutive calls within
  the same turn. `langchain_anthropic.middleware.
  AnthropicPromptCachingMiddleware` (same `AgentMiddleware` mechanism as
  `ThinkingBlockRepairMiddleware` above) tags the system prompt's trailing
  block and the last tool definition with an ephemeral `cache_control`
  breakpoint. Live-verified with a real API call: two `ainvoke()`s against
  `coding_agent` both returned `cache_read_input_tokens` covering nearly
  the entire input, including the first call of a freshly-built agent
  process (cache is content-keyed, not session-keyed). **Any new
  `create_agent(...)` model construction in supervisor.py/sub_agents.py
  MUST include this middleware too**, same standing as the thinking-repair
  rule above — omitting it doesn't break correctness, only silently
  reintroduces the full-reprefill cost this fix closes. Deliberately NOT
  applied to `compaction.py`/`memory_extraction.py`'s single-shot Haiku
  calls (no middleware pipeline exists there; lower reuse value) — left as
  an open follow-up, not a rejected option.
- **Retry circuit breaker: `RepeatedToolFailureCircuitBreaker` in every
  agent model's middleware list (added 2026-08-04, STEPS.md 122)** —
  found via a real, live-diagnosed incident: a Langfuse trace showed a
  single supervisor turn retrying a failing `render_ui` call 43 times in
  a row (~28 minutes of real model latency, real API spend), because it
  tried to build a surface needing a real image it had no tool to
  produce, kept exhausting its 4096-token output budget mid-generation,
  and nothing ever told it to stop. `assistant/circuit_breaker.py`'s
  `awrap_model_call` scans the trailing message history for a streak of
  identical-tool-name calls that all came back with
  `ToolMessage.status="error"`; once the streak reaches
  `max_consecutive_failures` (default 3), it returns a synthetic
  `AIMessage` explaining what happened INSTEAD of calling the model
  again — caps both the wasted time and the wasted spend, not just one
  of the two. This is a GENERIC safety net (any tool, any reason it
  keeps failing identically), independent of that incident's own root
  cause (supervisor.py's system prompt now separately tells the
  supervisor it has no media tool of its own — see the prompt itself).
  **Any new `create_agent(...)` model construction in supervisor.py/
  sub_agents.py MUST include this middleware too**, same standing as the
  thinking-repair/prompt-caching rules above — a retry storm is a
  generic failure mode of the ReAct tool-calling loop itself, not
  specific to any one agent's tools. Also best-effort updates
  `assistant/active_turns.py`'s in-flight-turn registry (see that
  module's own docstring for its one accepted scope gap) so the
  dashboard's `ActiveTurnBanner` can show "retrying X" WHILE it's still
  happening — the user's own separate, standing ask this addresses:
  never again be surprised by a process that had been silently running
  in the background. See STEPS.md 122 for the full incident, the fix,
  and the new cross-channel visibility feature this prompted.
- **Active-thread pointer, not a fixed `THREAD_ID` constant (superseded
  Phase 15, 2026-07-15):** every client previously shared one hardcoded
  `THREAD_ID = "cli-default-thread"`, which was fine until concurrent real
  usage collided badly enough to notice (STEPS.md 66 — a diagnostic call
  against the shared thread interleaved with the user's live GUI session
  and produced a confusing false "no delete access" symptom). Replaced by
  `assistant/thread_store.py`: a separate `threads.sqlite` file holding a
  thread registry plus a single-row active-pointer table clients read by
  default. `/chat` and `/resume` (server.py) accept an optional explicit
  `thread_id` that bypasses the pointer entirely — this explicit-id-with-
  pointer-fallback model is the actual fix, since it lets one client target
  a specific thread without mutating global state other concurrent clients
  still depend on. Per-run IDs generated with no registry would still
  silently defeat cross-session persistence, same reasoning as the
  original fixed-constant decision — the pointer model doesn't relax that,
  it just makes "which thread is the default" a stored, switchable fact
  instead of a hardcoded one. First-run bootstrap seeds the registry with
  `LEGACY_DEFAULT_THREAD_ID = "cli-default-thread"` (the exact old constant)
  as both the first registered thread and the initial active pointer, so a
  user who never touches the new thread commands keeps talking to exactly
  the `conversation_memory.sqlite` history they already had. Full thread
  management (list/rename/switch/create) lives in the dashboard's History
  panel; the CLI gets `--new` plus in-session `/new`, `/threads`, `/switch`
  commands; voice is reduced to two behaviors — continue the active thread
  (re-resolved every turn, not cached at daemon startup) or a fixed local
  trigger phrase ("start a new conversation") to start fresh, pattern-
  matched on the raw transcript before it reaches the graph, same
  fail-closed local-parsing posture as `parse_confirmation`.
- **Web search:** `TavilySearch` from `langchain-tavily`. Do not reintroduce the
  deprecated `TavilySearchResults` or `langchain-community`.
- **Tool errors are data, not exceptions:** failures (denylist rejections
  included) return as normal ToolMessages the model can read and explain —
  never raised exceptions that crash the graph.
- **`load_dotenv()` is called inside tools.py** (needs TAVILY_API_KEY at import
  time) as well as main.py. Idempotent; keep both.
- **CLI output stays non-streaming** (`main.py`'s `_render_content()`
  still guards against non-string `.content` shapes) — only the dashboard
  streams. Phase 14 (STEPS.md 71/72) added SSE streaming to
  `assistant/server.py`'s `/chat`/`/resume` specifically for the Tauri
  dashboard client; `main.py` still calls `graph.ainvoke()` directly and
  was deliberately left untouched — no request to stream the CLI. (Voice
  used to be in the same non-streaming category as the CLI, via its own
  `voice_daemon.py` process; since that daemon's 2026-08-06 retirement,
  voice lives inside the dashboard and goes through this same streaming
  `/chat` path like any other turn — see STEPS.md 123.)

## Security model — never weaken without explicit discussion

Threat model: web/email content + shell/file/side-effect tools = prompt
injection. Adversarial text arrives in context as tool results and can try to
induce harmful actions. Mitigation lives on the EXECUTION side, not in
filtering content.

- Shell: `shlex.split()` → argv list → `subprocess.run(shell=False)`. Never
  `shell=True`, never raw string execution.
- Denylist blocks: `rm`/`sudo`/`su`/`osascript`; shell interpreters invoked
  with `-c` (`bash -c` re-introduces full shell semantics even under
  shell=False); shell metacharacters (`| ; && $(` backtick) checked as
  SUBSTRINGS within tokens (shlex doesn't split on them — `ls&&rm` is one
  token); sensitive system paths, including common home-directory folders
  (Desktop/Documents/Downloads/Pictures/Movies) — this only catches literal
  path arguments, not paths a script computes at runtime, which is what the
  next bullet is for.
- **Shell confirmation gate:** `execute_shell_command` interrupts for
  confirmation when argv invokes a general-purpose interpreter
  (python/python3/node/perl/ruby) with inline code (`-c`/`-e`) — the one
  pattern where the code about to run was never written to a file first, so
  nothing in the conversation has been reviewable ahead of time. Running a
  *file* the agent already wrote via `write_file` (e.g. `python3 script.py`)
  stays ungated — that's this tool's core job, and denylists can't fully
  contain a general-purpose interpreter anyway (STEPS.md 32).
- File tools: confined to `workspace/` anchored at the project root (not cwd);
  traversal rejected via resolve-then-relative_to; dotfiles hard-blocked
  independent of the containment check.
- **Confirmation rule (standing):** side-effectful actions require my
  explicit confirmation before execution; read-only actions don't. Named
  explicitly as of Phase 12 (STEPS.md 63/64), since "email/calendar" stopped
  being a read-only-by-construction category: **sending an email**,
  **modifying Gmail labels on a message** (including archiving),
  **creating/updating/deleting a Google Calendar event**, **creating/
  deleting a Gmail filter**, and Mac control (`run_shortcut`). Every one of
  these is a LOCAL wrapper tool that calls `interrupt()` itself and shows the
  real content verbatim — see `assistant/write_tools.py`'s module docstring
  for why the gate can't sit on the raw Gmail/Calendar MCP tools directly
  (separate Node process, can't call `interrupt()`), and `sub_agents.py`'s
  `_select_life_admin_tools` for the actual enforcement point (raw write
  tool names are never added to a model's tool list — only their gated
  wrappers are). Email sends, calendar create/update, and Gmail filter
  writes are all additionally text-only, never voice-approvable
  (`server.py`'s phone-turn handler checks `voice_approvable: False` on the
  interrupt payload and auto-declines silently, since the phone's own
  Speak/Dictate round trip has no screen to show free-text content on —
  the Mac dashboard's in-app voice, since the 2026-08-06 daemon retirement,
  has no voice-answerable gate path at all, text-only or otherwise: every
  gate is click-only regardless of which channel the turn came from) —
  free-text content (an email body, an event description, a filter's
  forward target) is harder to vet by ear than an action verb like "send".
  The one deliberate exception is calendar event **delete**, which
  IS voice-approvable — it carries no free-text payload to hide an injection
  in, unlike every other gated action here (STEPS.md 63); Gmail filter
  delete does NOT get the same exception, since identifying which filter is
  being removed requires reading its forward-target/criteria content aloud
  (STEPS.md 64). **A separate, further exception:** `mac_tools.py`'s Apple
  Calendar `calendar_delete_event` (STEPS.md 146, 2026-08-25) is not just
  voice-approvable but fully **ungated** — no `interrupt()` at all, not in
  `GATED_ACTIONS` — a deliberate weakening made at my own direct request,
  same category of decision as `open_url_in_brave` (Phase 13) and
  `run_shortcut_on_phone` (Phase 21). This is a different tool from the
  Google Calendar delete described above, which stays gated (voice-
  approvable, not ungated).
  **Memory writes are a deliberate exception to the interrupt() mechanism
  (re-architected 2026-07-28, at my direct request):** durable long-term
  memory facts no longer go through a live, blocking interrupt() during the
  conversation. `assistant/memory_review_agent.py` runs once a day (a
  midnight background task in `server.py`, or an on-demand `POST
  /memory/review/run-now`) and queues candidate facts into
  `memory_store.py`'s `pending_facts` table; nothing becomes a real,
  recalled fact until I explicitly approve a card in the dashboard's Memory
  panel (`GET /memory/pending`, `POST /memory/pending/{id}/approve|
  decline`). The confirmation principle is unchanged — no durable write
  without my explicit approval — only WHERE that approval happens moved,
  from a synchronous chat-blocking gate to an async review queue. See
  `assistant/memory_extraction.py`'s module docstring for the full
  before/after reasoning, including the deliberate citation-verification
  scope cut this required.
- New tools (MCP-loaded included) are evaluated against this threat model
  before joining the agent. MCP tools MERGE into TOOLS; they never replace
  Phase 1's hand-secured tools.
- **Skill-vetting policy (Phase 11, 2026-07-14):** a Claude Code skill is
  instruction-bearing content loaded into agent context — the same threat
  model as any other untrusted input, not an exception to it. No skill is
  installed into this project without reading it first. High/Medium-risk-rated
  community skills are declined by default. Bulk/marketplace installs (e.g.
  `npx antigravity-awesome-skills`, or any tool that installs more than the
  skill(s) explicitly asked for) are never used — one skill install event
  brought in ~1,840 unreviewed third-party skills plus a High-Risk-rated
  browser-automation skill (`browser-use`) under "full agent permissions"
  before this policy existed; see STEPS.md for the cleanup. First-party
  (Anthropic/Claude-Code-team) skills are the default preference over
  community ones. Same standing as the rest of this security model — do not
  weaken without discussion.
- **`run_claude_code` is a named, bounded exception to this whole section
  (2026-08-06):** `assistant/claude_code_tool.py`'s `run_claude_code`
  (`coding_agent`'s own delegate for actual coding/file/shell work) runs a
  real, separate Claude Code CLI session (`claude --print
  --dangerously-skip-permissions`) rooted at `$HOME`, with none of this
  project's own denylists, workspace confinement, or `interrupt()` gates in
  the path — it can read, write, or delete anything reachable from `$HOME`
  and run any shell command, fully ungated. Chosen deliberately, not an
  oversight, because a `subprocess.run()` call has no way to answer one of
  Claude Code's own permission prompts anyway (it would just hang on
  stdin). See the module's own docstring for the full reasoning (including
  why it bills the Claude.ai subscription, not this project's Console API
  key) and its own explicitly-listed, not-yet-implemented hardening
  options (dropping `--dangerously-skip-permissions` for
  `--permission-mode`/`--allowedTools`, a disposable worktree instead of
  real `$HOME`, routing through `interrupt()`, a spend cap, narrower
  `--add-dir` scoping).

## Tech stack

- Python 3.12 venv at `.venv` — deliberate choice for broadest wheel coverage
  ahead of Phase 5's audio deps; `requires-python = ">=3.11"` in pyproject.
  Package installed editable (`pip install -e .`).
- LangGraph + LangChain (1.x line); `langchain-mcp-adapters` from Phase 2 on.
- Anthropic SDK — Claude API (pay-per-token via Console account), NOT the
  Pro/Max subscription.
- Memory: SQLite via `langgraph-checkpoint-sqlite` (conversation state,
  `conversation_memory.sqlite`, memory.py) plus, as of Phase 7 Part B, a
  SEPARATE plain SQLite table for durable cross-conversation facts
  (`long_term_memory.sqlite`, memory_store.py — deliberately not sharing
  the checkpointer's own file/schema, now also holding `pending_facts` and
  a per-thread `review_cursor`, both added 2026-07-28). This reverses the
  earlier "long-term/vector memory is out of scope" line: it's now in
  scope, and deliberately NOT a vector store — Chroma was considered and
  rejected at Phase 7's scope-time checkpoint in favor of plain
  keyword/recency retrieval, since a single user's fact count is expected
  to stay small enough that embedding-based recall would be premature
  complexity: revisit if that assumption stops holding.
  `memory_store.recall_facts`'s keyword-scored selective retrieval (never a
  full context dump) is still exactly as described — it's just no longer
  what `recall_memory_node` calls. As of 2026-07-28, recall
  (`memory_extraction.recall_memory_node`) fires only on a thread's first
  genuine turn (`_is_first_genuine_turn`) rather than being re-injected on
  every single message — repeating the same known-facts block on every turn
  was pure duplication once the assistant had already seen it earlier in
  the same thread, at my direct request. That first-turn call loads the
  FULL profile (`memory_store.list_facts`), not the keyword-scored
  `recall_facts` — a real bug found live the same day: a thread's opening
  message is very often a low-content greeting ("hi") sharing no keyword
  with anything in the store once it grows past `recall_facts`' own
  small-store threshold, so keyword-scoring the opener silently recalled
  nothing even with directly relevant facts present (a real live
  reproduction: asking to text a saved contact right after "hi" opened the
  thread got zero memory context — mac_control_agent had no way to know the
  contact's number). Since this now runs once per thread instead of once
  per turn, the cost concern `recall_facts`' own filtering exists for is
  far smaller here. `assistant/supervisor.py`'s `_context_prefix_messages`
  (which forwards recalled facts into an isolated specialist call) needed
  a matching fix the same day: it used to only forward a recalled-facts
  message found within the CURRENT top-level turn's own slice, correct back
  when recall re-ran every turn but silently starving every specialist call
  past a thread's first turn once recall stopped doing that — it now
  searches the whole thread's history instead, since there is at most one
  recalled-facts message per thread now.
  **Extraction is no longer per-turn or agent-initiated-mid-conversation
  (re-architected 2026-07-28, superseding the original "automatic-write"
  description):** `assistant/memory_review_agent.py` runs once a day
  instead, scanning every thread's genuine human turns since its own
  last-scanned cursor and queuing 0+ candidates into `pending_facts` for me
  to approve/decline in the Memory panel — see the Security model section's
  Confirmation rule bullet for the full reasoning and what this changed vs.
  what stayed the same. See memory_extraction.py's module docstring for the
  full security design (source-restriction, isolated extraction channel) —
  this is the load-bearing part of Part B, not an implementation detail; do
  not weaken it without discussion, same standing as the Security model
  section below.
- Packaging: pyproject.toml is the source of truth (provides the `assistant`
  console script); requirements.txt is a flat mirror. Keep both in sync.
- **`assistant/cost_cache.py`** (added 2026-08-08/09, previously undocumented
  here): a small flat-JSON durable fallback for `/cost` (server.py) —
  Langfuse's own metrics API rate-limits at 100 requests/window, and this
  persists the last real per-window figures (today/week/all_time) plus one
  rate-limit record to `cost_cache.json` (gitignored) so a request seconds
  after a backend restart (which `--reload` triggers constantly in dev)
  still has real history to fall back on instead of showing a bare error.
  Deliberately a flat file, not a new SQLite store — holds exactly one
  small object, queried by nothing else, never grows. Writes go through a
  temp-file-then-`os.replace()` atomic swap (fixes crash-mid-write
  corruption); the separate lost-update race between two concurrent writes
  is a known, accepted, best-effort gap, not fixed.

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

## Conventions

- Type hints on signatures; docstrings on public functions/classes.
- Separate modules for agent/tool/graph/CLI (as scaffolded) so Phase 3's
  multi-agent split doesn't force a rewrite.
- Secrets: `.env` (gitignored) holds real values; `.env.example` (committed)
  holds placeholders ONLY — real keys landed in .env.example once before
  (STEPS.md 5.1), so check which file you're writing to. OAuth credential and
  token files are gitignored the moment they exist; verify with
  `git check-ignore`. Current keys: ANTHROPIC_API_KEY, TAVILY_API_KEY,
  LANGSMITH_API_KEY.
- A README exists from the end of Phase 2 onward and is refreshed at each
  phase completion.

## Cost

The Claude API is pay-per-token, separate from any Pro/Max subscription.
Default to Haiku where Sonnet-level reasoning isn't needed. Flag the token/cost
impact of any design choice that could get expensive (long system prompts on
every call, verbose tool outputs fed back into context, unnecessary agent
loops). Anything that runs unattended (Phase 6 scheduled tasks) requires a
confirmed Console spend cap and a per-run/per-month cost estimate BEFORE it is
scheduled.

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
