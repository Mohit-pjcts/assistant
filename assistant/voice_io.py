"""Local speech-to-text: mlx-whisper, reached via an arbitrary audio file.

Originally also home to the Mac menu-bar voice daemon's mic capture (a
sounddevice `Recorder`), buffer-based `transcribe()`, `speak()` TTS, and
confirmation-phrase parsing — all removed when that daemon was retired in
favor of in-app voice I/O (dashboard mic button -> server.py's
`/voice/transcribe` -> this module -> the same live chat turn, instead of a
separate always-on process with its own conversation write path). TTS moved
to the browser's own Web Speech API (ChatPanel.tsx's `speakReply`), which
needs no server-side counterpart. What's left here is exactly the piece both
the dashboard and the phone/PWA path still depend on.

STT runs `mlx-whisper` (`large-v3`) locally via Apple's MLX framework —
adopted for Phase 8 after a real four-way benchmark on this machine (M4 Pro;
STEPS.md 52) measured mlx-whisper large-v3 at 6-8x lower per-utterance
latency than faster-whisper large-v3 on CPU int8, for byte-identical
accuracy on the benchmark sample, while remaining the largest/most-capable
model tested — zero per-utterance API cost, no network dependency once the
model is cached locally.
"""

from __future__ import annotations

import mlx_whisper

STT_MODEL_REPO = "mlx-community/whisper-large-v3-mlx"


def transcribe_file(path: str) -> str:
    """Transcribe an arbitrary audio FILE (any format `ffmpeg` can decode —
    e.g. the webm/opus or mp4/aac a browser's MediaRecorder produces) to
    text. Used by server.py's `/voice/transcribe`, shared by the dashboard's
    in-app mic button and the phone/PWA path — one model, reached the same
    way from either client. `mlx_whisper.transcribe()` accepts a path
    directly (`Union[str, np.ndarray, mx.array]`, confirmed via its own
    signature) and internally shells out to `ffmpeg` to decode/resample
    whatever format it's given.

    `ffmpeg` on PATH is a hard requirement; a missing `ffmpeg` surfaces as
    whatever exception `mlx_whisper`'s own audio loader raises, left
    uncaught here — server.py's endpoint turns that into a clean HTTP error
    rather than this function silently returning an empty string, which
    would look identical to "you said nothing"."""
    result = mlx_whisper.transcribe(path, path_or_hf_repo=STT_MODEL_REPO, language="en")
    return result["text"].strip()
