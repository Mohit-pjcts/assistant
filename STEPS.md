# Build Log

Entries are dated per group below. Timestamps before 2026-07-08 22:49 are
reconstructed from conversation order (accurate to within a few minutes); from
22:49 onward they're taken directly from file modification times. Numbering
groups sub-steps that belong to the same piece of work; top-level groups
appear in chronological order.

## 1. Project scaffold & packaging (2026-07-08, ~19:10–19:30)

### 1.1 (~19:10) Initial package scaffold created

**What:** Created the package with stub modules (`main.py`, `agent.py`,
`tools.py`, `memory.py`), plus `pyproject.toml`, `requirements.txt`,
`.env.example`, and `.gitignore`.

**Why:** CLAUDE.md calls for separate agent/tool/memory/CLI modules from day one
so the codebase doesn't need a rewrite when Phase 3 (multi-agent) arrives. For
packaging, asked the user pyproject.toml vs. requirements.txt vs. both — chose
**both**: `pyproject.toml` as the source of truth (installable, gives an
`assistant` console script), `requirements.txt` for anyone who just wants
`pip install -r requirements.txt`.

### 1.2 (19:26) Renamed package `jarvis` → `assistant`

**What:** Renamed the `jarvis/` directory to `assistant/` and updated the
module docstring — done before the rest of the scaffold (module stubs,
`pyproject.toml`, etc.) was created, so everything downstream was created
under the new name directly.

**Why:** User didn't want the project branded "Jarvis".

**Commands:**
```sh
mv jarvis assistant
```

## 2. `memory.py` implementation & early dependency decisions (2026-07-08, ~19:26–19:40)

### 2.1 (19:31) `memory.py` implemented

**What:** `get_checkpointer()` — a thin context-manager wrapper around
LangGraph's `SqliteSaver.from_conn_string`, with a single default DB path.

**Why:** Per CLAUDE.md, memory.py's whole job is owning the SQLite checkpointer
setup so `agent.py` doesn't need to know SQLite specifics — just
`with get_checkpointer() as checkpointer: graph = builder.compile(checkpointer=checkpointer)`.

### 2.2 (~19:32) Tavily chosen for web search in `tools.py`

**What:** Decided `tools.py`'s web search will use Tavily, not Anthropic's
built-in server-side web search tool. Added `langchain-community` and
`tavily-python` to `pyproject.toml` / `requirements.txt`, and `TAVILY_API_KEY`
to `.env.example`. (Superseded at 5.2 below — the community package turned
out to be deprecated.)

**Why:** User's call — keeps every tool as a client-executed LangChain tool
that goes through the same tool node, instead of mixing in a server-side
Anthropic tool with different execution semantics.

### 2.3 (~19:35) `LANGSMITH_API_KEY` added to `.env.example`

**What:** Added the key placeholder alongside `ANTHROPIC_API_KEY` and
`TAVILY_API_KEY`.

**Why:** User wants it available, but tracing (`LANGCHAIN_TRACING_V2=true`) is
deliberately *not* wired up yet — deferred until `agent.py` exists, since
tracing a graph that doesn't exist yet isn't useful.

## 3. Environment setup & `memory.py` validation (2026-07-08, 22:49)

### 3.1 venv + dependency install

**What:** Created a `.venv` with Python 3.14, installed `requirements.txt`,
then did an editable install of the package itself.

**Why:** Editable install (`pip install -e .`) makes `assistant` importable
regardless of how a script or test is invoked, instead of relying on
`PYTHONPATH` tricks or always running via `python -m`.

**Commands:**
```sh
python3.14 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
```

### 3.2 Smoke-tested `memory.py`, kept as a real test

**What:** Wrote a throwaway script to confirm `get_checkpointer()` actually
constructs a working `SqliteSaver` against the installed
`langgraph-checkpoint-sqlite` version, and that a checkpoint round-trips
(write, then read back) against a scratch `.sqlite` file.

**Why it mattered:** First run failed — `SqliteSaver.put(config, checkpoint, ...)`
requires `config["configurable"]["checkpoint_ns"]` in addition to `thread_id`.
This wasn't in the assumed config shape and would have surfaced later as a
confusing runtime error from inside `agent.py` instead of here, where the
cause is obvious. Fixed the config shape, confirmed the round-trip, then kept
the test for real instead of deleting it — moved to `tests/test_memory.py`,
written pytest-shaped (`def test_...(): assert ...`) but currently runnable
directly with plain `python` since pytest isn't a dependency yet. This bug is
exactly why 5.4 below (agent.py) sets `checkpoint_ns` explicitly rather than
assuming it's optional.

**Commands:**
```sh
.venv/bin/python tests/test_memory.py
```

