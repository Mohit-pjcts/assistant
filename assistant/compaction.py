"""Short-term context compaction — Phase 7 Part A.

Bounds the ever-growing shared thread history (fixed THREAD_ID, agent.py) by
summarizing the oldest turns once total history crosses a self-imposed
fraction of a self-imposed token budget (never the model's actual 1M-token
context window — CLAUDE.md's cost-consciousness rule and PLAN.md's Phase 7
checkpoint: 50,000-token budget, trigger at 60% = 30,000, sized off real
LangSmith trace data from 2026-07-12/13 real usage: per-call prompt tokens
ran median 4,384 / mean 4,928 / max 13,027, and one full multi-hop turn hit
40,041 cumulative prompt tokens — the direct cause of the "everything gets
sent as context, it's slow and expensive" complaint this phase exists to
fix).

CRITICAL, discovered via a real spike before writing this module (throwaway
scripts, not committed; findings logged in STEPS.md): a create_agent(...)
sub-agent embedded as a subgraph node (as supervisor.py does for the
supervisor and every specialist) CANNOT compact the outer graph's shared
state by attaching langchain.agents.middleware's SummarizationMiddleware to
it — RemoveMessage ops resolved inside the subgraph's own internal reducer
never cross the subgraph boundary as explicit removal instructions to the
parent, so the outer graph's checkpointed history only grows, never shrinks
(verified empirically: 13 seed messages became 15 after "compaction" via the
nested-subgraph approach — worse than a no-op). The fix verified here:
compaction MUST be a plain top-level graph node (not create_agent-embedded)
whose own return value is merged directly by the outer graph's own
add_messages reducer, where RemoveMessage(id=REMOVE_ALL_MESSAGES) is honored
correctly (verified: 13 -> 4 with the same approach used below).
"""

from __future__ import annotations

from typing import Any

from dotenv import load_dotenv
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AnyMessage, HumanMessage, RemoveMessage
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.graph.message import REMOVE_ALL_MESSAGES

# Self-contained on import, same reasoning as tools.py/agent.py.
load_dotenv()

# Self-imposed budget — see module docstring for the real-trace numbers this
# is sized against. 50,000 sits above the observed single-call max (13K) so
# one dense tool result can't trip compaction mid-turn, and below the worst
# full-turn measured (40K) so a repeat of that turn gets caught before it
# reaches that cost.
TOKEN_BUDGET = 50_000
TRIGGER_FRACTION = 0.6
TRIGGER_TOKENS = int(TOKEN_BUDGET * TRIGGER_FRACTION)  # 30,000

# How much of the tail to keep verbatim once compaction fires. A token
# budget, not a message count — turn sizes vary too much (a tool result can
# dwarf a plain text exchange) for a fixed count to mean anything consistent.
KEEP_TOKENS = 15_000

# Cheap model for summarization — CLAUDE.md: "Default to Haiku where
# Sonnet-level reasoning isn't needed." Summarizing conversation that already
# happened is exactly that case; the summary quality bar is much lower than
# live agent reasoning.
SUMMARIZER_MODEL_NAME = "claude-haiku-4-5"

# Matches supervisor.py's own marker key for the Phase 6 routing-bridge
# HumanMessage — duplicated here (not imported) to avoid a supervisor.py <->
# compaction.py import cycle; both modules independently need to recognize
# it as "not a genuine user turn boundary."
_BRIDGE_MARKER_KEY = "phase6_routing_bridge"
_SUMMARY_MARKER_KEY = "phase7_compaction_summary"
_RECALLED_FACTS_MARKER_KEY = "phase7_recalled_facts"

_SUMMARY_PROMPT = (
    "Summarize the following personal-assistant conversation history in a "
    "few sentences, preserving concrete facts (names, dates, file paths, "
    "decisions made) over prose. If a '[Summary of earlier conversation: "
    "...]' block appears first, treat it as prior context to fold into the "
    "new summary, not raw dialogue to re-describe.\n\n{transcript}"
)


