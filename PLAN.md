# Project Plan — Personal AI Assistant

Companion to CLAUDE.md: rules live there, the ten phase plans live here. Work
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

## Phase 5 — Voice I/O — COMPLETE (2026-07-13)

**Objective:** speak to the assistant and hear it answer; the text CLI stays
fully intact.

**Delivered (two passes in one day):** v1 — a terminal push-to-talk CLI
(`voice_main.py`, calibrated raw-stdin trigger) proving the pipeline:
faster-whisper STT running locally (`base` model, CPU int8; wheels verified
on the 3.12 arm64 venv before committing — the reason the venv is 3.12),
`say` TTS, the SAME `graph.ainvoke()` path and THREAD_ID as the text CLI so
voice and text share one conversation, and the Phase 3/4 confirmation gate
answered by voice with fail-closed parsing (`parse_confirmation`: only a
recognized yes approves; no-words win when both appear; silence/ambiguity
declines). Then v2, after real use exposed v1's limits (STEPS.md 40) —
`assistant/voice_daemon.py`, an always-on menu bar daemon replacing the
terminal CLI entirely: global Option+Return hotkey via pynput (works from
any app; ~0.4s debounce; non-suppressing listener — the keystroke still
reaches the frontmost app, accepted tradeoff), rumps menu bar state
(🎙/🔴/💭, all AppKit mutation marshaled to the main thread via
AppHelper.callAfter), humanized spoken confirmations (`spoken_prompt` on
all three gated tools' interrupt payloads, raw-payload fallback for future
tools that forget it) with auto-record + one-press answers and a 30s
fail-closed timeout, configurable Enhanced/Premium TTS voice
(ASSISTANT_TTS_VOICE) with installed-check fallback, audio cues, a
self-rotating audit log of transcripts and confirmation outcomes at
~/Library/Logs/PersonalAssistant/, and a launchd LaunchAgent
(`launchd/*.plist`) for start-at-login. The launchd install surfaced a
real TCC saga worth knowing about — two distinct Python executables in the
venv's exec chain each needed Full Disk Access + Input Monitoring, granted
by path (STEPS.md 42). Full record: STEPS.md groups 37–43.

**Scope notes:** step 5's wake word remains unbuilt (stretch, explicitly
deferred — push-to-talk-from-anywhere covers the daily need). All four TCC
grants pin to the versioned Homebrew Cellar path; a `brew upgrade
python@3.12` silently kills the daemon until re-granted — the durable fix
(a stable `.app` bundle) is queued in Phase 6 step 3.

**Done-when (all met):** push-to-talk → transcription → agent → spoken
response works end-to-end ✓ — verified from other applications via the
launchd-spawned daemon, not just a terminal; the text CLI is unchanged ✓
(main.py zero diff across both passes); latency acceptable in real use ✓
(STT model preloaded at startup so first-utterance cost isn't paid
per-turn). Outstanding, non-blocking: one logout/login RunAtLoad check
(standard launchd behavior; user confirming later).

---

## Phase 6 — Fix cross-agent handoff routing — COMPLETE (2026-07-14)

**Objective:** the supervisor can chain a multi-step request across more than
one sub-agent in a single turn — run sub-agent A, take its output back to the
supervisor, route to sub-agent B — and finish. Today it can't: the first
sub-agent runs and the turn stalls.

**Why this was a phase, not a nicety:** this was a correctness bug in Phase
3's architecture, latent since it was built because every request tried
until now was single-hop. Repro (2026-07-13): "get the ingredients to make
alfredo pasta and send a list to my Notes app" — routed to `research_agent`
correctly, got the ingredients, then did NOT return to the supervisor to
route the note-creation step to `mac_control_agent`.

**Diagnosis (step 1, STEPS.md 47):** confirmed the working hypothesis —
`Command(graph=Command.PARENT)` routes control *down* from supervisor to
sub-agent but nothing routed it *back up* (every sub-agent edge went
straight to END). State was fine: sub-agent output already merged correctly
into outer state, disconfirming that half of the original hypothesis.

