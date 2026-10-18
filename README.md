# assistant



https://github.com/user-attachments/assets/c5269687-a2e9-4c33-8092-fb9eb6206b40



A personal AI assistant built on the Claude API and [LangGraph](https://github.com/langchain-ai/langgraph). Runs as a CLI and a Tauri desktop dashboard (voice included) — both talking to the same conversation, the same memory, and the same graph. A supervisor routes each request to the right specialist sub-agent (coding, research, email/calendar, Mac control) and can chain several in one turn. Side-effectful actions — sending an email, creating a calendar event, running a Shortcut, writing a durable memory — always pause for an explicit confirmation first. The whole thing is built around the assumption that anything a tool returns (a search result, an email, a calendar event, a Note) could be adversarial.

## What it can do today

- Hold a conversation that persists across separate launches (SQLite-backed), routed by a supervisor to the right specialist sub-agent, with **multiple named conversation threads** you can create/switch/rename/delete from the CLI or the dashboard — not just one endless thread.
- **Coding**: read/write files in a sandboxed workspace and run shell commands there — argument-list execution only (never a shell interpreter), a denylist blocking destructive commands and AppleScript, and a confirmation gate on inline interpreter code (`python3 -c "..."`).
- **Research**: search the web (Tavily); can resolve objective ambiguity itself (current date/time, a real-world fact) instead of asking you, while still asking when it's a genuine preference only you can supply.
- **Life-admin**: search/read Gmail *and* send email, archive/label messages, and create/delete Gmail filters; search/read Google Calendar *and* create/update/delete events. Every write pauses for confirmation showing the verbatim content (real recipient, real body, real event details) — never an LLM summary of what it's about to do.
- **Mac control**: open/focus an app, control Music.app playback, read/create Reminders and Notes, start a new Shortcut in the editor (you finish and save it), run a named Shortcut (confirmation-gated), read/create/update Apple Calendar events (create/update gated, mirrors the Google Calendar pattern), and open a URL in Brave.
- **Memory**: short-term — conversation history is automatically compacted (summarized) once it grows large, so cost/latency don't scale with a thread's entire lifetime. Long-term — the agent can propose durable facts about you worth remembering across conversations (always behind a confirmation gate showing the exact fact text, never voice-approvable), recalled selectively on later turns, never dumped wholesale.
- **Voice**: tap the mic button in the dashboard's chat composer to talk to it and hear it answer — speech-to-text running fully locally (`mlx-whisper large-v3`, no audio ever leaves the machine), replies spoken back via the browser's own Web Speech API. A voice turn is a normal chat turn (same streaming, same history) rather than a separate process, so it always shows up live, no refresh needed. Gated actions still confirm by click, same as typed turns — free-text gate content (email body, memory fact, event description) was never voice-approvable to begin with.
- **Dashboard ("Oni")**: a Tauri + React desktop app — a landing Home tab (adapted from an Astryx Playground design) that hands a typed message, a prompt-suggestion card, or a recorded voice message straight into a live chat with token-streaming responses and a Stop button, full conversation history, memory viewer, a per-day/week/all-time cost panel (real LangSmith aggregates), a thread sidebar, a live right-hand rail (agent activity graph, tool-call timeline, cost summary), and a kanban board the assistant can read and write directly. Tauri owns the Python backend's process lifecycle — launching the app starts it, quitting it stops it.
- **Photos and files in chat**: attach an image or a text file to a message; images are downsampled server-side before reaching Claude's vision model (keeps token cost sane on a large screenshot or photo).
- Side-effectful or opaque actions pause the conversation for an explicit confirmation before executing, via a real LangGraph interrupt — not just a prompt instruction. In the text CLI that's a y/n prompt; in the dashboard it's a real UI affordance rendering the verbatim payload, regardless of whether the turn that reached it was typed or spoken.

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
├── server.py              # FastAPI wrapper over the graph — /chat, /resume (SSE streaming +
│                            stop-mid-run), /history, /memory/facts, /cost, /threads,
│                            /voice/transcribe; shares the CLI's real checkpointer +
│                            active-thread pointer
├── interrupts.py          # Dummy confirmation-gated tool — the interrupt mechanic's test fixture
├── compaction.py          # Short-term context compaction + per-sub-agent history windowing
├── memory_store.py        # Long-term durable-facts storage (separate SQLite file)
├── memory_extraction.py   # Long-term memory: source-restricted extraction, confirmation gate,
│                            selective recall — see its module docstring for the full security design
├── thread_store.py        # Multi-thread registry + active-thread pointer (separate SQLite file)
├── board_store.py         # Kanban board storage (separate SQLite file)
├── board_tools.py         # Kanban board tools for life_admin_agent — deliberately ungated
│                            (local, in-app, fully reversible — not an external side effect)
├── thinking_repair.py     # Repairs a confirmed langchain-anthropic streaming bug so extended
│                            thinking can stay enabled without corrupting conversation state
├── voice_io.py            # Local STT (mlx-whisper) reached via an arbitrary audio file —
│                            server.py's /voice/transcribe, shared by the dashboard's own mic
│                            button and the phone/PWA path
└── memory.py              # get_checkpointer() — async context manager over AsyncSqliteSaver

