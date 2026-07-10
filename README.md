# assistant

A personal AI assistant built on the Claude API and [LangGraph](https://github.com/langchain-ai/langgraph). Runs as a CLI with persistent conversation memory, tool-calling (web search, sandboxed file/shell access, Gmail, Google Calendar), and a security model built around the assumption that anything a tool returns — a search result, an email, a calendar event — could be adversarial.

Not "Jarvis." Deliberately.

## What it can do today

- Hold a conversation that persists across separate launches (SQLite-backed).
- Search the web (Tavily).
- Read and write files in a sandboxed workspace, and run shell commands there — with a denylist blocking destructive commands, shell metacharacters, and shell-interpreter escapes.
- Search and read Gmail (read-only — cannot send, reply, delete, or modify).
- Search and read Google Calendar (read-only — cannot create, update, delete, or respond to events).

Email and calendar content is treated as untrusted input throughout: the system prompt tells the model not to follow instructions embedded in message/event content, and — more importantly — the tools themselves are built so an adversarial instruction has nothing dangerous to reach even if the model is fooled. See [Security model](#security-model) below.

## Architecture

```
assistant/
├── main.py       # CLI loop — async, owns checkpointer + MCP tool loading lifetime
├── agent.py      # build_agent(checkpointer, tools) + make_thread_config(thread_id)
├── tools.py      # Phase 1 hand-secured tools: web search, file r/w, shell exec
├── mcp_tools.py  # Phase 2 MCP integration: Gmail + Calendar, async, with interceptors
└── memory.py     # get_checkpointer() — async context manager over AsyncSqliteSaver
tests/            # pytest-shaped, runnable directly with plain python
workspace/        # the ONLY directory file/shell tools (and confined MCP downloads) may touch — runtime-created
PLAN.md           # six-phase build plan; only one phase is ever "active"
STEPS.md          # full build log — every decision, bug, and why
```

The agent itself is a single [`langchain.agents.create_agent`](https://docs.langchain.com/oss/python/langchain/agents) graph — no custom `StateGraph`, no multi-agent supervisor (that's Phase 3). `tools.py`'s tools are synchronous and hand-written; `mcp_tools.py`'s tools are loaded asynchronously at startup from locally-run MCP servers and merged into the same tool list the agent sees. Because MCP-loaded tools only support async invocation, the whole CLI runs on `graph.ainvoke()`, not `graph.invoke()` — see STEPS.md §14 for why that's a hard requirement, not a style choice.

## Setup

### Requirements

- Python 3.12 (a wheel-availability concession for Phase 5's audio deps — nothing in Phases 1–4 needs it specifically)
- Node.js (for the Gmail and Calendar MCP servers, which are separate Node/TypeScript projects run as local subprocesses)
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
| `LANGSMITH_API_KEY` | (unused until Phase 3) | Tracing isn't wired up yet |
| `GMAIL_MCP_SERVER_PATH` | Gmail | Path to a built `Gmail-MCP-Server/dist/index.js` |
| `GOOGLE_CALENDAR_MCP_SERVER_PATH` | Calendar | Path to a built `google-calendar-mcp/build/index.js` |
| `GOOGLE_CALENDAR_MCP_CREDENTIALS` | Calendar | Path to that server's `gcp-oauth.keys.json` |

Gmail and Calendar are optional at startup — if their env vars are unset or the servers aren't built yet, `main.py` prints a warning and runs with the web/file/shell tools only.

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

### Run

```sh
.venv/bin/assistant
```

Type `exit`/`quit`, or Ctrl+C/Ctrl+D, to leave. Conversation memory persists in `conversation_memory.sqlite` across separate launches (fixed thread ID, by design).

## Security model

Threat model: any tool that touches the web, email, or calendar content is a prompt-injection surface — adversarial text can arrive as a tool result and try to induce harmful actions. The mitigation lives on the *execution* side, not in filtering content:

- **Shell**: commands are parsed into an argument list and run with `shell=False` — never a shell interpreter. A denylist blocks `rm`/`sudo`/`su`, shell interpreters invoked with `-c`, shell metacharacters (checked as substrings, since `shlex` doesn't split on them), and sensitive system paths.
- **Files**: confined to `workspace/`, anchored at the project root. Path traversal is rejected by resolving and checking containment; dotfiles/dotdirs are blocked independent of that check.
- **Gmail**: OAuth grant itself is scoped to `gmail.readonly` — send/reply/delete/modify aren't just hidden from the model, the token can't do them. Two tools (`download_attachment`, `download_email`) write to disk from inside the separate Node server process, outside `tools.py`'s own sandbox — an interceptor forces their save path into `workspace/` and reduces filenames to their basename, regardless of what the model requests.
- **Calendar**: the OAuth grant is *not* scope-restricted (no self-hosted Calendar MCP server was found that supports it — see STEPS.md §17). Read-only is enforced by an `ENABLED_TOOLS` server-side allowlist plus a client-side interceptor that refuses write-tool calls before they reach the server. The interceptor caught a real gap during development: the server registers `manage-accounts` regardless of the allowlist.
- **Cost**: an MCP tool that defaults to expanding up to 50 full email threads into context on a single call is capped to 10 by an interceptor, rather than trusting the model to pass a small limit.
- **Standing rule**: any side-effectful action (sending email, creating events, Mac control) requires explicit confirmation before execution — enforced today by keeping those tools out of scope entirely; LangGraph interrupts formalize this in Phase 3.

Full reasoning, including two things that went wrong during development (a credentials-file mistake and an accidental token print) and how they were caught, is in [STEPS.md](STEPS.md).

## Roadmap

Six phases, one active at a time — see [PLAN.md](PLAN.md) for the full plan.

1. ✅ Foundations — single agent, tool-calling, persistent memory
2. ✅ Gmail + Calendar via MCP (this README's state)
3. Multi-agent split — supervisor + coding/research/life-admin sub-agents, LangSmith tracing, interrupt-based confirmation gate
4. Mac-native control — allowlisted `osascript` actions
5. Voice I/O — local STT, `say` for TTS
6. Proactivity — scheduled morning briefing, repo polish

## Development

```sh
.venv/bin/python tests/test_memory.py
.venv/bin/python tests/test_tools.py
.venv/bin/python tests/test_mcp_tools.py
```

No test framework dependency yet — each file is pytest-shaped (`def test_...(): assert ...`) but runnable directly with plain `python`.