def is_genuine_human_turn(message: AnyMessage) -> bool:
    """A real user-turn boundary — not a synthetic HumanMessage the graph
    itself inserts (the Phase 6 routing bridge, marking a mid-turn re-entry
    into the supervisor after a specialist finishes; or Phase 7 Part B's
    recalled-facts injection, memory_extraction.py's recall_memory_node).
    Exported: also used by sub_agents.py's SubAgentWindowMiddleware to
    window each specialist's own model calls to the CURRENT top-level turn
    — the same boundary this module uses for compaction, since both are
    instances of "never split what belongs to one turn," just applied to
    different problems (bounding growth over calendar time here; bounding
    cross-turn context leakage there — STEPS.md 48)."""
    if not isinstance(message, HumanMessage):
        return False
    kwargs = getattr(message, "additional_kwargs", {})
    return not (kwargs.get(_BRIDGE_MARKER_KEY) or kwargs.get(_RECALLED_FACTS_MARKER_KEY))


def is_compaction_summary(message: AnyMessage) -> bool:
    """True for the synthetic summary message compaction inserts at the
    front of history. Exported so sub_agents.py's per-agent windowing
    (SubAgentWindowMiddleware) can always preserve it even when windowing to
    a narrower slice — otherwise a specialist invoked well into a compacted
    thread would lose all awareness of what happened before its own handoff.
    """
    return bool(getattr(message, "additional_kwargs", {}).get(_SUMMARY_MARKER_KEY))


def tag_recalled_facts(message: HumanMessage) -> None:
    """Marks a HumanMessage as Part B's recalled-facts injection, in place,
    so is_genuine_human_turn excludes it. A function rather than exposing
    the raw marker key, so memory_extraction.py doesn't need to know the
    literal dict shape."""
    message.additional_kwargs[_RECALLED_FACTS_MARKER_KEY] = True


def _find_keep_boundary(messages: list[AnyMessage]) -> int:
    """Largest index i such that messages[i] starts a genuine user turn and
    messages[i:] fits within KEEP_TOKENS.

    Only ever splits at genuine-user-turn boundaries — never mid AIMessage/
    ToolMessage pairing, which would leave an orphaned tool_use block and
    400 on the next Anthropic API call (STEPS.md 36's lesson, still load-
    bearing here).

    Falls back to the start of the most recent turn even if it alone
    exceeds KEEP_TOKENS — the turn currently being responded to is never
    summarized away.
    """
    turn_starts = [i for i, m in enumerate(messages) if is_genuine_human_turn(m)]
    if not turn_starts:
        return 0
    best = turn_starts[-1]
    for i in reversed(turn_starts):
        if count_tokens_approximately(messages[i:]) <= KEEP_TOKENS:
            best = i
        else:
            break
    return best


def compact_history_node(state: dict[str, Any]) -> dict[str, Any]:
    """Top-level graph node — NOT create_agent-embedded; see module
    docstring for why that distinction is load-bearing. Wired at
    START -> compact_history -> supervisor in supervisor.py's build_graph(),
    so it runs once per top-level CLI turn (mid-turn specialist loop-backs
    re-enter at "supervisor" directly, not through this node again — see
    supervisor.py's route_after_specialist).
    """
    messages: list[AnyMessage] = state["messages"]
    if count_tokens_approximately(messages) < TRIGGER_TOKENS:
        return {}

    keep_from = _find_keep_boundary(messages)
    if keep_from == 0:
        # Nothing safe to summarize — the single most recent turn alone
        # already exceeds the keep budget. Let it through uncompacted rather
        # than risk cutting mid-turn.
        return {}

    to_summarize = messages[:keep_from]
    kept = messages[keep_from:]

    transcript = "\n".join(
        f"{type(m).__name__}: "
        f"{m.content if isinstance(m.content, str) else m.content!r}"
        for m in to_summarize
    )
    model = ChatAnthropic(model=SUMMARIZER_MODEL_NAME, thinking={"type": "disabled"})
    summary_text = model.invoke(
        [HumanMessage(content=_SUMMARY_PROMPT.format(transcript=transcript))]
    ).content

    summary_message = HumanMessage(
        content=f"[Summary of earlier conversation: {summary_text}]",
        additional_kwargs={_SUMMARY_MARKER_KEY: True},
    )

    return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), summary_message, *kept]}
