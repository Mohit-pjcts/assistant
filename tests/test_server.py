"""Tests for assistant.server (Phase 9 backend wrapper). Runnable directly,
same convention as test_interrupts.py/test_memory_store.py — real graph
calls (real Anthropic API), no mocking, isolated via tempfile-redirected DB
paths so nothing here touches the real conversation_memory.sqlite or
long_term_memory.sqlite (CLAUDE.md's verification-discipline rule).

The DB-path env vars server.py reads (ASSISTANT_CONVERSATION_DB_PATH,
ASSISTANT_MEMORY_DB_PATH) must be set BEFORE assistant.server is imported —
both are read at module import time — so this file sets them at the very
top, ahead of the assistant.server import, same ordering constraint
main.py/tools.py already document for load_dotenv().
"""

import asyncio
import atexit
import os
import shutil
import tempfile

_tmpdir = tempfile.mkdtemp(prefix="assistant_test_server_")
# Not a `with TemporaryDirectory()` block (test_interrupts.py's usual
# pattern) — the env vars below must be set before `assistant.server` is
# imported, which happens at this module's top level, so the directory has
# to outlive any single function's scope. Cleaned up via atexit instead.
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)
os.environ["ASSISTANT_CONVERSATION_DB_PATH"] = os.path.join(_tmpdir, "conversation_memory.sqlite")
os.environ["ASSISTANT_MEMORY_DB_PATH"] = os.path.join(_tmpdir, "long_term_memory.sqlite")

from fastapi.testclient import TestClient  # noqa: E402

from assistant import memory_store, server  # noqa: E402


