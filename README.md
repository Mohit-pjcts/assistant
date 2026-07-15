# assistant

A personal AI assistant built on the Claude API and [LangGraph](https://github.com/langchain-ai/langgraph). Runs as a CLI, an always-on voice daemon in the macOS menu bar, and a Tauri desktop dashboard — all three talking to the same conversation, the same memory, and the same graph. A supervisor routes each request to the right specialist sub-agent (coding, research, email/calendar, Mac control) and can chain several in one turn. Side-effectful actions — sending an email, creating a calendar event, running a Shortcut, writing a durable memory — always pause for an explicit confirmation first. The whole thing is built around the assumption that anything a tool returns (a search result, an email, a calendar event, a Note) could be adversarial.

Not "Jarvis." Deliberately.

## What it can do today

- Hold a conversation that persists across separate launches (SQLite-backed), routed by a supervisor to the right specialist sub-agent, with **multiple named conversation threads** you can create/switch/rename/delete from the CLI, voice, or the dashboard — not just one endless thread.
- **Coding**: read/write files in a sandboxed workspace and run shell commands there — argument-list execution only (never a shell interpreter), a denylist blocking destructive commands and AppleScript, and a confirmation gate on inline interpreter code (`python3 -c "..."`).
- **Research**: search the web (Tavily); can resolve objective ambiguity itself (current date/time, a real-world fact) instead of asking you, while still asking when it's a genuine preference only you can supply.
- **Life-admin**: search/read Gmail *and* send email, archive/label messages, and create/delete Gmail filters; search/read Google Calendar *and* create/update/delete events. Every write pauses for confirmation showing the verbatim content (real recipient, real body, real event details) — never an LLM summary of what it's about to do.
- **Mac control**: open/focus an app, control Music.app playback, read/create Reminders and Notes, start a new Shortcut in the editor (you finish and save it), run a named Shortcut (confirmation-gated), read/create/update Apple Calendar events (create/update gated, mirrors the Google Calendar pattern), and open a URL in Brave.
- **Memory**: short-term — conversation history is automatically compacted (summarized) once it grows large, so cost/latency don't scale with a thread's entire lifetime. Long-term — the agent can propose durable facts about you worth remembering across conversations (always behind a confirmation gate showing the exact fact text, never voice-approvable), recalled selectively on later turns, never dumped wholesale.
- **Voice**: press Option+Return from any application to talk to it and hear it answer — an always-on menu bar daemon (🎙/🔴/💭 state), speech-to-text running fully locally (`mlx-whisper large-v3`, no audio ever leaves the machine), replies spoken via macOS `say`. Say "start a new conversation" to switch threads by voice. Voice and text share the same conversation history and thread; the confirmation gate works spoken too — except for anything with free-text content (email body, memory fact, event description), which is text-only by design (harder to vet by ear than an action verb).
- **Dashboard**: a Tauri + React desktop app — live chat with token-streaming responses and a Stop button, full conversation history, memory viewer, a per-day/week/all-time cost panel (real LangSmith aggregates), and a thread sidebar. Tauri owns the Python backend's and voice daemon's process lifecycle — launching the app starts both, quitting it stops both.
- Side-effectful or opaque actions pause the conversation for an explicit confirmation before executing, via a real LangGraph interrupt — not just a prompt instruction. In the text CLI that's a y/n prompt; in the dashboard it's a real UI affordance rendering the verbatim payload; in voice mode the question is spoken and the answer parsed fail-closed (anything that isn't a clear yes — mumble, silence, timeout — declines).

Email, calendar, Note, and Shortcut content are all treated as untrusted input: the system prompts tell the model not to follow instructions embedded in message/event content or blindly trust what a Shortcut does, and — more importantly — the tools themselves are built so an adversarial instruction has nothing dangerous to reach even if the model is fooled. See [Security model](#security-model) below.

## Architecture

```
assistant/
├── main.py               # CLI loop — async, owns checkpointer + MCP tool loading lifetime;
│                            --new / /new / /threads / /switch for thread management
├── studio.py              # LangGraph Studio (`langgraph dev`) entry point — same graph, no checkpointer
├── supervisor.py          # Outer StateGraph: routes to sub-agents via Command-based handoff tools;
│                            loop-back (a sub-agent's result returns to a re-evaluating supervisor,
│                            capped per-turn) so one request can chain multiple sub-agents
├── sub_agents.py          # coding / research / life_admin / mac_control sub-agents (each a
│                            create_agent graph); per-sub-agent context windowing
├── agent.py               # make_thread_config(thread_id) only
├── tools.py               # Phase 1 hand-secured tools: file r/w, shell exec (+ hardening)
├── mac_tools.py           # osascript/open/shortcuts-CLI bridge behind a hard allowlist —
│                            Music/Reminders/Notes/Shortcuts + Apple Calendar +
│                            open-URL-in-Brave
├── write_tools.py         # Gated write-tool wrappers: send_email, modify_gmail_labels,
│                            create/update/delete_calendar_event, create/delete_gmail_filter —
│                            local wrappers that call interrupt() themselves and show the
│                            verbatim payload (the raw MCP write tools never reach a model)
├── mcp_tools.py           # MCP integration: Gmail + Calendar, async, with interceptors
├── interrupts.py          # Dummy confirmation-gated tool — the interrupt mechanic's test fixture
├── compaction.py          # Short-term context compaction + per-sub-agent history windowing
├── memory_store.py        # Long-term durable-facts storage (separate SQLite file)
├── memory_extraction.py   # Long-term memory: source-restricted extraction, confirmation gate,
│                            selective recall — see its module docstring for the full security design
├── thread_store.py        # Multi-thread registry + active-thread pointer (separate SQLite file)
├── thinking_repair.py     # Repairs a confirmed langchain-anthropic streaming bug so extended
│                            thinking can stay enabled without corrupting conversation state
├── voice_io.py            # Mic capture, local STT (mlx-whisper), `say` TTS, confirmation parsing
├── voice_daemon.py        # Always-on menu bar daemon — global hotkey, same graph as the CLI,
│                            "start a new conversation" trigger phrase for switching threads
└── memory.py              # get_checkpointer() — async context manager over AsyncSqliteSaver

dashboard/                 # Tauri 2 + React + TypeScript desktop app
├── src/
│   ├── App.tsx             # tab shell (chat/history/memory/cost) + persistent thread sidebar
│   ├── lib/api.ts          # typed client for assistant/server.py, incl. SSE streaming
│   └── components/
│       ├── chat/           # ChatPanel (streaming + Stop) + InterruptGate (per-action gate UI)
│       ├── history/        # full unfiltered conversation feed
│       ├── memory/         # view + delete durable facts
│       ├── cost/           # LangSmith cost aggregates
│       └── threads/        # thread sidebar — new/switch/rename/delete
└── src-tauri/              # Rust shell — owns the Python backend's and voice daemon's process
                               lifecycle end-to-end (spawn on launch, kill on quit)

launchd/          # Legacy LaunchAgent plist — superseded by Tauri's own process ownership;
                    kept for the CLI-only-without-the-dashboard case
tests/            # pytest-shaped (test_*.py / test_* / assert), run with `pytest`
workspace/        # the ONLY directory file/shell tools (and confined MCP downloads) may touch
PLAN.md           # phase-by-phase build plan; only one phase is ever "active"
STEPS.md          # full build log — every decision, bug, and why
```

A hand-built outer `StateGraph` (`supervisor.py`) holds a routing supervisor and four sub-agents, each itself a [`langchain.agents.create_agent`](https://docs.langchain.com/oss/python/langchain/agents) graph embedded as a node. Routing uses LangGraph's `Command`-based handoff-tool pattern — the supervisor never sees a sub-agent's own tool list, only what its own system prompt says that sub-agent owns, so every new sub-agent's capabilities have to be described in `SUPERVISOR_SYSTEM_PROMPT` explicitly. A sub-agent's result routes back through a re-evaluating supervisor (capped per turn) rather than ending the turn outright, so a single request can chain multiple specialists — "get me a recipe and save the ingredients to Notes" hits research then Mac control in one turn. `checkpoint_ns` nests automatically per sub-agent under the shared checkpointer. `tools.py`/`mac_tools.py`'s tools are synchronous and hand-written; `mcp_tools.py`'s tools are loaded asynchronously at startup from locally-run MCP servers and merged in. Because MCP-loaded tools only support async invocation, the whole CLI runs on `graph.ainvoke()`; the dashboard streams via `graph.astream_events()`. LangSmith tracing is wired up so routing decisions and sub-agent tool calls are inspectable as real trace trees, not just final answers, and backs the dashboard's cost panel. A `langgraph dev` entry point (`studio.py`) exposes the same graph to LangGraph Studio for local, visual debugging.

Extended thinking (`thinking={"type": "adaptive"}`) is enabled on all five agent models, paired everywhere with `ThinkingBlockRepairMiddleware` — a real `langchain-anthropic` bug can drop a streamed thinking block's required field during SSE chunk merging, which the Anthropic API then rejects on replay; the middleware repairs the malformed shape before it ever reaches persisted state, rather than disabling the feature project-wide to avoid it.

Voice mode (`voice_daemon.py`) and the dashboard are both wrappers around the *same* graph and the *same* thread registry, not separate agent logic — a conversation started by voice can be continued by keyboard or in the dashboard, and vice versa. Voice is internally three coordinated threads — a rumps menu bar app on the main thread (an AppKit hard requirement; all UI mutation is marshaled there), a dedicated asyncio loop for graph/STT/TTS work, and pynput's global-hotkey listener — with a small IDLE → RECORDING → PROCESSING state machine in between, and an extra ANSWERING state for spoken confirmation answers.

## Setup

### Requirements

- Python 3.12 (a wheel-availability concession for the audio deps)
- Node.js (for the Gmail and Calendar MCP servers, run as local subprocesses)
- Rust + Node.js (only if building/running the Tauri dashboard — `dashboard/`)
- macOS (the Mac-control sub-agent uses `osascript`/`open`/`shortcuts`, all macOS-only; the CLI/backend otherwise run cross-platform)
- API keys: an Anthropic API key (pay-per-token Console account, not a Pro/Max subscription), a [Tavily](https://tavily.com) API key

### Install

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
cp .env.example .env   # then fill in the real values
```

### Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Core agent | Console API key, pay-per-token |
| `TAVILY_API_KEY` | Web search | |
| `LANGSMITH_API_KEY` | Tracing + dashboard cost panel | Optional but recommended |
| `LANGCHAIN_TRACING_V2` | Tracing | `true` to enable |
| `LANGCHAIN_PROJECT` | Tracing | LangSmith project name |
| `LANGSMITH_ENDPOINT` | Tracing (regional accounts only) | Not in `.env.example` — only needed off the default US endpoint |
| `GMAIL_MCP_SERVER_PATH` | Gmail | Path to a built `Gmail-MCP-Server/dist/index.js` |
| `GOOGLE_CALENDAR_MCP_SERVER_PATH` | Calendar | Path to a built `google-calendar-mcp/build/index.js` |
| `GOOGLE_CALENDAR_MCP_CREDENTIALS` | Calendar | Path to that server's `gcp-oauth.keys.json` |
| `ASSISTANT_TTS_VOICE` | Voice (optional) | TTS voice name, default `Ava (Premium)`; falls back to the system voice with a logged warning if not installed |

Gmail and Calendar are optional at startup — if their env vars are unset or the servers aren't built yet, `main.py` prints a warning and runs without the `life_admin_agent` tools. Mac control needs no setup beyond running on macOS — see the permissions note below.

### Gmail and Calendar OAuth setup

Both integrations run as local MCP servers behind your own Google Cloud OAuth app — no third-party hosted MCP platform touches your credentials, and both servers store their tokens outside this repo (`~/.gmail-mcp/`, `~/.config/google-calendar-mcp/`).

**Gmail** — [`ArtyMcLabin/Gmail-MCP-Server`](https://github.com/ArtyMcLabin/Gmail-MCP-Server). The OAuth grant is scoped to `gmail.modify` + `gmail.settings.basic` (a superset of `gmail.readonly`, sufficient for send/archive/label plus filter management — widened from the original read-only grant once send/write access was added):

```sh
git clone https://github.com/ArtyMcLabin/Gmail-MCP-Server.git ~/mcp-servers/Gmail-MCP-Server
cd ~/mcp-servers/Gmail-MCP-Server && npm install && npm run build

# Google Cloud Console: new project → enable Gmail API → OAuth consent
# screen (External, add the gmail.modify + gmail.settings.basic scopes,
# add yourself as a test user) → OAuth client (Desktop app) → download the JSON

mkdir -p ~/.gmail-mcp
mv ~/Downloads/<downloaded>.json ~/.gmail-mcp/gcp-oauth.keys.json
node dist/index.js auth --scopes=gmail.modify
```

Even with this scope, sending email, archiving/labeling, and creating/deleting filters are all gated behind a confirmation showing the verbatim content — see [Security model](#security-model).

**Calendar** — [`nspady/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp). This server always requests the full read/write `.../auth/calendar` scope at the OAuth-grant level (not configurable). Since write access is now a real, gated capability rather than something to lock out, no read-only enforcement is layered on top — every create/update/delete goes through `write_tools.py`'s confirmation gate instead.

```sh
git clone https://github.com/nspady/google-calendar-mcp.git ~/mcp-servers/google-calendar-mcp
cd ~/mcp-servers/google-calendar-mcp && npm install && npm run build

# Same GCP project works — enable Calendar API, add the .../auth/calendar
# scope to the consent screen, create a *separate* Desktop-app OAuth client

mkdir -p ~/.config/google-calendar-mcp
mv ~/Downloads/<downloaded>.json ~/.config/google-calendar-mcp/gcp-oauth.keys.json
GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json npm run auth
```

Both apps stay in Google's "Testing" publish status by default, which means tokens expire after 7 days and need re-auth (rerun the `auth` command above). Publishing the app (still shows an "unverified" warning, but no expiry) is a one-click alternative on the OAuth consent screen if the weekly re-auth gets old.

### Mac-control permissions

No API keys or config needed — but the first time each AppleScript-controlled app (Music, Reminders, Notes, Calendar) or `run_shortcut` (Shortcuts automation) actually runs, macOS shows a one-time Automation permission dialog asking whether to let your terminal/Python process control that app. Click Allow. This is a per-app, first-use-only prompt — nothing to configure ahead of time. `open_url_in_brave` needs no special permission beyond Brave being installed.

### Voice mode

Speech-to-text runs fully locally via [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) (`large-v3`, Apple Silicon only — no per-utterance API cost, no audio leaving the machine). The model preloads at startup so first-utterance latency isn't paid per turn.

**Nicer voice (optional, recommended):** macOS's default `say` voice is robotic. Download an Enhanced/Premium voice once — System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… — and either grab "Ava (Premium)" (the default this project looks for) or set `ASSISTANT_TTS_VOICE` to whichever you picked.

**Run it directly** (or let the dashboard start it for you — see below):

```sh
.venv/bin/assistant-voice
```

A 🎙 icon appears in the menu bar. Press **Option+Return** (from any application) to start recording — 🔴 — and again to stop and submit; the reply is spoken and logged. Say "start a new conversation" to switch to a fresh thread. When a gated action needs confirmation, the daemon speaks the question and immediately starts recording your answer — say yes or no, then one Option+Return submits it (memory writes, email sends, calendar creates/updates, and filter writes are text-only, never voice-approvable — free-text content is harder to vet by ear than a verb like "send"). Quit from the menu bar icon. Transcripts, confirmation outcomes, and errors go to a self-rotating log at `~/Library/Logs/PersonalAssistant/voice_daemon.log`.

**Permissions:** global hotkey listening needs the **Input Monitoring** TCC grant; running the daemon outside the dashboard (or via the legacy `launchd/` plist) also needs **Full Disk Access** to read a project under `~/Documents`. The venv's Python resolves through *two* distinct executables — the framework stub and the `Python.app` bundle it re-execs into — and macOS attributes grants per-binary, so **both** need **both** grants:

```
/opt/homebrew/Cellar/python@3.12/<version>/Frameworks/Python.framework/Versions/3.12/bin/python3.12
/opt/homebrew/Cellar/python@3.12/<version>/Frameworks/Python.framework/Versions/3.12/Resources/Python.app
```

Those grants pin to the versioned Cellar path, so a `brew upgrade python@3.12` requires re-granting.

### Dashboard app

```sh
cd dashboard
npm install
npm run tauri dev
```

This launches the Tauri window, which itself spawns the Python backend (`uvicorn assistant.server:app`) and the voice daemon as child processes — quitting the window stops both. No need to run `assistant`/`assistant-voice` separately when using the dashboard. `npm run build` produces a release bundle.

### Run (CLI only)

```sh
.venv/bin/assistant
```

Type `exit`/`quit`, or Ctrl+C/Ctrl+D, to leave. `--new` starts a fresh thread; mid-session, `/new` starts one, `/threads` lists them, `/switch <id>` switches. Conversation memory persists in `conversation_memory.sqlite` across separate launches. When a tool needs confirmation, the CLI prints `[confirm] {...} Proceed? (y/n):` and pauses — type `y` or `n`.

For visual/step-by-step debugging of the graph itself (routing decisions, tool calls, message state), run `.venv/bin/langgraph dev` instead — opens [LangGraph Studio](https://github.com/langchain-ai/langgraph-studio) against the same graph, without a persistent checkpointer (Studio manages its own run state).

## Security model

Threat model: any tool that touches the web, email, calendar, Notes, or Shortcut content is a prompt-injection surface — adversarial text can arrive as a tool result and try to induce harmful actions. The mitigation lives on the *execution* side, not in filtering content:

- **Shell**: commands are parsed into an argument list and run with `shell=False` — never a shell interpreter. A denylist blocks `rm`/`sudo`/`su`/`osascript`, shell interpreters invoked with `-c`, shell metacharacters (checked as substrings, since `shlex` doesn't split on them), sensitive system paths, and common home-directory folders. A general-purpose interpreter invoked with inline code (`python3 -c "..."`, `node -e "..."`) pauses for confirmation via a LangGraph interrupt — running a *file* the agent already wrote (`python3 script.py`) stays ungated.
- **Files**: confined to `workspace/`, anchored at the project root. Path traversal is rejected by resolving and checking containment; dotfiles/dotdirs are blocked independent of that check.
- **Mac control**: every action is a fixed AppleScript template (or the plain `open`/`shortcuts`/`open -a "Brave Browser"` CLI) invoked as an argv list — model-supplied values are passed as osascript's own positional argv, never string-interpolated into script source. Open app / Music playback / Reminders / Notes / Apple Calendar reads / opening a blank Shortcut editor are ungated. Running a named Shortcut, and creating/updating an Apple Calendar event, always pause for confirmation with the verbatim payload. `open_url_in_brave` ships deliberately ungated (accepted risk, a discussed tradeoff — see STEPS.md — not an oversight) — it's open/navigate only, never automation (no clicking, typing, or scraping).
- **Gmail/Calendar writes**: `send_email`, `modify_gmail_labels`, `create/update/delete_calendar_event`, and `create/delete_gmail_filter` are local wrapper tools that call `interrupt()` themselves and render the real content verbatim (actual recipient, actual body, actual event details) — never an LLM re-summary. The raw MCP write tools never reach a model's tool list; only their gated wrappers do. Update/delete carry a real read-back of the target so an opaque ID alone isn't what you're approving. Calendar-delete is voice-approvable (no free-text payload to hide an injection in); everything else with free-text content is text-only.
- **Gmail read**: `download_attachment`/`download_email` write to disk from inside the separate Node server process, outside `tools.py`'s own sandbox — an interceptor forces their save path into `workspace/` and reduces filenames to their basename.
- **Cost**: an MCP tool that defaults to expanding up to 50 full email threads into context on a single call is capped by an interceptor, rather than trusting the model to pass a small limit.
- **Long-term memory**: writing a durable fact is automatic (the agent decides what's worth saving) but layered: extraction only ever reads the genuine user's own current-turn text (never tool-result content, closing the "a prompt-injected 'remember X' becomes a permanent fact" hole structurally, not just behaviorally); a cited fact must be backed by a real tool result found independently in the current turn or it's refused outright; every write still goes through the same confirmation gate as any other side effect, with the exact confirmed text persisted verbatim; and recall is framed as data ("known facts...") to the model, never as directives.
- **Standing confirmation rule**: any side-effectful or opaque action pauses the graph via a real `langgraph.types.interrupt()` and waits for an explicit confirmation before executing — demonstrated end-to-end (both confirm and decline paths) through the real CLI/dashboard/voice, not just tested in isolation.
- **Voice confirmation fails closed**: the spoken answer only approves on a recognized affirmative — a mistranscription, ambiguous phrase, silence, or timeout all decline. Decline-words win when both appear.
- **Skill vetting**: a Claude Code skill is instruction-bearing content loaded into agent context — the same threat model as any other untrusted input. No skill is installed without reading it first; High/Medium-risk community skills are declined by default; bulk/marketplace installs are never used.

Full reasoning, including several things that went wrong during development and how they were caught, is in [STEPS.md](STEPS.md).

## Roadmap

See [PLAN.md](PLAN.md) for the full phase-by-phase plan.

1. ✅ Foundations — single agent, tool-calling, persistent memory
2. ✅ Gmail + Calendar via MCP (read-only)
3. ✅ Multi-agent split — supervisor + coding/research/life-admin sub-agents, LangSmith tracing, interrupt-based confirmation gate
4. ✅ Mac-native control — allowlisted `osascript`/`open`/`shortcuts` actions
5. ✅ Voice I/O — local STT, always-on hotkey daemon, spoken confirmation gate, launchd autostart
6. ✅ Cross-agent handoff routing — a sub-agent's result loops back through a re-evaluating supervisor so one turn can chain multiple specialists
7. ✅ Memory — short-term compaction + long-term automatic-write facts, behind a layered, red-teamed security design
8. ✅ Voice upgrade — STT swapped to `mlx-whisper large-v3` (6-8x latency win)
9. ✅ Tauri desktop dashboard — chat/history/memory/cost panels as a peer client of the graph
10. 🔄 **Active** — polish-debt cleanup: extended thinking re-enabled behind a verified repair middleware, Haiku-for-research_agent evaluated (stays on Sonnet 5), pytest adopted; remaining: README (this refresh), voice-accuracy re-benchmark
11. ✅ Skills cleanup + a standing skill-vetting policy
12. ✅ Email + Google Calendar WRITE access — gated send/modify/create/update/delete, verbatim confirmation
13. ✅ Apple Calendar (read + gated write) + open-URL-in-Brave
14. ✅ UI rework — full visual redesign, SSE streaming + stop-mid-run, Tauri owns backend/voice process lifecycle
15. ✅ Multi-thread conversation support — thread registry, delete, persistent sidebar

## Development

```sh
.venv/bin/pytest
```

`tests/` is pytest-shaped (`def test_...(): assert ...`, `test_*.py` naming) and also runnable directly with plain `python tests/test_x.py` if you'd rather not install pytest. Most files hit real APIs (Anthropic, Tavily, LangSmith) rather than mocking — by design, per this project's testing convention — so a full run has a small real cost and takes about a minute. `test_mac_tools.py` and `test_voice_io.py` monkeypatch `subprocess.run` and hardware-touching internals throughout, so they run anywhere — no macOS apps, microphone, or permission grants required; live verification of the real integrations is manual and recorded in STEPS.md instead. No CI is wired up — a deliberate choice given the no-mocking convention (either paying for API calls on every push, or a lint-only CI that doesn't prove the suite passes); see STEPS.md.
