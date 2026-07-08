# Project: Personal AI Assistant

## Goal

A general-purpose personal assistant, built on the Claude API + LangGraph, that can
handle "anything" — coding help, research, life admin (email/calendar), Mac-native
control, and voice interaction. This is a personal project, but it will be published on GitHub — so code
quality, structure, and an eventual README matter. Treat it as a portfolio piece.

## Current Phase: Phase 1 (MVP)

Only build what this phase needs. Don't jump ahead to multi-agent, MCP, or voice yet.

**Phase 1 deliverable:** a single LangGraph agent with tool-calling (web search, file
read/write, shell execution) and persistent conversation memory via a SQLite checkpointer.
Should run as a CLI loop I can chat with.

**Roadmap (for context only — do not build ahead of current phase):**

1. Foundations — basic LangGraph agent + tool calling + SQLite memory (CURRENT)
2. Core tools via MCP — filesystem / web search / shell MCP servers
3. Multi-agent split — supervisor + sub-agents (coding, research, life-admin, mac-control)
4. Mac-native control — AppleScript/osascript bridge, Shortcuts integration
5. Voice I/O — speech-to-text in, text-to-speech out (this is a firm feature, not
   optional — but it comes after the core agent/tools are solid, not before)
6. Proactivity + polish — launchd scheduled tasks, nicer interface

## Tech Stack

- Python 3.11+
- LangGraph + LangChain for orchestration
- Anthropic SDK (`anthropic` package) — Claude API, NOT the Pro/Max subscription
  (billing is separate — pay-per-token via Console account)
- Model choice: Sonnet for the main/supervisor agent reasoning, Haiku for cheap routing
  or simple sub-tasks, to keep API costs down
- Memory: SQLite via LangGraph's checkpointer for now (short-term/conversation).
  Long-term/fact memory (vector store, e.g. Chroma) comes in a later phase — don't add yet.
- Tool access in later phases via `langchain-mcp-adapters` + existing MCP servers
  (filesystem, Gmail, Calendar, etc.) rather than hand-rolled API wrappers
- Voice (Phase 5): local STT (e.g. faster-whisper) + macOS `say` or a TTS API — decide
  specifics when we get there, don't lock this in now

## Conventions

- Python: type hints on function signatures, docstrings on public functions/classes
- Keep agent/tool/graph code in separate modules from day one (e.g. `agent.py`,
  `tools.py`, `memory.py`, `main.py`) even in Phase 1, so it's easy to extend into the
  multi-agent structure in Phase 3 without a rewrite
- No premature abstraction — Phase 1 is one agent, not a framework. Resist building a
  generic "plugin system" this early.
- Prefer small, testable functions over large monolithic ones
- Use environment variables (`.env`, loaded via `python-dotenv`) for the API key —
  never hardcode it or commit it. Add `.env` to `.gitignore` immediately.

## Cost awareness

This calls the Claude API directly (pay-per-token), separate from any Pro/Max
subscription. Default to Haiku wherever the task doesn't need Sonnet-level reasoning,
and mention estimated token/cost impact for any design choice that could get expensive
(e.g. long system prompts on every call, verbose tool outputs fed back into context).

## Git — IMPORTANT

I commit and push myself. Do not run `git commit`, `git push`, or `git add` on your
own initiative, and do not commit automatically at the end of a task. Instead, when a
chunk of work is in a good state to save, tell me explicitly: what changed, why it's a
sensible commit boundary, and a suggested commit message — then let me run the
commands. If I ask you to just "commit this," confirm what's being committed first.

## Updates

Write each step in a file. Every step taken. Every update. Every bug fix. Organize it coherently using numbers and date&time.
