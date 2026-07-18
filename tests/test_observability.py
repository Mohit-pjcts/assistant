"""Tests for assistant.observability — Phase 16 Part B's Langfuse v3
migration.

No live Langfuse account needed: constructing a `Langfuse` client and
entering/exiting `propagate_attributes()` don't authenticate or make any
network call synchronously (verified by hand — only actual span export
does, which happens async via the batch processor), so these exercise real
construction with throwaway keys rather than mocking anything. The actual
"does a trace show up in the real Langfuse UI" check is a live, by-hand
verification step, recorded in STEPS.md, not reproduced here.
"""

import asyncio

from opentelemetry import context as otel_context_api

from assistant import observability
from assistant.agent import make_thread_config


def _reset_state() -> None:
    """Shared reset for the four independent lazy-singleton globals this
    module now has (v3 split get_client()'s caching from _get_handler()'s
    own None-or-real state, unlike v2 where one handler object gated both).

    Every test below wraps its body in `try: ... finally: _reset_state()`
    (called once up front too) rather than relying on a pytest autouse
    fixture — a /code-review max finding (STEPS.md 91) caught that the
    OLD head-and-tail-call pattern left state dirty if a test failed its
    own assertion before reaching its trailing call, but an autouse
    fixture would make this the only file in tests/ that isn't runnable
    with plain `python`, breaking a convention every other file here
    follows (CLAUDE.md: "pytest-shaped, runnable with plain python"). The
    try/finally gets the same guaranteed-cleanup property either way."""
    observability._client = None
    observability._client_attempted = False
    observability._handler = None
    observability._client_name = None


def test_get_client_returns_none_without_keys(monkeypatch) -> None:
    """A missing/unset Langfuse config must not break chat on any client —
    same defensive posture as server.py's LangSmithClient handling."""
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        assert observability.get_client() is None
    finally:
        _reset_state()


def test_get_client_builds_real_client_when_configured(monkeypatch) -> None:
    """With keys set, a real `Langfuse` client is constructed (not mocked) —
    v3's client construction doesn't authenticate synchronously, verified by
    hand, so this is safe without a live account."""
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")

        client = observability.get_client()

        from langfuse import Langfuse

        assert isinstance(client, Langfuse)
    finally:
        _reset_state()


def test_get_client_resolves_langfuse_host_over_langfuse_base_url(monkeypatch) -> None:
    """A real /code-review max finding (STEPS.md 91): this project's own
    LANGFUSE_HOST-priority intent was silently overridden by the installed
    SDK's own internal precedence, which checks LANGFUSE_BASE_URL before a
    `host=` kwarg — fixed by passing the resolved value as `base_url=`
    instead, which the SDK checks first. Asserted directly against the
    real constructed client's own resolved `_base_url`, not just "no
    exception"."""
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_HOST", "https://intended-host.example.com")
        monkeypatch.setenv("LANGFUSE_BASE_URL", "https://wrong-host.example.com")

        client = observability.get_client()

        assert client is not None
        assert client._base_url == "https://intended-host.example.com"
    finally:
        _reset_state()


def test_get_handler_returns_none_without_client(monkeypatch) -> None:
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        assert observability._get_handler() is None
    finally:
        _reset_state()


def test_get_handler_builds_real_handler_when_configured(monkeypatch) -> None:
    """Unlike v2, the handler carries NO session/tags/trace_name state at
    all — those are set per-call by tracing_context() via
    propagate_attributes() instead (see module docstring)."""
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")

        handler = observability._get_handler()

        assert isinstance(handler, observability.CallbackHandler)
    finally:
        _reset_state()


