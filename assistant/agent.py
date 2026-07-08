"""LangGraph agent definition: graph construction and tool-calling loop."""

from __future__ import annotations

from typing import Any

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph.state import CompiledStateGraph

from assistant.tools import TOOLS

# Self-contained on import, same reasoning as tools.py — ChatAnthropic reads
# ANTHROPIC_API_KEY at construction time.
load_dotenv()

MODEL_NAME = "claude-sonnet-5"

SYSTEM_PROMPT = (
    "You are a personal assistant with three tools available: web search, "
    "file read/write (confined to a local workspace directory), and shell "
    "command execution (also confined to that workspace, with destructive "
    "commands blocked). Use a tool when it would get a better or more "
    "current answer than reasoning alone. Be direct and concise."
)


def build_agent(checkpointer: BaseCheckpointSaver) -> CompiledStateGraph:
    """Build the compiled LangGraph agent, wired to the given checkpointer.

    Args:
        checkpointer: A checkpoint saver — e.g. from
            memory.get_checkpointer() — used to persist conversation state
            across turns. Owned and lifecycle-managed by the caller; this
            function only wires it in.

    Returns:
        A compiled LangGraph agent, ready to `.invoke()` or `.stream()`
        with a config built by `make_thread_config()`.
    """
    model = ChatAnthropic(model=MODEL_NAME)
    return create_agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )


def make_thread_config(thread_id: str) -> dict[str, Any]:
    """Build the LangGraph invocation config for a given conversation thread.

    Always sets both thread_id and checkpoint_ns explicitly — memory.py's
    test surfaced that the underlying SqliteSaver requires checkpoint_ns
    when checkpoints are read/written, so it's set here rather than relying
    on it being defaulted elsewhere.

    Args:
        thread_id: Identifier for the conversation thread (e.g. a UUID
            generated once per CLI session).
    """
    return {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