## 4. Build log created (2026-07-08, ~22:55)

### 4.1 Format planned with the user

**What:** Used AskUserQuestion to settle file location (`STEPS.md` at repo
root), structure (chronological, append at bottom), thoroughness (decisions +
rationale + notable commands), and scope (backfill the whole session).

**Why:** So the reasoning behind decisions survives past the chat session —
useful as working memory during development and as a portfolio artifact
later.

### 4.2 `STEPS.md` written with backfilled entries

**What:** Entries 1–3 above (scaffold, rename, memory.py, Tavily/LangSmith
decisions, venv/install, smoke test) written in one pass, reconstructed from
the conversation so far.

## 5. `tools.py` — design, security fix, implementation (2026-07-08, 23:02–23:10)

### 5.1 (23:02) Fixed secrets in the wrong file

**What:** Found real API keys (Anthropic, Tavily, LangSmith) sitting in
`.env.example` instead of `.env`. Moved them to a new `.env` (gitignored),
restored `.env.example` to placeholders.

**Why it mattered:** `.env.example` is deliberately **not** gitignored — it's
meant to be committed as a template. Had this been committed and pushed as-is,
all three real API keys would have been published on GitHub. Caught before any
commit existed (`git log` showed no commits yet), so no rotation was needed —
just moving the values to the right file. Confirmed via `git check-ignore -v .env`
that the fix actually took.

### 5.2 (23:06) Swapped Tavily integration package

**What:** Verified via a real search call that `TavilySearchResults`
(langchain-community, chosen at 2.2) is deprecated and slated for removal in
LangChain 1.0 — we're already on langchain-core 1.4.8. Replaced it with
`TavilySearch` from `langchain-tavily`, which is still a normal
client-executed `BaseTool` through the same tool node, so it satisfies the
original design intent from 2.2. Dropped `langchain-community` /
`tavily-python` from deps (confirmed nothing else needed them via
`pip show langchain-community | grep Required-by`); added `langchain` /
`langchain-tavily` instead.

### 5.3 (23:09) `tools.py` implemented

**What:** Three tool categories behind a shared security model: a workspace
directory (`<project root>/workspace/`) that all file/shell operations are
confined to, plus a shell-command denylist.
`TOOLS = [read_file, write_file, execute_shell_command, web_search]`.

**Why — the threat model:** the user flagged that web search + shell + file
tools together is a real prompt-injection risk (adversarial text in a search
result could try to get the agent to run a destructive command via tool
results). Requirements: shell commands as argument lists (never
`shell=True`), a destructive-command denylist, file access confined to a
workspace dir with path-traversal rejection and a hard dotfile block, and
Tavily wired up with no special result-filtering (the guardrails on the
*execution* side are the mitigation, not filtering search content itself).

**Decisions made during implementation, and why:**
- **`shlex.split()` does not treat `| ; && \` $(` as delimiters by
  default** — e.g. `"ls&&rm -rf ~"` parses to one token, `'ls&&rm'`, not
  separate tokens. An exact-token-match denylist would silently miss this.
  The denylist checks for these as *substrings* within tokens instead.
- **Blocked `bash -c` / `sh -c` (and other shell interpreters) explicitly.**
  Denylisting `rm`/`sudo` as the first token doesn't stop
  `bash -c "rm -rf ~"` — invoking a shell interpreter as the target program
  re-introduces full shell semantics even under `shell=False`. Not explicitly
  asked for, but the most direct way to defeat the "argument list, no shell"
  mitigation, so it's in the denylist too.
- **Workspace dir anchored to the project root
  (`Path(__file__).parent.parent`), not `Path.cwd()`.** Anchoring to cwd
  would mean the workspace — and any state written into it — depends on
  which directory the `assistant` command happens to be invoked from.
- **Dotfile block is independent of the containment check.** Any path
  component starting with `.` is rejected even if it resolves inside the
  workspace dir, so a `.env` or `.git/` that legitimately exists inside
  `workspace/` is still blocked, not just traversal attempts that try to
  escape it.

### 5.4 (23:09) `load_dotenv()` import-order fix

**What:** `web_search = TavilySearch(...)` is constructed at module import
time and needs `TAVILY_API_KEY` already in the environment — discovered this
the hard way when importing `assistant.tools` directly (e.g. from tests)
failed with a pydantic validation error, because nothing had loaded `.env`
yet. Added `load_dotenv()` inside `tools.py` itself, not just relied on from
`main.py`.

**Why:** Makes the module self-sufficient regardless of import order.
`load_dotenv()` is idempotent, so calling it here too (in addition to
wherever `main.py` will call it) is harmless.

