# assistant

A personal AI assistant built on the Claude API and [LangGraph](https://github.com/langchain-ai/langgraph). Runs as a CLI — and as an always-on voice daemon in the macOS menu bar — with persistent conversation memory, a supervisor that routes to specialist sub-agents (coding, research, email/calendar, Mac control), and a security model built around the assumption that anything a tool returns — a search result, an email, a calendar event — could be adversarial.

Not "Jarvis." Deliberately.

## What it can do today

- Hold a conversation that persists across separate launches (SQLite-backed), routed by a supervisor to the right specialist sub-agent.
- **Coding**: read/write files in a sandboxed workspace and run shell commands there — argument-list execution only (never a shell interpreter), a denylist blocking destructive commands and AppleScript, and a confirmation gate on inline interpreter code (`python3 -c "..."`).
- **Research**: search the web (Tavily).
- **Life-admin**: search and read Gmail (read-only — cannot send, reply, delete, or modify); search and read Google Calendar (read-only — cannot create, update, delete, or respond to events).
- **Mac control**: open/focus an app, control Music.app playback, read/create Reminders and Notes, start a new Shortcut in the editor (you finish and save it), and run a named Shortcut — the last one always asks for confirmation first.
- **Voice**: press Option+Return from any application to talk to it and hear it answer — an always-on menu bar daemon (🎙/🔴/💭 state), speech-to-text running fully locally (faster-whisper, no audio ever leaves the machine), replies spoken via macOS `say`. Voice and text share one conversation history, and the confirmation gate works spoken too: the daemon asks the question aloud and records your yes/no.
- Side-effectful or opaque actions (running a named Shortcut, inline interpreter code) pause the conversation for an explicit confirmation before executing, via a real LangGraph interrupt — not just a prompt instruction. In the text CLI that's a y/n prompt; in voice mode the question is spoken and the answer parsed fail-closed (anything that isn't a clear yes — mumble, silence, timeout — declines).

