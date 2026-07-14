"""Voice I/O building blocks: mic capture, local STT (mlx-whisper), TTS
(macOS `say`), and confirmation-answer parsing for the voice daemon.

Recording is start/stop-driven rather than blocking: the daemon's global
hotkey fires as two separate events (start recording, stop and submit) on a
listener thread, with arbitrary time in between, so `Recorder` exposes
explicit `start()`/`stop()` calls held across those events — a fresh
instance per utterance, so no stale frames can leak between turns.

STT runs `mlx-whisper` (`large-v3`) locally via Apple's MLX framework —
swapped in for Phase 8 after a real four-way benchmark on this machine
(M4 Pro; STEPS.md 52) measured mlx-whisper large-v3 at 6-8x lower
per-utterance latency than faster-whisper large-v3 on CPU int8, for
byte-identical accuracy on the benchmark sample, while remaining the
largest/most-capable model tested — zero per-utterance API cost, no network
dependency once the model is cached locally. `mlx_whisper.transcribe()`'s
own module-level `ModelHolder` cache (keyed on the repo string) is what
makes the model persist across calls; `preload_stt_model()` below forces
that cache to populate at startup by calling `ModelHolder.get_model()`
directly with the same dtype `transcribe()` defaults to (`float16`), so the
first real utterance doesn't pay the load/download cost — see STEPS.md 53
for why calling `mlx_whisper.transcribe()` on a dummy buffer would NOT have
been an equally direct way to force this. TTS uses macOS `say`, invoked
argv-only (`shell=False`) for consistency with the rest of the codebase's
subprocess posture, though — unlike mac_tools.py's allowlisted actions —
this isn't a gated agent-invocable tool: it's the voice harness's own
output rendering, equivalent to main.py's `print()`, never something the
model chooses to call. The voice is configurable (ASSISTANT_TTS_VOICE env
var) and checked against the actually-installed voices once, falling back
to the system default with a logged warning — a not-yet-downloaded
Enhanced/Premium voice must never crash the daemon.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess

import mlx.core as mx
import mlx_whisper
import numpy as np
import sounddevice as sd
from mlx_whisper.transcribe import ModelHolder

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
STT_MODEL_REPO = "mlx-community/whisper-large-v3-mlx"
_STT_DTYPE = mx.float16  # matches mlx_whisper.transcribe()'s own fp16 default
_TTS_TIMEOUT_SECONDS = 60

# Premium/Enhanced voices are a manual, one-time download in System Settings
# (Accessibility > Spoken Content > System Voice > Manage Voices...) — there
# is no scriptable way to fetch one, hence the installed-check + fallback in
# _resolve_tts_voice() rather than assuming the default below exists.
DEFAULT_TTS_VOICE = "Ava (Premium)"


class Recorder:
    """Accumulates mic audio frames via a sounddevice InputStream between
    explicit start() and stop() calls (which may happen on different threads
    at arbitrarily distant times — see module docstring). One instance per
    utterance; stop() closes the stream for good."""

    def __init__(self) -> None:
        self._frames: list[np.ndarray] = []
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=self._callback,
        )

    def _callback(self, indata: np.ndarray, frames: int, time_info: object, status: object) -> None:
        self._frames.append(indata.copy())

    def start(self) -> None:
        self._stream.start()

    def stop(self) -> np.ndarray:
        """Stop and close the stream, returning everything captured as a
        mono float32 buffer at SAMPLE_RATE."""
        self._stream.stop()
        self._stream.close()
        if not self._frames:
            return np.zeros(0, dtype="float32")
        return np.concatenate(self._frames, axis=0).reshape(-1)


def preload_stt_model() -> None:
    """Load the STT model ahead of first use — the first load downloads (if
    not already cached locally) and initializes the model, which would
    otherwise land as latency on the user's first utterance. Populates
    `mlx_whisper.transcribe`'s own `ModelHolder` cache directly so the first
    real `transcribe()` call below hits a warm cache instead of loading
    again (see module docstring)."""
    ModelHolder.get_model(STT_MODEL_REPO, _STT_DTYPE)


def transcribe(audio: np.ndarray) -> str:
    """Transcribe a mono float32 audio buffer at SAMPLE_RATE to text."""
    if audio.size == 0:
        return ""
    result = mlx_whisper.transcribe(audio, path_or_hf_repo=STT_MODEL_REPO, language="en")
    return result["text"].strip()


def _installed_voices() -> set[str]:
    """Names of the voices `say` can actually use, per `say -v ?`.

    Each output line is "<name>  <locale>  # <sample>" with the name padded
    by 2+ spaces — names themselves can contain single spaces and parens
    (e.g. "Ava (Premium)"), so split on the padding, not on whitespace.
    """
    try:
        result = subprocess.run(
            ["say", "-v", "?"],
            shell=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return set()
    return {
        re.split(r"\s{2,}", line)[0].strip()
        for line in result.stdout.splitlines()
        if line.strip()
    }


_resolved_voice: str | None = None
_voice_resolved = False


def _resolve_tts_voice() -> str | None:
    """The configured TTS voice if installed, else None (system default).

    Resolved once and cached — the installed-voice set doesn't change while
    the daemon runs, and shelling out to `say -v ?` per utterance would add
    pointless latency.
    """
    global _resolved_voice, _voice_resolved
    if _voice_resolved:
        return _resolved_voice

    configured = os.environ.get("ASSISTANT_TTS_VOICE", DEFAULT_TTS_VOICE)
    if configured in _installed_voices():
        _resolved_voice = configured
    else:
        _resolved_voice = None
        logger.warning(
            "TTS voice %r is not installed — falling back to the system "
            "default voice. Download it via System Settings > Accessibility "
            "> Spoken Content > System Voice > Manage Voices...",
            configured,
        )
    _voice_resolved = True
    return _resolved_voice


def speak(text: str) -> None:
    """Speak text aloud via macOS `say`. Best-effort: TTS failure (e.g.
    `say` unavailable) must never crash the voice loop — the same text is
    always logged/printed by the caller anyway."""
    if not text:
        return
    voice = _resolve_tts_voice()
    argv = ["say", *(["-v", voice] if voice else []), text]
    try:
        subprocess.run(argv, shell=False, timeout=_TTS_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


_YES_PHRASES = ("yes", "yeah", "yep", "confirm", "confirmed", "sure", "affirmative", "go ahead", "do it")
_NO_PHRASES = ("no", "nope", "cancel", "stop", "don't", "do not", "negative")


def parse_confirmation(text: str) -> bool:
    """Interpret a transcribed confirmation answer.

    Fails closed: only a recognized affirmative counts as approval. Anything
    ambiguous, unrecognized, or empty (e.g. a mistranscription, silence, or
    a dropped recording) is treated as a decline — matching the confirmation
    gate's existing fail-closed posture (CLAUDE.md's standing rule exists so
    side-effectful actions never happen by accident). No-words are checked
    first so a phrase containing both ("no, don't go ahead") declines rather
    than approves.
    """
    normalized = text.strip().lower()
    if any(phrase in normalized for phrase in _NO_PHRASES):
        return False
    if any(phrase in normalized for phrase in _YES_PHRASES):
        return True
    return False
