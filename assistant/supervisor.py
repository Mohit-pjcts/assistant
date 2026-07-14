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

Extended thinking is explicitly disabled on the supervisor's model — see
sub_agents.py's module docstring and STEPS.md 28 for why (a confirmed
langchain-anthropic streaming bug, not something specific to this file).

Parallel tool calls are explicitly disabled on the supervisor's model via
NoParallelHandoffs below — see STEPS.md 36 for the real, live-observed
failure this closes: a single turn spanning multiple domains ("check my
calendar AND search the web AND play music") made the supervisor call two
transfer_to_* tools in the same AIMessage. Each handoff tool returns a
Command(graph=Command.PARENT) trying to route the outer graph to a
different node; only one of the two ever wins, and the other's tool_use
block is left with no matching tool_result — a state corruption Anthropic's
API rejects on every subsequent call to that thread ("tool_use ids were
found without tool_result blocks"), permanently breaking the conversation
until manually repaired. This wasn't caught in Phase 3's testing because
every regression scenario there only ever exercised one domain per turn.

Phase 6 (STEPS.md 47/48): the ORIGINAL fix for STEPS.md 36 over-corrected —
it also taught the supervisor "you can only transfer to ONE specialist per
turn" in the system prompt, which combined with every sub-agent node
routing straight to END meant a compound, sequential request (e.g. "get
alfredo ingredients and save them to Notes") stalled after the first
specialist: nothing routed control back to the supervisor to dispatch the
second one. NoParallelHandoffs (one handoff tool call per model turn) was
never the problem and stays; the fix is a LOOP — sub-agents route back to
"supervisor" (not END) via _route_after_specialist below, so the supervisor
re-evaluates with the completed specialist's output already merged into
its context (verified in the repro: STEPS.md 47) and can dispatch the next
one, turn after turn, until it judges the request satisfied and answers
directly (the existing supervisor -> END default edge). The system prompt
was rewritten from "only ONE specialist per turn" to "one at a time, keep
going until done." _route_after_specialist enforces a hard MAX_HANDOFFS_PER_TURN
cap by counting completed transfer_to_* handoffs in the message history —
a structural guard, not a prompt instruction, so a supervisor that can't
decide it's done can't spin the graph forever.
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AnyMessage, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import InjectedState
from langgraph.types import Command

from assistant.compaction import compact_history_node
from assistant.memory_extraction import extract_and_propose_memory_node, recall_memory_node
from assistant.sub_agents import (
    build_coding_agent,
    build_life_admin_agent,
    build_mac_control_agent,
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
    "questions; life_admin_agent for anything about email or GOOGLE "
    "Calendar (the user's Google account calendar); mac_control_agent for "
    "controlling this Mac directly — opening or focusing an application, "
    "Music playback, Reminders, Notes, running a named Shortcut, reading/"
    "creating/updating events on APPLE Calendar (the local/iCloud/Exchange "
    "calendar in the Mac's own Calendar app — a DIFFERENT calendar system "
    "from Google Calendar; if a request just says 'calendar' with no other "
    "signal, prefer life_admin_agent's Google Calendar as the default "
    "unless the user specifically says 'Apple Calendar', 'the Calendar "
    "app', or similar), or opening a URL in Brave Browser. If the message "
    "is a plain greeting or doesn't need a specialist, answer directly "
    "without transferring. Transfer to only ONE specialist at a time, even "
    "for a request that spans multiple domains — after that specialist "
    "responds, you will see its result and can transfer to the next "
    "specialist the request needs. Keep doing this, one specialist per "
    "turn, until every part of the request has been handled, then answer "
    "directly summarizing what was done instead of transferring again."
)


class NoParallelHandoffs(AgentMiddleware):
    """Forces the supervisor to call at most one tool per turn.

    Without this, a compound request spanning multiple domains can make the
    model call two transfer_to_* tools in one AIMessage — see this module's
    docstring and STEPS.md 36 for the real corruption that caused, and why
    a hard cap here (not just the system-prompt instruction above) is the
    actual fix: prompt instructions are a hint the model can ignore under
    enough pressure, this is a structural guarantee via the Anthropic API's
    own disable_parallel_tool_use.
    """

    async def awrap_model_call(self, request, handler):  # noqa: ANN001, ANN201
        request.model_settings["parallel_tool_calls"] = False
        return await handler(request)


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
TRANSFER_TO_MAC_CONTROL = _make_handoff_tool(
    "mac_control_agent",
    "Transfer to the Mac-control specialist (apps, Music, Reminders, Notes, Shortcuts).",
)

# Hard ceiling on completed handoffs within a single outer-graph turn. Purely
# a runaway-loop guard (cost + hang risk) — a real multi-hop request needs at
# most one handoff per sub-agent, so this is generous headroom, not a tuned
# limit. Enforced structurally in _route_after_specialist, not left to the
# supervisor's own judgment: a model that can't decide it's done must not be
# able to spin the graph forever.
MAX_HANDOFFS_PER_TURN = 6


_ROUTING_BRIDGE_TEXT = (
    "[Routing note, not from the user] The specialist above has finished "
    "responding. If the original request still has an unhandled part, "
    "transfer to the specialist for it now. Otherwise respond directly, "
    "summarizing what was done."
)

# Tags a routing-bridge HumanMessage so _count_handoffs can tell it apart
# from a genuine user turn (see that function's docstring for why the
# distinction matters).
_BRIDGE_MARKER_KEY = "phase6_routing_bridge"


def _make_routing_bridge() -> HumanMessage:
    return HumanMessage(
        content=_ROUTING_BRIDGE_TEXT, additional_kwargs={_BRIDGE_MARKER_KEY: True}
    )


def _is_routing_bridge(message: AnyMessage) -> bool:
    return bool(getattr(message, "additional_kwargs", {}).get(_BRIDGE_MARKER_KEY))


def _count_handoffs(messages: list[AnyMessage]) -> int:
    """Count completed transfer_to_* handoffs since the current top-level
    user turn started — NOT the thread's lifetime total.

    This project's fixed THREAD_ID (agent.py) means one thread persists
    across every CLI invocation forever, so `messages` keeps every past
    turn's handoffs too. An earlier version of this function summed the
    whole history, which meant a thread with enough accumulated handoffs
    from PAST turns would already be at/over MAX_HANDOFFS_PER_TURN before
    the CURRENT turn even started its first specialist — routing straight
    to END and silently defeating the loop-back fix on any thread beyond
    its first few turns. Caught by inspecting the real conversation_memory
    .sqlite thread (99 messages of real accumulated use) after a fresh,
    short-lived test thread had shown the loop working correctly — the bug
    only manifests once real history has accumulated (STEPS.md 48).

    Scoped instead to messages since the most recent GENUINE HumanMessage
    (skipping this module's own _make_routing_bridge() insertions, which
    are also HumanMessages — counting from the last HumanMessage of ANY
    kind would anchor on the bridge from the previous loop iteration
    instead of the real turn boundary, undercounting just as badly).

    Derived from the synthetic ToolMessages _make_handoff_tool creates
    (name=f"transfer_to_{agent_name}") rather than a separate counter field
    on GraphState — keeps GraphState's schema exactly matching create_agent's
    own AgentState (see the class docstring), which is what lets the
    supervisor and every sub-agent be embedded as subgraph nodes with no
    manual state-transform shim.
    """
    turn_start = 0
    for i, m in enumerate(messages):
        if isinstance(m, HumanMessage) and not _is_routing_bridge(m):
            turn_start = i
    return sum(
        1
        for m in messages[turn_start:]
        if isinstance(m, ToolMessage) and (m.name or "").startswith("transfer_to_")
    )


def _route_after_specialist(state: GraphState) -> Command:
    """Outer-graph node every sub-agent routes to after finishing.

    Not a bare conditional-edge function: re-invoking the supervisor's model
    on history that ends in an AIMessage (exactly what a sub-agent's own
    final answer leaves behind) is shaped like an assistant-message prefill,
    which Anthropic's API rejects with a 400 on Sonnet 5 (verified against
    the real API while building this — the very first version of this loop
    used a plain path function and hit that error immediately). A HumanMessage
    bridge keeps the conversation ending in a non-assistant turn before the
    next model call. It never reaches the user — main.py only ever renders
    the final message, and once the supervisor answers or hands off again
    this bridge is no longer the last message in state.

    Capped by MAX_HANDOFFS_PER_TURN so a supervisor that never decides it's
    done can't spin the graph forever.

    Routes to "extract_memory" (Phase 7 Part B), not END, at the cap — every
    path that ends a turn must pass through memory extraction, the same way
    every path already passes through this node before ending; see
    build_graph()'s edges.
    """
    if _count_handoffs(state["messages"]) >= MAX_HANDOFFS_PER_TURN:
        return Command(goto="extract_memory")
    return Command(goto="supervisor", update={"messages": [_make_routing_bridge()]})


def build_supervisor() -> CompiledStateGraph:
    """Build the supervisor sub-graph — a create_agent(...) ReAct loop whose
    tools are handoff tools, not real work tools."""
    model = ChatAnthropic(model=SUPERVISOR_MODEL_NAME, thinking={"type": "disabled"})
    return create_agent(
        model=model,
        tools=[
            TRANSFER_TO_CODING,
            TRANSFER_TO_RESEARCH,
            TRANSFER_TO_LIFE_ADMIN,
            TRANSFER_TO_MAC_CONTROL,
        ],
        system_prompt=SUPERVISOR_SYSTEM_PROMPT,
        middleware=[NoParallelHandoffs()],
        name="supervisor",
    )


def build_graph(
    checkpointer: BaseCheckpointSaver | None,
    coding_extra_tools: list[BaseTool] | None,
    mcp_tools: list[BaseTool],
) -> CompiledStateGraph:
    """Assemble and compile the outer supervisor graph.

    Only this call gets a checkpointer — the supervisor and sub-agent
    subgraphs inherit it via nested checkpoint_ns automatically when
    invoked as nodes (verified: STEPS.md 24).

    Args:
        checkpointer: Owned and lifecycle-managed by the caller (main.py),
            same contract as the old agent.build_agent(). None when the
            caller's own runtime manages persistence instead (e.g. the
            LangGraph Studio dev server — see studio.py — which errors on
            local_dev if the graph brings its own checkpointer).
        coding_extra_tools: Passed through to build_coding_agent() — used
            to wire in the Phase 3 step-5 dummy interrupt tool.
        mcp_tools: The full flat tool list from mcp_tools.load_mcp_tools();
            filtered internally by build_life_admin_agent().
    """
    builder = StateGraph(GraphState)
    # Plain top-level nodes, NOT create_agent-embedded — see compaction.py's
    # module docstring for why that distinction is load-bearing (a
    # nested-subgraph SummarizationMiddleware was verified NOT to propagate
    # its compaction back to this shared state; the same property is what
    # makes recall/extraction safe to run at this level too). Both
    # compact_history and recall_memory run once per top-level CLI turn;
    # mid-turn specialist loop-backs re-enter at "supervisor" directly via
    # route_after_specialist, not through either node again.
    builder.add_node("compact_history", compact_history_node)
    # Phase 7 Part B: selective recall, injected as data before the
    # supervisor (and every specialist, via SubAgentWindowMiddleware's
    # append-after-turn-boundary ordering) ever sees the request.
    builder.add_node("recall_memory", recall_memory_node)
    builder.add_node(
        "supervisor",
        build_supervisor(),
        destinations=(
            "coding_agent",
            "research_agent",
            "life_admin_agent",
            "mac_control_agent",
            "extract_memory",
        ),
    )
    builder.add_node("coding_agent", build_coding_agent(coding_extra_tools))
    builder.add_node("research_agent", build_research_agent())
    builder.add_node("life_admin_agent", build_life_admin_agent(mcp_tools))
    builder.add_node("mac_control_agent", build_mac_control_agent())
    builder.add_node(
        "route_after_specialist",
        _route_after_specialist,
        destinations=("supervisor", "extract_memory"),
    )
    # Phase 7 Part B: proposes 0+ durable facts from the CURRENT turn's user
    # text only, each individually confirmed via interrupt() before being
    # persisted. Sits on EVERY path that ends a turn — the supervisor's own
    # default no-handoff edge, and route_after_specialist's cap-triggered
    # end — so no turn can complete without passing through it once.
    builder.add_node("extract_memory", extract_and_propose_memory_node)

    builder.add_edge(START, "compact_history")
    builder.add_edge("compact_history", "recall_memory")
    builder.add_edge("recall_memory", "supervisor")
    builder.add_edge("supervisor", "extract_memory")  # default path when no handoff tool is called
    builder.add_edge("extract_memory", END)
    # Loop back through route_after_specialist instead of ending outright: a
    # multi-hop request (STEPS.md 47) needs the supervisor to see this
    # specialist's output and decide whether another handoff is needed.
    for agent_name in (
        "coding_agent",
        "research_agent",
        "life_admin_agent",
        "mac_control_agent",
    ):
        builder.add_edge(agent_name, "route_after_specialist")

    return builder.compile(checkpointer=checkpointer)
