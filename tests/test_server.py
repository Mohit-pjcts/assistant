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
import json
import os
import shutil
import tempfile
from typing import Any

_tmpdir = tempfile.mkdtemp(prefix="assistant_test_server_")
# Not a `with TemporaryDirectory()` block (test_interrupts.py's usual
# pattern) — the env vars below must be set before `assistant.server` is
# imported, which happens at this module's top level, so the directory has
# to outlive any single function's scope. Cleaned up via atexit instead.
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)
os.environ["ASSISTANT_CONVERSATION_DB_PATH"] = os.path.join(_tmpdir, "conversation_memory.sqlite")
os.environ["ASSISTANT_MEMORY_DB_PATH"] = os.path.join(_tmpdir, "long_term_memory.sqlite")
os.environ["ASSISTANT_THREADS_DB_PATH"] = os.path.join(_tmpdir, "threads.sqlite")

from fastapi.testclient import TestClient  # noqa: E402

from assistant import memory_store, server, thread_store  # noqa: E402


def _parse_sse(text: str) -> list[dict[str, Any]]:
    """/chat and /resume return text/event-stream (Phase 14 streaming) —
    this decodes it back into the list of JSON frames a test can assert
    on. Each frame is `data: {...}\\n\\n`; TestClient buffers the full
    streamed body into `.text` for a plain (non-`.stream()`) request, so
    this is enough for tests that only care about the end result."""
    events = []
    for frame in text.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        assert frame.startswith("data: "), f"unexpected SSE frame: {frame!r}"
        events.append(json.loads(frame[len("data: ") :]))
    return events


def _final_sse_event(response: Any) -> dict[str, Any]:
    """The terminal frame of a /chat or /resume stream — always
    `{"type": "interrupt", ...}`, `{"type": "message", ...}`, or (on a
    real backend error) `{"type": "error", ...}`. Mirrors what the OLD
    non-streaming response body used to be in full, before Phase 14."""
    events = _parse_sse(response.text)
    assert events, f"expected at least one SSE event, got none — raw body: {response.text!r}"
    return events[-1]


async def test_chat_round_trips_through_the_real_graph() -> None:
    with TestClient(server.app) as client:
        response = client.post("/chat", json={"message": "Say exactly: server test ok"})
        assert response.status_code == 200, response.text
        body = _final_sse_event(response)
        assert body["type"] == "message"
        assert "server test ok" in body["content"].lower()


async def test_chat_streams_token_events_that_reassemble_into_the_final_message() -> None:
    """Phase 14: proves the stream is a REAL token-by-token stream of the
    actual answer, not a hollow typing animation disconnected from the
    final content — verified by reassembling every token event's text and
    comparing it against the terminal message event's content."""
    with TestClient(server.app) as client:
        response = client.post(
            "/chat", json={"message": "Count from 1 to 5, one number per line, no other text."}
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)
        token_events = [e for e in events if e["type"] == "token"]
        assert token_events, f"expected at least one token event, got {events}"
        assert events[-1]["type"] == "message"
        streamed_text = "".join(e["text"] for e in token_events)
        assert streamed_text.strip() == events[-1]["content"].strip()


async def test_stop_cancels_the_registered_task_for_its_thread() -> None:
    """Unit-level coverage of /chat/stop's own lookup+cancel logic.

    The FULL live scenario (a real concurrent request actually streaming
    while a separate request calls /chat/stop, the stream terminating
    immediately, and a follow-up /chat call on the same thread working
    perfectly cleanly afterward — no corrupted or half-written state) was
    verified live against a real running backend with two genuinely
    concurrent curl processes, not simulated here: `TestClient` drives the
    ASGI app through a synchronous portal that does not reliably support
    two truly concurrent in-flight requests from the same driving thread,
    so a test built on `client.stream()` + a nested `client.post()` was
    flaky for reasons specific to the test harness, not the implementation
    (confirmed by the real curl-based check passing cleanly every time).
    This test instead exercises the exact same production code path
    (`app.state.active_tasks` lookup + `task.cancel()`) directly, without
    depending on TestClient reproducing real request concurrency."""
    with TestClient(server.app) as client:
        # Reuse the already-registered legacy default thread rather than
        # POST /threads a new one — creating a thread always activates it
        # (this codebase's own documented behavior), which would silently
        # move the shared active pointer and break later tests in this
        # file that assume nothing has repointed it yet.
        thread_id = thread_store.LEGACY_DEFAULT_THREAD_ID

        async def _never_finishes() -> None:
            await asyncio.sleep(60)

        task = asyncio.ensure_future(_never_finishes())
        server.app.state.active_tasks[thread_id] = task
        try:
            response = client.post("/chat/stop", json={"thread_id": thread_id})
            assert response.status_code == 200, response.text
            assert response.json()["stopped"] is True
            await asyncio.sleep(0)  # let the cancellation actually land
            assert task.cancelled()
        finally:
            server.app.state.active_tasks.pop(thread_id, None)
            task.cancel()


