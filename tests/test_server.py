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
# setdefault, not unconditional assignment (test_a2ui.py surfaced this
# live, Phase 17): `assistant.server` is a singleton module — whichever
# test file's import statement reaches it FIRST during pytest's collection
# (alphabetical across all test_*.py files, not just this one) is the ONE
# import that actually happens; its env-var values are what every DB-path
# constant `assistant.server`/`memory_store` bind internally at that
# moment, permanently, for the whole test session. A later file
# unconditionally overwriting os.environ here would desync from that
# already-frozen binding — setdefault instead means whichever tmpdir wins
# the real first import is the SAME one every file's own os.environ reads
# see afterward, regardless of collection order.
os.environ.setdefault("ASSISTANT_CONVERSATION_DB_PATH", os.path.join(_tmpdir, "conversation_memory.sqlite"))
os.environ.setdefault("ASSISTANT_MEMORY_DB_PATH", os.path.join(_tmpdir, "long_term_memory.sqlite"))
os.environ.setdefault("ASSISTANT_THREADS_DB_PATH", os.path.join(_tmpdir, "threads.sqlite"))
os.environ.setdefault("ASSISTANT_BOARD_DB_PATH", os.path.join(_tmpdir, "board.sqlite"))
os.environ.setdefault("ASSISTANT_PHONE_DB_PATH", os.path.join(_tmpdir, "phone_data.sqlite"))
os.environ.setdefault("ASSISTANT_AUTOMATIONS_DB_PATH", os.path.join(_tmpdir, "automations.sqlite"))
os.environ.setdefault("ASSISTANT_WORKFLOWS_DB_PATH", os.path.join(_tmpdir, "workflows.sqlite"))
os.environ.setdefault("ASSISTANT_ACTIVITY_LOG_DB_PATH", os.path.join(_tmpdir, "activity_log.sqlite"))
# Bound here, not re-read from os.environ inside the test function itself —
# same reasoning, belt-and-suspenders: this constant is fixed at the exact
# instant this module resolved the (possibly-already-set) env var, so nothing
# imported afterward can retroactively desync it from what actually got used.
_MEMORY_DB_PATH = os.environ["ASSISTANT_MEMORY_DB_PATH"]

from fastapi.testclient import TestClient  # noqa: E402

from assistant import activity_log, memory_store, server, thread_store  # noqa: E402


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


async def test_activity_frames_surface_across_the_delegated_specialist_boundary() -> None:
    """PLAN.md Phase 19's own live-verification requirement, mirroring how
    Phase 18 proved render_ui crosses this exact nested-ainvoke() boundary
    (test_a2ui.py's test_render_ui_available_on_delegated_specialist_and_
    persists) rather than assuming the mechanism generalizes: directs the
    supervisor to delegate to research_agent, which calls the REAL search
    tool (`tavily_search` — the actual LangChain tool name `TavilySearch`
    registers, not `tools.py`'s `web_search` wrapper function name). Must
    surface BOTH levels as `activity` SSE frames — the outer
    supervisor->research_agent boundary (call_specialist's own dispatch)
    AND research_agent's OWN inner tavily_search call (_AgentActivityRelay,
    attached to research_agent's isolated ainvoke() config) — proving
    adispatch_custom_event's contextvar propagation survives this nested
    call exactly the way research_fa_token/a2ui_surface already did, now
    for tool-activity instead of tokens/rendered surfaces."""
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    "Delegate this to research_agent: search the web for "
                    "\"esbuild\" and tell me one fact about it."
                )
            },
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)
        activity_events = [e for e in events if e["type"] == "activity"]
        assert activity_events, f"expected at least one activity frame, got {events}"

        outer_starts = [
            e
            for e in activity_events
            if e["phase"] == "tool_start" and e["agent"] == "supervisor" and e["tool"] == "research_agent"
        ]
        assert outer_starts, f"expected a supervisor->research_agent tool_start, got {activity_events}"
        outer_ends = [
            e
            for e in activity_events
            if e["phase"] == "tool_end" and e["agent"] == "supervisor" and e["tool"] == "research_agent"
        ]
        assert outer_ends, f"expected a supervisor->research_agent tool_end, got {activity_events}"

        inner_starts = [
            e
            for e in activity_events
            if e["phase"] == "tool_start" and e["agent"] == "research_agent" and e["tool"] == "tavily_search"
        ]
        assert inner_starts, (
            f"expected research_agent's own inner web_search tool_start to surface "
            f"across the nested ainvoke() boundary, got {activity_events}"
        )
        inner_ends = [
            e
            for e in activity_events
            if e["phase"] == "tool_end" and e["agent"] == "research_agent" and e["tool"] == "tavily_search"
        ]
        assert inner_ends, f"expected research_agent's own inner web_search tool_end, got {activity_events}"

        assert events[-1]["type"] == "message"


async def test_activity_log_endpoint_returns_recorded_events() -> None:
    """Thin integration test for GET /activity/log (STEPS.md 151) — does
    NOT need a real graph turn (activity_log.record_event/list_recent
    already have their own dedicated unit coverage in
    test_activity_log.py); this only proves the endpoint itself correctly
    reads from the SAME store server.py is wired to (the
    ASSISTANT_ACTIVITY_LOG_DB_PATH redirect this file's own top-of-module
    setup applies) and serializes it as JSON."""
    await activity_log.record_event("thread-xyz", "life_admin_agent", activity_log.OUTCOME_SUCCESS)
    with TestClient(server.app) as client:
        response = client.get("/activity/log")
        assert response.status_code == 200, response.text
        body = response.json()
        matches = [e for e in body["events"] if e["thread_id"] == "thread-xyz"]
        assert matches, f"expected the just-recorded event, got {body}"
        assert matches[0]["agent"] == "life_admin_agent"
        assert matches[0]["outcome"] == "success"


