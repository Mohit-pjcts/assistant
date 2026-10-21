"""Oni's spoken voice for the iPhone: ElevenLabs text-to-speech, fetched by the Mac.

PLAN.md Phase 32. The earbud voice feature plays Oni's reply through the earbuds
in an ElevenLabs voice. The Mac does the fetching so the API key stays in the
Mac's `.env` and never reaches the phone; the phone posts the reply text to
`/voice/speak` and plays the MP3 it gets back.

Same voice and the same guard rails as Onstage (`stage/src/voice.ts`), because
both draw on ONE free-plan ElevenLabs account (about 10,000 credits a month, 0.5
credit per character for these models):

- voice: Alice (`ELEVENLABS_VOICE` overrides it, the same variable Onstage reads);
- model: `eleven_flash_v2_5`;
- at most 2 requests at a time (the free plan answers a third with a 429);
- stop speaking before the monthly credits run out mid-sentence
  (`KEEP_CREDITS`), so Oni cannot starve Onstage;
- a failed or refused request is an error the phone can read (it then falls back
  to the phone's own voice); a bad key or an exhausted quota switches ElevenLabs
  off until the backend restarts.

On top of that, one request is capped at `MAX_CHARS` characters (about 350
credits): this endpoint is open to anything on the tailnet like the rest of the
Mac API (PLAN.md Phase 31, D2), so a single call cannot burn the month.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from collections import OrderedDict

import httpx

log = logging.getLogger(__name__)

API = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = "Xb7hH8MSUJpSbSDYk0k2"  # Alice, the voice Onstage uses
MODEL = "eleven_flash_v2_5"  # ~75 ms model latency
OUTPUT_FORMAT = "mp3_44100_64"  # small for the phone; the credit cost is per character, not per byte
MAX_PARALLEL = 2
KEEP_CREDITS = 300
MAX_CHARS = 700
CACHE_SIZE = 60
TIMEOUT_SECONDS = 10.0


class SpeakError(Exception):
    """Speech could not be produced. `status` is the HTTP status to return."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*\*|__|\*|~~)")
_TABLE_RULE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$", re.MULTILINE)
_SENTENCE_END = re.compile(r"[.!?。！？](?=\s|$)")


def speakable(text: str) -> tuple[str, bool]:
    """Turn a chat reply into plain text a voice can read, and cut it to
    `MAX_CHARS`. Returns `(text, was_truncated)`.

    Markdown a voice would read out loud as noise ("asterisk asterisk", a whole
    code block, a long URL) is removed or reduced to its words. Truncation
    prefers the last sentence end before the limit, else the last word."""
    out = _CODE_FENCE.sub(" ", text)
    out = _IMAGE.sub(" ", out)
    out = _LINK.sub(r"\1", out)
    out = _URL.sub("a link", out)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _HEADING.sub("", out)
    out = _TABLE_RULE.sub(" ", out)
    out = _BULLET.sub("", out)
    out = out.replace("|", " ")
    out = _EMPHASIS.sub("", out)
    # A line break is a pause: give every line that does not already end in
    # punctuation a full stop, then read the lines as one paragraph.
    lines = [line.strip() for line in out.split("\n") if line.strip()]
    out = " ".join(line if line[-1] in ".!?:;。！？" else line + "." for line in lines)
    out = re.sub(r"\s+", " ", out).strip()
    if len(out) <= MAX_CHARS:
        return out, False
    window = out[:MAX_CHARS]
    ends = [m.end() for m in _SENTENCE_END.finditer(window)]
    if ends and ends[-1] >= MAX_CHARS // 2:
        return window[: ends[-1]].strip(), True
    return window.rsplit(" ", 1)[0].strip(), True


class Speaker:
    """ElevenLabs text-to-speech with the guard rails in the module docstring."""

    def __init__(
        self,
        *,
        key: str | None = None,
        voice: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._key = (os.environ.get("ELEVENLABS_API_KEY", "") if key is None else key).strip()
        self._voice = voice or os.environ.get("ELEVENLABS_VOICE") or DEFAULT_VOICE
        self._transport = transport
        self._disabled_reason: str | None = None
        self._slots = asyncio.Semaphore(MAX_PARALLEL)
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._credits_left: int | None = None  # from /user/subscription, then counted down
        self._quota_checked = False

    @property
    def enabled(self) -> bool:
        return bool(self._key) and self._disabled_reason is None

    async def speak(self, text: str) -> tuple[bytes, bool]:
        """MP3 audio for `text` and whether it was truncated. Raises SpeakError."""
        clean, truncated = speakable(text)
        if not clean:
            raise SpeakError(400, "nothing to say")
        if not self._key:
            raise SpeakError(503, "ElevenLabs is not configured (ELEVENLABS_API_KEY is empty)")
        if self._disabled_reason:
            raise SpeakError(503, self._disabled_reason)

        cache_id = hashlib.sha1(clean.encode()).hexdigest()
        if cache_id in self._cache:
            self._cache.move_to_end(cache_id)
            return self._cache[cache_id], truncated

        async with httpx.AsyncClient(transport=self._transport, timeout=TIMEOUT_SECONDS) as client:
            if not self._quota_checked:
                await self._check_quota(client)
            cost = (len(clean) + 1) // 2
            if self._credits_left is not None and self._credits_left - cost < KEEP_CREDITS:
                self._disabled_reason = (
                    f"ElevenLabs credits nearly used up ({self._credits_left} left); "
                    "keeping the rest for Onstage"
                )
                raise SpeakError(503, self._disabled_reason)
            audio = await self._synthesize(client, clean, cost)

        self._cache[cache_id] = audio
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return audio, truncated

    async def _synthesize(self, client: httpx.AsyncClient, text: str, cost: int) -> bytes:
        async with self._slots:
            try:
                response = await client.post(
                    f"{API}/text-to-speech/{self._voice}/stream",
                    params={"output_format": OUTPUT_FORMAT},
                    headers={"xi-api-key": self._key},
                    json={"text": text, "model_id": MODEL},
                )
            except httpx.HTTPError as error:
                raise SpeakError(502, f"ElevenLabs request failed: {type(error).__name__}") from error
        if response.status_code != 200:
            body = response.text[:200]
            if response.status_code == 401 or "quota_exceeded" in body:
                self._disabled_reason = f"ElevenLabs refused the request ({response.status_code}): {body}"
            raise SpeakError(502, f"ElevenLabs {response.status_code}: {body}")
        used = response.headers.get("character-cost") or response.headers.get("x-character-count")
        if self._credits_left is not None:
            self._credits_left -= int(used) if used and used.isdigit() else cost
        return response.content

    async def _check_quota(self, client: httpx.AsyncClient) -> None:
        """Read the credits left once; if that fails, try anyway (the API refuses
        cleanly when the quota is empty)."""
        self._quota_checked = True
        try:
            response = await client.get(f"{API}/user/subscription", headers={"xi-api-key": self._key})
            if response.status_code == 401:
                self._disabled_reason = "ElevenLabs rejected the API key"
                raise SpeakError(503, self._disabled_reason)
            data = response.json()
            self._credits_left = int(data["character_limit"]) - int(data["character_count"])
            log.info("ElevenLabs credits left this month: %s", self._credits_left)
        except SpeakError:
            raise
        except Exception:  # noqa: BLE001 - unknown quota must not block speech
            log.warning("could not read the ElevenLabs quota; speaking without the guard")


_speaker: Speaker | None = None


def get_speaker() -> Speaker:
    """The one process-wide speaker, created on first use so `.env` is loaded."""
    global _speaker
    if _speaker is None:
        _speaker = Speaker()
    return _speaker
