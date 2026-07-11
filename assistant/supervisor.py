"""Supervisor + outer graph assembly.

The supervisor's own create_agent(...) graph and the three sub-agent graphs
are each embedded as one node of a hand-built StateGraph; routing between
them uses LangGraph's Command handoff pattern (PLAN.md Phase 3 step 1
checkpoint: hand-rolled graph, chosen over the langgraph-supervisor library
for full control over interrupt placement and checkpoint_ns namespacing).

Mechanic verified against real execution before this file was written for
real, not assumed — see STEPS.md 24: a standalone spike confirmed the
handoff actually routes, the final message list has no orphaned tool calls,
and checkpoint_ns nests automatically under the parent node's name.
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AnyMessage, ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import InjectedState
from langgraph.types import Command

from assistant.sub_agents import (
    build_coding_agent,
    build_life_admin_agent,
    build_research_agent,
)

# Self-contained on import, same reasoning as tools.py/agent.py.
load_dotenv()


class GraphState(TypedDict):
    """Outer graph state. Mirrors create_agent's own AgentState.messages
    field exactly (Annotated[list[AnyMessage], add_messages]) — this is what
    lets a compiled create_agent(...) sub-agent graph be added directly as a
    node with no manual state-transform shim."""

    messages: Annotated[list[AnyMessage], add_messages]


SUPERVISOR_MODEL_NAME = "claude-sonnet-5"

SUPERVISOR_SYSTEM_PROMPT = (
    "You are the routing supervisor of a personal assistant. Decide which "
    "specialist to hand off to and transfer immediately — do not attempt "
    "the task yourself. Hand off to coding_agent for file/shell tasks in "
    "the workspace, and also for any request to send a test/demo "
    "notification; research_agent for web search / current-events "
    "questions; life_admin_agent for anything about email or calendar. If "
    "the message is a plain greeting or doesn't need a specialist, answer "
    "directly without transferring."
)


def _make_handoff_tool(agent_name: str, description: str) -> BaseTool:
    """Build a handoff tool that transfers control to `agent_name`.

    Uses InjectedState to carry the supervisor subgraph's current message
    list — including a synthetic ToolMessage closing out this tool call —
    into the Command's update. A normal state return inside the
    supervisor's own internal subgraph does NOT auto-sync to the outer
    graph; only graph=Command.PARENT writes do, and without the synthetic
    ToolMessage the outer graph would carry an orphaned tool call, which
    would break the next Anthropic API call.
    """
    tool_name = f"transfer_to_{agent_name}"

    @tool(tool_name, description=description)
    def handoff(
        state: Annotated[GraphState, InjectedState],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        tool_message = ToolMessage(
            content=f"Transferred to {agent_name}.",
            name=tool_name,
            tool_call_id=tool_call_id,
        )
        return Command(
            goto=agent_name,
            update={"messages": [*state["messages"], tool_message]},
            graph=Command.PARENT,
        )

    return handoff


TRANSFER_TO_CODING = _make_handoff_tool(
    "coding_agent", "Transfer to the coding/file/shell specialist."
)
TRANSFER_TO_RESEARCH = _make_handoff_tool(
    "research_agent", "Transfer to the web research specialist."
)
TRANSFER_TO_LIFE_ADMIN = _make_handoff_tool(
    "life_admin_agent", "Transfer to the Gmail/Calendar specialist."
)


def build_supervisor() -> CompiledStateGraph:
    """Build the supervisor sub-graph — a create_agent(...) ReAct loop whose
    tools are handoff tools, not real work tools."""
    model = ChatAnthropic(model=SUPERVISOR_MODEL_NAME)
    return create_agent(
        model=model,
        tools=[TRANSFER_TO_CODING, TRANSFER_TO_RESEARCH, TRANSFER_TO_LIFE_ADMIN],
        system_prompt=SUPERVISOR_SYSTEM_PROMPT,
        name="supervisor",
    )


def build_graph(
    checkpointer: BaseCheckpointSaver,
    coding_extra_tools: list[BaseTool] | None,
    mcp_tools: list[BaseTool],
) -> CompiledStateGraph:
    """Assemble and compile the outer supervisor graph.

    Only this call gets a checkpointer — the supervisor and sub-agent
    subgraphs inherit it via nested checkpoint_ns automatically when
    invoked as nodes (verified: STEPS.md 24).

    Args:
        checkpointer: Owned and lifecycle-managed by the caller (main.py),
            same contract as the old agent.build_agent().
        coding_extra_tools: Passed through to build_coding_agent() — used
            to wire in the Phase 3 step-5 dummy interrupt tool.
        mcp_tools: The full flat tool list from mcp_tools.load_mcp_tools();
            filtered internally by build_life_admin_agent().
    """
    builder = StateGraph(GraphState)
    builder.add_node(
        "supervisor",
        build_supervisor(),
        destinations=("coding_agent", "research_agent", "life_admin_agent", END),
    )
    builder.add_node("coding_agent", build_coding_agent(coding_extra_tools))
    builder.add_node("research_agent", build_research_agent())
    builder.add_node("life_admin_agent", build_life_admin_agent(mcp_tools))

    builder.add_edge(START, "supervisor")
    builder.add_edge("supervisor", END)  # default path when no handoff tool is called
    builder.add_edge("coding_agent", END)
    builder.add_edge("research_agent", END)
    builder.add_edge("life_admin_agent", END)

    return builder.compile(checkpointer=checkpointer)
