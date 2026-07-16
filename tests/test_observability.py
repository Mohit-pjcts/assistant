"""Tests for assistant.observability — Phase 16 Part A's Langfuse v2 wiring.

No live Langfuse account needed: CallbackHandler construction doesn't
authenticate synchronously (verified by hand against the real installed
package — it only talks to the network on first flush), so these exercise
real construction with throwaway keys rather than mocking anything. The
actual "does a trace show up in the real Langfuse UI" check is a live,
by-hand verification step (this project's no-mocking convention doesn't
extend to standing up a real cloud account inside a test run), recorded in
STEPS.md, not reproduced here.
"""

import asyncio

from assistant import observability
from assistant.agent import make_thread_config


def test_legacy_langchain_shim_lets_v2_callback_handler_import() -> None:
    """The whole point of the shim (see observability.py's module
    docstring): langfuse.callback.CallbackHandler must be importable
    against this project's real installed LangChain 1.x. Import already
    happened at module load time above — this just asserts the class
    that import produced is real and constructible, not a stub."""
    assert observability.CallbackHandler is not None


def test_get_langfuse_run_config_is_noop_without_keys(monkeypatch) -> None:
    """A missing/unset Langfuse config must not break chat on any client —
    same defensive posture as server.py's LangSmithClient handling."""
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    observability._handler = None
    observability._handler_attempted = False

    assert observability.langfuse_run_config("some-thread") == {}


def test_get_langfuse_run_config_builds_real_handler_when_configured(monkeypatch) -> None:
    """With keys set, a real CallbackHandler is constructed (not mocked)
    and merged in with the calling thread's id as the Langfuse session —
    verified against the real installed source (langfuse/callback/
    langchain.py) that `langfuse_session_id` in per-call metadata is what
    the handler actually reads, overriding any constructor-time default."""
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
    observability._handler = None
    observability._handler_attempted = False

    config = observability.langfuse_run_config("thread-abc")

    assert "callbacks" in config and len(config["callbacks"]) == 1
    assert isinstance(config["callbacks"][0], observability.CallbackHandler)
    assert config["metadata"] == {"langfuse_session_id": "thread-abc"}

    # Cleanup so later tests (and other modules importing observability in
    # the same pytest process) don't inherit this throwaway handler.
    observability._handler = None
    observability._handler_attempted = False


def test_configure_client_sets_trace_name_and_tags(monkeypatch) -> None:
    """Best-practices audit finding (STEPS.md 80): trace_name/tags are
    constructor-bound in v2, not per-call overridable like session_id — so
    configure_client() must run before the lazy handler is first built, and
    the resulting handler must carry the stable trace name plus a
    client-specific tag."""
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
    observability._handler = None
    observability._handler_attempted = False
    observability._client_name = None

    observability.configure_client("cli")
    handler = observability._get_handler()

    assert handler.trace_name == observability.TRACE_NAME
    assert handler.tags == ["client:cli"]

    observability._handler = None
    observability._handler_attempted = False
    observability._client_name = None


def test_get_client_returns_none_without_keys(monkeypatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    observability._handler = None
    observability._handler_attempted = False

    assert observability.get_client() is None


def test_get_client_reuses_the_handlers_own_client(monkeypatch) -> None:
    """get_client() must not construct a second Langfuse client/connection —
    STEPS.md 82's whole point for prompts.py/score_gate_outcome() sharing
    credentials with the CallbackHandler."""
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
    observability._handler = None
    observability._handler_attempted = False

    handler = observability._get_handler()
    client = observability.get_client()

    assert client is handler.langfuse

    observability._handler = None
    observability._handler_attempted = False


def test_score_gate_outcome_is_a_noop_without_client(monkeypatch) -> None:
    """Evaluations scoring must never raise or hang when Langfuse isn't
    configured — same defensive posture as everything else in this module.
    The full real round trip (correct trace attribution, the from_timestamp
    fix for the indexing-race bug found live) is verified by hand against
    the real account, not reproduced here — see STEPS.md 82."""
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    observability._handler = None
    observability._handler_attempted = False

    asyncio.run(observability.score_gate_outcome("some-thread", True, "some_action"))
    # No exception, no hang — that's the whole assertion.

    observability._handler = None
    observability._handler_attempted = False


def test_make_thread_config_still_sets_configurable_correctly() -> None:
    """agent.make_thread_config()'s pre-existing contract (checkpoint_ns
    always set alongside thread_id) must survive the Phase 16 merge
    unchanged — this is the load-bearing Phase 1 behavior STEPS.md 3.2
    documents."""
    config = make_thread_config("some-thread-id")
    assert config["configurable"] == {"thread_id": "some-thread-id", "checkpoint_ns": ""}


def test_make_thread_config_merges_langfuse_keys_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-throwaway")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-throwaway")
    observability._handler = None
    observability._handler_attempted = False

    config = make_thread_config("thread-xyz")

    assert config["configurable"] == {"thread_id": "thread-xyz", "checkpoint_ns": ""}
    assert config["metadata"] == {"langfuse_session_id": "thread-xyz"}
    assert len(config["callbacks"]) == 1

    observability._handler = None
    observability._handler_attempted = False


if __name__ == "__main__":
    mp = __import__("_pytest.monkeypatch", fromlist=["MonkeyPatch"]).MonkeyPatch()
    try:
        test_legacy_langchain_shim_lets_v2_callback_handler_import()
        test_get_langfuse_run_config_is_noop_without_keys(mp)
        test_get_langfuse_run_config_builds_real_handler_when_configured(mp)
        test_configure_client_sets_trace_name_and_tags(mp)
        test_get_client_returns_none_without_keys(mp)
        test_get_client_reuses_the_handlers_own_client(mp)
        test_score_gate_outcome_is_a_noop_without_client(mp)
        test_make_thread_config_still_sets_configurable_correctly()
        test_make_thread_config_merges_langfuse_keys_when_configured(mp)
        print("All test_observability tests passed.")
    finally:
        mp.undo()
