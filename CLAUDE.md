# Project: Personal AI Assistant

## Goal

A general-purpose personal assistant, built on the Claude API + LangGraph: coding
help, research, life admin (email/calendar), Mac-native control, and voice
interaction. Personal project, published on GitHub — code quality, structure, and
the README matter. Treat it as a portfolio piece. The package is named `assistant`
(not "Jarvis" — deliberate).

## How to use this file (every session)

1. Read the Current Status block below.
2. Open `PLAN.md` and read the ACTIVE phase's plan before doing any work.
   Do not build ahead of the active phase.
3. When all of the active phase's done-when criteria are met, say so explicitly
   and propose: the status update here, the status flip in PLAN.md, and a commit
   boundary (see Git rules). Status edits happen only with my approval.
4. Log work in `STEPS.md` as you go (see Build log section).

## Current Status

- **No active phase** — Phase 12 (Email + Google Calendar WRITE access) is
  next; read PLAN.md before beginning it.
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
- **PARKED: Phase 10** — proactivity + polish, parked 2026-07-14 to run the
  write-access/browser/UI arc; its deferred-debt checklist is recorded in
  PLAN.md's Phase 10 park note (voice accuracy, extended-thinking re-enable,
  Haiku eval, backend lifecycle, README/pytest/CI, the briefing itself).
- Complete: Phase 11 — skills cleanup + vetting policy: removed the
  High-Risk `browser-use` skill, the ~1,840-skill `antigravity-awesome-skills`
  bulk install, and the full `anthropics/skills` clone; kept only
  `frontend-design` and `find-skills`; confirmed no skill artifacts in git
  history or settings; standing vetting policy added to the Security model
  section below (STEPS.md group 62).

Roadmap history: renumbered 2026-07-13 (handoff-fix/memory/voice-upgrade/
dashboard inserted ahead of the original polish phase). On 2026-07-14 Phase
10 was parked and Phases 11–14 added: 11 skills-cleanup, 12 email+calendar
WRITE, 13 Apple Calendar + open-URL-in-Brave, 14 UI rework. See PLAN.md.

This block is the only part of this file that changes routinely; everything
below is durable.

## Architecture (as built - through phase 9)

```
assistant/
├── main.py               # CLI loop; owns checkpointer lifetime; fixed THREAD_ID
├── agent.py               # shared invocation-config helper (make_thread_config); graph
│                             construction itself lives in supervisor.py/sub_agents.py (Phase 3)
├── supervisor.py          # supervisor + outer StateGraph assembly; Command handoff routing
├── sub_agents.py          # coding/research/life-admin worker sub-agent graphs
├── tools.py               # Phase 1 hand-secured tools: web search (Tavily), file r/w, shell exec
├── mcp_tools.py           # Phase 2+ MCP-loaded tools (Gmail/Calendar), merged into TOOLS
├── mac_tools.py           # Mac-native control: osascript/open/shortcuts behind a hard allowlist
├── interrupts.py          # confirmation-gated dummy tool demonstrating the interrupt mechanic
├── memory.py              # get_checkpointer() context manager over AsyncSqliteSaver
│                             (conversation_memory.sqlite)
├── compaction.py          # Phase 7 Part A: short-term context compaction
├── memory_store.py        # Phase 7 Part B: durable cross-conversation facts storage
│                             (long_term_memory.sqlite, separate from the checkpointer's file)
├── memory_extraction.py   # Phase 7 Part B: extraction, confirmation gate, recall — see its
│                             module docstring for the full security design
├── voice_io.py            # Phase 5/8: mic capture, local STT (mlx-whisper), TTS (`say`)
├── voice_daemon.py        # Phase 5: always-on Option+Return hotkey daemon (menu bar app)
├── server.py              # Phase 9: FastAPI wrapper over build_graph() for the dashboard app
│                             (/chat, /resume, /history, /memory/facts, /cost) — shares the
│                             CLI/voice daemon's real checkpointer + THREAD_ID, NOT the
│                             separate `langgraph dev` ephemeral store
└── studio.py              # LangGraph Studio / `langgraph dev` entry point (dev-time graph
                              debugger only; checkpointer=None, unrelated to server.py)

dashboard/                 # Phase 9: Tauri 2 + React + TypeScript + shadcn/ui desktop app
├── src/
│   ├── App.tsx             # tab shell (chat/history/memory/cost)
│   ├── lib/api.ts          # typed client for assistant/server.py's endpoints
│   └── components/
│       ├── chat/           # ChatPanel + InterruptGate (confirmation-gate UI affordance)
│       ├── history/        # HistoryPanel — full unfiltered /history feed
│       ├── memory/         # MemoryPanel — view + delete (client-confirm, not interrupt-gated)
│       ├── cost/           # CostPanel — LangSmith aggregates, today/week/all-time
│       └── ui/             # shadcn/ui primitives
└── src-tauri/              # Rust shell (process lifecycle not yet wired to server.py — started
                               by hand as of Phase 9 step 6)

tests/                      # pytest-shaped, runnable with plain python; one test file per
                               assistant/ module (test_server.py, test_supervisor.py, etc.)
launchd/                    # com.mohitvuyyuru.assistant-voice.plist — voice_daemon.py autostart
workspace/                  # the ONLY dir file/shell tools may touch (runtime-created)
PLAN.md                     # the phase plans; read the active one each session
STEPS.md                    # build log
```

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
- **Fixed `THREAD_ID` constant** in main.py — per-run IDs would silently defeat
  cross-session persistence, which is the point of the SQLite checkpointer.
- **Web search:** `TavilySearch` from `langchain-tavily`. Do not reintroduce the
  deprecated `TavilySearchResults` or `langchain-community`.
- **Tool errors are data, not exceptions:** failures (denylist rejections
  included) return as normal ToolMessages the model can read and explain —
  never raised exceptions that crash the graph.
- **`load_dotenv()` is called inside tools.py** (needs TAVILY_API_KEY at import
  time) as well as main.py. Idempotent; keep both.
- **Non-streaming CLI output** for now; `_render_content()` in main.py guards
  against non-string `.content` shapes. Streaming is a later UX pass.

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
- **Confirmation rule (standing):** side-effectful actions — sending email,
  creating/modifying events, Mac control, and (Phase 7 Part B) writing a
  durable long-term memory fact — require my explicit confirmation before
  execution; read-only actions don't. Until LangGraph interrupts are wired
  (Phase 3), enforce this by scoping tools read-only. Memory writes are
  additionally text-only, never voice-approvable (voice_daemon.py checks
  `voice_approvable: False` on the interrupt payload) — fact content is
  harder to vet by ear than an action verb like "send".
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
  the checkpointer's own file/schema). This reverses the earlier
  "long-term/vector memory is out of scope" line: it's now in scope,
  automatic-write (agent decides what's worth saving, not user-asked-for),
  and deliberately NOT a vector store — Chroma was considered and rejected
  at Phase 7's scope-time checkpoint in favor of plain keyword/recency
  retrieval, since a single user's fact count is expected to stay small
  enough that embedding-based recall would be premature complexity: revisit
  if that assumption stops holding. Retrieval is selective (memory_store.
  recall_facts), never a full context dump. See memory_extraction.py's
  module docstring for the full security design (source-restricted
  extraction, isolated extraction channel, scoped tool-content citation,
  universal confirmation gate) — this is the load-bearing part of Part B,
  not an implementation detail; do not weaken it without discussion, same
  standing as the Security model section below.
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
- No premature abstraction — current phase's needs only. No generic "plugin
  systems."
- Small, testable functions over monoliths.
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
