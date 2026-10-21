"""The iPhone app's gate-card layouts are checked against this fixture of the
keys every `interrupt({...})` payload really carries (ios/OniCore, Gate.swift).
If a gated tool gains or loses a payload field, this fails until the fixture is
refreshed, and refreshing it makes the Swift drift test show which card needs a
slot for the new field. No model or network calls."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import extract_gate_keys  # noqa: E402


def test_fixture_matches_every_interrupt_payload_in_the_code() -> None:
    fixture = json.loads(extract_gate_keys.FIXTURE.read_text())
    assert extract_gate_keys.extract() == fixture, (
        "a gated tool's payload keys changed: run `python scripts/extract_gate_keys.py --write`, "
        "then `ios/OniCore/test.sh --filter GateLayoutDrift`"
    )


def test_every_gated_action_is_in_the_fixture() -> None:
    from assistant.supervisor import GATED_ACTIONS

    fixture = json.loads(extract_gate_keys.FIXTURE.read_text())
    assert set(GATED_ACTIONS) <= set(fixture), sorted(set(GATED_ACTIONS) - set(fixture))