def test_get_handler_and_get_client_share_the_same_underlying_client(monkeypatch) -> None:
    """v2 guaranteed this by construction (get_client() literally returned
    handler.langfuse). v3 splits _client/_handler into independently-lazy
    globals; `_get_handler()`'s `CallbackHandler()` builds its OWN `Langfuse`
    wrapper object internally (langfuse's own `get_client()`, a different
    function from this module's — verified directly against the installed
    source, `_create_client_from_instance()` constructs a fresh wrapper
    every time), so `handler.client is client` is FALSE even when correctly
    configured — checked directly, not assumed, after this test's own first
    draft asserted identity and failed.

    Asserting on `._otel_tracer` identity instead was ALSO tried and found
    too fragile to keep: it depends on langfuse's own process-wide,
    public-key-keyed instance registry not having accumulated more than one
    distinct project's worth of instances across the whole pytest session
    (a real, observed flake — passes in isolation, fails as part of the
    full suite once other tests' throwaway clients pile up, since the SDK's
    own multi-project disambiguation then deliberately returns a disabled/
    no-op tracer rather than guess). `_base_url` equality is the externally
    observable, registry-noise-proof signal that both wrapper objects were
    actually configured against the same project, and is what this test
    asserts instead. A dropped v2-era test asserting the "same client"
    guarantee had no v3 replacement (a /code-review max finding, STEPS.md
    91) — this is the v3-correct, non-flaky version of that guarantee."""
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")

        client = observability.get_client()
        handler = observability._get_handler()

        assert handler.client._base_url == client._base_url
    finally:
        _reset_state()


def test_langfuse_callbacks_is_noop_without_keys(monkeypatch) -> None:
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        assert observability.langfuse_callbacks() == []
    finally:
        _reset_state()


def test_langfuse_callbacks_returns_handler_when_configured(monkeypatch) -> None:
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")

        callbacks = observability.langfuse_callbacks()

        assert len(callbacks) == 1
        assert isinstance(callbacks[0], observability.CallbackHandler)
    finally:
        _reset_state()


def test_tracing_context_is_a_clean_noop_without_keys(monkeypatch) -> None:
    """Missing Langfuse config must not break the graph invocation it
    wraps — the whole point of this being a no-op `yield`, not an error."""
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        with observability.tracing_context("some-thread"):
            pass  # no exception is the whole assertion
    finally:
        _reset_state()


def test_tracing_context_propagates_real_session_tags_and_trace_name(monkeypatch) -> None:
    """A real /code-review max finding (STEPS.md 91): the previous version
    of this test only asserted "no exception," never that the actual
    session_id/tags/trace_name values reach propagate_attributes() — a
    future bug swapping the tags=/session_id= keyword arguments, or
    breaking the f"client:{_client_name}" format, would have passed the
    whole suite. `propagate_attributes()` stores each value inspectably via
    OTEL's own `context.get_value("langfuse.propagated.<key>")` (verified
    directly against the installed langfuse source, not assumed), so this
    now asserts the real values reaching it inside the `with` block."""
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
        observability.configure_client("cli")

        with observability.tracing_context("thread-abc"):
            assert otel_context_api.get_value("langfuse.propagated.session_id") == "thread-abc"
            assert otel_context_api.get_value("langfuse.propagated.tags") == ["client:cli"]
            assert otel_context_api.get_value("langfuse.propagated.trace_name") == "agent-turn"
    finally:
        _reset_state()


def test_configure_client_sets_client_name(monkeypatch) -> None:
    _reset_state()
    try:
        observability.configure_client("cli")
        assert observability._client_name == "cli"
    finally:
        _reset_state()


def test_score_gate_outcome_is_a_noop_without_client(monkeypatch) -> None:
    """Evaluations scoring must never raise or hang when Langfuse isn't
    configured — same defensive posture as everything else in this module.
    The full real round trip is verified by hand against the real account,
    not reproduced here — see STEPS.md."""
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        asyncio.run(observability.score_gate_outcome("some-thread", True, "some_action"))
        # No exception, no hang — that's the whole assertion.
    finally:
        _reset_state()