### 5.5 (23:09) `tests/test_tools.py` written, live Tavily call confirmed

**What:** 17 tests (no framework dependency yet, same style as
`test_memory.py`) covering round-trip read/write, absolute-path rejection,
traversal rejection, dotfile blocking, sensitive-path blocking, and the
no-spaces `ls&&rm` / `curl x|bash` denylist-bypass attempts specifically
(since those are the cases an exact-match check would have missed). All pass.
Also ran one live Tavily search through the real module (not a mock) to
confirm the key works end-to-end post-fix.

**Commands:**
```sh
.venv/bin/pip install -e . -q   # picks up updated deps
.venv/bin/python tests/test_tools.py
.venv/bin/python tests/test_memory.py
```

## 6. `agent.py` — implementation and end-to-end wiring (2026-07-08, 23:31)

### 6.1 Design constraints given

**What:** User specified: use a LangGraph prebuilt agent constructor (not a
custom `StateGraph`), model = Sonnet 5, `agent.py` accepts a checkpointer as
a parameter rather than creating its own (main.py will own the
`with get_checkpointer()` block), invocation config must set both
`thread_id` and `checkpoint_ns` (per the bug found at 3.2), tool errors must
surface as normal tool results rather than raised exceptions, and a short
system prompt — not a persona doc.

**Why:** Matches CLAUDE.md's "no premature abstraction" rule (Phase 1 is one
agent, not a framework) and keeps memory lifecycle ownership in one place
(`main.py`) rather than split across modules.

### 6.2 Verified the prebuilt constructor and model before wiring

