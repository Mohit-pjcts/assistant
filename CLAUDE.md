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
  SSE path via `astream_events`) — the CLI/voice daemon's non-streaming
  `ainvoke()` was never at risk either way. Rather than disable thinking
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
  dashboard client; `main.py`/`voice_daemon.py` still call
  `graph.ainvoke()` directly and were deliberately left untouched — no
  request to stream the CLI or voice output, and streaming voice output
  would need mid-utterance TTS chunking that's out of scope here.

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
  (`voice_daemon.py` checks `voice_approvable: False` on the interrupt
  payload) — free-text content (an email body, an event description, a
  filter's forward target) is harder to vet by ear than an action verb like
  "send". The one deliberate exception is calendar event **delete**, which
  IS voice-approvable — it carries no free-text payload to hide an injection
  in, unlike every other gated action here (STEPS.md 63); Gmail filter
  delete does NOT get the same exception, since identifying which filter is
  being removed requires reading its forward-target/criteria content aloud
  (STEPS.md 64).
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