async def test_chat_round_trips_through_the_real_graph() -> None:
    with TestClient(server.app) as client:
        response = client.post("/chat", json={"message": "Say exactly: server test ok"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message"
        assert "server test ok" in body["content"].lower()


async def test_history_reflects_the_same_thread_chat_wrote_to() -> None:
    with TestClient(server.app) as client:
        client.post("/chat", json={"message": "Say exactly: history check"})
        response = client.get("/history")
        assert response.status_code == 200, response.text
        messages = response.json()["messages"]
        assert any(m["role"] == "user" and "history check" in m["content"] for m in messages)
        assert any(m["role"] == "assistant" for m in messages)


async def test_gated_tool_interrupt_then_approve() -> None:
    """The confirmation gate (CLAUDE.md's standing rule): /chat surfaces the
    raw interrupt payload unmodified, /resume with approved=True completes
    the action."""
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={"message": "Use the send_test_notification tool to notify me 'approve test'"},
        )
        body = response.json()
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"
        assert body["payload"]["action"] == "send_test_notification"
        assert "approve test" in body["payload"]["message"]

        resumed = client.post("/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        assert resumed.json()["type"] == "message"

        # This gated-tool round trip is a real multi-hop turn (supervisor ->
        # coding_agent -> route_after_specialist), so it genuinely produces a
        # Phase 6 routing-bridge HumanMessage — real coverage for the
        # `synthetic` flag /history must set on it (STEPS.md 57), not just
        # an assumption. Confirms the flag fires on real graph output, not
        # only on a hand-constructed message in isolation.
        history = client.get("/history")
        assert history.status_code == 200, history.text
        messages = history.json()["messages"]
        bridge_messages = [
            m for m in messages if "Routing note, not from the user" in m["content"]
        ]
        assert bridge_messages, f"expected a routing-bridge message in history, got {messages}"
        assert all(m["synthetic"] is True for m in bridge_messages), (
            f"routing-bridge message(s) not flagged synthetic: {bridge_messages}"
        )
        # And a genuine user message in the same history must NOT be flagged.
        genuine_user_messages = [
            m
            for m in messages
            if m["role"] == "user" and "Routing note" not in m["content"]
        ]
        assert genuine_user_messages
        assert all(m["synthetic"] is False for m in genuine_user_messages)

        # `name` (STEPS.md 58): the History panel needs to know WHICH tool
        # produced a given ToolMessage, not just the generic "tool" role.
        # Real coverage, not assumed — a live check during this step showed
        # `name` is ALSO set on assistant (AIMessage) entries in this
        # multi-agent graph, to the responding node's name ("supervisor" /
        # "coding_agent"), which is real and useful info too, not noise.
        tool_messages = [m for m in messages if m["role"] == "tool"]
        assert tool_messages
        assert any(m["name"] == "send_test_notification" for m in tool_messages), (
            f"expected a send_test_notification ToolMessage, got {tool_messages}"
        )
        assistant_messages = [m for m in messages if m["role"] == "assistant"]
        assert any(m["name"] == "coding_agent" for m in assistant_messages)
        assert any(m["name"] == "supervisor" for m in assistant_messages)
        assert all(m["name"] is None for m in messages if m["role"] == "user"), (
            "a genuine/synthetic user HumanMessage should never carry a node/tool name"
        )

        assert "sent" in resumed.json()["content"].lower()


async def test_gated_tool_interrupt_then_decline() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={"message": "Use the send_test_notification tool to notify me 'decline test'"},
        )
        body = response.json()
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"

        resumed = client.post("/resume", json={"approved": False})
        assert resumed.status_code == 200, resumed.text
        content = resumed.json()["content"].lower()
        assert "not" in content and ("sent" in content or "cancel" in content), (
            f"expected a cancellation-flavored reply, got: {content}"
        )


async def test_memory_facts_list_and_delete() -> None:
    with TestClient(server.app) as client:
        empty = client.get("/memory/facts")
        assert empty.status_code == 200
        assert empty.json()["facts"] == []

        fact_id = await memory_store.save_fact(
            "test fact for test_server", None, db_path=os.environ["ASSISTANT_MEMORY_DB_PATH"]
        )

        listed = client.get("/memory/facts")
        assert listed.status_code == 200
        facts = listed.json()["facts"]
        assert len(facts) == 1
        assert facts[0]["id"] == fact_id
        assert facts[0]["content"] == "test fact for test_server"

        deleted = client.delete(f"/memory/facts/{fact_id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True

        after = client.get("/memory/facts")
        assert after.json()["facts"] == []


async def test_delete_unknown_fact_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.delete("/memory/facts/999999")
        assert response.status_code == 404


async def test_cost_returns_real_langsmith_aggregates() -> None:
    """Against the REAL personal-assistant LangSmith project — no mocking,
    same convention as every other test in this file. Not a cost concern to
    run for real: get_run_stats() is a read-only aggregation query, not an
    LLM call (STEPS.md 60). No DB isolation needed either — /cost never
    touches conversation_memory.sqlite/long_term_memory.sqlite, it only
    talks to LangSmith's API."""
    with TestClient(server.app) as client:
        response = client.get("/cost")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["project"] == "personal-assistant"
        windows = body["windows"]
        assert set(windows.keys()) == {"today", "week", "all_time"}

        for window in windows.values():
            assert window["run_count"] >= 0
            assert window["total_tokens"] >= 0
            assert window["total_cost"] >= 0.0
            # total should be prompt+completion, not a separate drifting number
            assert window["total_tokens"] == window["prompt_tokens"] + window["completion_tokens"]

        # Nested time windows: all_time >= week >= today, always, given this
        # project has real historical usage (STEPS.md 54 onward).
        assert windows["all_time"]["run_count"] >= windows["week"]["run_count"]
        assert windows["week"]["run_count"] >= windows["today"]["run_count"]
        assert windows["all_time"]["total_cost"] >= windows["week"]["total_cost"]


if __name__ == "__main__":
    asyncio.run(test_chat_round_trips_through_the_real_graph())
    print("OK: /chat round-trips through the real graph")
    asyncio.run(test_history_reflects_the_same_thread_chat_wrote_to())
    print("OK: /history reflects the same thread /chat wrote to")
    asyncio.run(test_gated_tool_interrupt_then_approve())
    print("OK: gated-tool interrupt -> /resume(approved=True) completes the action")
    asyncio.run(test_gated_tool_interrupt_then_decline())
    print("OK: gated-tool interrupt -> /resume(approved=False) cancels the action")
    asyncio.run(test_memory_facts_list_and_delete())
    print("OK: /memory/facts list + delete round-trip")
    asyncio.run(test_delete_unknown_fact_returns_404())
    print("OK: deleting an unknown fact id returns 404")
    asyncio.run(test_cost_returns_real_langsmith_aggregates())
    print("OK: /cost returns real LangSmith aggregates across today/week/all_time")
