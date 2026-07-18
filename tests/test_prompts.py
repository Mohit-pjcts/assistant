"""Tests for assistant.prompts — Phase 16 Part A's prompt-management pillar
(STEPS.md 82).

No live Langfuse account needed for the fallback-path tests: without keys
configured, get_prompt() never makes a network call at all (observability.
get_client() returns None immediately). The "fetches a real prompt from
Langfuse" round trip was verified by hand against the real account (STEPS.md
82: all 6 migrated prompts fetch back byte-for-byte identical to their local
fallback), not reproduced here — this project's no-mocking convention
doesn't extend to standing up prompt fixtures in a real cloud account inside
a test run.
"""

from assistant import observability, prompts


def test_compile_local_substitutes_double_brace_variables() -> None:
    result = prompts._compile_local("Hello {{name}}, today is {{day}}.", name="Ada", day="Tuesday")
    assert result == "Hello Ada, today is Tuesday."


def test_compile_local_is_a_noop_with_no_variables() -> None:
    assert prompts._compile_local("Plain text, no placeholders.") == "Plain text, no placeholders."


def test_compile_local_leaves_unmatched_placeholders_untouched() -> None:
    """Mirrors Langfuse's own compile() behavior for a variable that wasn't
    supplied — doesn't guess or blank it out."""
    result = prompts._compile_local("Hello {{name}}.")
    assert result == "Hello {{name}}."


def test_get_prompt_returns_fallback_without_client(monkeypatch) -> None:
    """Unconfigured Langfuse must never prevent a prompt from resolving —
    same defensive posture as langfuse_run_config()'s {} no-op.

    Resets `_client`/`_client_attempted` (v3's real gating globals), not
    the v2-era `_handler_attempted` this used to reset (a real
    /code-review max finding, STEPS.md 91) — that attribute no longer
    exists on observability.py, so the old reset silently touched a dead
    name instead of the state get_client() actually caches on."""
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    observability._client = None
    observability._client_attempted = False
    observability._handler = None

    result = prompts.get_prompt("some-prompt-name", "the fallback text")
    assert result == "the fallback text"

    observability._client = None
    observability._client_attempted = False
    observability._handler = None


def test_get_prompt_compiles_fallback_variables_without_client(monkeypatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    observability._client = None
    observability._client_attempted = False
    observability._handler = None

    result = prompts.get_prompt("some-prompt-name", "Hi {{name}}", name="Bob")
    assert result == "Hi Bob"

    observability._client = None
    observability._client_attempted = False
    observability._handler = None


if __name__ == "__main__":
    mp = __import__("_pytest.monkeypatch", fromlist=["MonkeyPatch"]).MonkeyPatch()
    try:
        test_compile_local_substitutes_double_brace_variables()
        test_compile_local_is_a_noop_with_no_variables()
        test_compile_local_leaves_unmatched_placeholders_untouched()
        test_get_prompt_returns_fallback_without_client(mp)
        test_get_prompt_compiles_fallback_variables_without_client(mp)
        print("All test_prompts tests passed.")
    finally:
        mp.undo()
