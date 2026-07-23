"""Supervisor + outer graph assembly.

**Agents-as-tools rewrite (superseded the Command-handoff architecture this
module used from Phase 3 through Phase 16 Part B).** The old design embedded
each specialist as its own StateGraph node, reached via a `transfer_to_*`
tool returning `Command(graph=Command.PARENT)` to redirect the OUTER graph.
That produced a real, user-visible problem in Langfuse tracing: because
LangGraph nodes are peers in a graph, not calls into each other, every node
(`compact_history`, `supervisor`, `coding_agent`, `route_after_specialist`,
`extract_memory`, ...) traced as a flat sibling of the graph's own root run.
The only nesting that ever appeared was an accidental side effect of
`Command.PARENT` recursing into the parent graph from inside a tool's own
call stack — not a real, readable call hierarchy. Confirmed live (not just
inferred) by pulling a real trace's raw, unfiltered observation list via the
Langfuse API: `extract_memory` was found firing in PARALLEL with the first
`coding_agent` attempt, both as direct children of the root graph, because
the then-current build still had `builder.add_edge("supervisor",
"extract_memory")` as a plain, unconditional edge — LangGraph fires a node's
static edges regardless of whatever `Command.PARENT` redirect a tool inside
that node's own subgraph ALSO issued in the same step. (A `_route_after_
supervisor` conditional-edge fix for this existed uncommitted in the working
tree at the time this rewrite started; this rewrite removes the whole
mechanism the bug lived in, rather than keeping it fixed.)

The fix is architectural, not cosmetic: specialists are no longer graph
nodes reached by routing. Each one is a TOOL the supervisor calls directly
— `await specialist_graph.ainvoke(...)` from inside a `@tool` function. A
specialist's entire run is then a genuine nested child of the supervisor's
own tool-call span, and a multi-hop request becomes the supervisor's own
ReAct loop calling more than one tool in sequence — no more bouncing out to
a separate `route_after_specialist` node, no more `Command.PARENT`, no more
conditional-edge routing between "did the supervisor hand off or answer
directly."  This collapses build_graph() down to a plain, un-conditional
five-node pipeline: `compact_history -> recall_memory -> supervisor ->
extract_memory -> END`.

**Why this is safe for the confirmation gate (verified BEFORE this rewrite,
not assumed):** every gated tool in this project (`interrupts.
send_test_notification`, everything in `write_tools.py`, `mac_tools.py`'s
gated tools) depends on `interrupt()`/`Command(resume=...)` pausing and
resuming correctly. Under the old architecture that worked because a
specialist was a real graph node sharing the outer graph's checkpointer.
Under this rewrite, a specialist is invoked via a bare `await
other_graph.ainvoke(...)` from inside a tool function — a pattern LangGraph's
own docs explicitly call out as NOT statically discoverable ("does not work
when a subgraph is called inside a tool function or other indirection")
without confirming interrupt propagation for it either way. Rather than trust
that gap, this was spiked empirically before any real code changed: first a
minimal bare-StateGraph version (inner graph with an `interrupt()`-calling
node, invoked with NO config and NO checkpointer of its own, from inside an
outer node's plain function body), then the real call path this rewrite
actually uses (an outer `create_agent(...)` graph whose `@tool` function
invokes ANOTHER `create_agent(...)` graph with a gated tool, through
`create_agent`'s real ToolNode, checkpointer only on the outer graph). Both
spikes: interrupt surfaced correctly at the outer `ainvoke()`'s
`__interrupt__` key, and `Command(resume=...)` correctly replayed the
interrupted tool call and resumed with the right value — the mechanism relies
on `interrupt()`'s own resume-tracking being scoped to the ambient
task/contextvar chain, which threads through a nested `ainvoke()` call from a
tool function exactly as it would through a plain node, as long as the INNER
graph has no checkpointer of its own (giving it one would let it try to
absorb/resolve the interrupt itself, breaking the replay-matching the outer
graph's checkpointer relies on). This is why every `build_*_agent()` in
sub_agents.py stays checkpointer-less, same as before this rewrite — that
detail was already correct for the old architecture and turns out to be
exactly what this one needs too.

**Context propagation, now explicit instead of implicit:** the old
architecture gave every specialist the outer graph's ENTIRE shared message
history for free (windowed to the current turn by sub_agents.py's now-removed
`SubAgentWindowMiddleware`, which existed specifically to bound that
sharing). Since a specialist call is now a fresh, isolated `ainvoke()` with
its own message list, there is no shared state left to leak — the
cross-turn-leakage bug class `SubAgentWindowMiddleware` was built to close
(STEPS.md 48) is now structurally impossible rather than mitigated. What
still needs forwarding on purpose is done on purpose, by
`_context_prefix_messages()`: the compaction summary (if the thread has one)
and the CURRENT turn's recalled-facts message (Phase 7 Part B), prepended to
whatever instruction the supervisor's own model composed for that specialist
call.

**Known, disclosed limitation carried over from this rewrite (not silently
dropped):** `write_tools.py`'s `MAX_WRITES_PER_TURN` counts gated-write
`ToolMessage`s in whatever state it's handed via `InjectedState`. Under the
old architecture that state was the outer graph's own shared history, so the
cap correctly spanned every `life_admin_agent` handoff within one top-level
turn. Under this rewrite, each call to the `life_admin_agent` tool starts a
FRESH, isolated sub-agent conversation, so the cap now applies per
tool-call, not per top-level turn — a compound turn that calls
`life_admin_agent` more than once could in principle exceed 3 total writes
across those calls, each still individually confirmed via its own
`interrupt()`. write_tools.py's own docstring already frames
`MAX_WRITES_PER_TURN` as "generous headroom... purely a runaway-loop /
confirmation-fatigue guard," not the actual security boundary (that's the
per-action confirmation gate, untouched by this rewrite) — flagged here
rather than fixed, since closing it properly needs a persisted, per-turn,
per-specialist accumulated history (a real state-schema addition) and this
rewrite's actual goal was the trace shape, not this cap's scope. Revisit if
this gap turns out to matter in practice.

**Upfront confirmation (explicitly discussed and authorized, not a silent
change to the confirmation gate's guarantees):** `GATED_ACTIONS` below is a
CLOSED, enumerated list of every action any specialist tool can gate on —
not a general "the model decides what's risky" mechanism. The
`request_gated_action_confirmation` tool lets the supervisor ask for
confirmation, in its own words, BEFORE delegating to a specialist, once it
recognizes the request maps to one of these known actions. Once approved,
the specific action name is threaded into that specialist's own isolated
conversation (`GatedAgentState.pre_approved_actions`, sub_agents.py), and
the underlying gated tool (interrupts.send_test_notification, write_tools.py's
writes, mac_tools.py's gated tools) skips its OWN `interrupt()` call ONLY
for that specific, already-cleared action name — every other case still
gates exactly as it always did (defense in depth: a specialist deciding on
a gated action the supervisor never anticipated is still individually
gated at the point it actually happens, not silently allowed through).

This is a real, accepted weakening of the previous guarantee, not a
relabeling of the same thing: what the supervisor shows upfront is ITS OWN
understanding of the request (parsed from the user's own words, not a
blind guess — the user's own phrasing usually already contains the
specifics, e.g. "send a notification saying X"), not necessarily
byte-identical to whatever the specialist's own, separate reasoning step
ends up constructing when it actually builds the tool call. The two could
diverge. Bounding this to a small, closed, explicitly-enumerated action
list (rather than an open-ended "ask whenever the model feels it should")
is what keeps the residual risk small and auditable — the full list is
always exactly `GATED_ACTIONS`'s keys, nothing implicit.
"""

