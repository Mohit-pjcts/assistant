"""Tests for assistant.voice_io (+ voice_daemon's pure helpers) — the pure,
testable pieces only.

Global-hotkey handling, mic capture, menu bar rendering, and real TTS all
need real hardware/GUI and are verified by hand instead (CLAUDE.md's
"interactive entry points verified by hand" rule). What's tested here:
parse_confirmation's fail-closed behavior — the piece the confirmation
gate's safety actually depends on — transcribe()'s empty-audio short
circuit, the TTS voice-fallback logic (monkeypatched installed-voice set,
following test_mac_tools.py's monkeypatch pattern), speak()'s argv shape,
and the daemon's spoken_prompt fallback for interrupt payloads.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import numpy as np

import assistant.voice_io as voice_io
from assistant.voice_daemon import _spoken_question


@contextmanager
def _fresh_voice_cache():
    """Reset voice_io's one-time voice-resolution cache around a test so
    each case exercises the resolution logic, not a stale cached answer."""
    saved = (voice_io._resolved_voice, voice_io._voice_resolved)
    voice_io._resolved_voice, voice_io._voice_resolved = None, False
    try:
        yield
    finally:
        voice_io._resolved_voice, voice_io._voice_resolved = saved


@contextmanager
def _installed_voices_stubbed(voices: set[str]):
    original = voice_io._installed_voices
    voice_io._installed_voices = lambda: voices
    try:
        yield
    finally:
        voice_io._installed_voices = original


def test_parse_confirmation_recognizes_yes_phrases() -> None:
    for text in ["yes", "Yes.", "yeah", "yep", "sure", "confirmed", "go ahead", "do it"]:
        assert voice_io.parse_confirmation(text) is True, f"expected True for {text!r}"


def test_parse_confirmation_recognizes_no_phrases() -> None:
    for text in ["no", "No.", "nope", "cancel", "stop", "don't", "negative"]:
        assert voice_io.parse_confirmation(text) is False, f"expected False for {text!r}"


def test_parse_confirmation_fails_closed_on_unrecognized_text() -> None:
    for text in ["", "banana", "what did you say", "maybe later"]:
        assert voice_io.parse_confirmation(text) is False, f"expected False for {text!r}"


def test_parse_confirmation_no_takes_priority_when_both_present() -> None:
    assert voice_io.parse_confirmation("no, don't go ahead") is False


def test_transcribe_empty_audio_returns_empty_string_without_loading_model() -> None:
    original_get_model = voice_io._get_stt_model

    def _fail_if_called() -> None:
        raise AssertionError("transcribe() should not load the STT model for empty audio")

    voice_io._get_stt_model = _fail_if_called
    try:
        assert voice_io.transcribe(np.zeros(0, dtype="float32")) == ""
    finally:
        voice_io._get_stt_model = original_get_model


def test_resolve_tts_voice_uses_configured_voice_when_installed() -> None:
    with _fresh_voice_cache(), _installed_voices_stubbed({"Ava (Premium)", "Samantha"}):
        os.environ["ASSISTANT_TTS_VOICE"] = "Ava (Premium)"
        try:
            assert voice_io._resolve_tts_voice() == "Ava (Premium)"
        finally:
            del os.environ["ASSISTANT_TTS_VOICE"]


def test_resolve_tts_voice_falls_back_to_none_when_not_installed() -> None:
    with _fresh_voice_cache(), _installed_voices_stubbed({"Samantha"}):
        os.environ["ASSISTANT_TTS_VOICE"] = "Ava (Premium)"
        try:
            assert voice_io._resolve_tts_voice() is None
        finally:
            del os.environ["ASSISTANT_TTS_VOICE"]


def test_speak_passes_voice_flag_as_argv_when_resolved() -> None:
    calls: list[list[str]] = []
    original_run = voice_io.subprocess.run

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    voice_io.subprocess.run = fake_run
    try:
        with _fresh_voice_cache(), _installed_voices_stubbed({"Ava (Premium)"}):
            os.environ["ASSISTANT_TTS_VOICE"] = "Ava (Premium)"
            try:
                voice_io.speak("hello there")
            finally:
                del os.environ["ASSISTANT_TTS_VOICE"]
    finally:
        voice_io.subprocess.run = original_run

    assert calls == [["say", "-v", "Ava (Premium)", "hello there"]], f"unexpected argv: {calls}"


def test_speak_omits_voice_flag_on_fallback() -> None:
    calls: list[list[str]] = []
    original_run = voice_io.subprocess.run

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    voice_io.subprocess.run = fake_run
    try:
        with _fresh_voice_cache(), _installed_voices_stubbed(set()):
            voice_io.speak("hello there")
    finally:
        voice_io.subprocess.run = original_run

    assert calls == [["say", "hello there"]], f"unexpected argv: {calls}"


def test_spoken_question_prefers_spoken_prompt() -> None:
    payload = {"action": "run_shortcut", "name": "X", "spoken_prompt": "Permission to run 'X'?"}
    assert _spoken_question(payload) == "Permission to run 'X'?"


def test_spoken_question_falls_back_to_raw_payload() -> None:
    payload = {"action": "legacy_tool", "arg": 1}
    question = _spoken_question(payload)
    assert "legacy_tool" in question and question.endswith("proceed?"), (
        f"unexpected fallback question: {question!r}"
    )


if __name__ == "__main__":
    test_parse_confirmation_recognizes_yes_phrases()
    print("OK: test_parse_confirmation_recognizes_yes_phrases")
    test_parse_confirmation_recognizes_no_phrases()
    print("OK: test_parse_confirmation_recognizes_no_phrases")
    test_parse_confirmation_fails_closed_on_unrecognized_text()
    print("OK: test_parse_confirmation_fails_closed_on_unrecognized_text")
    test_parse_confirmation_no_takes_priority_when_both_present()
    print("OK: test_parse_confirmation_no_takes_priority_when_both_present")
    test_transcribe_empty_audio_returns_empty_string_without_loading_model()
    print("OK: test_transcribe_empty_audio_returns_empty_string_without_loading_model")
    test_resolve_tts_voice_uses_configured_voice_when_installed()
    print("OK: test_resolve_tts_voice_uses_configured_voice_when_installed")
    test_resolve_tts_voice_falls_back_to_none_when_not_installed()
    print("OK: test_resolve_tts_voice_falls_back_to_none_when_not_installed")
    test_speak_passes_voice_flag_as_argv_when_resolved()
    print("OK: test_speak_passes_voice_flag_as_argv_when_resolved")
    test_speak_omits_voice_flag_on_fallback()
    print("OK: test_speak_omits_voice_flag_on_fallback")
    test_spoken_question_prefers_spoken_prompt()
    print("OK: test_spoken_question_prefers_spoken_prompt")
    test_spoken_question_falls_back_to_raw_payload()
    print("OK: test_spoken_question_falls_back_to_raw_payload")
    print("\n11 tests passed")