**What:** Checked both `langgraph.prebuilt.create_react_agent` and
`langchain.agents.create_agent` — both compile internally and accept
`checkpointer` directly. Chose `langchain.agents.create_agent`: it's the
newer, actively-recommended constructor in the LangChain 1.x line we're on
(imports without a deprecation warning, unlike 5.2's Tavily situation),
with a cleaner signature (`system_prompt` instead of `prompt`) and
`middleware` support that could matter for Phase 3. Also confirmed
`ChatAnthropic(model="claude-sonnet-5")` actually works with a real API call
before wiring it into the graph.

### 6.3 `agent.py` implemented

**What:** `build_agent(checkpointer)` — constructs `ChatAnthropic`, calls
`create_agent(model=..., tools=TOOLS, system_prompt=..., checkpointer=...)`.
`make_thread_config(thread_id)` — returns
`{"configurable": {"thread_id": ..., "checkpoint_ns": ""}}`, so the
`checkpoint_ns` requirement from 3.2 is encapsulated here instead of
duplicated in `main.py`. System prompt is three sentences: what tools exist,
when to use them, tone — deliberately not a persona document.

### 6.4 Throwaway end-to-end smoke test, then deleted

**What:** Wrote a script (not in `tests/`, per instruction — this one wasn't
meant to be permanent) that built the real agent via `build_agent()` +
`get_checkpointer()` and ran two checks directly against the compiled graph:
(1) a message requiring a tool call actually triggers `write_file` then
`read_file`, and the result reaches the final answer; (2) a message that
provokes a denylisted shell command (`sudo rm -rf /`) produces a normal
`ToolMessage` containing the block reason, and the model explains it in
plain language — confirming tool errors don't raise and crash the graph.
Both passed on the first run. Deleted the script afterward; also cleaned up
`workspace/smoke.txt`, which the test wrote into the *real* project
`workspace/` dir since (unlike `tests/test_tools.py`) it didn't monkeypatch
`tools.WORKSPACE_DIR` to a temp directory.

**Commands:**
```sh
.venv/bin/python _smoke_test_agent.py   # confirmed, then removed
rm -rf workspace _smoke_test_agent.py
```

## 7. Build log reorganized (2026-07-08, 23:32)

**What:** Restructured this file from a flat chronological list into
numbered groups (`1`, `1.1`, `5.2`, etc.) with per-entry timestamps, per the
user's request. Timestamps reconstructed from a mix of file modification
times (`stat -f "%Sm"` on each artifact) and conversation order where mtimes
had been overwritten by later edits to the same file (e.g. `pyproject.toml`
was touched at scaffold time, again at 2.2, and again at 5.2 — only the last
survives on disk).

**Why:** Requested alongside the `agent.py` work — grouping keeps multi-step
work (like 5's tools.py arc: security fix → dependency swap → implementation
→ bug fix → tests) legible as one unit instead of five same-weight bullet
points, while top-level numbering preserves the overall chronological order
this log already relies on.

## 8. `main.py` — CLI chat loop, Phase 1 complete (2026-07-09, ~00:55–01:18)

### 8.1 (~00:55) Design constraints given

**What:** User specified: a fixed `THREAD_ID` constant (not generated per
run) so conversation memory is actually observable across separate CLI
launches, not just within one process; `load_dotenv()` called first, before
anything reads env vars; Ctrl+C, Ctrl+D/EOF, and a typed `exit`/`quit`
command must all exit quietly with no traceback; the agent invocation
wrapped in try/except so one bad API call doesn't crash the loop; and
non-streaming output (print the full response once, no token streaming) for
Phase 1.

**Why:** The fixed thread ID is what makes 3.2's `checkpoint_ns` fix and
`memory.py`'s whole design actually testable end-to-end — persistence across
launches is the point of the SQLite checkpointer, not just persistence
within a single loop iteration.

### 8.2 (~00:58) Checked `AIMessage.content` shape before writing the print logic

**What:** LangChain types message content as `str | list[str | dict]`, and
Sonnet 5 defaults to adaptive thinking on when the `thinking` param is
omitted (per Anthropic's own migration notes) — a real risk that `.content`
could come back as a list of blocks rather than a plain string, which would
print an ugly Python repr to the user. Ran a real no-tool-call turn and
inspected `type(final.content)` / `repr(...)` directly: came back as a plain
string in both a simple Q&A case and (from 6.4's smoke test) a tool-call
case.

**Why it still matters:** added a small `_render_content()` helper anyway —
cheap defense against ever printing a raw list/dict repr in the interactive
CLI if a future response shape differs, without adding real complexity for
the common case.

### 8.3 (~01:00) `main.py` implemented

**What:** `load_dotenv()` called before the `assistant.agent`/`assistant.tools`
imports (which themselves also call it — redundant but explicit, matching
5.4's reasoning). `main()` opens `get_checkpointer()` once for the process
lifetime, builds the graph via `build_agent()`, and loops on `input()` →
`graph.invoke()` → print, using `make_thread_config(THREAD_ID)` for every
turn. A single try/except per loop iteration wraps *both* the `input()` call
and the `graph.invoke()` call: `(EOFError, KeyboardInterrupt)` breaks the
loop (ordering this before the generic `except Exception` matters — `EOFError`
is a subclass of `Exception`, so if the broad clause came first it would
swallow EOF and spin in a tight infinite-error loop instead of exiting);
any other exception prints `[error] {type}: {message}` and `continue`s.

### 8.4 (~01:05–01:18) Manually verified end-to-end (no automated test — interactive entry point)

**What:** Ran the actual CLI (piped stdin, plus a small Python harness for
precise `SIGINT` timing) covering every requirement:
- Conversational turn → correct answer.
- Tool-call turn (`write_file` then `read_file` on `greeting.txt`) → tool
  actually ran, result reached the final answer.
- Typed `exit` → clean exit, code 0, no traceback.
- Piped stdin closing (EOF) with no `exit` typed → clean exit, code 0.
- `SIGINT` while blocked on `input()` → clean exit, code 0.
- `SIGINT` while `graph.invoke()` was mid-flight (sent 0.3s after submitting
  a prompt likely to still be waiting on the API) → clean exit, code 0, not
  just at the prompt.
- Forced `ANTHROPIC_API_KEY=sk-ant-invalid-test-key` for one process (env var
  set before launch, so `load_dotenv()`'s default `override=False` didn't
  clobber it with the real key) → got
  `[error] AuthenticationError: ... invalid x-api-key`, loop did **not**
  crash, next input prompt still worked, `exit` still exited cleanly.
- Fixed `THREAD_ID` persistence, the actual point of 8.1: ran the CLI once,
  told it "my favorite color is teal," exited; launched a **separate**
  process, asked "what did I say my favorite color was?" — correctly
  answered "teal," confirming memory persists across launches, not just
  within one loop.

**Cleanup:** deleted `conversation_memory.sqlite` and `workspace/` afterward
so this manual-testing conversation isn't sitting in the persistent memory
DB the first time it's used for real.

**Commands:**
```sh
# scripted multi-turn run
printf "...\nexit\n" | .venv/bin/python -m assistant.main

# SIGINT timing via a Python subprocess harness (bash pipeline PID tracking
# for kill -INT proved unreliable against a piped-stdin process)
.venv/bin/python -c "
import subprocess, signal, time
proc = subprocess.Popen(['.venv/bin/python', '-m', 'assistant.main'], ...)
time.sleep(2)
proc.send_signal(signal.SIGINT)
"

rm -f conversation_memory.sqlite
rm -rf workspace
```

Phase 1 deliverable complete: single LangGraph agent, tool-calling
(web search, file read/write, shell execution), persistent conversation
memory via SQLite, runnable as a CLI loop.