from __future__ import annotations

import json
from functools import partial
from typing import Annotated, Any, Awaitable, Callable, TypedDict

import httpx
from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_anthropic import ChatAnthropic
from langchain_core.callbacks import adispatch_custom_event
from langchain_core.messages import AnyMessage, HumanMessage, ToolMessage
from langchain_core.messages.utils import convert_to_messages
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_config
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import InjectedState
from langgraph.types import Command, interrupt

from assistant import observability, prompts
from assistant.compaction import (
    compact_history_node,
    is_compaction_summary,
    is_genuine_human_turn,
    is_recalled_facts_message,
)
from assistant.memory_extraction import extract_and_propose_memory_node, recall_memory_node
from assistant.sub_agents import (
    build_coding_agent,
    build_life_admin_agent,
    build_mac_control_agent,
    build_research_agent,
)
from assistant.thinking_repair import ThinkingBlockRepairMiddleware

# Phase 16 Part A.5 (the mentor's distributed-tracing spike, PLAN.md):
# toggles research_agent between its normal in-process embedding and the
# HTTP-proxied version calling assistant/fa_service.py as a separate
# process. Spike-scoped, off by default; flip to demonstrate the
# distributed hop without touching any other sub-agent. Under this
# rewrite the toggle picks which `invoke` callable _make_specialist_tool
# closes over — see build_supervisor() below — rather than which graph
# node gets registered, since specialists are tools now, not nodes.
RESEARCH_AGENT_VIA_HTTP = False
RESEARCH_FA_URL = "http://127.0.0.1:8100/research"
RESEARCH_FA_STREAM_URL = "http://127.0.0.1:8100/research/stream"

