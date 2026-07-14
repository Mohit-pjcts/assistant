"""Phase 9 backend wrapper: a thin local HTTP server the dashboard app talks
to instead of `langgraph dev` (STEPS.md 54's scoping checkpoint).

Deliberately NOT `assistant/studio.py`'s `make_graph()` path: that one
compiles with `checkpointer=None` because the LangGraph API server manages
its own (ephemeral, `.langgraph_api/`-backed) persistence in local_dev
mode — a separate store from `conversation_memory.sqlite`. This module
instead builds the graph exactly like `main.py` does: a real
`AsyncSqliteSaver` over `conversation_memory.sqlite`, keyed by the SAME
fixed `THREAD_ID` main.py and voice_daemon.py already use. That is what
makes the dashboard app a genuine peer of the CLI/voice daemon — one shared
conversation, not a fork — and what makes the /history endpoint meaningful
(main.py's own thread has real data; the dev server's would not).

Interrupt payloads (CLAUDE.md's standing confirmation-gate rule) are relayed
to the client UNMODIFIED — never re-rendered or re-summarized. This is
load-bearing for Phase 7's memory-write gate specifically: the `fact` field
must reach the UI verbatim so it can be shown exactly as approved, per the
red-team requirement `voice_daemon.py` already enforces by declining to
speak it at all.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv

# Loaded before any other project import — same ordering reasoning as
# main.py: assistant.sub_agents/assistant.supervisor construct ChatAnthropic
# instances at module import time, so the environment must be populated
# first.
load_dotenv()

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from langchain_core.messages import BaseMessage  # noqa: E402
from langgraph.types import Command  # noqa: E402

from assistant import memory_store  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.supervisor import build_graph  # noqa: E402

# Same fixed thread as main.py — this IS the point (STEPS.md 54): the app
# shares the CLI/voice daemon's actual conversation, not a separate one.
THREAD_ID = "cli-default-thread"

# Overridable so tests/throwaway runs can redirect to a temp copy instead of
# the real conversation_memory.sqlite (CLAUDE.md's verification-discipline
# rule: throwaway scripts must not pollute real state). Read at import time,
# same "env before code runs" ordering as tools.py's TAVILY_API_KEY.
CONVERSATION_DB_PATH = os.environ.get("ASSISTANT_CONVERSATION_DB_PATH", "conversation_memory.sqlite")

# Same redirect story for the long-term facts DB — monkeypatches
# memory_store.DEFAULT_DB_PATH exactly the way memory_store's own tests
# already do (its docstring: a parameter default would bind too early to
# catch a later override, so it's resolved inside each function body).
if "ASSISTANT_MEMORY_DB_PATH" in os.environ:
    memory_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_MEMORY_DB_PATH"]


def _render_content(content: object) -> str:
    """Render a message's content as plain text. Mirrors main.py's
    `_render_content` (kept as a separate copy rather than a shared import —
    this module and main.py are two independent entry points, same as
    voice_daemon.py already duplicating its own small rendering helper)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(part for part in parts if part)
    return str(content)


def _message_role(message: BaseMessage) -> str:
    """Map a LangChain message's class to a plain role string for the
    dashboard's history panel."""
    return {
        "human": "user",
        "ai": "assistant",
        "tool": "tool",
        "system": "system",
    }.get(message.type, message.type)


def _serialize_turn_result(result: dict[str, Any]) -> dict[str, Any]:
    """Shape a graph.ainvoke()/Command-resume result into the /chat and
    /resume response body. An in-flight interrupt takes priority: the
    client must resolve it via /resume before any further /chat calls are
    meaningful (mirrors main.py's `while "__interrupt__" in result` loop,
    just surfaced to an HTTP caller turn-by-turn instead of looped
    in-process)."""
    if "__interrupt__" in result:
        # Passed through exactly as the tool constructed it (interrupts.py,
        # memory_extraction.py) — no re-rendering, per this module's
        # docstring.
        return {"type": "interrupt", "payload": result["__interrupt__"][0].value}
    final_message = result["messages"][-1]
    return {"type": "message", "content": _render_content(final_message.content)}


class ChatRequest(BaseModel):
    message: str


class ResumeRequest(BaseModel):
    approved: bool


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Own the checkpointer for the server's process lifetime, same
    contract main.py's `async with get_checkpointer()` block has — opened
    once, not per-request."""
    try:
        mcp_tools = await load_mcp_tools()
    except Exception:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        mcp_tools = []

    async with get_checkpointer(CONVERSATION_DB_PATH) as checkpointer:
        graph = build_graph(checkpointer, [send_test_notification], mcp_tools)
        app.state.graph = graph
        app.state.config = make_thread_config(THREAD_ID)
        yield


app = FastAPI(lifespan=lifespan)


@app.post("/chat")
async def chat(request: ChatRequest) -> dict[str, Any]:
    try:
        result = await app.state.graph.ainvoke(
            {"messages": [("user", request.message)]},
            config=app.state.config,
        )
    except Exception as exc:  # network errors, rate limits, etc. — data, not a crash
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return _serialize_turn_result(result)


@app.post("/resume")
async def resume(request: ResumeRequest) -> dict[str, Any]:
    try:
        result = await app.state.graph.ainvoke(
            Command(resume=request.approved),
            config=app.state.config,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return _serialize_turn_result(result)


@app.get("/history")
async def history() -> dict[str, Any]:
    """Read the shared thread's persisted state via the public
    `graph.aget_state()` API — not by hand-parsing the checkpointer's own
    serialized SQLite rows (STEPS.md 54 flagged this as real parsing work
    the wrong way to do it)."""
    snapshot = await app.state.graph.aget_state(app.state.config)
    messages: list[BaseMessage] = snapshot.values.get("messages", [])
    return {
        "messages": [
            {"role": _message_role(m), "content": _render_content(m.content)}
            for m in messages
        ]
    }


@app.get("/memory/facts")
async def list_memory_facts() -> dict[str, Any]:
    facts = await memory_store.list_facts()
    return {
        "facts": [
            {
                "id": f.id,
                "content": f.content,
                "provenance": f.provenance,
                "created_at": f.created_at,
            }
            for f in facts
        ]
    }


@app.delete("/memory/facts/{fact_id}")
async def delete_memory_fact(fact_id: int) -> dict[str, Any]:
    """User-initiated deletion of their own already-saved fact — curation,
    not a new agent side effect, so this deliberately does NOT go through
    interrupt() (that gate is for the agent writing autonomously; see
    memory_extraction.py's docstring). No confirmation-gate change implied."""
    deleted = await memory_store.delete_fact(fact_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No fact with id {fact_id}")
    return {"deleted": True}