def test_fire_score_gate_outcome_schedules_a_task_in_an_independent_context(monkeypatch) -> None:
    """A /code-review max finding (STEPS.md 91): all three call sites fired
    `asyncio.create_task(score_gate_outcome(...))` from inside an enclosing
    `tracing_context()` block, inheriting a copy of that (possibly
    already-closing) OTEL context. `fire_score_gate_outcome()` centralizes
    the fix — `context=contextvars.Context()` gives the task a genuinely
    empty context, asserted here by checking the propagated session_id
    from the *caller's* enclosing tracing_context() block is NOT visible
    inside the scheduled task's own context."""
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        seen: dict[str, object] = {}

        async def _fake_score_gate_outcome(thread_id, approved, action=None) -> None:
            seen["session_id"] = otel_context_api.get_value("langfuse.propagated.session_id")

        async def _run() -> None:
            monkeypatch.setattr(observability, "score_gate_outcome", _fake_score_gate_outcome)
            monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
            monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
            with observability.tracing_context("thread-outer"):
                observability.fire_score_gate_outcome("thread-outer", True, "some_action")
                task = next(t for t in asyncio.all_tasks() if t is not asyncio.current_task())
                await task

        asyncio.run(_run())
        assert seen["session_id"] is None
    finally:
        _reset_state()


def test_inject_trace_headers_is_a_dict_of_strings(monkeypatch) -> None:
    _reset_state()
    try:
        headers = observability.inject_trace_headers()
        assert isinstance(headers, dict)
        assert all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items())
    finally:
        _reset_state()


def test_attached_parent_context_is_a_clean_noop_with_no_headers(monkeypatch) -> None:
    """No `traceparent` header (no active span on the caller's side, or a
    caller not doing distributed tracing at all) must extract to an empty
    context unchanged — the graceful fallback `fa_service.py`'s two
    endpoints both depend on."""
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        with observability.attached_parent_context({}, "some-thread"):
            pass  # no exception is the whole assertion
    finally:
        _reset_state()


def test_make_thread_config_still_sets_configurable_correctly() -> None:
    """agent.make_thread_config()'s pre-existing contract (checkpoint_ns
    always set alongside thread_id) must survive the Phase 16 merge
    unchanged — this is the load-bearing Phase 1 behavior STEPS.md 3.2
    documents."""
    config = make_thread_config("some-thread-id")
    assert config["configurable"] == {"thread_id": "some-thread-id", "checkpoint_ns": ""}


def test_make_thread_config_is_noop_without_keys(monkeypatch) -> None:
    _reset_state()
    try:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        config = make_thread_config("thread-xyz")

        assert "callbacks" not in config
    finally:
        _reset_state()


def test_make_thread_config_merges_langfuse_callbacks_when_configured(monkeypatch) -> None:
    _reset_state()
    try:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")

        config = make_thread_config("thread-xyz")

        assert config["configurable"] == {"thread_id": "thread-xyz", "checkpoint_ns": ""}
        assert len(config["callbacks"]) == 1
        assert isinstance(config["callbacks"][0], observability.CallbackHandler)
    finally:
        _reset_state()


if __name__ == "__main__":
    mp = __import__("_pytest.monkeypatch", fromlist=["MonkeyPatch"]).MonkeyPatch()
    try:
        test_get_client_returns_none_without_keys(mp)
        test_get_client_builds_real_client_when_configured(mp)
        test_get_client_resolves_langfuse_host_over_langfuse_base_url(mp)
        test_get_handler_returns_none_without_client(mp)
        test_get_handler_builds_real_handler_when_configured(mp)
        test_get_handler_and_get_client_share_the_same_underlying_client(mp)
        test_langfuse_callbacks_is_noop_without_keys(mp)
        test_langfuse_callbacks_returns_handler_when_configured(mp)
        test_tracing_context_is_a_clean_noop_without_keys(mp)
        test_tracing_context_propagates_real_session_tags_and_trace_name(mp)
        test_configure_client_sets_client_name(mp)
        test_score_gate_outcome_is_a_noop_without_client(mp)
        test_fire_score_gate_outcome_schedules_a_task_in_an_independent_context(mp)
        test_inject_trace_headers_is_a_dict_of_strings(mp)
        test_attached_parent_context_is_a_clean_noop_with_no_headers(mp)
        test_make_thread_config_still_sets_configurable_correctly()
        test_make_thread_config_is_noop_without_keys(mp)
        test_make_thread_config_merges_langfuse_callbacks_when_configured(mp)
        print("All test_observability tests passed.")
    finally:
        mp.undo()
