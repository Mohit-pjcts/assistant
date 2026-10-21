"""Tests for PLAN.md Phase 32 Stage 2: the spoken voice (assistant/voice_speak.py),
the `/voice/speak` endpoint, the headset channel on `/chat`, and the PATH fix for
ffmpeg (assistant/tool_path.py).

ElevenLabs is replaced by `httpx.MockTransport`, so nothing here spends credits
on the real (free-plan, shared with Onstage) account; one live call was made by
hand and is recorded in STEPS.md.
"""

import asyncio
import atexit
import os
import shutil
import tempfile

import httpx
import pytest

_tmpdir = tempfile.mkdtemp(prefix="assistant_test_voice_speak_")
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)
# setdefault for the same reason test_server.py explains: whichever test file
# imports assistant.server first fixes these paths for the whole session.
os.environ.setdefault("ASSISTANT_CONVERSATION_DB_PATH", os.path.join(_tmpdir, "conversation_memory.sqlite"))
os.environ.setdefault("ASSISTANT_MEMORY_DB_PATH", os.path.join(_tmpdir, "long_term_memory.sqlite"))

from assistant import voice_speak  # noqa: E402
from assistant.tool_path import ensure_tool_path  # noqa: E402
from assistant.voice_speak import MAX_CHARS, Speaker, SpeakError, speakable  # noqa: E402

MP3 = b"ID3fake-mp3-bytes"