**Delivered:** design CHECKPOINT picked option (a) — sub-agents loop back to
a re-evaluating supervisor via a new `route_after_specialist` node, capped
by `MAX_HANDOFFS_PER_TURN` (STEPS.md 47/48). Building it surfaced a live API
constraint immediately — re-invoking the supervisor on history ending in an
AIMessage 400s as an unsupported prefill on Sonnet 5 — fixed with a synthetic
bridging HumanMessage. Verified against fresh threads (the alfredo→Notes
chain, plus a second research→coding chain) and against the interrupt
confirmation gate mid-chain (still fires correctly, no orphaned tool calls).

A second, more serious bug was found only by testing against the REAL
persistent `conversation_memory.sqlite` thread (99 messages of real use):
`_count_handoffs` summed handoffs across the thread's ENTIRE lifetime, not
just the current turn — since `THREAD_ID` is fixed and persists forever, any
thread with enough accumulated history would hit the cap and silently
defeat the loop-back fix from turn two onward. Fixed by scoping the count to
messages since the most recent genuine user turn; verified by seeding a
thread with 3× the cap's worth of fake past handoffs and confirming a new
multi-hop request still completes. 9 tests now in `tests/test_supervisor.py`
(was 2), including a structural graph-topology guard against the exact bug
this phase fixed.