dashboard/                 # Tauri 2 + React + TypeScript desktop app ("Oni")
├── src/
│   ├── App.tsx             # three-column shell: thread sidebar · tabs (home/chat/history/
│   │                          memory/cost/board) · live right-hand context rail
│   ├── lib/api.ts          # typed client for assistant/server.py, incl. SSE streaming
│   ├── themes/oniMatcha/   # ember-recolored Astryx theme, applied app-wide
│   └── components/
│       ├── chat/           # ChatPanel (streaming + Stop) + InterruptGate (per-action gate UI)
│       ├── home/           # landing tab — greeting, prompt suggestions, hands off into chat
│       ├── board/           # kanban board UI, backed by board_store.py/board_tools.py
│       ├── history/        # full unfiltered conversation feed
│       ├── memory/         # view + delete durable facts
│       ├── cost/           # LangSmith cost aggregates
│       ├── threads/        # thread sidebar — new/switch/rename/delete
│       └── activity/       # live agent-activity graph, tool-call timeline, status pill
└── src-tauri/              # Rust shell — owns the Python backend's process lifecycle end-to-end
                               (spawn on launch, kill on quit)

tests/            # pytest-shaped (test_*.py / test_* / assert), run with `pytest`
workspace/        # the ONLY directory file/shell tools (and confined MCP downloads) may touch
PLAN.md           # phase-by-phase build plan; only one phase is ever "active"
STEPS.md          # full build log — every decision, bug, and why
```

A hand-built outer `StateGraph` (`supervisor.py`) holds a routing supervisor and four sub-agents, each itself a [`langchain.agents.create_agent`](https://docs.langchain.com/oss/python/langchain/agents) graph embedded as a node. Routing uses LangGraph's `Command`-based handoff-tool pattern — the supervisor never sees a sub-agent's own tool list, only what its own system prompt says that sub-agent owns, so every new sub-agent's capabilities have to be described in `SUPERVISOR_SYSTEM_PROMPT` explicitly. A sub-agent's result routes back through a re-evaluating supervisor (capped per turn) rather than ending the turn outright, so a single request can chain multiple specialists — "get me a recipe and save the ingredients to Notes" hits research then Mac control in one turn. `checkpoint_ns` nests automatically per sub-agent under the shared checkpointer. `tools.py`/`mac_tools.py`'s tools are synchronous and hand-written; `mcp_tools.py`'s tools are loaded asynchronously at startup from locally-run MCP servers and merged in. Because MCP-loaded tools only support async invocation, the whole CLI runs on `graph.ainvoke()`; the dashboard streams via `graph.astream_events()`. LangSmith tracing is wired up so routing decisions and sub-agent tool calls are inspectable as real trace trees, not just final answers, and backs the dashboard's cost panel. A `langgraph dev` entry point (`studio.py`) exposes the same graph to LangGraph Studio for local, visual debugging.

Extended thinking (`thinking={"type": "adaptive"}`) is enabled on all five agent models, paired everywhere with `ThinkingBlockRepairMiddleware` — a real `langchain-anthropic` bug can drop a streamed thinking block's required field during SSE chunk merging, which the Anthropic API then rejects on replay; the middleware repairs the malformed shape before it ever reaches persisted state, rather than disabling the feature project-wide to avoid it.

Voice lives entirely inside the dashboard now, not a separate process: `ChatPanel.tsx`'s mic button records via the browser's own `MediaRecorder`, uploads to `server.py`'s `/voice/transcribe` (local mlx-whisper, same model the phone/PWA path already used), and feeds the transcript through the exact same `handleSend` a typed message takes — so a voice turn streams live into the open chat with no separate sync mechanism needed. Replies are spoken back via the browser's own Web Speech API, only for turns that originated by voice. (An earlier design ran voice as an always-on menu-bar daemon with a global Option+Return hotkey, retired in favor of this in-app version — see STEPS.md for the change.)

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

Voice lives inside the dashboard's chat composer — no separate process, no extra setup. Speech-to-text runs fully locally via [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) (`large-v3`, Apple Silicon only — no per-utterance API cost, no audio leaving the machine) behind `server.py`'s `/voice/transcribe`; the model loads lazily on first use rather than at server startup. Tap the mic button, speak, tap again to stop — the transcript sends like a typed message, and the reply is spoken back via the browser's own Web Speech API. The only permission involved is the standard macOS microphone prompt the Tauri window shows the first time you tap the mic (its `Info.plist` already declares `NSMicrophoneUsageDescription`) — no Input Monitoring or Full Disk Access grants needed.

*(An earlier design ran voice as an always-on menu-bar daemon with a global Option+Return hotkey and spoken confirmation answers — retired in favor of the in-app version above; see STEPS.md for why.)*

### Dashboard app

```sh
cd dashboard
npm install
npm run tauri dev
```

This launches the Tauri window, which itself spawns the Python backend (`uvicorn assistant.server:app`) as a child process — quitting the window stops it too. No need to run `assistant` separately when using the dashboard. `npm run build` produces a release bundle.

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
- **Standing confirmation rule**: any side-effectful or opaque action pauses the graph via a real `langgraph.types.interrupt()` and waits for an explicit confirmation before executing — demonstrated end-to-end (both confirm and decline paths) through the real CLI and dashboard, not just tested in isolation. A voice-originated turn hits the exact same click-based gate as a typed one — there is no separate voice-answerable path. The kanban board (`board_tools.py`) is the deliberate exception this rule already carves out: local, in-app, fully reversible actions aren't gated — the same category `open_url_in_brave` sits in below.
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
10. ✅ Proactivity + polish — extended thinking re-enabled behind a verified repair middleware, Haiku-for-research_agent evaluated (stays on Sonnet 5), pytest adopted (CI declined by choice), README refreshed, voice accuracy accepted as-is; the originally-planned morning-briefing feature was cut from scope entirely
11. ✅ Skills cleanup + a standing skill-vetting policy
12. ✅ Email + Google Calendar WRITE access — gated send/modify/create/update/delete, verbatim confirmation
13. ✅ Apple Calendar (read + gated write) + open-URL-in-Brave
14. ✅ UI rework — full visual redesign, SSE streaming + stop-mid-run, Tauri owns backend/voice process lifecycle
15. ✅ Multi-thread conversation support — thread registry, delete, persistent sidebar
16. ✅ Langfuse integration — tracing, prompt management, evaluations (v2 → v3), plus a distributed-tracing spike (real OTEL `traceparent` propagation, streaming relay, live abort-on-stop)
17. ✅ A2UI generative UI — agents can render structured, optionally interactive cards/forms in the dashboard via a constrained, allowlisted component vocabulary, always display/input-only — no new side-effect path
18. ✅ A2UI extended to specialist sub-agents + surfaces persist across a reload
19. ✅ Startup/cost/voice bug fixes + the "Oni" dashboard redesign — three-column layout with a live agent-activity right rail
20. ✅ Astryx redesign integration — an ember-recolored theme, the chat panel restyled on Astryx components, photo/file uploads, a real kanban board with full agent access, and a landing page adapted from an Astryx Playground design

## Development

```sh
.venv/bin/pytest
```

`tests/` is pytest-shaped (`def test_...(): assert ...`, `test_*.py` naming) and also runnable directly with plain `python tests/test_x.py` if you'd rather not install pytest. Most files hit real APIs (Anthropic, Tavily, LangSmith) rather than mocking — by design, per this project's testing convention — so a full run has a small real cost and takes about a minute. `test_mac_tools.py` monkeypatches `subprocess.run` throughout and `test_voice_io.py` monkeypatches the STT model call, so they run anywhere — no macOS apps, microphone, or permission grants required; live verification of the real integrations is manual and recorded in STEPS.md instead. No CI is wired up — a deliberate choice given the no-mocking convention (either paying for API calls on every push, or a lint-only CI that doesn't prove the suite passes); see STEPS.md.
