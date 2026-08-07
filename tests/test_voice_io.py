"""Tests for assistant.voice_io — now just transcribe_file, the one piece
that survived the menu-bar voice daemon's retirement (see voice_io.py's own
module docstring). Everything else this file used to cover (parse_confirmation,
buffer-based transcribe(), speak(), the daemon's spoken-prompt/new-thread-
trigger helpers) tested code that no longer exists.
"""

import assistant.voice_io as voice_io


def test_transcribe_file_passes_path_and_strips_result() -> None:
    calls: list[tuple] = []

    def fake_transcribe(path, **kwargs):
        calls.append((path, kwargs))
        return {"text": "  hello there  "}

    original = voice_io.mlx_whisper.transcribe
    voice_io.mlx_whisper.transcribe = fake_transcribe
    try:
        assert voice_io.transcribe_file("/tmp/utterance.webm") == "hello there"
    finally:
        voice_io.mlx_whisper.transcribe = original

    assert calls == [
        ("/tmp/utterance.webm", {"path_or_hf_repo": voice_io.STT_MODEL_REPO, "language": "en"})
    ]


if __name__ == "__main__":
    test_transcribe_file_passes_path_and_strips_result()
    print("OK: test_transcribe_file_passes_path_and_strips_result")
    print("\n1 test passed")