**Known, deferred issue (see Phase 7's checkpoint below):** a third bug was
found and reproduced — sub-agents see the ENTIRE shared message history, not
a view scoped to their own tools, so a sub-agent can occasionally hallucinate
a `transfer_to_*` tool call it doesn't have after seeing another turn use one.
Verified this does NOT break end-to-end correctness (the outer loop recovers
either way — confirmed across multiple full-graph runs), so it's a cost/
quality issue, not the correctness bug this phase was scoped to fix. A real
fix means scoping each sub-agent's visible history, which touches Phase 3's
"no manual state-transform shim" design and belongs alongside Phase 7's
context-management work rather than as a Phase 6 afterthought.

**Done-when (all met):** the alfredo→Notes chain and a second, different
multi-hop chain (research→coding, writing a real file) complete end-to-end
✓; the confirmation gate still fires correctly through the new routing ✓; a
loop cap exists, is scoped correctly (see above), and is tested ✓; all prior
tests pass plus new multi-hop/routing tests ✓; STEPS.md updated (47, 48) ✓.

---

## Phase 7 — Memory: short-term compaction + long-term facts — COMPLETE (2026-07-14)

**Objective:** the assistant stops resending the entire conversation history
every turn (short-term), and remembers durable facts about me across
conversations the way Claude's own memory does (long-term). One phase,
sequenced internally: short-term FIRST (it fixed a live cost/latency
problem), long-term second (bigger design surface, security question
attached).

**Why now / why urgent:** the fixed-THREAD_ID design (Phase 1) means one
ever-growing thread. With voice added, real use was resending a large and
growing history into every single call — the direct, measured cause of the
"everything gets sent as context, it's slow and expensive" problem observed
2026-07-13. Real LangSmith trace data pulled at scope time (2026-07-12/13
usage): per-call prompt tokens median 4,384 / mean 4,928 / max 13,027; one
full multi-agent turn hit 40,041 cumulative prompt tokens.

**Reverses a standing decision:** CLAUDE.md previously said vector/long-term
memory was explicitly out of scope. This phase overturned that deliberately
— CLAUDE.md's Tech Stack and standing confirmation rule were updated as part
of the phase, not quietly contradicted (see STEPS.md 51.3's CLAUDE.md diff).

### Part A — Short-term (conversation compaction) — delivered

**Bundled with the Phase 6 leakage checkpoint** (STEPS.md 48: sub-agents
were invoked with the outer graph's ENTIRE shared history, causing
`research_agent` to hallucinate a `transfer_to_coding_agent` call after
seeing an earlier turn's supervisor use that name) rather than split into a
separate phase — both are the same category of change (what context
reaches which model). Budget locked at scope time: self-imposed 50,000-token
ceiling, trigger at 60% (30,000 tokens), sized against the real trace
numbers above.

**Delivered** (`assistant/compaction.py`, `assistant/sub_agents.py`,
`assistant/supervisor.py`; full detail STEPS.md 50): a plain top-level graph
node (`compact_history_node`) — NOT `create_agent`-embedded, after a spike
proved a nested-subgraph `SummarizationMiddleware` silently fails to shrink
the shared outer state at all (grew 13→15 messages instead of shrinking,
since a subgraph's own internal `RemoveMessage` resolution never crosses
back to the parent's reducer as an explicit removal). Fires on a genuine
turn-boundary-safe split only, summarizing with Haiku. Leakage fix:
`SubAgentWindowMiddleware`, a `wrap_model_call`-family middleware (verified
NOT to mutate shared state, unlike the compaction approach) that windows
each sub-agent's own model call to the CURRENT top-level turn — the first
version anchored on "this agent's own handoff" specifically and, caught by
live end-to-end testing, both orphaned a tool_use/tool_result pair AND
over-corrected by cutting a second specialist's context off a genuine
multi-hop chain within the same turn; corrected to turn-boundary windowing.

**Verified:** 58.2% token reduction on a realistic oversized synthetic
thread (35,945→15,016 tokens); a real research_agent→coding_agent
multi-hop chain completes end-to-end with zero orphaned tool_use blocks;
69 tests (61 prior unchanged + 8 new).

### Part B — Long-term (durable facts about me) — delivered

**Write model: AUTOMATIC** (agent decides what's worth saving) — user's
choice, 2026-07-13, which carried a real security question, resolved at a
CHECKPOINT (STEPS.md 50.1/50.2) before any auto-write code was built: an
automatic memory writer reads conversation content including tool results
(email bodies, web pages), so a prompt-injected "remember X" could become a
DURABLE fact — turning a single-turn injection into a persistent one.

**Security design, locked after an Opus red-team pass** found real gaps in
the first proposal (STEPS.md 50.2 has the full finding-by-finding
breakdown) — layered as: (A) source restriction — extraction reads ONLY the
genuine user's own current-turn text; (B) isolated extraction channel — a
separate cheap (Haiku) call constructed without tool content in scope, not
merely instructed to ignore it; (D) scoped, hardened tool-content opt-in —
a cited fact is only ever backed by a REAL tool result found independently
in the current turn, never the extraction model's own unverifiable claim,
and an uncited claim is refused outright rather than silently saved without
its citation; (C) confirmation gate — every write goes through the same
`interrupt()` mechanism as every other side effect, text-only (never
voice-approvable — new `voice_approvable` gate added to `voice_daemon.py`),
with the exact confirmed string persisted verbatim (no re-extraction
after approval); plus a `MAX_MEMORY_WRITES_PER_TURN` rate cap and
recall framed as data ("known facts..."), never as directives, so even a
false memory that slipped through still can't trigger an unconfirmed
action. One documented, accepted residual risk: an earlier injection-shaped
assistant turn can still socially engineer a later genuinely-user-authored
message — no source restriction closes that; it's a general injection
property, not specific to memory.

**Storage:** plain SQLite (`assistant/memory_store.py`, a separate file
from the checkpointer's own DB), not Chroma — confirmed at scope time
rather than defaulting to the Phase 1 mention: a single user's fact count is
expected to stay small enough that an embedding-based vector store is
premature complexity. Selective keyword/recency recall, not dump-everything.

**Delivered:** `assistant/memory_store.py` (storage/recall, new),
`assistant/memory_extraction.py` (the full locked design, new),
`voice_daemon.py`'s text-only gate, `supervisor.py`'s `recall_memory` +
`extract_memory` nodes wired onto every turn-ending path. Two real bugs
caught before landing (full detail STEPS.md 51.1/51.2): a parameter-default
late-binding bug that silently defeated a test's DB redirect (root-caused
after it produced a real stray file with duplicate rows); and a duplicate-
save bug from LangGraph's node-replay-on-resume semantics — code between
two `interrupt()` calls in one node re-executes on every subsequent resume
— caught with a minimal debug script before it reached the test suite, and
fixed by deferring all persistence to a pass that only runs once fully
resolved.

**Verified, live:** a real extraction correctly proposed durable facts from
a genuine preference statement while correctly skipping a one-time
question in the same turn; confirmed facts persisted and were recalled
correctly on a later turn through the full graph; the source-restriction
boundary is proven structurally (tool content is deterministically absent
from what reaches the extraction model, not just behaviorally tested against
today's model). 81/81 tests total (12 new for Part B).

**Voice wiring** (the "connect voice to memory" item from 2026-07-13):
achieved for free — voice uses the same graph, so it inherits compaction
and recall automatically; the only voice-specific change needed was the
new text-only confirmation gate for memory writes specifically.

**Done-when (all met):** per-call history size is bounded (compaction
demonstrably fires and measurably reduces tokens sent) while recent-turn
continuity still works ✓; durable facts persist across separate
conversations and are recalled selectively ✓; a prompt-injected "remember
X" from tool-result content is demonstrably NOT persisted — proven
structurally via source restriction, not just behaviorally ✓; CLAUDE.md's
out-of-scope note updated ✓; STEPS.md updated (groups 50–51) ✓.

---

## Phase 8 — Voice upgrade (accuracy + latency) — COMPLETE (2026-07-14)

**Objective:** fix the two real complaints with Phase 5's voice — it's slow and
it sometimes mishears — now that the hardware ceiling is known to be high.

**De-risked by hardware:** the machine is an M4 Pro / 24GB (confirmed
2026-07-13). On weaker Apple Silicon accuracy and latency trade against each
other; on an M4 Pro they largely don't — a large model can run fast. This is
close to "swap backend, bump model, benchmark," not a research slog.

**Delivered:** a real four-way benchmark on this machine (STEPS.md 52) —
`faster-whisper base` (prior production model), `faster-whisper large-v3`,
`faster-whisper distil-large-v3`, and `mlx-whisper large-v3` — against 3 real
clips of the user's own voice (clear, harder vocabulary, deliberate
background noise), scored with `jiwer` against known ground truth. Backend
swapped to `mlx-whisper large-v3` in `assistant/voice_io.py` (STEPS.md 53),
behind the exact same `preload_stt_model()`/`transcribe()` seam
`voice_daemon.py` already used — confirming Phase 5's isolation held, zero
daemon changes needed. `requirements.txt`/`pyproject.toml` updated
(faster-whisper removed, mlx-whisper added with an arm64-only platform
marker — Apple MLX ships no Intel/Linux wheels).

**CHECKPOINT result:** user picked `mlx-whisper large-v3` on the latency
evidence (6-8x faster than `faster-whisper large-v3` on CPU, near-`base`
speed) plus the accuracy-ceiling argument (same weights as `large-v3`, just a
faster runtime) — NOT on a proven WER win, which the benchmark didn't show
(see caveat below).

**Verified, live, on the real launchd daemon** (STEPS.md 53) — restarted to
pick up the new code, not just unit-tested: model preload at startup, a real
hotkey→record→transcribe→respond round trip (including an accidental 185s
capture, transcribed correctly in ~4.5s), Phase 7's text-only memory gate
still correctly declining voice approval after a live mishearing ("window
seats" → "Windows Eats"), and a real gated Mac-control action's full
spoken confirm→approve→execute cycle. Text CLI (`main.py`/`agent.py`)
confirmed untouched via `git diff --stat`. 81/81 tests pass (1 test updated
for the new backend, count unchanged).

**Known caveat — one done-when criterion not literally met, accepted
knowingly:** the benchmark's WER was TIED across all four candidates
(including `base`) on the 3-clip sample — it does NOT demonstrate an
accuracy improvement, the phase's original bar. Root-caused rather than
ignored: all four models dropped/garbled the same leading words after the
recording's beep cue, a shared artifact, not a per-model differentiator;
n=3 clips/one session is too small to conclude model size doesn't matter for
accuracy either way. The user chose to proceed on `large-v3`'s known-larger
capacity as the reasonable bet for real-world accented/noisy speech this
small sample didn't exercise, rather than block the phase on a bigger
benchmark pass. Real-world daily use is the actual accuracy test going
forward, not this session's synthetic sample.

**Steps:**
1. Benchmark candidates on THIS machine with real utterances (include accented
   speech and some background noise): accuracy and end-to-end latency for
   mlx-whisper large-v3 vs faster-whisper large-v3 vs distil-large-v3 vs
   current base. Present numbers. CHECKPOINT: pick based on measured results.
2. Swap the STT backend/model in `voice_daemon.py` behind the existing
   interface (STT is already isolated from the graph — keep it that way).
   Mind the model-preload-at-startup behavior (Phase 5) so first-utterance
   latency stays paid once, not per turn.
3. Re-verify the full voice path end-to-end (daemon, hotkey, spoken
   confirmation gate) still works with the new backend; the text CLI stays
   untouched.

**Done-when (met, with the accuracy caveat above):** measured transcription
accuracy on real accented/noisy speech improves over base — **not proven by
this sample (tied, not improved); accepted knowingly rather than blocking**
✓*; end-to-end latency is acceptable (near-`base`, decisively better than any
other large-model option) ✓; the daemon + hotkey + spoken confirmation gate
all still work — verified live on the real launchd daemon, not just unit
tests ✓; text CLI unchanged ✓; STEPS.md updated with the benchmark numbers
✓ (groups 52-53).

---

## Phase 9 — Dashboard app — IN PROGRESS (scoping checkpoint locked 2026-07-14)

**Objective:** a desktop app with a dashboard for the assistant — live chat,
conversation history, and token/cost tracking. Voice I/O moving into the app
is now a LATER pass within this phase, not this pass (see Decision 3 below) —
`voice_daemon.py` keeps running unchanged for now.

**Architectural fork, decided at planning, CONFIRMED at the scoping
checkpoint:** the app is a CLIENT of the existing Python graph, it does NOT
replace it. (Note the Phase 6/7 caveat: the graph the app drives must be the
fixed, compacted, memory-enabled one — this is why the app comes after those
phases, so panels have real data to show and the graph behaves.)

**Scoping checkpoint decisions (STEPS.md 54 has full reasoning for each):**
1. **Desktop shell: Tauri** (not Electron) — smaller bundle/footprint,
   modern portfolio signal; accepted tradeoff is a small added Rust surface.
2. **Transport: a thin custom FastAPI wrapper (`assistant/server.py`), NOT
   the `langgraph dev` REST API.** This REVERSES the original plan below —
   checked at the checkpoint and found `langgraph dev`'s persistence
   (`.langgraph_api/*.pckl`) is a separate, ephemeral store from
   `conversation_memory.sqlite`, so the app would NOT share the CLI/voice
   daemon's actual conversation, and the History panel would have nothing
   real to read. The wrapper instead calls `build_graph()` directly with the
   same `AsyncSqliteSaver`/fixed `THREAD_ID` main.py already uses.
   `langgraph.json`/`studio.py`/`langgraph dev` are unchanged and kept for
   Studio's dev-time graph debugger — just not what the shipped app depends
   on.
3. **Voice sequencing: deferred** to a later pass/checkpoint within this
   phase, not built alongside the initial panels — avoids stacking two new
   integration surfaces (custom transport + first GUI interrupt affordance,
   and mic/hotkey/playback-in-app) at once, on top of the gate being
   security-critical.

**Interrupt-gate UI (load-bearing, carried forward from Phase 7):** the
wrapper passes each gated tool's raw interrupt payload through unmodified.
For memory writes (`voice_approvable: False`), the app UI must show the
`fact` string verbatim (no re-summary) and must not offer voice approval for
that gate specifically — same requirement `voice_daemon.py` already enforces.
Treat this as its own verification item, not a detail of the chat panel.

**Stack:** shadcn/ui for the frontend (matches the user's React background;
low-effort polish). Panel-inventory reality check (STEPS.md 54, corrects the
original "half-built" framing below): History needs real parsing work
(`graph.aget_state()`, not a flat table); Cost/tokens needs NEW LangSmith
retrieval code (nothing queries it today, `langsmith` SDK is only a
transitive dependency so far); Memory is the one actually close to
half-built (`memory_store.py` has save/list/recall already, needs a new
`delete_fact()` — a user-curation action, not an agent side effect, so no
interrupt gate needed for it).

**Steps (locked at the scoping checkpoint; supersedes the original list
below):**
1. **DONE (STEPS.md 55).** `assistant/server.py` (backend wrapper) —
   `/chat`, `/resume`, `/history`, `/memory/facts` (list + delete). 87/87
   tests pass, verified against the real graph over the shared
   `conversation_memory.sqlite` thread.
2. **DONE (STEPS.md 56).** Tauri + React + shadcn/ui scaffold
   (`dashboard/`), Rust toolchain installed. Both halves verified to
   compile (`npm run build`, `cargo check`) — actually launching `npm run
   tauri dev` and confirming a real window is a flagged user action, not
   done in this session (no way to visually verify a GUI from here).
3. **DONE (STEPS.md 57).** Chat panel wired to `/chat`/`/resume`, including
   the interrupt-gate UI affordance — verified against a real gated tool
   (approve/decline) and specifically against a memory-write interrupt
   (byte-for-byte verbatim `fact` text, no voice affordance). Also added,
   found live rather than planned: `/history`'s `synthetic` flag, so
   graph-inserted routing-bridge/recalled-facts/compaction-summary messages
   never render as if the real user typed them. Real window confirmed
   working by the user (STEPS.md 57 follow-up). Not yet done: the Tauri
   shell doesn't spawn/own the Python backend's process lifecycle yet
   (started by hand).
4. **DONE (STEPS.md 58).** History panel wired to `/history` — the
   deliberate opposite of the chat panel: shows every message (tool/system/
   empty-content/synthetic), labeled with role, the message's `name` (which
   tool ran, or which agent node responded — found live, not planned:
   `name` turned out to matter for assistant messages too, not just tool
   ones), and an "internal" badge for synthetic entries. Manual refresh,
   no polling.
5. **DONE (STEPS.md 59).** Memory panel wired to `/memory/facts` (view +
   delete). No backend changes needed — those endpoints and their real-graph
   test coverage already existed from step 1. Deletion requires an explicit
   confirm dialog (client-side UX safeguard against a stray click) but is
   deliberately NOT behind the interrupt gate — that gate is for the agent's
   own autonomous writes, not user curation of already-saved data.
6. Cost/token panel — new LangSmith retrieval code behind a new endpoint;
   scope the query/aggregation shape at this step, not assumed up front.
7. CHECKPOINT (separate from this phase's initial done-when): voice-in-app
   sequencing — only after 1–6 are stable; retire `voice_daemon.py` only once
   real parity is confirmed.

**Done-when (initial pass, i.e. steps 1–6 — voice-in-app is its own later
done-when per step 7):** the app runs as a desktop client of the local graph
sharing the CLI/voice daemon's actual conversation thread; chat, history,
memory, and cost panels all work against real data; the confirmation gate has
a real, verified UI affordance including the memory-write verbatim/no-voice
requirement; STEPS.md updated.

<details>
<summary>Original pre-checkpoint plan (superseded 2026-07-14 by the scoping
checkpoint above — kept for the record, not current)</summary>

The `langgraph dev` server (STEPS.md 27) already exposes the graph over
HTTP/REST — that is the seam the app talks to. This also cleanly retires the
Python voice daemon: the app owns mic/hotkey/playback and calls the graph
server. Two of the three panels are already half-built by earlier phases:
history reads the SQLite the graph already writes; cost/tokens come from
LangSmith traces (Phase 3) which carry token counts. Memory (Phase 7) becomes
a fourth natural panel — "what the assistant knows about me."

1. CHECKPOINT: desktop shell choice (Tauri/Electron), and confirm the
   app→graph transport (the langgraph dev REST API, or a thin wrapper over it).
2. Core chat panel talking to the graph server; verify parity with the CLI
   (same graph, same memory, same confirmation gate — the gate now needs a UI
   affordance, not a terminal y/n).
3. History panel reading persisted conversation state.
4. Cost/token panel from LangSmith trace data.
5. Move voice into the app (mic + hotkey + playback as an app responsibility);
   retire `voice_daemon.py` once parity is confirmed.
6. (If Phase 7 done) memory panel.

</details>

---

## Phase 10 — Proactivity + polish — NOT STARTED

*(This was the original Phase 6, renumbered when the handoff-fix / memory /
voice-upgrade / dashboard work was inserted ahead of it on 2026-07-13. Content
unchanged except where Phase 5 v2 already settled a step.)*

**Objective:** the assistant does something useful unprompted, and the repo
is portfolio-finished.

**Steps:**
1. Morning briefing: a separate entry point (e.g. `assistant.briefing`) that
   runs one agent turn — today's calendar + unread email summary — delivered
   via notification/`say`/terminal (or the Phase 9 app, if it exists by now);
   scheduled with launchd.
2. Unattended-cost gate BEFORE scheduling anything: estimate per-run and
   per-month token cost; confirm the Console spend cap is set. CHECKPOINT:
   nothing runs on a schedule without the user's sign-off on both.
3. Interface hardening — SETTLED by Phase 5 v2 (it's a rumps menu bar app plus
   global hotkey): wrap the daemon in a stable `.app` bundle so the four TCC
   grants (STEPS.md 42) attach to a bundle ID instead of a versioned Homebrew
   Cellar path that `brew upgrade python@3.12` silently invalidates. (If Phase
   9 moved voice into the app, this may be moot — reconcile at scope time.)
4. Repo polish: README refresh (architecture diagram, demo GIF), pytest
   adoption for the existing test files, optional GitHub Actions to run the
   suite.
5. Revisit the globally-disabled extended thinking (STEPS.md 28): turned off
   everywhere to work around a `langchain-anthropic` 1.4.8 SSE-merging bug that
   only manifested in Studio's streaming UI — the CLI's non-streaming
   `ainvoke()` was never at risk, so it's been paying lost reasoning depth for
   a bug it never hits. Check for a fixed release past 1.4.8; if present,
   re-enable (adaptive/default, matching STEPS.md 8.2) and confirm Studio no
   longer reproduces the `BadRequestError`. Explicit decision either way — don't
   let the disable become permanent by default.
6. Final cost review: measure real daily spend from traces/Console; adjust
   model assignments if needed. Includes the Haiku evaluation deferred from
   Phase 3 step 3 (STEPS.md 24/25): `research_agent` is the best candidate —
   decide using real LangSmith trace data.

**Done-when:** the briefing fires on schedule for a week without intervention;
the spend cap is verified; the README and repo are presentable enough to send
to a recruiter without a warning attached.