def _fake_elevenlabs(*, credits_left=10_000, tts_status=200, calls=None, in_flight=None):
    """A fake ElevenLabs: /user/subscription reports `credits_left`, the TTS route
    returns MP3 bytes (or `tts_status`). `calls` collects (method, url, headers,
    json); `in_flight` collects the peak number of concurrent TTS requests."""
    state = {"now": 0, "peak": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        if request.url.path.endswith("/user/subscription"):
            return httpx.Response(
                200, json={"tier": "free", "character_limit": 10_000, "character_count": 10_000 - credits_left}
            )
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        if in_flight is not None:
            in_flight["peak"] = state["peak"]
        await asyncio.sleep(0.02)
        state["now"] -= 1
        if tts_status != 200:
            return httpx.Response(tts_status, text='{"detail":{"status":"quota_exceeded"}}')
        return httpx.Response(200, content=MP3, headers={"character-cost": "10"})

    return httpx.MockTransport(handler)


# --- speakable -------------------------------------------------------------


def test_speakable_strips_markdown_a_voice_would_read_aloud():
    text = (
        "## Plan\n"
        "**Bold** and _soft_ and `code` words.\n"
        "- first item\n"
        "- second item\n"
        "See [the docs](https://example.com/very/long/path) or https://example.com/x now.\n"
        "```python\nprint('never spoken')\n```\n"
    )
    clean, truncated = speakable(text)
    assert not truncated
    for noise in ("#", "**", "`", "](", "http", "print", "- "):
        assert noise not in clean, (noise, clean)
    assert "Bold and _soft_ and code words." in clean
    assert "first item." in clean and "second item." in clean
    assert "the docs" in clean and "a link" in clean


def test_speakable_leaves_plain_text_alone():
    assert speakable("Your next meeting is at three.") == ("Your next meeting is at three.", False)


def test_speakable_truncates_at_a_sentence_end():
    sentence = "This is a sentence of moderate length that goes on. "
    clean, truncated = speakable(sentence * 40)
    assert truncated
    assert len(clean) <= MAX_CHARS
    assert clean.endswith(".")


def test_speakable_truncates_on_a_word_when_there_is_no_sentence_end():
    clean, truncated = speakable("word " * 400)
    assert truncated and len(clean) <= MAX_CHARS
    assert not clean.endswith("wor")  # cut on a whole word


def test_speakable_empty_after_cleaning():
    assert speakable("```\ncode only\n```")[0] == ""


# --- Speaker ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_speak_sends_alice_flash_and_the_key_and_returns_the_audio():
    calls: list[httpx.Request] = []
    speaker = Speaker(key="k-test", transport=_fake_elevenlabs(calls=calls))
    audio, truncated = await speaker.speak("Hello there.")
    assert audio == MP3 and truncated is False
    tts = [c for c in calls if "/text-to-speech/" in c.url.path][0]
    assert tts.url.path == f"/v1/text-to-speech/{voice_speak.DEFAULT_VOICE}/stream"
    assert tts.headers["xi-api-key"] == "k-test"
    assert tts.url.params["output_format"] == voice_speak.OUTPUT_FORMAT
    assert b'"model_id":"eleven_flash_v2_5"' in tts.content.replace(b" ", b"")


@pytest.mark.asyncio
async def test_speak_uses_the_voice_override(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_VOICE", "custom-voice-id")
    calls: list[httpx.Request] = []
    await Speaker(key="k", transport=_fake_elevenlabs(calls=calls)).speak("Hi.")
    assert any(c.url.path == "/v1/text-to-speech/custom-voice-id/stream" for c in calls)


@pytest.mark.asyncio
async def test_the_same_text_is_fetched_once():
    calls: list[httpx.Request] = []
    speaker = Speaker(key="k", transport=_fake_elevenlabs(calls=calls))
    await speaker.speak("Repeat me.")
    await speaker.speak("Repeat me.")
    assert len([c for c in calls if "/text-to-speech/" in c.url.path]) == 1


@pytest.mark.asyncio
async def test_never_more_than_two_requests_at_once():
    peak: dict[str, int] = {}
    speaker = Speaker(key="k", transport=_fake_elevenlabs(in_flight=peak))
    await asyncio.gather(*(speaker.speak(f"Sentence number {i}.") for i in range(8)))
    assert peak["peak"] == voice_speak.MAX_PARALLEL


@pytest.mark.asyncio
async def test_stops_before_the_credits_run_out_and_makes_no_tts_request():
    calls: list[httpx.Request] = []
    speaker = Speaker(key="k", transport=_fake_elevenlabs(credits_left=voice_speak.KEEP_CREDITS + 2, calls=calls))
    with pytest.raises(SpeakError) as error:
        await speaker.speak("This sentence costs more than the spare credits.")
    assert error.value.status == 503 and "Onstage" in error.value.detail
    assert not [c for c in calls if "/text-to-speech/" in c.url.path]
    assert not speaker.enabled  # stays off until the backend restarts


@pytest.mark.asyncio
async def test_no_key_is_a_clear_503():
    with pytest.raises(SpeakError) as error:
        await Speaker(key="", transport=_fake_elevenlabs()).speak("Hello.")
    assert error.value.status == 503 and "not configured" in error.value.detail


@pytest.mark.asyncio
async def test_a_quota_exceeded_reply_switches_it_off_and_is_a_502():
    speaker = Speaker(key="k", transport=_fake_elevenlabs(tts_status=401))
    with pytest.raises(SpeakError) as error:
        await speaker.speak("Hello.")
    assert error.value.status == 502
    assert not speaker.enabled
    with pytest.raises(SpeakError) as again:
        await speaker.speak("A different sentence.")
    assert again.value.status == 503


@pytest.mark.asyncio
async def test_a_network_failure_is_a_502_not_a_crash():
    def boom(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/user/subscription"):
            return httpx.Response(200, json={"character_limit": 10_000, "character_count": 0})
        raise httpx.ConnectError("no route")

    with pytest.raises(SpeakError) as error:
        await Speaker(key="k", transport=httpx.MockTransport(boom)).speak("Hello.")
    assert error.value.status == 502


@pytest.mark.asyncio
async def test_an_unreadable_quota_does_not_block_speech():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/user/subscription"):
            return httpx.Response(500, text="oops")
        return httpx.Response(200, content=MP3)

    audio, _ = await Speaker(key="k", transport=httpx.MockTransport(handler)).speak("Hello.")
    assert audio == MP3


@pytest.mark.asyncio
async def test_empty_text_is_a_400():
    with pytest.raises(SpeakError) as error:
        await Speaker(key="k", transport=_fake_elevenlabs()).speak("```\nonly code\n```")
    assert error.value.status == 400


# --- the endpoint and the headset channel -----------------------------------


def _client(monkeypatch, speaker: Speaker):
    from fastapi.testclient import TestClient

    from assistant import server

    monkeypatch.setattr(voice_speak, "_speaker", speaker)
    # No `with`: the graph's startup is not needed for this route.
    return TestClient(server.app)


def test_voice_speak_returns_mpeg_audio(monkeypatch):
    client = _client(monkeypatch, Speaker(key="k", transport=_fake_elevenlabs()))
    response = client.post("/voice/speak", json={"text": "Hello **there**."})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["x-spoken-truncated"] == "0"
    assert response.content == MP3


def test_voice_speak_reports_truncation(monkeypatch):
    client = _client(monkeypatch, Speaker(key="k", transport=_fake_elevenlabs()))
    response = client.post("/voice/speak", json={"text": "A fairly long sentence here. " * 60})
    assert response.status_code == 200 and response.headers["x-spoken-truncated"] == "1"


def test_voice_speak_failure_is_readable_by_the_phone(monkeypatch):
    client = _client(monkeypatch, Speaker(key="", transport=_fake_elevenlabs()))
    response = client.post("/voice/speak", json={"text": "Hello."})
    assert response.status_code == 503 and "not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_headset_channel_prepends_the_marker_and_other_turns_are_untouched(monkeypatch):
    from assistant import server

    seen: list[dict] = []

    async def fake_resolve(thread_id):
        return "t1"

    def fake_turn_response(thread_id, input_, detached=False):
        seen.append(input_)
        return "ok"

    monkeypatch.setattr(server, "_resolve_thread_id", fake_resolve)
    monkeypatch.setattr(server, "_turn_response", fake_turn_response)

    await server.chat(server.ChatRequest(message="what's next today", channel="headset"))
    await server.chat(server.ChatRequest(message="typed message"))

    voiced = seen[0]["messages"][0][1]
    typed = seen[1]["messages"][0][1]
    assert voiced.startswith(server._HEADSET_CHANNEL_MARKER + "\n\n")
    assert voiced.endswith("what's next today")
    assert typed == "typed message"


def test_history_hides_both_channel_markers():
    from assistant import server

    for marker in (server._HEADSET_CHANNEL_MARKER, server._PHONE_CHANNEL_MARKER):
        assert server._strip_channel_marker(marker + "\n\nwhat's next") == "what's next"
    assert server._strip_channel_marker("a normal message") == "a normal message"


def test_headset_marker_forbids_voice_approval_and_cards():
    from assistant import server

    marker = server._HEADSET_CHANNEL_MARKER
    assert "never ask them to approve by voice" in marker
    assert "render_ui" in marker


# --- ffmpeg PATH ------------------------------------------------------------


def test_ensure_tool_path_adds_homebrew_once_and_keeps_existing_entries(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr("assistant.tool_path.os.path.isdir", lambda d: d == "/opt/homebrew/bin")
    ensure_tool_path()
    ensure_tool_path()  # idempotent
    parts = os.environ["PATH"].split(os.pathsep)
    assert parts == ["/usr/bin", "/bin", "/opt/homebrew/bin"]


def test_ensure_tool_path_skips_directories_that_do_not_exist(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setattr("assistant.tool_path.os.path.isdir", lambda d: False)
    ensure_tool_path()
    assert os.environ["PATH"] == "/usr/bin"