# Self-contained on import, same reasoning as tools.py/agent.py.
load_dotenv()


class GraphState(TypedDict):
    """Outer graph state. Mirrors create_agent's own AgentState.messages
    field exactly (Annotated[list[AnyMessage], add_messages]) — this is what
    lets the compiled create_agent(...) supervisor graph be added directly
    as a node with no manual state-transform shim."""

    messages: Annotated[list[AnyMessage], add_messages]


# The CLOSED, enumerated list every upfront confirmation is bounded to — see
# this module's docstring for the full why a closed list (not "the model
# decides what's risky") is what keeps this design's accepted TOCTOU
# weakening small and auditable. Every key here is a REAL tool name that
# ALSO independently gates itself via interrupt() (interrupts.py,
# write_tools.py, mac_tools.py) — this dict only controls what the
# supervisor is ALLOWED to pre-clear, never removes any tool's own gate.
GATED_ACTIONS: dict[str, str] = {
    "send_test_notification": "coding_agent",
    "send_email": "life_admin_agent",
    "modify_gmail_labels": "life_admin_agent",
    "create_calendar_event": "life_admin_agent",
    "update_calendar_event": "life_admin_agent",
    "delete_calendar_event": "life_admin_agent",
    "create_gmail_filter": "life_admin_agent",
    "delete_gmail_filter": "life_admin_agent",
    "run_shortcut": "mac_control_agent",
    "calendar_create_event": "mac_control_agent",
    "calendar_update_event": "mac_control_agent",
}

# additional_kwargs marker key on the ToolMessage request_gated_action_
# confirmation returns when approved — how _pre_approved_actions_this_turn
# finds it without free-text parsing.
_GATED_ACTION_APPROVED_KEY = "gated_action_approved"


SUPERVISOR_MODEL_NAME = "claude-sonnet-5"

# Langfuse prompt name: "supervisor-system-prompt" (scripts/
# sync_prompts_to_langfuse.py). This constant is the mandatory local
# fallback. Reworded for this rewrite's tool-calling framing (was
# "hand off"/"transfer" language matching the old Command-handoff
# mechanism) — the routing guidance itself (which specialist owns what,
# the Apple/Google Calendar disambiguation, the one-specialist-at-a-time
# rule, the objective-fact-lookup rule) is unchanged. The Langfuse-hosted
# copy needs re-syncing (scripts/sync_prompts_to_langfuse.py) after this
# change lands, or Langfuse keeps serving the stale handoff-oriented text.
SUPERVISOR_SYSTEM_PROMPT_FALLBACK = (
    "You are the routing supervisor of a personal assistant. You do not do "
    "specialist work yourself — you call the right specialist tool with a "
    "clear, self-contained instruction (it does not see the rest of this "
    "conversation, only what you put in that instruction). Use coding_agent "
    "for file/shell tasks in the workspace, and also for any request to "
    "send a test/demo notification; research_agent for web search / "
    "current-events questions; life_admin_agent for anything about email or "
    "GOOGLE Calendar (the user's Google account calendar); mac_control_agent "
    "for controlling this Mac directly — opening or focusing an "
    "application, Music playback, Reminders, Notes, running a named "
    "Shortcut, reading/creating/updating events on APPLE Calendar (the "
    "local/iCloud/Exchange calendar in the Mac's own Calendar app — a "
    "DIFFERENT calendar system from Google Calendar; if a request just says "
    "'calendar' with no other signal, prefer life_admin_agent's Google "
    "Calendar as the default unless the user specifically says 'Apple "
    "Calendar', 'the Calendar app', or similar), or opening a URL in Brave "
    "Browser. If the message is a plain greeting or doesn't need a "
    "specialist, answer directly without calling a tool. Call only ONE "
    "specialist tool at a time, even for a request that spans multiple "
    "domains — after it returns, you will see its result and can call the "
    "next specialist the request needs. Keep doing this, one specialist "
    "call at a time, until every part of the request has been handled, "
    "then answer directly summarizing what was done instead of calling "
    "another tool. If completing the request depends on an OBJECTIVE fact "
    "you can look up rather than a genuine preference only the user can "
    "supply — the current date/time, the user's current timezone, a "
    "real-world fact — resolve it yourself via research_agent before "
    "finishing, instead of asking the user or silently guessing. Still ask "
    "the user directly when the missing piece is a genuine preference or "
    "decision only they can make (which meeting time they want, who to "
    "invite, and similar).\n\n"
    "Before delegating a request that clearly involves one of these "
    "specific actions — " + ", ".join(sorted(GATED_ACTIONS)) + " — call "
    "request_gated_action_confirmation FIRST, describing in `summary` "
    "exactly what will happen using the real specifics from the user's own "
    "request (the actual message text, the actual recipient, the actual "
    "event time — not a vague paraphrase). Only after it comes back "
    "approved should you delegate to the specialist that performs it; that "
    "specialist's own confirmation for this exact action is already "
    "satisfied, so it will just proceed without asking again. If declined, "
    "do not delegate at all — tell the user directly that it was "
    "cancelled. This applies ONLY to the actions listed above — everything "
    "else (reads, searches, non-destructive Mac control, and any specialist "
    "action not in that list) needs no upfront confirmation at all."
)

