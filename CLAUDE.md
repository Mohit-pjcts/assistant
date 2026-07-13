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

- **No active phase** — Phase 7 (Memory: short-term compaction + long-term
  facts) is next; read PLAN.md before beginning it, including the
  context-leakage checkpoint carried over from Phase 6.
- Complete: Phase 1 — single-agent CLI with tools + persistent memory
  (STEPS.md groups 1–8)
- Complete: Phase 2 — Gmail + Calendar via MCP, async graph migration
  (STEPS.md groups 9–20)
- Complete: Phase 3 — supervisor + 3 sub-agents, LangGraph handoff routing,
  interrupt-based confirmation gate (STEPS.md groups 21–25)
- Complete: Phase 4 — Mac-native control via osascript/`open`/`shortcuts`
  bridge + mac_control_agent, plus a shell-tool security hardening pass
  (STEPS.md groups 29–33)
- Complete: Phase 5 — voice I/O: local faster-whisper STT, always-on
  Option+Return hotkey daemon (pynput + rumps menu bar), spoken
  confirmation gate, launchd autostart (STEPS.md groups 37–43)
- Complete: Phase 6 — fixed cross-agent handoff routing: sub-agents now loop
  back through a re-evaluating supervisor instead of stalling after the
  first specialist, with a correctly turn-scoped handoff cap (STEPS.md
  groups 47–48)

Roadmap was renumbered 2026-07-13: four phases (6 handoff-fix, 7 memory,
8 voice-upgrade, 9 dashboard) inserted ahead of the original proactivity/
polish phase, now Phase 10. See PLAN.md for all phase plans.

This block is the only part of this file that changes routinely; everything
below is durable.

## Architecture (as built - phase 1)

```
assistant/
├── main.py      # CLI loop; owns checkpointer lifetime; fixed THREAD_ID
├── agent.py     # build_agent(checkpointer) + make_thread_config(thread_id)
├── tools.py     # TOOLS: web search (Tavily), file r/w, shell exec
└── memory.py    # get_checkpointer() context manager over SqliteSaver
tests/           # pytest-shaped, runnable with plain python
workspace/       # the ONLY dir file/shell tools may touch (runtime-created)
PLAN.md          # the six phase plans; read the active one each session
STEPS.md         # build log
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
  creating/modifying events, Mac control — require my explicit confirmation
  before execution; read-only actions don't. Until LangGraph interrupts are
  wired (Phase 3), enforce this by scoping tools read-only.
- New tools (MCP-loaded included) are evaluated against this threat model
  before joining the agent. MCP tools MERGE into TOOLS; they never replace
  Phase 1's hand-secured tools.

## Tech stack

- Python 3.12 venv at `.venv` — deliberate choice for broadest wheel coverage
  ahead of Phase 5's audio deps; `requires-python = ">=3.11"` in pyproject.
  Package installed editable (`pip install -e .`).
- LangGraph + LangChain (1.x line); `langchain-mcp-adapters` from Phase 2 on.
- Anthropic SDK — Claude API (pay-per-token via Console account), NOT the
  Pro/Max subscription.
- Memory: SQLite via `langgraph-checkpoint-sqlite` (conversation state).
  Long-term/vector memory is out of scope until the plan says otherwise.
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