async def test_search_conversations_endpoint_finds_a_seeded_thread() -> None:
    """Thin integration test for GET /search/conversations (STEPS.md 151) —
    does NOT load the real embedding model (slow, a cold load needs a
    network round-trip per conversation_search.py's own docstring) or make
    a real Anthropic API call: seeds a thread's checkpoint state directly
    via graph.aupdate_state() rather than a real /chat turn, and fakes
    conversation_search's model the same way test_conversation_search.py
    does. Proves the endpoint wires app.state.graph's aget_state() through
    to conversation_search.semantic_search() correctly — the actual
    ranking/caching logic already has its own dedicated unit coverage."""
    from pathlib import Path as _Path

    import numpy as np
    from langchain_core.messages import HumanMessage as HM

    from assistant import conversation_search
    from assistant.agent import make_thread_config

    class _FakeModel:
        def encode(self, text: str):
            return np.array([1.0, 0.0, 0.0], dtype=np.float32)

    conversation_search._model = None
    original_load_model = conversation_search._load_model
    original_cache_path = conversation_search._CACHE_PATH
    conversation_search._load_model = lambda: _FakeModel()
    conversation_search._CACHE_PATH = _Path(_tmpdir) / "conversation_embeddings_cache.npz"
    try:
        thread = await thread_store.create_thread(title="Roth IRA question")
        with TestClient(server.app) as client:
            await server.app.state.graph.aupdate_state(
                make_thread_config(thread.id),
                {"messages": [HM(content="should I use a Roth or Traditional IRA")]},
            )
            response = client.get("/search/conversations", params={"q": "retirement accounts"})
            assert response.status_code == 200, response.text
            body = response.json()
            matches = [r for r in body["results"] if r["thread_id"] == thread.id]
            assert matches, f"expected the seeded thread to be found, got {body}"
    finally:
        conversation_search._load_model = original_load_model
        conversation_search._CACHE_PATH = original_cache_path


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
        # file that assume nothing has repointed it yet. Reading the pointer
        # first-run-bootstraps that thread's row, so this test also passes
        # when run alone (it used to depend on an earlier test having done it).
        await thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH)
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
    the action.

    Which of two valid paths the supervisor takes is genuinely
    non-deterministic (an accepted property of the upfront-confirmation
    design, supervisor.py's module docstring — it's the model's own
    judgment call, not a structural guarantee): it may call
    request_gated_action_confirmation FIRST (payload has "summary", not
    "message"), or delegate straight to coding_agent and hit
    send_test_notification's own interrupt directly (payload has
    "message"). Both are correct outcomes; this test accepts either rather
    than assuming one."""
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={"message": "Use the send_test_notification tool to notify me 'approve test'"},
        )
        body = _final_sse_event(response)
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"
        assert body["payload"]["action"] == "send_test_notification"
        payload_text = body["payload"].get("message") or body["payload"].get("summary") or ""
        assert "approve test" in payload_text, (
            f"expected the real message text in the gate payload, got {body['payload']}"
        )

        resumed = client.post("/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        resumed_body = _final_sse_event(resumed)
        if resumed_body["type"] == "interrupt":
            # Took the upfront-confirmation path — a second, real interrupt
            # from inside coding_agent's own send_test_notification would
            # mean pre_approved_actions failed to suppress it; approve it
            # too and let the later history assertions catch that failure
            # (the ToolMessage would show two coding_agent calls instead of
            # one, or an unexpected "message" payload shape).
            resumed = client.post("/resume", json={"approved": True})
            resumed_body = _final_sse_event(resumed)
        assert resumed_body["type"] == "message", f"expected a final message, got {resumed_body}"

        # Under the agents-as-tools rewrite (supervisor.py), this gated-tool
        # round trip stays entirely inside the supervisor's own tool call —
        # there is no separate outer-graph hop for coding_agent anymore, so
        # no Phase 6 routing-bridge HumanMessage is produced (that whole
        # mechanism was removed along with the Command-handoff loop-back it
        # supported). `/history` only ever sees the OUTER graph's own
        # checkpointed messages, and a specialist's internal deliberation
        # (including its OWN send_test_notification ToolMessage) now lives
        # in an isolated, non-persisted sub-agent conversation — only its
        # final summarized text crosses back, as a ToolMessage named after
        # the specialist tool itself ("coding_agent"). This is a real,
        # disclosed trade-off of the rewrite, not an oversight: the History
        # panel shows one summarized line per specialist call instead of
        # every internal tool call a specialist made.
        history = client.get("/history")
        assert history.status_code == 200, history.text
        messages = history.json()["messages"]
        genuine_user_messages = [m for m in messages if m["role"] == "user"]
        assert genuine_user_messages
        assert any(
            m["synthetic"] is False and "approve test" in m["content"]
            for m in genuine_user_messages
        )

        # `name` (STEPS.md 58): the History panel needs to know WHICH
        # specialist produced a given ToolMessage, not just the generic
        # "tool" role. Real coverage, not assumed — a live check during
        # this rewrite showed the specialist's summarized reply now arrives
        # as a ToolMessage named after the specialist ("coding_agent"), and
        # the supervisor's own final answer as an assistant message named
        # "supervisor".
        tool_messages = [m for m in messages if m["role"] == "tool"]
        assert tool_messages
        assert any(m["name"] == "coding_agent" for m in tool_messages), (
            f"expected a coding_agent ToolMessage (the specialist's summarized "
            f"reply), got {tool_messages}"
        )
        assistant_messages = [m for m in messages if m["role"] == "assistant"]
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


async def test_write_disk_file_gated_round_trip_through_the_real_graph() -> None:
    """PLAN.md Phase 23: coding_agent's write_disk_file (outside workspace/)
    is reachable via /chat, gates correctly, and actually writes on
    approval — the real end-to-end proof that disk_tools.py's tools are
    correctly wired into the supervisor/coding_agent, not just unit-tested
    in isolation (tests/test_disk_tools.py). Uses a tempfile-safe target
    path, never a real user file.

    Same accepted non-determinism as test_gated_tool_interrupt_then_approve:
    the supervisor may take the upfront-confirmation path
    (request_gated_action_confirmation — payload has "summary", not the
    tool's own "path"/"new_content" fields) or delegate straight to
    coding_agent and hit write_disk_file's own interrupt directly (full
    payload). Both are correct outcomes."""
    target = os.path.join(_tmpdir, "phase23_write_test.txt")
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    f"Use the write_disk_file tool to write the exact content "
                    f"'phase 23 verified' to the exact path {target!r}."
                )
            },
        )
        body = _final_sse_event(response)
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"
        assert body["payload"]["action"] == "write_disk_file"
        if "path" in body["payload"]:
            assert body["payload"]["path"] == target
            assert body["payload"]["new_content"] == "phase 23 verified"
        assert not os.path.exists(target), "must not write before approval"

        resumed = client.post("/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        resumed_body = _final_sse_event(resumed)
        if resumed_body["type"] == "interrupt":
            # Took the upfront-confirmation path — the real write_disk_file
            # interrupt (full payload) still fires from inside coding_agent.
            assert resumed_body["payload"]["action"] == "write_disk_file"
            assert resumed_body["payload"]["path"] == target
            assert resumed_body["payload"]["new_content"] == "phase 23 verified"
            resumed = client.post("/resume", json={"approved": True})
            resumed_body = _final_sse_event(resumed)
        assert resumed_body["type"] == "message", resumed_body

    assert os.path.exists(target)
    with open(target) as f:
        assert f.read() == "phase 23 verified"


async def test_propose_workflow_bundles_two_gated_actions_into_one_confirmation() -> None:
    """PLAN.md Phase 25's central live-verification requirement: the
    propose_workflow -> approve -> execute -> audit mechanism, proven
    end-to-end against the REAL graph. Deliberately uses two SAFE,
    already-permission-granted gated actions (write_disk_file +
    delete_disk_file, both coding_agent-owned) rather than
    calendar_create_event/send_imessage — those need Messages.app/Photos.app
    permission grants only the user can click (Phase 25's own decision D11
    splits verification this way: the mechanism is provable now, the
    app-dependent proof workflows are not). Proves: ONE interrupt covers
    BOTH steps (not two separate gates); approval clears both actions at
    once via pre_approved_actions; both real side effects actually happen,
    in order; workflow_store records the approved-vs-executed audit for
    both, with the REAL executed arguments, not just the planned summary.
    Uses a tempfile-safe target path, never a real user file."""
    target = os.path.join(_tmpdir, "phase25_workflow_test.txt")
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    "Call propose_workflow with exactly these two steps, in this order: "
                    f"1) write_disk_file to write the exact content 'workflow test' to "
                    f"the exact path {target!r}; 2) delete_disk_file to delete that exact "
                    "same file. Do not do anything else first."
                )
            },
        )
        body = _final_sse_event(response)
        assert body["type"] == "interrupt", f"expected an interrupt, got {body}"
        assert body["payload"]["action"] == "propose_workflow"
        step_actions = [s["action"] for s in body["payload"]["steps"]]
        assert step_actions == ["write_disk_file", "delete_disk_file"], (
            f"expected exactly these two steps bundled into ONE gate, got {body['payload']}"
        )
        assert not os.path.exists(target), "must not write before approval"

        resumed = client.post("/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        resumed_body = _final_sse_event(resumed)
        assert resumed_body["type"] == "message", (
            f"expected a final message with no second gate (both actions were "
            f"pre-approved by the one workflow confirmation), got {resumed_body}"
        )

        # Both real side effects happened, in order, with no second
        # confirmation needed for either — write then delete nets out to
        # "file does not exist," which alone would also be true if NEITHER
        # step ran, so the workflow_store audit below is what actually
        # proves both executed rather than neither.
        assert not os.path.exists(target)

        workflows = client.get("/workflows").json()["workflows"]
        run = next(
            (r for r in workflows if [s["action"] for s in r["steps"]] == ["write_disk_file", "delete_disk_file"]),
            None,
        )
        assert run is not None, f"expected a recorded workflow run, got {workflows}"
        assert run["status"] == "completed"
        assert all(s["outcome"] == "success" for s in run["steps"])
        write_step, delete_step = run["steps"]
        assert write_step["executed_args"]["content"] == "workflow test"
        assert target in write_step["executed_args"]["path"]
        assert target in delete_step["executed_args"]["path"]


async def test_phone_turn_round_trips_through_the_real_graph() -> None:
    """PLAN.md Phase 21: /phone/turn is the non-streaming sibling of /chat —
    same real-graph round trip, single JSON body back instead of SSE."""
    with TestClient(server.app) as client:
        response = client.post("/phone/turn", json={"message": "Say exactly: phone test ok"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message"
        assert "phone test ok" in body["content"].lower()


async def test_phone_turn_includes_location_context() -> None:
    """`location` is free text the Shortcut itself attaches (module
    docstring's `PhoneTurnRequest`) — proves it actually reaches the model
    as real context, not silently dropped."""
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn",
            json={
                "message": "What city am I in right now, based only on the location I just gave you? One word.",
                "location": "San Francisco, CA",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message"
        assert "san francisco" in body["content"].lower()


async def test_phone_turn_with_unknown_thread_id_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn", json={"message": "hi", "thread_id": "does-not-exist"}
        )
        assert response.status_code == 404


async def test_phone_turn_and_resume_gated_round_trip() -> None:
    """The confirmation gate over the phone channel: mirrors
    test_gated_tool_interrupt_then_approve's own accepted non-determinism
    (the supervisor may take the upfront-confirmation path — voice_
    approvable: False, auto-declined transparently by /phone/turn per
    _run_turn's docstring — or delegate straight to coding_agent's own
    send_test_notification interrupt, which carries no voice_approvable
    key at all and so is never auto-declined). Both are correct outcomes;
    this test accepts either rather than assuming one, same as its /chat
    counterpart."""
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn",
            json={"message": "Use the send_test_notification tool to notify me 'phone approve test'"},
        )
        assert response.status_code == 200, response.text
        body = response.json()

        if body["type"] == "message":
            # Took the voice_approvable: False upfront-confirmation path —
            # _run_turn auto-declined it transparently, so the action never
            # happened. Nothing further to resume.
            assert "not" in body["content"].lower() or "cancel" in body["content"].lower()
            return

        assert body["type"] == "interrupt", f"expected an interrupt or message, got {body}"
        assert body["payload"]["action"] == "send_test_notification"

        resumed = client.post("/phone/resume", json={"approved": True})
        assert resumed.status_code == 200, resumed.text
        resumed_body = resumed.json()
        if resumed_body["type"] == "interrupt":
            resumed = client.post("/phone/resume", json={"approved": True})
            resumed_body = resumed.json()
        assert resumed_body["type"] == "message", f"expected a final message, got {resumed_body}"
        assert "sent" in resumed_body["content"].lower()


async def test_phone_turn_auto_declines_text_only_gate() -> None:
    """The behavior _run_turn has that /chat's _stream_turn does not
    (module docstring): a voice_approvable: False gate never reaches the
    client as an interrupt at all — it auto-declines and the turn
    continues silently, exactly like voice_daemon.py's own loop. Directs
    the request at request_gated_action_confirmation's own upfront path by
    naming it explicitly, sidestepping the same non-determinism the two
    tests above have to accept."""
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn",
            json={
                "message": (
                    "Call request_gated_action_confirmation directly with "
                    "action='send_test_notification' and a summary describing "
                    "sending a notification that says 'phone auto-decline test'."
                )
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message", (
            f"a voice_approvable: False gate must never surface as an interrupt "
            f"on this channel, got {body}"
        )


async def test_phone_turn_propose_workflow_gets_explicit_dashboard_message() -> None:
    """PLAN.md Phase 25 decision D8: unlike every OTHER text-only gate on
    this channel (which auto-declines silently, per the test above), a
    propose_workflow plan gets a DETERMINISTIC, explicit message telling
    the user to approve it on the dashboard instead — the phone must never
    silently imply nothing happened when it actually declined a whole
    multi-step plan. Directs the request at propose_workflow's own upfront
    path by naming it explicitly, same sidestep of non-determinism as the
    test above."""
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn",
            json={
                "message": (
                    "Call propose_workflow directly with goal='phone workflow test' and "
                    "these two steps: 1) action='write_disk_file', summary='write a test "
                    "file'; 2) action='delete_disk_file', summary='delete that test file'. "
                    "Do not do anything else."
                )
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message"
        assert "dashboard" in body["content"].lower()


async def test_phone_turn_run_shortcut_on_phone_is_ungated() -> None:
    """phone_tools.run_shortcut_on_phone was explicitly UNGATED at the
    user's own request (deliberate, documented choice — see
    phone_tools.py's module docstring, same category as mac_tools.py's
    own open_url_in_brave decision).

    A real, live-diagnosed model quirk (not a code bug) makes the
    supervisor's OWN routing non-deterministic here, distinct from every
    other GATED_ACTIONS-adjacent non-determinism already documented in
    this file: given "call run_shortcut_on_phone," the supervisor
    sometimes calls request_gated_action_confirmation('run_shortcut_on_
    phone') anyway despite it not being a gated action, gets "not a
    recognized gated action" back, then RETRIES with the similar-
    sounding 'run_shortcut' (the still-gated MAC action) instead of just
    delegating — which auto-declines (voice_approvable: False) and
    reports "cancelled," even though the actual tool never gates.
    Confirmed by reading the real /history trace for a failing run, not
    guessed at; reproduces even with an instruction explicitly forbidding
    the confirmation tool. tests/test_phone_tools.py's
    test_run_shortcut_on_phone_never_gates proves the actual code-level
    guarantee deterministically, without the supervisor's own reasoning
    in the loop — this test accepts either supervisor path, same
    convention as every other GATED_ACTIONS non-determinism test here,
    and only makes the STRONGER assertion (a real phone_action, no
    interrupt) when the direct-tool path is the one taken."""
    with TestClient(server.app) as client:
        thread = client.post("/threads", json={}).json()
        response = client.post(
            "/phone/turn",
            json={
                "thread_id": thread["id"],
                "message": (
                    "run_shortcut_on_phone is NOT a gated action and needs no "
                    "confirmation. Delegate this exact instruction to phone_agent, "
                    "verbatim, without calling request_gated_action_confirmation at "
                    "all: call run_shortcut_on_phone with name='Lock Screen' exactly "
                    "once. Then reply with exactly: ran it."
                ),
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message", f"expected an immediate message, got {body}"

        if "phone_actions" not in body:
            # The supervisor took its confused-retry-then-decline path
            # (see docstring) — a real, accepted model-level outcome,
            # not the tool gating. Nothing further to assert.
            assert "cancel" in body["content"].lower(), body
            return

        assert {"type": "run_shortcut", "name": "Lock Screen"} in body["phone_actions"]


async def test_phone_turn_delegates_to_phone_agent_and_surfaces_open_url_action() -> None:
    """PLAN.md Phase 21: phone_agent is reachable via /phone/turn (same
    delegated-specialist proof pattern as test_a2ui.py's
    test_render_ui_available_on_delegated_specialist_and_persists) and its
    open_url_on_phone call surfaces as a `phone_actions` entry in the JSON
    response — proving the additional_kwargs[PHONE_ACTION_KEY] forwarding
    chain (open_url_on_phone -> _invoke_agent_graph -> call_specialist ->
    _run_turn's message-diffing collection) all actually connects, not
    just each link in isolation."""
    with TestClient(server.app) as client:
        response = client.post(
            "/phone/turn",
            json={
                "message": (
                    "Delegate this exact instruction to phone_agent, verbatim: call "
                    "open_url_on_phone with url='https://example.com/phone-test' "
                    "exactly once. Then reply to me with exactly: opened it."
                )
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message", body
        assert "phone_actions" in body, f"expected a phone_actions entry, got {body}"
        assert {"type": "open_url", "url": "https://example.com/phone-test"} in body["phone_actions"]


async def test_phone_turn_ambiguous_open_request_routes_to_phone_not_mac() -> None:
    """PLAN.md Phase 22's real routing gap, found while wiring the
    messaging cluster: an ambiguous 'open X' request has no other signal
    telling the supervisor whether to act on the Mac (mac_control_agent's
    open_app) or the phone (phone_agent's open_app_on_phone) — without
    _PHONE_CHANNEL_MARKER (server.py), a natural, non-explicit phrasing
    like this one could silently open the app on the Mac sitting
    elsewhere instead of the phone actually in the user's hand. Uses a
    natural phrasing (no 'delegate to phone_agent' instruction, unlike the
    test above) specifically to exercise the marker's real steering
    effect, not just prove the tool works when explicitly named."""
    with TestClient(server.app) as client:
        response = client.post("/phone/turn", json={"message": "open Spotify"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message", body
        assert "phone_actions" in body, (
            f"expected phone_agent's open_app_on_phone to fire (proving it routed to "
            f"the phone, not mac_control_agent's Mac-only open_app), got {body}"
        )
        assert any(a["type"] == "open_app" for a in body["phone_actions"]), body["phone_actions"]


async def test_phone_turn_without_phone_action_omits_the_field() -> None:
    """The common case — a plain question with no phone_agent tool call —
    must not carry a stray empty/absent-but-truthy phone_actions key."""
    with TestClient(server.app) as client:
        response = client.post("/phone/turn", json={"message": "Say exactly: no phone action here"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert "phone_actions" not in body, body


async def test_phone_health_sync_round_trips_through_get_latest_health_snapshot() -> None:
    """POST /phone/health-sync stores a snapshot; phone_agent's
    get_latest_health_snapshot tool (reached via /phone/turn) reads it
    back — the real end-to-end path a phone's health-sync Shortcut and a
    later Action Button question would exercise."""
    with TestClient(server.app) as client:
        synced = client.post(
            "/phone/health-sync",
            json={"content": "Resting heart rate: 58 bpm. Steps today: 4213."},
        )
        assert synced.status_code == 200, synced.text
        assert synced.json()["kind"] == "health"

        response = client.post(
            "/phone/turn",
            json={
                "message": (
                    "Delegate this exact instruction to phone_agent, verbatim: call "
                    "get_latest_health_snapshot and report back the resting heart "
                    "rate number it returns, and nothing else."
                )
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["type"] == "message", body
        assert "58" in body["content"]


async def test_memory_facts_list_and_delete() -> None:
    with TestClient(server.app) as client:
        empty = client.get("/memory/facts")
        assert empty.status_code == 200
        assert empty.json()["facts"] == []

        fact_id = await memory_store.save_fact("test fact for test_server", None, db_path=_MEMORY_DB_PATH)

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


async def test_create_memory_fact_is_user_authored_and_ungated() -> None:
    """POST /memory/facts is the user typing directly into the Memory
    panel — no interrupt() round trip, immediate write, tagged
    provenance="user" so it's distinguishable from an agent-derived fact."""
    with TestClient(server.app) as client:
        response = client.post("/memory/facts", json={"content": "user's favorite color is teal"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["content"] == "user's favorite color is teal"
        assert body["provenance"] == "user"

        listed = client.get("/memory/facts")
        facts = listed.json()["facts"]
        assert any(f["id"] == body["id"] and f["provenance"] == "user" for f in facts)


async def test_create_memory_fact_rejects_empty_content() -> None:
    with TestClient(server.app) as client:
        response = client.post("/memory/facts", json={"content": "   "})
        assert response.status_code == 400


async def test_update_memory_fact_round_trip() -> None:
    with TestClient(server.app) as client:
        fact_id = await memory_store.save_fact("user's dog is named Rex", db_path=_MEMORY_DB_PATH)

        response = client.patch(f"/memory/facts/{fact_id}", json={"content": "user's dog is named Max"})
        assert response.status_code == 200, response.text
        assert response.json()["content"] == "user's dog is named Max"

        listed = client.get("/memory/facts")
        facts = listed.json()["facts"]
        assert any(f["id"] == fact_id and f["content"] == "user's dog is named Max" for f in facts)


async def test_update_unknown_fact_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.patch("/memory/facts/999999", json={"content": "irrelevant"})
        assert response.status_code == 404


async def test_update_memory_fact_rejects_empty_content() -> None:
    with TestClient(server.app) as client:
        fact_id = await memory_store.save_fact("user's cat is named Whiskers", db_path=_MEMORY_DB_PATH)
        response = client.patch(f"/memory/facts/{fact_id}", json={"content": ""})
        assert response.status_code == 400


async def test_nightly_review_queues_a_pending_fact_the_user_can_approve() -> None:
    """End-to-end, against the REAL graph and REAL Haiku extraction (no
    mocking, same convention as every other test in this file): a fresh
    thread's first real /chat turn states a durable preference,
    /memory/review/run-now (the manual trigger _memory_review_loop also
    calls at midnight) should pick it up as a pending proposal, and
    approving it is what actually makes it a real, recalled fact — proving
    the new async review-queue confirmation path end to end, replacing the
    old per-turn interrupt() gate this phase removed."""
    with TestClient(server.app) as client:
        thread = client.post("/threads", json={}).json()
        chat = client.post(
            "/chat",
            json={
                "message": (
                    "For the record: I'm vegetarian. Just acknowledge that, "
                    "don't ask me anything else."
                ),
                "thread_id": thread["id"],
            },
        )
        assert chat.status_code == 200, chat.text

        run = client.post("/memory/review/run-now")
        assert run.status_code == 200, run.text
        assert run.json()["queued"] >= 1

        pending = client.get("/memory/pending").json()["pending"]
        vegetarian_candidates = [p for p in pending if "vegetarian" in p["content"].lower()]
        assert vegetarian_candidates, f"expected a vegetarian-shaped proposal, got: {pending}"
        candidate = vegetarian_candidates[0]
        assert candidate["provenance"] == "nightly review"

        approved = client.post(f"/memory/pending/{candidate['id']}/approve")
        assert approved.status_code == 200, approved.text
        assert approved.json()["content"] == candidate["content"]

        facts = client.get("/memory/facts").json()["facts"]
        assert any(f["id"] == approved.json()["id"] for f in facts)
        still_pending = client.get("/memory/pending").json()["pending"]
        assert all(p["id"] != candidate["id"] for p in still_pending)


async def test_declining_a_pending_fact_discards_it_without_saving() -> None:
    with TestClient(server.app) as client:
        pending_id = await memory_store.propose_pending_fact(
            "user likes jazz", provenance="nightly review", db_path=_MEMORY_DB_PATH
        )
        declined = client.post(f"/memory/pending/{pending_id}/decline")
        assert declined.status_code == 200, declined.text
        assert declined.json()["declined"] is True

        pending = client.get("/memory/pending").json()["pending"]
        assert all(p["id"] != pending_id for p in pending)
        facts = client.get("/memory/facts").json()["facts"]
        assert all("jazz" not in f["content"] for f in facts)


async def test_approve_unknown_pending_fact_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/memory/pending/999999/approve")
        assert response.status_code == 404


async def test_decline_unknown_pending_fact_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/memory/pending/999999/decline")
        assert response.status_code == 404


async def test_cost_returns_real_langfuse_aggregates() -> None:
    """Against the REAL Langfuse project — no mocking, same convention as
    every other test in this file. Not a cost concern to run for real:
    metrics_v_2.metrics() is a read-only aggregation query, not an LLM
    call. No DB isolation needed either — /cost never touches
    conversation_memory.sqlite/long_term_memory.sqlite, it only talks to
    Langfuse's API. Swapped from LangSmith (2026-07-25) after LangSmith's
    own monthly trace-ingestion quota silently stopped accepting new
    traces — see server.py's /cost docstring."""
    with TestClient(server.app) as client:
        response = client.get("/cost")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["project"] == "langfuse"
        windows = body["windows"]
        assert set(windows.keys()) == {"today", "week", "all_time"}

        for window in windows.values():
            assert window["run_count"] >= 0
            assert window["total_tokens"] >= 0
            assert window["total_cost"] >= 0.0
            # total should be prompt+completion, not a separate drifting number
            assert window["total_tokens"] == window["prompt_tokens"] + window["completion_tokens"]

        # Nested time windows: all_time >= week >= today, always, given this
        # project has real Langfuse trace history (Phase 16 onward,
        # 2026-07-16).
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
        client.post("/threads", json={"title": "other"})
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


# --- POST /uploads (file/photo upload feature) ------------------------------
# Deliberately hit the real workspace/ dir (tools.py's WORKSPACE_DIR has no
# env-var redirect, unlike the DB paths above) rather than modifying that
# security-sensitive module just for test isolation — each test cleans up
# exactly what it wrote, same "throwaway scripts must not pollute real
# state" discipline CLAUDE.md's verification section already requires.
# None of these hit the graph — cheap, no Anthropic API calls.


def _tiny_png_bytes() -> bytes:
    import io as _io

    from PIL import Image as _Image

    buf = _io.BytesIO()
    _Image.new("RGB", (4, 4), color=(200, 90, 40)).save(buf, format="PNG")
    return buf.getvalue()


def _cleanup_upload(rel_path: str) -> None:
    from assistant.tools import WORKSPACE_DIR

    resolved = WORKSPACE_DIR / rel_path
    if resolved.exists():
        resolved.unlink()
        if not any(resolved.parent.iterdir()):
            resolved.parent.rmdir()


async def test_upload_image_happy_path_and_downsamples() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/uploads", files={"file": ("photo.png", _tiny_png_bytes(), "image/png")}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "image"
        assert body["mime_type"] == "image/png"
        assert body["path"].startswith("uploads/")
        assert body["filename"] == "photo.png"
        try:
            from assistant.tools import WORKSPACE_DIR

            assert (WORKSPACE_DIR / body["path"]).is_file()
        finally:
            _cleanup_upload(body["path"])


async def test_upload_oversized_image_rejected_with_413() -> None:
    oversized = b"\x00" * (server.MAX_IMAGE_BYTES + 1024)
    with TestClient(server.app) as client:
        response = client.post(
            "/uploads", files={"file": ("big.png", oversized, "image/png")}
        )
        assert response.status_code == 413


async def test_upload_heic_rejected_with_clear_error() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/uploads", files={"file": ("photo.heic", b"not-a-real-heic", "image/heic")}
        )
        assert response.status_code == 415
        assert "HEIC" in response.text or "convert" in response.text.lower()


async def test_upload_filename_with_traversal_characters_is_sanitized() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/uploads",
            files={"file": ("../../etc/passwd.png", _tiny_png_bytes(), "image/png")},
        )
        assert response.status_code == 200
        body = response.json()
        assert ".." not in body["path"]
        assert body["path"].startswith("uploads/")
        _cleanup_upload(body["path"])


async def test_chat_with_image_attachment_reaches_claude_vision() -> None:
    """The one real end-to-end check for the whole upload feature: an
    uploaded image actually reaches Claude as a multimodal content block
    and gets a sensible response — not just that the endpoint accepts a
    file. Hits the real Anthropic API (claude-sonnet-5 vision), unlike the
    /uploads-only tests above."""
    import io as _io

    from PIL import Image as _Image

    buf = _io.BytesIO()
    _Image.new("RGB", (64, 64), color=(255, 0, 0)).save(buf, format="PNG")
    red_square = buf.getvalue()

    with TestClient(server.app) as client:
        upload = client.post(
            "/uploads", files={"file": ("swatch.png", red_square, "image/png")}
        )
        assert upload.status_code == 200, upload.text
        attachment = upload.json()
        try:
            response = client.post(
                "/chat",
                json={
                    "message": "What single color is this image? Answer with just the color name.",
                    "attachments": [
                        {
                            "path": attachment["path"],
                            "mime_type": attachment["mime_type"],
                            "kind": attachment["kind"],
                            "filename": attachment["filename"],
                        }
                    ],
                },
            )
            assert response.status_code == 200, response.text
            body = _final_sse_event(response)
            assert body["type"] == "message"
            assert "red" in body["content"].lower()
        finally:
            _cleanup_upload(attachment["path"])


# --- /board/tasks (kanban board) ---------------------------------------
# Pure CRUD over the isolated tmpdir-redirected board.sqlite — no graph
# calls, cheap.


async def test_board_task_create_list_update_move_delete_round_trip() -> None:
    with TestClient(server.app) as client:
        created = client.post(
            "/board/tasks",
            json={"column": "todo", "title": "Write tests", "priority": "high"},
        )
        assert created.status_code == 200, created.text
        task = created.json()
        assert task["column"] == "todo"
        assert task["priority"] == "high"
        assert task["ref"].startswith("ONI-")
        task_id = task["id"]

        listed = client.get("/board/tasks")
        assert listed.status_code == 200
        assert any(t["id"] == task_id for t in listed.json()["tasks"])

        edited = client.patch(f"/board/tasks/{task_id}", json={"title": "Write more tests"})
        assert edited.status_code == 200
        assert edited.json()["title"] == "Write more tests"
        assert edited.json()["column"] == "todo"

        moved = client.patch(f"/board/tasks/{task_id}", json={"column": "done"})
        assert moved.status_code == 200
        assert moved.json()["column"] == "done"

        deleted = client.delete(f"/board/tasks/{task_id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True

        listed_after = client.get("/board/tasks")
        assert not any(t["id"] == task_id for t in listed_after.json()["tasks"])


async def test_board_task_unknown_id_returns_404() -> None:
    with TestClient(server.app) as client:
        assert client.patch("/board/tasks/does-not-exist", json={"title": "x"}).status_code == 404
        assert client.delete("/board/tasks/does-not-exist").status_code == 404


async def test_board_task_invalid_column_returns_400() -> None:
    with TestClient(server.app) as client:
        response = client.post(
            "/board/tasks", json={"column": "not-a-real-column", "title": "x"}
        )
        assert response.status_code == 400


# --- Unattended pre-approved automations (PLAN.md Phase 24) ----------------


def _create_test_automation(client: TestClient, **overrides: Any) -> dict[str, Any]:
    payload = {
        "name": "Landing text",
        "trigger_description": "arrive at SFO",
        "target": "+15551234567",
        "goal": "Say exactly: I have landed.",
        "action": "send_imessage",
        **overrides,
    }
    response = client.post("/automations", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def test_automation_create_list_update_delete_round_trip() -> None:
    with TestClient(server.app) as client:
        created = _create_test_automation(client)
        assert created["enabled"] is True
        assert created["action"] == "send_imessage"
        automation_id = created["id"]

        listed = client.get("/automations")
        assert listed.status_code == 200
        assert any(a["id"] == automation_id for a in listed.json()["automations"])

        updated = client.patch(f"/automations/{automation_id}", json={"enabled": False})
        assert updated.status_code == 200
        assert updated.json()["enabled"] is False

        deleted = client.delete(f"/automations/{automation_id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True

        listed_after = client.get("/automations")
        assert not any(a["id"] == automation_id for a in listed_after.json()["automations"])


async def test_automation_create_rejects_non_eligible_action() -> None:
    """PLAN.md Phase 24's deliberate scope narrowing — unattended
    pre-approval is limited to messaging-shaped actions, not the full
    GATED_ACTIONS set (server.py's AUTOMATION_ELIGIBLE_ACTIONS)."""
    with TestClient(server.app) as client:
        response = client.post(
            "/automations",
            json={
                "name": "bad",
                "trigger_description": "x",
                "target": "x",
                "goal": "x",
                "action": "delete_disk_file",
            },
        )
        assert response.status_code == 400


async def test_automation_update_unknown_id_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.patch("/automations/does-not-exist", json={"enabled": False})
        assert response.status_code == 404


async def test_automation_delete_unknown_id_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.delete("/automations/does-not-exist")
        assert response.status_code == 404


async def test_fire_disabled_automation_is_skipped_and_logged() -> None:
    with TestClient(server.app) as client:
        created = _create_test_automation(client)
        client.patch(f"/automations/{created['id']}", json={"enabled": False})

        fired = client.post(f"/automations/{created['id']}/fire")
        assert fired.status_code == 200, fired.text
        assert fired.json()["outcome"] == "skipped"

        runs = client.get("/automations/runs")
        assert any(
            r["automation_id"] == created["id"] and r["outcome"] == "skipped"
            for r in runs.json()["runs"]
        )


async def test_fire_automation_within_cooldown_is_skipped_and_not_regated() -> None:
    """A real, live-diagnosed gap: a flaky geofence can refire the same
    automation repeatedly in a short window, each one a real unattended
    send. Seeds a prior "fired" run directly (no need to actually fire
    through the real graph a second time) and confirms an immediate
    refire is skipped rather than running again."""
    with TestClient(server.app) as client:
        created = _create_test_automation(client)
        await server.automation_store.log_run(created["id"], outcome="fired", detail="test seed")

        fired = client.post(f"/automations/{created['id']}/fire")
        assert fired.status_code == 200, fired.text
        body = fired.json()
        assert body["outcome"] == "skipped"
        assert "cooldown" in body["detail"].lower()


async def test_fire_unknown_automation_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/automations/does-not-exist/fire")
        assert response.status_code == 404


async def test_fire_automation_runs_through_the_real_graph_with_no_interrupt() -> None:
    """PLAN.md Phase 24's central live-verification requirement: a real
    registered automation fires against the REAL graph and completes with
    NO interrupt — proving pre_approved_actions correctly short-circuits
    send_imessage's own interrupt() call (mac_tools.py) the same way a
    live upfront-confirmed turn already does, and that the whole chain
    (automation_store -> /fire -> _invoke_agent_graph -> mac_control_agent
    -> send_imessage) is actually wired together, not just each piece
    unit-tested in isolation."""
    with TestClient(server.app) as client:
        created = _create_test_automation(
            client,
            goal="Use the send_imessage tool to send exactly this message: automation fired ok",
            target="+15559990000",
        )

        fired = client.post(f"/automations/{created['id']}/fire")
        assert fired.status_code == 200, fired.text
        body = fired.json()
        assert body["outcome"] == "fired", body

        runs = client.get("/automations/runs")
        matching = [r for r in runs.json()["runs"] if r["automation_id"] == created["id"]]
        assert matching and matching[0]["outcome"] == "fired"


# ---- Projects (PLAN.md Phase 28) — plain CRUD, no LLM calls needed.
# Placed last and deliberately never let a project/thread creation here
# become the shared active-thread pointer for an earlier real-graph test
# that relies on it — thread_store.create_thread always reassigns the
# pointer, so ordering these after every real-graph test avoids that
# cross-test interference entirely.


async def test_projects_crud_round_trips_through_the_api() -> None:
    with TestClient(server.app) as client:
        created = client.post("/projects", json={"name": "Coding"})
        assert created.status_code == 200, created.text
        project = created.json()
        assert project["name"] == "Coding"
        assert project["color"]

        listed = client.get("/projects")
        assert any(p["id"] == project["id"] for p in listed.json()["projects"])

        renamed = client.patch(f"/projects/{project['id']}", json={"name": "Engineering"})
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["name"] == "Engineering"


async def test_rename_unknown_project_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.patch("/projects/does-not-exist", json={"name": "x"})
        assert response.status_code == 404


async def test_assigning_and_clearing_a_thread_project_round_trips_through_the_api() -> None:
    with TestClient(server.app) as client:
        project = client.post("/projects", json={"name": "Research"}).json()
        thread = client.post("/threads", json={"title": "Roth vs traditional"}).json()

        assigned = client.patch(f"/threads/{thread['id']}/project", json={"project_id": project["id"]})
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()["project_id"] == project["id"]

        cleared = client.patch(f"/threads/{thread['id']}/project", json={"project_id": None})
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["project_id"] is None


async def test_assign_thread_project_unknown_ids_return_404() -> None:
    with TestClient(server.app) as client:
        project = client.post("/projects", json={"name": "Research"}).json()
        bad_thread = client.patch("/threads/does-not-exist/project", json={"project_id": project["id"]})
        assert bad_thread.status_code == 404

        thread = client.post("/threads", json={"title": "x"}).json()
        bad_project = client.patch(f"/threads/{thread['id']}/project", json={"project_id": "does-not-exist"})
        assert bad_project.status_code == 404


async def test_deleting_a_project_unassigns_its_threads_via_the_api() -> None:
    with TestClient(server.app) as client:
        project = client.post("/projects", json={"name": "Life Admin"}).json()
        thread = client.post("/threads", json={"title": "Pack for Denver"}).json()
        client.patch(f"/threads/{thread['id']}/project", json={"project_id": project["id"]})

        deleted = client.delete(f"/projects/{project['id']}")
        assert deleted.status_code == 200, deleted.text

        threads = client.get("/threads").json()["threads"]
        surviving = next(t for t in threads if t["id"] == thread["id"])
        assert surviving["project_id"] is None


async def test_delete_unknown_project_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.delete("/projects/does-not-exist")
        assert response.status_code == 404


# ---- Claude Code sessions: live visibility + kill switch (STEPS.md 149) ---
# No real `claude` CLI subprocess here — a fake process object stands in,
# same "fast offline unit coverage for pure logic" convention as
# test_claude_code_live.py itself.


class _FakeLiveProcess:
    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass

    async def wait(self) -> int:
        return 0


async def test_live_claude_code_sessions_endpoint_reflects_the_registry() -> None:
    from assistant import claude_code_live

    with TestClient(server.app) as client:
        empty = client.get("/claude-code-sessions/live")
        assert empty.status_code == 200, empty.text
        assert empty.json() == {"sessions": []}

        claude_code_live.register("live-test-session", _FakeLiveProcess(), "a live prompt")
        try:
            response = client.get("/claude-code-sessions/live")
            assert response.status_code == 200, response.text
            sessions = response.json()["sessions"]
            assert len(sessions) == 1
            assert sessions[0]["session_id"] == "live-test-session"
            assert sessions[0]["prompt_preview"] == "a live prompt"
        finally:
            claude_code_live.unregister("live-test-session")


async def test_stop_claude_code_session_terminates_a_live_one() -> None:
    from assistant import claude_code_live

    with TestClient(server.app) as client:
        claude_code_live.register("live-test-session-2", _FakeLiveProcess(), "prompt")
        response = client.post("/claude-code-sessions/live-test-session-2/stop")
        assert response.status_code == 200, response.text
        assert response.json() == {"stopped": True}
        assert claude_code_live.is_live("live-test-session-2") is False


async def test_stop_unknown_claude_code_session_returns_404() -> None:
    with TestClient(server.app) as client:
        response = client.post("/claude-code-sessions/does-not-exist/stop")
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
    asyncio.run(test_write_disk_file_gated_round_trip_through_the_real_graph())
    print("OK: write_disk_file gated round-trip through the real graph")
    asyncio.run(test_phone_turn_round_trips_through_the_real_graph())
    print("OK: /phone/turn round-trips through the real graph")
    asyncio.run(test_phone_turn_includes_location_context())
    print("OK: /phone/turn includes location context")
    asyncio.run(test_phone_turn_with_unknown_thread_id_returns_404())
    print("OK: /phone/turn with an unknown thread_id returns 404")
    asyncio.run(test_phone_turn_and_resume_gated_round_trip())
    print("OK: /phone/turn gated-tool interrupt -> /phone/resume completes the action")
    asyncio.run(test_phone_turn_auto_declines_text_only_gate())
    print("OK: /phone/turn auto-declines a voice_approvable: False gate")
    asyncio.run(test_phone_turn_run_shortcut_on_phone_is_ungated())
    print("OK: /phone/turn's run_shortcut_on_phone is ungated (accepting supervisor non-determinism)")
    asyncio.run(test_phone_turn_delegates_to_phone_agent_and_surfaces_open_url_action())
    print("OK: /phone/turn delegates to phone_agent and surfaces an open_url phone_action")
    asyncio.run(test_phone_turn_ambiguous_open_request_routes_to_phone_not_mac())
    print("OK: /phone/turn routes an ambiguous 'open X' request to phone_agent, not mac_control_agent")
    asyncio.run(test_phone_turn_without_phone_action_omits_the_field())
    print("OK: /phone/turn omits phone_actions when none occurred")
    asyncio.run(test_phone_health_sync_round_trips_through_get_latest_health_snapshot())
    print("OK: /phone/health-sync round-trips through get_latest_health_snapshot")
    asyncio.run(test_memory_facts_list_and_delete())
    print("OK: /memory/facts list + delete round-trip")
    asyncio.run(test_delete_unknown_fact_returns_404())
    print("OK: deleting an unknown fact id returns 404")
    asyncio.run(test_create_memory_fact_is_user_authored_and_ungated())
    print("OK: POST /memory/facts is user-authored and ungated")
    asyncio.run(test_create_memory_fact_rejects_empty_content())
    print("OK: POST /memory/facts rejects empty content")
    asyncio.run(test_update_memory_fact_round_trip())
    print("OK: PATCH /memory/facts/{id} round-trips")
    asyncio.run(test_update_unknown_fact_returns_404())
    print("OK: PATCH an unknown fact id returns 404")
    asyncio.run(test_update_memory_fact_rejects_empty_content())
    print("OK: PATCH /memory/facts/{id} rejects empty content")
    asyncio.run(test_nightly_review_queues_a_pending_fact_the_user_can_approve())
    print("OK: nightly review queues a pending fact the user can approve")
    asyncio.run(test_declining_a_pending_fact_discards_it_without_saving())
    print("OK: declining a pending fact discards it without saving")
    asyncio.run(test_approve_unknown_pending_fact_returns_404())
    print("OK: approving an unknown pending fact returns 404")
    asyncio.run(test_decline_unknown_pending_fact_returns_404())
    print("OK: declining an unknown pending fact returns 404")
    asyncio.run(test_cost_returns_real_langfuse_aggregates())
    print("OK: /cost returns real Langfuse aggregates across today/week/all_time")
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
    asyncio.run(test_upload_image_happy_path_and_downsamples())
    print("OK: POST /uploads accepts an image and stores it under workspace/")
    asyncio.run(test_upload_oversized_image_rejected_with_413())
    print("OK: POST /uploads rejects an oversized image with 413")
    asyncio.run(test_upload_heic_rejected_with_clear_error())
    print("OK: POST /uploads rejects HEIC with a clear conversion error")
    asyncio.run(test_upload_filename_with_traversal_characters_is_sanitized())
    print("OK: POST /uploads sanitizes a filename with traversal characters")
    asyncio.run(test_chat_with_image_attachment_reaches_claude_vision())
    print("OK: an uploaded image reaches Claude as a real multimodal content block")
    asyncio.run(test_board_task_create_list_update_move_delete_round_trip())
    print("OK: board task create/list/update/move/delete round-trips")
    asyncio.run(test_board_task_unknown_id_returns_404())
    print("OK: board task operations on an unknown id return 404")
    asyncio.run(test_board_task_invalid_column_returns_400())
    print("OK: board task creation with an invalid column returns 400")
    asyncio.run(test_automation_create_list_update_delete_round_trip())
    print("OK: automation create/list/update/delete round-trips")
    asyncio.run(test_automation_create_rejects_non_eligible_action())
    print("OK: automation creation rejects a non-eligible action")
    asyncio.run(test_automation_update_unknown_id_returns_404())
    print("OK: automation update on an unknown id returns 404")
    asyncio.run(test_automation_delete_unknown_id_returns_404())
    print("OK: automation delete on an unknown id returns 404")
    asyncio.run(test_fire_disabled_automation_is_skipped_and_logged())
    print("OK: firing a disabled automation is skipped and logged")
    asyncio.run(test_fire_unknown_automation_returns_404())
    print("OK: firing an unknown automation returns 404")
    asyncio.run(test_fire_automation_runs_through_the_real_graph_with_no_interrupt())
    print("OK: firing a real automation runs through the real graph with no interrupt")
    asyncio.run(test_projects_crud_round_trips_through_the_api())
    print("OK: project create/list/rename round-trips through the API")
    asyncio.run(test_rename_unknown_project_returns_404())
    print("OK: renaming an unknown project returns 404")
    asyncio.run(test_assigning_and_clearing_a_thread_project_round_trips_through_the_api())
    print("OK: assigning and clearing a thread's project round-trips through the API")
    asyncio.run(test_assign_thread_project_unknown_ids_return_404())
    print("OK: assigning a thread's project with an unknown thread/project id returns 404")
    asyncio.run(test_deleting_a_project_unassigns_its_threads_via_the_api())
    print("OK: deleting a project unassigns rather than deletes its threads, via the API")
    asyncio.run(test_delete_unknown_project_returns_404())
    print("OK: deleting an unknown project returns 404")
    asyncio.run(test_live_claude_code_sessions_endpoint_reflects_the_registry())
    print("OK: GET /claude-code-sessions/live reflects the live registry")
    asyncio.run(test_stop_claude_code_session_terminates_a_live_one())
    print("OK: POST /claude-code-sessions/{id}/stop terminates a live session")
    asyncio.run(test_stop_unknown_claude_code_session_returns_404())
    print("OK: stopping an unknown Claude Code session returns 404")