SUPERVISOR_SYSTEM_PROMPT = prompts.get_prompt(
    "supervisor-system-prompt", SUPERVISOR_SYSTEM_PROMPT_FALLBACK
)


class NoParallelSpecialistCalls(AgentMiddleware):
    """Forces the supervisor to call at most one tool per model turn.

    Mirrors the old NoParallelHandoffs — same underlying reason survives the
    rewrite unchanged: server.py's SSE/`/resume` handling only relays the
    FIRST pending interrupt in a turn, so two gated specialist calls issued
    in the same AIMessage could strand the second one's confirmation with no
    way to approve/decline it. A structural cap (disable_parallel_tool_use
    via the Anthropic API), not left to the system prompt's own instruction.
    """

    async def awrap_model_call(self, request, handler):  # noqa: ANN001, ANN201
        request.model_settings["parallel_tool_calls"] = False
        return await handler(request)


def _context_prefix_messages(state: GraphState) -> list[AnyMessage]:
    """What a fresh, isolated specialist call would otherwise miss, forwarded
    on purpose: the compaction summary (if this thread has been compacted)
    and the CURRENT top-level turn's recalled-facts message (Phase 7 Part
    B) — both previously visible to every specialist for free via shared
    graph state (see this module's docstring for why that's gone). Recall
    is scoped to the current turn boundary the same way
    memory_extraction.py's own `_current_turn_user_text` is, so a stale
    recalled-facts message from an earlier turn is never re-forwarded."""
    messages = state["messages"]
    prefix: list[AnyMessage] = []
    if messages and is_compaction_summary(messages[0]):
        prefix.append(messages[0])
    turn_start = 0
    for i, m in enumerate(messages):
        if is_genuine_human_turn(m):
            turn_start = i
    for m in messages[turn_start:]:
        if is_recalled_facts_message(m):
            prefix.append(m)
    return prefix


def _pre_approved_actions_this_turn(state: GraphState) -> set[str]:
    """Which GATED_ACTIONS the supervisor already got upfront confirmation
    for, THIS turn only — scanned the same turn-boundary way
    `_context_prefix_messages` and memory_extraction.py's
    `_current_turn_user_text` are, so an approval from an earlier,
    unrelated turn is never carried forward. Reads a structured marker
    (`_GATED_ACTION_APPROVED_KEY` in additional_kwargs), not the
    ToolMessage's free-text content — deliberately, so this can't be
    fooled by a coincidentally-similar-looking string anywhere else in the
    conversation."""
    messages = state["messages"]
    turn_start = 0
    for i, m in enumerate(messages):
        if is_genuine_human_turn(m):
            turn_start = i
    approved: set[str] = set()
    for m in messages[turn_start:]:
        if isinstance(m, ToolMessage):
            action = getattr(m, "additional_kwargs", {}).get(_GATED_ACTION_APPROVED_KEY)
            if action:
                approved.add(action)
    return approved