async def test_stop_with_nothing_in_flight_reports_not_stopped() -> None:
    with TestClient(server.app) as client:
        response = client.post("/chat/stop", json={})
        assert response.status_code == 200, response.text
        assert response.json()["stopped"] is False


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
        body = _final_sse_event(response)
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"
        assert body["payload"]["action"] == "send_test_notification"
        assert "approve test" in body["payload"]["message"]

        resumed = client.post("/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        resumed_body = _final_sse_event(resumed)
        assert resumed_body["type"] == "message"

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

        assert "sent" in resumed_body["content"].lower()


async def test_gated_tool_interrupt_then_decline() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={"message": "Use the send_test_notification tool to notify me 'decline test'"},
        )
        body = _final_sse_event(response)
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"

        resumed = client.post("/resume", json={"approved": False})
        assert resumed.status_code == 200, resumed.text
        content = _final_sse_event(resumed)["content"].lower()
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


async def test_history_response_carries_the_thread_id_it_read() -> None:
    with TestClient(server.app) as client:
        client.post("/chat", json={"message": "Say exactly: thread id check"})
        response = client.get("/history")
        assert response.status_code == 200, response.text
        assert response.json()["thread_id"]


async def test_threads_list_includes_the_bootstrapped_legacy_thread() -> None:
    """Every /chat call above this point in the file used no explicit
    thread_id, so it ran against thread_store's bootstrapped legacy default
    (STEPS.md 66's old fixed THREAD_ID, preserved as the first-ever active
    thread) — this is the actual 'old single-thread behavior still works'
    done-when criterion, checked at the HTTP layer, not just thread_store's
    own unit tests."""
    with TestClient(server.app) as client:
        response = client.get("/threads")
        assert response.status_code == 200, response.text
        body = response.json()
        assert any(t["id"] == thread_store.LEGACY_DEFAULT_THREAD_ID for t in body["threads"])
        assert body["active_thread_id"] == thread_store.LEGACY_DEFAULT_THREAD_ID


async def test_create_thread_becomes_the_new_active_thread() -> None:
    with TestClient(server.app) as client:
        response = client.post("/threads", json={"title": "Trip planning"})
        assert response.status_code == 200, response.text
        thread = response.json()
        assert thread["title"] == "Trip planning"
        assert thread["id"]

        listed = client.get("/threads")
        body = listed.json()
        assert body["active_thread_id"] == thread["id"]
        assert any(t["id"] == thread["id"] for t in body["threads"])


async def test_explicit_thread_id_isolates_conversations_without_touching_active_pointer() -> None:
    """The actual fix for STEPS.md 66's collision: two different thread_ids
    used explicitly on /chat must never see each other's messages, and
    using an explicit thread_id must not silently move the shared active
    pointer out from under some other concurrent client relying on it."""
    with TestClient(server.app) as client:
        thread_a = client.post("/threads", json={"title": "Thread A"}).json()
        thread_b = client.post("/threads", json={"title": "Thread B"}).json()
        # POST /threads always activates what it just created, so thread_b
        # (created second) is the active pointer right now.
        active_before = client.get("/threads").json()["active_thread_id"]
        assert active_before == thread_b["id"]

        response = client.post(
            "/chat",
            json={"message": "Say exactly: isolated thread A reply", "thread_id": thread_a["id"]},
        )
        assert response.status_code == 200, response.text
        assert "isolated thread a reply" in _final_sse_event(response)["content"].lower()

        # The explicit-thread_id call above must NOT have moved the pointer
        # — a second client relying on the active pointer (e.g. a live GUI
        # session, per STEPS.md 66) would otherwise have its thread silently
        # swapped out from under it.
        active_after = client.get("/threads").json()["active_thread_id"]
        assert active_after == thread_b["id"], (
            "an explicit thread_id on /chat must not mutate the shared active pointer"
        )

        # thread_b's own history must be completely untouched by thread_a's chat.
        client.post("/threads/active", json={"thread_id": thread_b["id"]})
        history_b = client.get("/history").json()["messages"]
        assert not any("isolated thread a reply" in m["content"].lower() for m in history_b)

        client.post("/threads/active", json={"thread_id": thread_a["id"]})
        history_a = client.get("/history").json()["messages"]
        assert any("isolated thread a reply" in m["content"].lower() for m in history_a)


