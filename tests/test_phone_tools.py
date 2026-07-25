"""Tests for assistant.phone_tools — PLAN.md Phase 21's phone_agent tools.

open_app_on_phone/open_url_on_phone/get_latest_health_snapshot are already
covered live, end to end, in tests/test_server.py (real graph calls through
/phone/turn) and have no dedicated unit tests of their own — they're plain
Command-returning functions with no branching logic to unit-test in
isolation. run_shortcut_on_phone is the same shape (also ungated, per the
user's explicit choice — see its own module docstring), but gets ONE direct
unit test here specifically because a real, live-diagnosed model quirk
(tests/test_server.py's own test_phone_turn_run_shortcut_on_phone_is_ungated
docstring has the full story: the supervisor sometimes calls
request_gated_action_confirmation('run_shortcut_on_phone') anyway, despite
it not being a gated action, then retries with the similar-sounding
'run_shortcut' instead of just delegating) makes the LIVE graph test
non-deterministic at the SUPERVISOR level. This test proves the actual
code-level guarantee — the TOOL itself never gates — independent of
whatever the model chooses to do around it.
"""

import assistant.phone_tools as phone_tools
from assistant.phone_tools import PHONE_ACTION_KEY


def test_run_shortcut_on_phone_never_gates() -> None:
    """Deterministic, no LLM/graph involved: calling the tool directly
    must never raise/block on a confirmation — it always returns
    immediately with the phone_action marker set. This is the actual
    code-level guarantee the user's "keep shortcuts on phone ungated"
    request depends on; tests/test_server.py's live version of this
    additionally proves the graph wiring but can't isolate the
    supervisor's own occasional confused retry from the tool's real
    behavior the way this test can."""
    command = phone_tools.run_shortcut_on_phone.invoke(
        {
            "name": "run_shortcut_on_phone",
            "args": {"name": "Lock Screen"},
            "id": "test-call-id",
            "type": "tool_call",
        }
    )
    message = command.update["messages"][0]
    assert message.additional_kwargs[PHONE_ACTION_KEY] == [
        {"type": "run_shortcut", "name": "Lock Screen"}
    ]
    assert "Lock Screen" in message.content


if __name__ == "__main__":
    test_run_shortcut_on_phone_never_gates()
    print("OK: test_run_shortcut_on_phone_never_gates")
    print("\n1 test passed")