def _make_confirmation_tool() -> BaseTool:
    """The supervisor's own upfront-confirmation tool — see this module's
    docstring for the full design and its accepted tradeoff. Returns a
    `Command` (not a plain string) so the approval can be recorded as a
    structured marker on the ToolMessage itself
    (`_GATED_ACTION_APPROVED_KEY`), which `_pre_approved_actions_this_turn`
    later scans for — the same Command-returning-tool pattern this
    codebase already used for the pre-rewrite handoff tools."""

    @tool(
        "request_gated_action_confirmation",
        description=(
            "Ask the user to confirm a side-effectful action BEFORE delegating "
            "to the specialist that would perform it. Call this first whenever "
            "the request clearly involves one of the known gated actions: "
            + ", ".join(sorted(GATED_ACTIONS)) + ". Give `summary` in plain "
            "language describing exactly what will happen, using the specific "
            "details from the user's own request (e.g. the real message text, "
            "the real recipient, the real event time) — not a vague "
            "paraphrase. Once approved, immediately delegate to the owning "
            "specialist with the same request; that specialist's own "
            "confirmation for this exact action is automatically satisfied, so "
            "it will just proceed. If declined, do not delegate — tell the "
            "user it was cancelled instead."
        ),
    )
    async def request_gated_action_confirmation(
        action: str,
        summary: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        if action not in GATED_ACTIONS:
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=(
                                f"Error: {action!r} is not a recognized gated action. "
                                f"Valid actions: {sorted(GATED_ACTIONS)}."
                            ),
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        approved = interrupt(
            {
                "action": action,
                "summary": summary,
                # Upfront confirmations cover free-text-shaped content by
                # nature (a message, an email body, an event description) —
                # same reasoning as every other text-only gate in this
                # project (CLAUDE.md's security model): harder to vet by
                # ear than a bare action verb, so never voice-approvable.
                "voice_approvable": False,
            }
        )
        content = (
            f"Approved — proceed with the {action} action via the "
            f"{GATED_ACTIONS[action]} specialist now; its own confirmation "
            "for this exact action is already satisfied."
            if approved
            else f"Declined by the user — do not delegate a request that "
            f"depends on {action}. Tell the user it was cancelled."
        )
        marker = {_GATED_ACTION_APPROVED_KEY: action} if approved else {}
        return Command(
            update={
                "messages": [
                    ToolMessage(content=content, tool_call_id=tool_call_id, additional_kwargs=marker)
                ]
            }
        )

    return request_gated_action_confirmation


async def _invoke_agent_graph(
    agent_graph: CompiledStateGraph, messages: list[AnyMessage], pre_approved_actions: set[str]
) -> str:
    """The in-process specialist path: a fresh, isolated `ainvoke()` per
    call — see this module's docstring for why the specialist graph must
    stay checkpointer-less (sub_agents.py) for interrupt()/resume to work
    correctly through this nested-call shape. `pre_approved_actions` feeds
    `GatedAgentState` (sub_agents.py) — the specialist's own gated tools
    check it via InjectedState (see supervisor.py's module docstring)."""
    result = await agent_graph.ainvoke(
        {"messages": messages, "pre_approved_actions": pre_approved_actions}
    )
    final = result["messages"][-1]
    return final.content if isinstance(final.content, str) else str(final.content)


async def _invoke_research_agent_via_http(
    messages: list[AnyMessage], pre_approved_actions: set[str]
) -> str:
    """`pre_approved_actions` accepted for a uniform call signature with
    `_invoke_agent_graph` (see `_make_specialist_tool`) but unused here —
    research_agent has no gated tools, GATED_ACTIONS owns none of them.

    Phase 16 Part A.5 (the mentor's distributed-tracing spike): replaces
    the in-process `research_agent` call with an HTTP call to
    `assistant/fa_service.py` running as its own process — reproducing
    Nova's superagent-to-functional-agent hop in miniature. Adapted for this
    rewrite to take a plain `messages` list (this tool call's own isolated
    context) instead of the outer GraphState — `fa_service.py` itself
    already only ever wanted a plain message list, so it needed no change.

    Uses `langgraph.config.get_config()` rather than a config parameter, to
    reach the ambient thread_id from inside a tool function without
    changing this function's call signature — same technique the pre-
    rewrite version of this function used from inside a graph node.

    Cross-process trace nesting: real OTEL context propagation
    (`observability.inject_trace_headers()`), unchanged from before this
    rewrite — see git history for the full why (Phase 16 Part B, STEPS.md
    89/91).

    Streaming relay + error handling: unchanged from before this rewrite —
    consumes `fa_service.py`'s `/research/stream` SSE endpoint, re-dispatches
    tokens via `adispatch_custom_event`, and turns a failed/incomplete
    request into a returned error string rather than an uncaught exception
    (CLAUDE.md's "tool errors are data, not exceptions" rule) instead of the
    AIMessage-in-a-dict shape the old graph-node version returned.
    """
    config = get_config()
    thread_id = config["configurable"]["thread_id"]
    outgoing = [m.model_dump() for m in messages]
    trace_headers = observability.inject_trace_headers()

    final_messages_raw: list[dict[str, Any]] | None = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as client, client.stream(
            "POST",
            RESEARCH_FA_STREAM_URL,
            json={"messages": outgoing, "thread_id": thread_id},
            headers=trace_headers,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                try:
                    payload = json.loads(line[len("data: ") :])
                except json.JSONDecodeError:
                    continue
                event_type = payload.get("type")
                if event_type == "token":
                    text = payload.get("text")
                    if text:
                        await adispatch_custom_event("research_fa_token", {"text": text})
                elif event_type == "final":
                    final_messages_raw = payload.get("messages", [])
                elif event_type == "error":
                    return f"Research request failed: {payload.get('detail', 'unknown error')}"
    except httpx.HTTPError as exc:
        return (
            f"Research request failed: could not reach the research "
            f"service ({type(exc).__name__})."
        )

    if final_messages_raw is None:
        return (
            "Research request did not complete (the research service "
            "closed the connection without returning a result)."
        )

    final_messages = convert_to_messages(final_messages_raw)
    if not final_messages:
        return "Research request returned no result."
    final = final_messages[-1]
    return final.content if isinstance(final.content, str) else str(final.content)


def _make_specialist_tool(
    tool_name: str,
    description: str,
    invoke: Callable[[list[AnyMessage], set[str]], Awaitable[str]],
) -> BaseTool:
    """Build a tool that delegates to one specialist — the "agents as
    tools" replacement for the old `_make_handoff_tool`'s
    `Command(graph=Command.PARENT)` redirect. `invoke` is either
    `_invoke_agent_graph` bound to a specialist's own compiled graph
    (`functools.partial`), or `_invoke_research_agent_via_http` when
    RESEARCH_AGENT_VIA_HTTP is set.

    `state: Annotated[GraphState, InjectedState]` reads the OUTER graph's
    state (this tool call is still one of the supervisor's own tools, so
    InjectedState resolves against the supervisor's graph, not the
    specialist's) to build both `_context_prefix_messages()` AND
    `_pre_approved_actions_this_turn()` — the latter is the upfront-
    confirmation mechanism's actual handoff point: whatever GATED_ACTIONS
    the supervisor already confirmed via `request_gated_action_confirmation`
    THIS turn gets forwarded into the specialist's own isolated state
    (`GatedAgentState.pre_approved_actions`), which is what lets its own
    gated tool skip a redundant second confirmation. `state` itself is
    NEVER passed to the specialist — only `seed` and `pre_approved`.
    """

    @tool(tool_name, description=description)
    async def call_specialist(
        request: str, state: Annotated[GraphState, InjectedState]
    ) -> str:
        seed = [*_context_prefix_messages(state), HumanMessage(content=request)]
        pre_approved = _pre_approved_actions_this_turn(state)
        return await invoke(seed, pre_approved)

    return call_specialist


_CODING_TOOL_DESCRIPTION = (
    "Delegate a coding/file/shell task (or a request to send a test/demo "
    "notification) to the coding specialist. Give it a clear, "
    "self-contained instruction — it only sees what you pass in `request`, "
    "not the rest of this conversation."
)
_RESEARCH_TOOL_DESCRIPTION = (
    "Delegate a web-search / current-events / real-world-fact question to "
    "the research specialist. Give it a clear, self-contained instruction."
)
_LIFE_ADMIN_TOOL_DESCRIPTION = (
    "Delegate a Gmail or Google Calendar task to the life-admin specialist. "
    "Give it a clear, self-contained instruction; every write action it "
    "takes still pauses for the user's own confirmation regardless of what "
    "you ask for."
)
_MAC_CONTROL_TOOL_DESCRIPTION = (
    "Delegate a Mac-control task (apps, Music, Reminders, Notes, Shortcuts, "
    "Apple Calendar, or opening a URL in Brave) to the Mac-control "
    "specialist. Give it a clear, self-contained instruction; gated actions "
    "still pause for the user's own confirmation regardless of what you "
    "ask for."
)


def build_supervisor(
    coding_agent_graph: CompiledStateGraph,
    research_agent_graph: CompiledStateGraph,
    life_admin_agent_graph: CompiledStateGraph,
    mac_control_agent_graph: CompiledStateGraph,
) -> CompiledStateGraph:
    """Build the supervisor — a create_agent(...) ReAct loop whose tools
    delegate to each specialist's own compiled graph directly, rather than
    being handoff tools that redirect a separate outer graph (see this
    module's docstring)."""
    model = ChatAnthropic(model=SUPERVISOR_MODEL_NAME, thinking={"type": "adaptive"})
    research_invoke = (
        _invoke_research_agent_via_http
        if RESEARCH_AGENT_VIA_HTTP
        else partial(_invoke_agent_graph, research_agent_graph)
    )
    tools = [
        _make_confirmation_tool(),
        _make_specialist_tool(
            "coding_agent", _CODING_TOOL_DESCRIPTION, partial(_invoke_agent_graph, coding_agent_graph)
        ),
        _make_specialist_tool("research_agent", _RESEARCH_TOOL_DESCRIPTION, research_invoke),
        _make_specialist_tool(
            "life_admin_agent",
            _LIFE_ADMIN_TOOL_DESCRIPTION,
            partial(_invoke_agent_graph, life_admin_agent_graph),
        ),
        _make_specialist_tool(
            "mac_control_agent",
            _MAC_CONTROL_TOOL_DESCRIPTION,
            partial(_invoke_agent_graph, mac_control_agent_graph),
        ),
    ]
    return create_agent(
        model=model,
        tools=tools,
        system_prompt=SUPERVISOR_SYSTEM_PROMPT,
        middleware=[NoParallelSpecialistCalls(), ThinkingBlockRepairMiddleware()],
        name="supervisor",
    )


def build_graph(
    checkpointer: BaseCheckpointSaver | None,
    coding_extra_tools: list[BaseTool] | None,
    mcp_tools: list[BaseTool],
) -> CompiledStateGraph:
    """Assemble and compile the outer graph.

    Only this call gets a checkpointer — the supervisor subgraph inherits it
    via nested checkpoint_ns automatically when invoked as a node (verified:
    STEPS.md 24); each specialist graph stays deliberately checkpointer-less
    (see this module's docstring for why that's load-bearing under this
    rewrite, not just carried over from the old architecture).

    A plain, unconditional five-node pipeline — no more conditional edges,
    no more `Command`-based routing, no more `destinations=` tuples: since
    specialists are tools now, the supervisor node always naturally
    completes with a final answer, so there is nothing left to route
    between "handed off" and "answered directly."

    Args:
        checkpointer: Owned and lifecycle-managed by the caller (main.py).
        coding_extra_tools: Passed through to build_coding_agent() — used
            to wire in the Phase 3 step-5 dummy interrupt tool.
        mcp_tools: The full flat tool list from mcp_tools.load_mcp_tools();
            filtered internally by build_life_admin_agent().
    """
    coding_agent_graph = build_coding_agent(coding_extra_tools)
    research_agent_graph = build_research_agent()
    life_admin_agent_graph = build_life_admin_agent(mcp_tools)
    mac_control_agent_graph = build_mac_control_agent()

    builder = StateGraph(GraphState)
    builder.add_node("compact_history", compact_history_node)
    builder.add_node("recall_memory", recall_memory_node)
    builder.add_node(
        "supervisor",
        build_supervisor(
            coding_agent_graph, research_agent_graph, life_admin_agent_graph, mac_control_agent_graph
        ),
    )
    # Phase 7 Part B: proposes 0+ durable facts from the CURRENT turn's user
    # text only, each individually confirmed via interrupt() before being
    # persisted. Unconditionally after "supervisor" now — every turn ends
    # with the supervisor's own final answer, so there is no longer a
    # separate "did it hand off or answer" branch to gate this on.
    builder.add_node("extract_memory", extract_and_propose_memory_node)

    builder.add_edge(START, "compact_history")
    builder.add_edge("compact_history", "recall_memory")
    builder.add_edge("recall_memory", "supervisor")
    builder.add_edge("supervisor", "extract_memory")
    builder.add_edge("extract_memory", END)

    return builder.compile(checkpointer=checkpointer)