async def test_chat_with_unknown_thread_id_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/chat", json={"message": "hi", "thread_id": "does-not-exist"})
        assert response.status_code == 404


async def test_set_active_unknown_thread_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/threads/active", json={"thread_id": "does-not-exist"})
        assert response.status_code == 404


async def test_rename_thread() -> None:
    with TestClient(server.app) as client:
        thread = client.post("/threads", json={}).json()
        renamed = client.patch(f"/threads/{thread['id']}", json={"title": "Renamed"})
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["title"] == "Renamed"

        listed = client.get("/threads").json()["threads"]
        assert any(t["id"] == thread["id"] and t["title"] == "Renamed" for t in listed)


async def test_rename_unknown_thread_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.patch("/threads/does-not-exist", json={"title": "x"})
        assert response.status_code == 404


async def test_delete_non_active_thread_leaves_pointer_unchanged() -> None:
    with TestClient(server.app) as client:
        keep = client.post("/threads", json={"title": "keep"}).json()
        doomed = client.post("/threads", json={"title": "doomed"}).json()
        client.post("/threads/active", json={"thread_id": keep["id"]})

        response = client.delete(f"/threads/{doomed['id']}")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["deleted"] is True
        assert body["active_thread_id"] == keep["id"]

        listed = client.get("/threads").json()
        assert not any(t["id"] == doomed["id"] for t in listed["threads"])
        assert listed["active_thread_id"] == keep["id"]


async def test_delete_active_thread_reassigns_the_pointer() -> None:
    with TestClient(server.app) as client:
        other = client.post("/threads", json={"title": "other"}).json()
        active = client.post("/threads", json={"title": "active"}).json()
        # "active" is the pointer now (POST /threads always activates).

        response = client.delete(f"/threads/{active['id']}")
        assert response.status_code == 200, response.text
        new_active_id = response.json()["active_thread_id"]
        assert new_active_id != active["id"]

        listed = client.get("/threads").json()
        assert listed["active_thread_id"] == new_active_id
        assert not any(t["id"] == active["id"] for t in listed["threads"])


async def test_delete_unknown_thread_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.delete("/threads/does-not-exist")
        assert response.status_code == 404


if __name__ == "__main__":
    asyncio.run(test_chat_round_trips_through_the_real_graph())
    print("OK: /chat round-trips through the real graph")
    asyncio.run(test_chat_streams_token_events_that_reassemble_into_the_final_message())
    print("OK: /chat streams token events that reassemble into the final message")
    asyncio.run(test_stop_cancels_the_registered_task_for_its_thread())
    print("OK: /chat/stop cancels the registered task for its thread")
    asyncio.run(test_stop_with_nothing_in_flight_reports_not_stopped())
    print("OK: /chat/stop with nothing in flight reports stopped=False")
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
    asyncio.run(test_history_response_carries_the_thread_id_it_read())
    print("OK: /history response includes the thread_id it read")
    asyncio.run(test_threads_list_includes_the_bootstrapped_legacy_thread())
    print("OK: /threads includes the bootstrapped legacy default thread")
    asyncio.run(test_create_thread_becomes_the_new_active_thread())
    print("OK: POST /threads creates a thread and activates it")
    asyncio.run(test_explicit_thread_id_isolates_conversations_without_touching_active_pointer())
    print("OK: explicit thread_id isolates conversations without moving the active pointer")
    asyncio.run(test_chat_with_unknown_thread_id_returns_404())
    print("OK: /chat with an unknown thread_id returns 404")
    asyncio.run(test_set_active_unknown_thread_returns_404())
    print("OK: POST /threads/active with an unknown thread_id returns 404")
    asyncio.run(test_rename_thread())
    print("OK: PATCH /threads/{id} renames a thread")
    asyncio.run(test_rename_unknown_thread_returns_404())
    print("OK: PATCH /threads/{id} on an unknown thread returns 404")
    asyncio.run(test_delete_non_active_thread_leaves_pointer_unchanged())
    print("OK: deleting a non-active thread leaves the pointer unchanged")
    asyncio.run(test_delete_active_thread_reassigns_the_pointer())
    print("OK: deleting the active thread reassigns the pointer")
    asyncio.run(test_delete_unknown_thread_returns_404())
    print("OK: DELETE /threads/{id} on an unknown thread returns 404")