Email, calendar, and Shortcut content are all treated as untrusted input: the system prompts tell the model not to follow instructions embedded in message/event content or blindly trust what a Shortcut does, and — more importantly — the tools themselves are built so an adversarial instruction has nothing dangerous to reach even if the model is fooled. See [Security model](#security-model) below.

## Architecture

```
assistant/
├── main.py        # CLI loop — async, owns checkpointer + MCP tool loading lifetime
├── studio.py       # LangGraph Studio (`langgraph dev`) entry point — same graph, no checkpointer
├── supervisor.py   # Outer StateGraph: routes to sub-agents via Command-based handoff tools
├── sub_agents.py   # coding / research / life_admin / mac_control sub-agents (each a create_agent graph)
├── agent.py        # make_thread_config(thread_id) only — the single-agent builder it once held moved into supervisor.py/sub_agents.py at Phase 3
├── tools.py        # Phase 1 hand-secured tools: file r/w, shell exec (+ Phase 4 hardening)
├── mac_tools.py     # Phase 4: osascript/open/shortcuts-CLI bridge behind a hard allowlist
├── mcp_tools.py     # Phase 2 MCP integration: Gmail + Calendar, async, with interceptors
├── interrupts.py    # Dummy confirmation-gated tool — the interrupt mechanic's test fixture
├── voice_io.py      # Phase 5: mic capture, local faster-whisper STT, `say` TTS, confirmation parsing
├── voice_daemon.py  # Phase 5: always-on menu bar daemon — global hotkey, same graph as the CLI
└── memory.py        # get_checkpointer() — async context manager over AsyncSqliteSaver
launchd/          # LaunchAgent plist for starting the voice daemon at login
tests/            # pytest-shaped, runnable directly with plain python
workspace/        # the ONLY directory file/shell tools (and confined MCP downloads) may touch — runtime-created
PLAN.md           # six-phase build plan; only one phase is ever "active"
STEPS.md          # full build log — every decision, bug, and why
```

A hand-built outer `StateGraph` (`supervisor.py`) holds a routing supervisor and four sub-agents, each itself a [`langchain.agents.create_agent`](https://docs.langchain.com/oss/python/langchain/agents) graph embedded as a node. Routing uses LangGraph's `Command`-based handoff-tool pattern — the supervisor never sees a sub-agent's own tool list, only what its own system prompt says that sub-agent owns, so every new sub-agent's capabilities have to be described in `SUPERVISOR_SYSTEM_PROMPT` explicitly. `checkpoint_ns` nests automatically per sub-agent under the shared checkpointer. `tools.py`/`mac_tools.py`'s tools are synchronous and hand-written; `mcp_tools.py`'s tools are loaded asynchronously at startup from locally-run MCP servers and merged in. Because MCP-loaded tools only support async invocation, the whole CLI runs on `graph.ainvoke()`. LangSmith tracing is wired up (`LANGCHAIN_TRACING_V2`) so routing decisions and sub-agent tool calls are inspectable as real trace trees, not just final answers. A `langgraph dev` entry point (`studio.py`) exposes the same graph to LangGraph Studio for local, visual debugging.

Voice mode (`voice_daemon.py`) is a wrapper around the *same* graph, not separate agent logic: the daemon invokes the identical `graph.ainvoke()` path with the same thread ID as the text CLI, so a conversation started by voice can be continued by keyboard and vice versa. Internally it's three coordinated threads — a rumps menu bar app on the main thread (an AppKit hard requirement; all UI mutation is marshaled there), a dedicated asyncio loop for graph/STT/TTS work, and pynput's global-hotkey listener — with a small IDLE → RECORDING → PROCESSING state machine in between, and an extra ANSWERING state for spoken confirmation answers (auto-records after the question; one keypress submits).

## Setup

### Requirements

- Python 3.12 (a wheel-availability concession for Phase 5's audio deps — nothing in Phases 1–4 needs it specifically)
- Node.js (for the Gmail and Calendar MCP servers, which are separate Node/TypeScript projects run as local subprocesses)
- macOS (Phase 4's Mac-control sub-agent uses `osascript`/`open`/`shortcuts`, all macOS-only; everything else is cross-platform)
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
| `LANGSMITH_API_KEY` | Tracing | Optional but recommended — routing/tool-call traces in the LangSmith UI |
| `LANGCHAIN_TRACING_V2` | Tracing | `true` to enable |
| `LANGCHAIN_PROJECT` | Tracing | LangSmith project name |
| `LANGSMITH_ENDPOINT` | Tracing (regional accounts only) | Not in `.env.example` — only needed if your LangSmith workspace isn't on the default US endpoint (e.g. APAC) |
| `GMAIL_MCP_SERVER_PATH` | Gmail | Path to a built `Gmail-MCP-Server/dist/index.js` |
| `GOOGLE_CALENDAR_MCP_SERVER_PATH` | Calendar | Path to a built `google-calendar-mcp/build/index.js` |
| `GOOGLE_CALENDAR_MCP_CREDENTIALS` | Calendar | Path to that server's `gcp-oauth.keys.json` |
| `ASSISTANT_TTS_VOICE` | Voice (optional) | TTS voice name, default `Ava (Premium)`; falls back to the system voice with a logged warning if not installed |

Gmail and Calendar are optional at startup — if their env vars are unset or the servers aren't built yet, `main.py` prints a warning and runs without the `life_admin_agent` tools. Mac control needs no setup beyond running on macOS — see the permissions note below.

### Gmail and Calendar OAuth setup

Both integrations run as local MCP servers behind your own Google Cloud OAuth app — no third-party hosted MCP platform touches your credentials, and both servers store their tokens outside this repo (`~/.gmail-mcp/`, `~/.config/google-calendar-mcp/`).

**Gmail** — [`ArtyMcLabin/Gmail-MCP-Server`](https://github.com/ArtyMcLabin/Gmail-MCP-Server), a maintained fork that supports scoping the OAuth grant itself to `gmail.readonly`:

```sh
git clone https://github.com/ArtyMcLabin/Gmail-MCP-Server.git ~/mcp-servers/Gmail-MCP-Server
cd ~/mcp-servers/Gmail-MCP-Server && npm install && npm run build

# Google Cloud Console: new project → enable Gmail API → OAuth consent
# screen (External, add gmail.readonly scope, add yourself as a test user)
# → OAuth client (Desktop app) → download the JSON

mkdir -p ~/.gmail-mcp
mv ~/Downloads/<downloaded>.json ~/.gmail-mcp/gcp-oauth.keys.json
node dist/index.js auth --scopes=gmail.readonly
```

**Calendar** — [`nspady/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp). Unlike the Gmail fork, this server always requests the full read/write `.../auth/calendar` scope at the OAuth-grant level (not configurable) — read-only is enforced entirely on this project's side: an `ENABLED_TOOLS` startup allowlist plus a `tool_interceptors` hook that refuses write-tool calls outright before they ever reach the server. See [Security model](#security-model).

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

No API keys or config needed — but the first time each AppleScript-controlled app (Music, Reminders, Notes) or `run_shortcut` (Shortcuts automation) actually runs, macOS shows a one-time Automation permission dialog asking whether to let your terminal/Python process control that app. Click Allow. This is a per-app, first-use-only prompt — nothing to configure ahead of time.

### Voice mode

Speech-to-text runs fully locally via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`base` model, CPU) — no per-utterance API cost, no audio leaving the machine. The model downloads itself on first run.

**Nicer voice (optional, recommended):** macOS's default `say` voice is robotic. Download an Enhanced/Premium voice once — System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… — and either grab "Ava (Premium)" (the default this project looks for) or set `ASSISTANT_TTS_VOICE` to whichever you picked.

**Run it directly:**

```sh
.venv/bin/assistant-voice
```

A 🎙 icon appears in the menu bar. Press **Option+Return** (from any application) to start recording — 🔴 — and again to stop and submit; the reply is spoken and logged. When a gated action needs confirmation, the daemon speaks the question and immediately starts recording your answer — say yes or no, then one Option+Return submits it. Quit from the menu bar icon. Transcripts, confirmation outcomes, and errors go to a self-rotating log at `~/Library/Logs/PersonalAssistant/voice_daemon.log`.

**Permissions (the fiddly part):** global hotkey listening needs the **Input Monitoring** TCC grant, and — if you install the launchd autostart below — reading a project that lives under `~/Documents` needs **Full Disk Access** too, because a launchd-spawned process doesn't inherit your terminal's folder grants. The catch (learned the hard way, STEPS.md 42): the venv's Python resolves through *two* distinct executables — the framework stub that boots the interpreter and the `Python.app` bundle it re-execs into — and macOS attributes grants per-binary, so **both** need **both** grants. In each of Input Monitoring and Full Disk Access, click **+**, press Cmd+Shift+G, and add each of (adjusting the version to your Homebrew install):

```
/opt/homebrew/Cellar/python@3.12/<version>/Frameworks/Python.framework/Versions/3.12/bin/python3.12
/opt/homebrew/Cellar/python@3.12/<version>/Frameworks/Python.framework/Versions/3.12/Resources/Python.app
```

Known wart: those grants pin to the versioned Cellar path, so a `brew upgrade python@3.12` silently kills the daemon until you re-add them. Wrapping the daemon in a stable `.app` bundle (so grants attach to a bundle ID) is queued as Phase 6 polish.

**Start at login (optional):** a ready-made LaunchAgent lives in `launchd/`. It pins the working directory (for `.env` discovery) and PATH (so the Node-based MCP servers still spawn — launchd's default PATH lacks `/opt/homebrew/bin`), restarts the daemon on a crash, and stays quit after an intentional menu bar Quit:

```sh
cp launchd/com.mohitvuyyuru.assistant-voice.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mohitvuyyuru.assistant-voice.plist
```

To uninstall: `launchctl bootout gui/$(id -u)/com.mohitvuyyuru.assistant-voice` and delete the plist.

### Run

```sh
.venv/bin/assistant
```

Type `exit`/`quit`, or Ctrl+C/Ctrl+D, to leave. Conversation memory persists in `conversation_memory.sqlite` across separate launches (fixed thread ID, by design). When a tool needs confirmation, the CLI prints `[confirm] {...} Proceed? (y/n):` and pauses — type `y` or `n`.

For visual/step-by-step debugging of the graph itself (routing decisions, tool calls, message state), run `.venv/bin/langgraph dev` instead — opens [LangGraph Studio](https://github.com/langchain-ai/langgraph-studio) against the same graph, without a persistent checkpointer (Studio manages its own run state).

## Security model

Threat model: any tool that touches the web, email, calendar, or Shortcut content is a prompt-injection surface — adversarial text can arrive as a tool result and try to induce harmful actions. The mitigation lives on the *execution* side, not in filtering content:

- **Shell**: commands are parsed into an argument list and run with `shell=False` — never a shell interpreter. A denylist blocks `rm`/`sudo`/`su`/`osascript`, shell interpreters invoked with `-c`, shell metacharacters (checked as substrings, since `shlex` doesn't split on them), sensitive system paths, and common home-directory folders (Desktop/Documents/Downloads/Pictures/Movies). A general-purpose interpreter invoked with inline code (`python3 -c "..."`, `node -e "..."`) pauses for confirmation via a LangGraph interrupt — running a *file* the agent already wrote (`python3 script.py`) stays ungated, since no denylist can fully contain a Turing-complete interpreter and gutting that capability would defeat the coding agent's actual purpose.
- **Files**: confined to `workspace/`, anchored at the project root. Path traversal is rejected by resolving and checking containment; dotfiles/dotdirs are blocked independent of that check.
- **Mac control**: every action is a fixed AppleScript template (or the plain `open`/`shortcuts` CLI) invoked as an argv list — model-supplied values are passed as osascript's own positional argv, read via `on run argv`, never string-interpolated into script source. Open app / Music playback / Reminders / Notes / opening a blank Shortcut editor are ungated (private, reversible, local-only, and — for the Shortcut editor — inert until the user manually finishes and saves it). Running a *named* Shortcut always pauses for confirmation, regardless of name, since a Shortcut's actual behavior is opaque to this codebase. There is no scriptable way to author a Shortcut's logic at all — `create_shortcut` only opens a blank editor, verified empirically rather than assumed from docs.
- **Gmail**: OAuth grant itself is scoped to `gmail.readonly` — send/reply/delete/modify aren't just hidden from the model, the token can't do them. Two tools (`download_attachment`, `download_email`) write to disk from inside the separate Node server process, outside `tools.py`'s own sandbox — an interceptor forces their save path into `workspace/` and reduces filenames to their basename, regardless of what the model requests.
- **Calendar**: the OAuth grant is *not* scope-restricted (no self-hosted Calendar MCP server was found that supports it — see STEPS.md §17). Read-only is enforced by an `ENABLED_TOOLS` server-side allowlist plus a client-side interceptor that refuses write-tool calls before they reach the server. The interceptor caught a real gap during development: the server registers `manage-accounts` regardless of the allowlist.
- **Cost**: an MCP tool that defaults to expanding up to 50 full email threads into context on a single call is capped to 10 by an interceptor, rather than trusting the model to pass a small limit.
- **Standing confirmation rule**: any side-effectful or opaque action — running a named Shortcut, inline interpreter code in the shell tool — pauses the graph via a real `langgraph.types.interrupt()` and waits for an explicit confirmation before executing. This is implemented, not aspirational: the interrupt mechanic is demonstrated end-to-end (both confirm and decline paths) through the real CLI, not just tested in isolation.
- **Voice confirmation fails closed**: the spoken answer to a confirmation question only approves on a recognized affirmative — a mistranscription, an ambiguous phrase, silence, or a 30-second timeout all decline. Decline-words win when both appear ("no, don't go ahead" declines). A side-effectful action should never happen because the STT misheard.
- **Voice-mode surface notes**: the global hotkey listener is non-suppressing — Option+Return still reaches whatever app is frontmost (accepted tradeoff, low collision in practice). The daemon's log records every transcript and confirmation outcome, an audit trail for actions approved by voice.

Full reasoning, including several things that went wrong during development (a credentials-file mistake, an accidental token print, and a real gap in the shell denylist found by testing this project's own "refuse cleanly" behavior) and how they were caught, is in [STEPS.md](STEPS.md).

## Roadmap

Six phases, one active at a time — see [PLAN.md](PLAN.md) for the full plan.

1. ✅ Foundations — single agent, tool-calling, persistent memory
2. ✅ Gmail + Calendar via MCP
3. ✅ Multi-agent split — supervisor + coding/research/life-admin sub-agents, LangSmith tracing, interrupt-based confirmation gate
4. ✅ Mac-native control — allowlisted `osascript`/`open`/`shortcuts` actions, mac_control sub-agent
5. ✅ Voice I/O — local faster-whisper STT, always-on hotkey daemon in the menu bar, spoken confirmation gate, launchd autostart (this README's state)
6. Proactivity — scheduled morning briefing, repo polish

## Development

```sh
.venv/bin/python tests/test_memory.py
.venv/bin/python tests/test_tools.py
.venv/bin/python tests/test_mcp_tools.py
.venv/bin/python tests/test_interrupts.py
.venv/bin/python tests/test_mac_tools.py
.venv/bin/python tests/test_supervisor.py
.venv/bin/python tests/test_voice_io.py
```

No test framework dependency yet — each file is pytest-shaped (`def test_...(): assert ...`) but runnable directly with plain `python`. `test_mac_tools.py` and `test_voice_io.py` monkeypatch `subprocess.run` and hardware-touching internals throughout, so they run anywhere — no macOS apps, microphone, or permission grants required; that live verification is manual and recorded in STEPS.md instead.
