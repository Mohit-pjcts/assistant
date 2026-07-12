"""LangGraph Studio / `langgraph dev` entry point.

Exposes the same supervisor graph as main.py, but compiled WITHOUT a
checkpointer — the LangGraph API server manages persistence itself in
local_dev mode and raises ("persistence is handled automatically by the
platform") if the graph brings its own. Referenced by langgraph.json's
"graphs" entry.
"""

from __future__ import annotations

from dotenv import load_dotenv
from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

from assistant.interrupts import send_test_notification
from assistant.mcp_tools import load_mcp_tools
from assistant.supervisor import build_graph

# Self-contained on import, same reasoning as tools.py/agent.py.
load_dotenv()


async def make_graph(config: RunnableConfig) -> CompiledStateGraph:
    """Factory consumed by langgraph.json's "graphs" entry.

    `config` is required by the factory-function contract the LangGraph API
    server dispatches to; unused here since this project has no
    per-request graph configuration.
    """
    try:
        mcp_tools = await load_mcp_tools()
    except Exception:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        mcp_tools = []

    return build_graph(
        checkpointer=None,
        coding_extra_tools=[send_test_notification],
        mcp_tools=mcp_tools,
    )
