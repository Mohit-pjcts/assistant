"""Tests for assistant.interrupts. Runnable directly (no test framework required yet).

Tests the LangGraph interrupt/resume mechanic in isolation from the
supervisor handoff mechanic (see test elsewhere for that) — a minimal
single-node graph wrapping just send_test_notification, so a failure here
can't be confused with a handoff-routing bug.
"""

import asyncio
import tempfile
import uuid
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from assistant.interrupts import send_test_notification
from assistant.memory import get_checkpointer


class State(TypedDict):
    result: str | None


def _act_node(state: State) -> dict:
    result = send_test_notification.invoke({"message": "test notification"})
    return {"result": result}


def _build_graph(checkpointer):
    builder = StateGraph(State)
    builder.add_node("act", _act_node)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=checkpointer)


async def test_interrupt_then_resume_confirmed() -> None:
    """Resuming with Command(resume=True) should run the tool to completion."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "scratch.sqlite"
        async with get_checkpointer(db_path) as checkpointer:
            graph = _build_graph(checkpointer)
            config = {
                "configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}
            }

            result = await graph.ainvoke({"result": None}, config=config)
            assert "__interrupt__" in result, f"expected an interrupt, got {result}"
            payload = result["__interrupt__"][0].value
            assert payload["action"] == "send_test_notification", (
                f"unexpected interrupt payload: {payload}"
            )
            assert payload["message"] == "test notification", (
                f"unexpected interrupt payload: {payload}"
            )
            # The voice daemon reads this aloud instead of the raw payload.
            assert "test notification" in payload["spoken_prompt"], (
                f"spoken_prompt should mention the message: {payload}"
            )

            resumed = await graph.ainvoke(Command(resume=True), config=config)
            assert resumed["result"] == "[simulated] notification sent: 'test notification'", (
                f"unexpected result after confirmed resume: {resumed}"
            )


async def test_interrupt_then_resume_declined() -> None:
    """Resuming with Command(resume=False) should short-circuit with a cancellation message."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "scratch.sqlite"
        async with get_checkpointer(db_path) as checkpointer:
            graph = _build_graph(checkpointer)
            config = {
                "configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}
            }

            result = await graph.ainvoke({"result": None}, config=config)
            assert "__interrupt__" in result, f"expected an interrupt, got {result}"

            resumed = await graph.ainvoke(Command(resume=False), config=config)
            assert resumed["result"] == "Cancelled — user did not confirm.", (
                f"unexpected result after declined resume: {resumed}"
            )


if __name__ == "__main__":
    asyncio.run(test_interrupt_then_resume_confirmed())
    print("OK: interrupt + Command(resume=True) runs the tool to completion")
    asyncio.run(test_interrupt_then_resume_declined())
    print("OK: interrupt + Command(resume=False) short-circuits with a cancellation message")
