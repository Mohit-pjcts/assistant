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
