"""Always-on voice daemon: press Option+Return from any application to talk
to the assistant; replies are spoken back. Runs as a menu bar app.

The graph invocation is the exact same `graph.ainvoke()` path as main.py's
text CLI (PLAN.md Phase 5 step 4). As of Phase 15, "sharing one conversation"
means following thread_store's active-thread pointer (re-read every turn —
see the Phase 15 threading note below), not a hardcoded shared constant.
main.py itself is untouched.

Threading model (each constraint is hard, not convention — see STEPS.md):

- **Main thread** runs `rumps.App.run()` — rumps wraps NSApplication's run
  loop, and AppKit UI must be created/driven from the thread that owns that
  loop. Menu bar title updates from other threads are therefore marshaled
  onto the main thread via `AppHelper.callAfter`, never set directly
  (direct cross-thread mutation is *silently* unsafe: it usually appears to
  work, then glitches intermittently).
- **A dedicated asyncio thread** owns the persistent event loop that calls
  `graph.ainvoke()` and runs each voice turn. CPU-bound STT and blocking
  TTS are pushed to `asyncio.to_thread` so the loop stays responsive.
- **pynput's listener thread** (GlobalHotKeys is itself a Thread) delivers
  hotkey callbacks from inside a macOS event tap. The callback must stay
  minimal and never let an exception escape — a slow or crashing tap
  callback can get the tap disabled by the OS, silently killing the hotkey
  — so it only flips state, starts/stops the recorder, and hands off via
  `run_coroutine_threadsafe`.
- (PortAudio's InputStream callback thread also exists inside Recorder —
  pre-existing, not new here.)

Permissions: global key listening needs the Input Monitoring TCC grant
(System Settings > Privacy & Security > Input Monitoring), possibly also
Accessibility — a different grant from the Automation ones mac_tools.py's
osascript calls prompt for. One-time, prompted on first run.

Known tradeoff (accepted, revisit if annoying): the listener does not
consume the keystroke — Option+Return still reaches the frontmost app.

Confirmation gate over voice: when the graph interrupts (CLAUDE.md's
standing rule for side-effectful actions), the daemon speaks the payload's
`spoken_prompt` and *automatically starts recording* the answer — one
Option+Return press submits it (no press-to-start: while a question is
pending, recording-by-default is the ergonomic behavior the user asked
for). Fails closed: an unclear answer, or no answer within the timeout,
declines.

Phase 15 threading: voice is deliberately reduced to exactly two behaviors
(PLAN.md's scope-split decision, STEPS.md 66) — continue whatever
thread_store's active pointer currently names (re-resolved at the START of
every turn, not cached at daemon startup, so a thread switched elsewhere —
e.g. the GUI starting a new conversation — takes effect on the very next
utterance without a daemon restart), or start a fresh thread on a fixed
trigger phrase ("start a new conversation") pattern-matched locally on the
raw transcript BEFORE it ever reaches the graph — same local, fail-closed
parsing approach as `parse_confirmation` for yes/no. Voice never resumes an
arbitrary specific OLD thread by id; picking from a list isn't a
voice-native interaction, so that stays GUI/CLI-only.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import sys
import threading
import time
from enum import Enum
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Loaded before any other assistant import — see main.py's identical
# comment: several modules construct ChatAnthropic/TavilySearch instances at
# import time, so the environment must already be populated by then.
from dotenv import load_dotenv

load_dotenv()

import rumps  # noqa: E402
from langgraph.types import Command  # noqa: E402
from pynput.keyboard import GlobalHotKeys  # noqa: E402
from PyObjCTools import AppHelper  # noqa: E402

from assistant import observability, thread_store  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.main import _render_content  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.supervisor import build_graph  # noqa: E402
from assistant.voice_io import (  # noqa: E402
    Recorder,
    parse_confirmation,
    preload_stt_model,
    speak,
    transcribe,
)

# Historically had to run before observability's lazy handler was first
# constructed, since tags were constructor-bound in Langfuse v2. No longer
# a hard ordering requirement as of the v3 migration (STEPS.md 86) — tags
# are read fresh per-call now. Set at module level (unlike main.py's own
# call, which lives inside main() specifically so importing
# _render_content above doesn't wrongly claim "cli") since nothing else
# imports from voice_daemon.py.
observability.configure_client("voice")

logger = logging.getLogger(__name__)

APP_NAME = "Assistant"
HOTKEY = "<alt>+<enter>"

# Fixed trigger phrase for starting a fresh thread by voice (PLAN.md Phase
# 15 step 1) — word-boundaried so it only fires on the actual command
# phrase, not any utterance that happens to contain "conversation"
# somewhere. Checked locally against the raw transcript, before the graph
# ever sees it — same fail-closed, non-model-routed posture as
# voice_io.parse_confirmation, not a tool call the model could choose to
# skip or a phrase an injected tool result could try to imitate mid-turn
# (this only ever runs on the user's own freshly-transcribed utterance).
_NEW_THREAD_TRIGGER_RE = re.compile(r"\bstart a new conversation\b")


def _is_new_thread_trigger(text: str) -> bool:
    return bool(_NEW_THREAD_TRIGGER_RE.search(text.strip().lower()))

# pynput already coalesces OS key-repeat on a held key (its HotKey tracks
# pressed-key state), so this debounce is NOT for repeat suppression — it
# guards against a genuinely fast double press and against a second event
# racing the state transition below.
DEBOUNCE_SECONDS = 0.4

ANSWER_TIMEOUT_SECONDS = 30
STARTUP_TIMEOUT_SECONDS = 120

TITLE_IDLE = "🎙"
TITLE_RECORDING = "🔴"
TITLE_PROCESSING = "💭"

_CUE_START = "/System/Library/Sounds/Tink.aiff"
_CUE_STOP = "/System/Library/Sounds/Pop.aiff"

LOG_DIR = Path.home() / "Library" / "Logs" / "PersonalAssistant"


class State(Enum):
    IDLE = "idle"
    RECORDING = "recording"  # capturing a normal utterance
    PROCESSING = "processing"  # STT / graph / TTS in flight
    ANSWERING = "answering"  # capturing a confirmation-gate answer


def _play_cue(path: str) -> None:
    """Fire-and-forget audio cue via macOS afplay (argv-only, non-blocking —
    the hotkey callback can't afford to wait for playback)."""
    try:
        subprocess.Popen(["afplay", path])
    except OSError:
        pass


def _spoken_question(payload: object) -> str:
    """The confirmation question to read aloud for an interrupt payload —
    the tool's own `spoken_prompt` when present, otherwise the raw payload
    (a gated tool that hasn't added one yet still works, just sounds worse).
    """
    if isinstance(payload, dict) and payload.get("spoken_prompt"):
        return str(payload["spoken_prompt"])
    return f"{payload} — proceed?"


class VoiceDaemon:
    """Owns the state machine and the three threads described in the module
    docstring."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = State.IDLE
        self._last_trigger = 0.0
        self._recorder: Recorder | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._graph = None
        self._shutdown: asyncio.Event | None = None
        self._answer_submitted: asyncio.Event | None = None

        self._ready = threading.Event()
        self._startup_error = False
        self._thread: threading.Thread | None = None
        self._hotkeys: GlobalHotKeys | None = None
        self._app: rumps.App | None = None

    # --- menu bar (main thread only, via callAfter) -------------------------

    def _set_title(self, title: str) -> None:
        AppHelper.callAfter(self._apply_title, title)

    def _apply_title(self, title: str) -> None:
        if self._app is not None:
            self._app.title = title

    # --- hotkey callback (pynput listener thread) ---------------------------

    def _on_trigger(self) -> None:
        # Never let an exception escape: this runs inside the macOS event
        # tap, where an uncaught error can kill hotkey delivery entirely.
        try:
            self._handle_trigger()
        except Exception:
            logger.exception("hotkey callback failed")

    def _handle_trigger(self) -> None:
        now = time.monotonic()
        with self._lock:
            if now - self._last_trigger < DEBOUNCE_SECONDS:
                return
            self._last_trigger = now

            if self._state is State.IDLE:
                recorder = Recorder()
                recorder.start()
                self._recorder = recorder
                self._state = State.RECORDING
                _play_cue(_CUE_START)
                self._set_title(TITLE_RECORDING)
                logger.info("recording started")

            elif self._state is State.RECORDING:
                audio = self._recorder.stop()
                self._recorder = None
                self._state = State.PROCESSING
                _play_cue(_CUE_STOP)
                self._set_title(TITLE_PROCESSING)
                logger.info("recording stopped (%.1fs captured)", audio.size / 16000)
                asyncio.run_coroutine_threadsafe(self._process_turn(audio), self._loop)

            elif self._state is State.ANSWERING:
                # The async side owns the recorder here; just signal it.
                _play_cue(_CUE_STOP)
                self._loop.call_soon_threadsafe(self._answer_submitted.set)

            else:  # PROCESSING
                logger.info("trigger ignored — a turn is already in flight")

    # --- per-turn pipeline (asyncio thread) ---------------------------------

    async def _process_turn(self, audio) -> None:
        try:
            text = (await asyncio.to_thread(transcribe, audio)).strip()
            if not text:
                logger.info("empty transcription — nothing heard")
                await asyncio.to_thread(speak, "I didn't catch that.")
                return
            logger.info("user: %s", text)

            if _is_new_thread_trigger(text):
                # Handled entirely locally, before the graph ever sees this
                # utterance — the trigger phrase is a client-side command,
                # not something for the model to interpret or act on.
                thread = await thread_store.create_thread()
                logger.info("voice trigger: started new thread %s", thread.id)
                await asyncio.to_thread(speak, "Started a new conversation.")
                await thread_store.touch_thread(thread.id)
                return

            # Re-resolved every turn, not cached at daemon startup — a
            # thread switched elsewhere (e.g. the GUI) takes effect on the
            # very next utterance (module docstring's Phase 15 section).
            thread_id = await thread_store.get_active_thread_id()
            config = make_thread_config(thread_id)

            # Phase 16 Part B (v3 migration): wraps the whole turn (initial
            # call + any resume loop below) in Langfuse v3's per-call
            # session/tags/trace-name propagation — observability.py's
            # module docstring has the full why this replaced v2's
            # config-dict-based metadata approach.
            with observability.tracing_context(thread_id) as span:
                if span is not None:
                    span.update(input=text)
                result = await self._graph.ainvoke(
                    {"messages": [("user", text)]},
                    config=config,
                )

                while "__interrupt__" in result:
                    payload = result["__interrupt__"][0].value
                    action = payload.get("action") if isinstance(payload, dict) else None
                    if isinstance(payload, dict) and payload.get("voice_approvable") is False:
                        # Phase 7 Part B's memory-write confirmations set
                        # this — fact content is harder to vet by ear than
                        # an action verb like "send", so this gate never
                        # asks by voice. Fail-closed (declined) rather than
                        # silently skip, same convention as an unclear/
                        # timed-out spoken answer.
                        logger.info("confirmation requires text — declining by voice")
                        await asyncio.to_thread(
                            speak, "That needs a text confirmation, so I'm skipping it for now."
                        )
                        result = await self._graph.ainvoke(Command(resume=False), config=config)
                        # Evaluations pillar (STEPS.md 82) — background
                        # task, never awaited, so scoring never adds
                        # latency here.
                        observability.fire_score_gate_outcome(thread_id, False, action)
                        continue
                    question = _spoken_question(payload)
                    logger.info("confirmation asked: %s", question)
                    approved = await self._ask_confirmation(question)
                    logger.info(
                        "confirmation outcome: %s", "approved" if approved else "declined"
                    )
                    result = await self._graph.ainvoke(Command(resume=approved), config=config)
                    observability.fire_score_gate_outcome(thread_id, approved, action)

                if span is not None:
                    span.update(output=_render_content(result["messages"][-1].content))

            reply = _render_content(result["messages"][-1].content)
            logger.info("assistant: %s", reply)
            await asyncio.to_thread(speak, reply)
            await thread_store.touch_thread(thread_id)

        except Exception:
            logger.exception("voice turn failed")
            await asyncio.to_thread(speak, "Sorry, something went wrong.")
        finally:
            with self._lock:
                self._state = State.IDLE
                self._recorder = None
            self._set_title(TITLE_IDLE)

    async def _ask_confirmation(self, question: str) -> bool:
        """Speak the question, then record the answer — recording starts
        automatically (the start cue right after the question marks it), and
        one Option+Return press submits. Fails closed on an unclear answer
        or on timeout."""
        await asyncio.to_thread(speak, f"{question} Say yes or no.")

        self._answer_submitted = asyncio.Event()
        with self._lock:
            recorder = Recorder()
            recorder.start()
            self._recorder = recorder
            self._state = State.ANSWERING
        _play_cue(_CUE_START)
        self._set_title(TITLE_RECORDING)

        try:
            await asyncio.wait_for(self._answer_submitted.wait(), timeout=ANSWER_TIMEOUT_SECONDS)
            timed_out = False
        except TimeoutError:
            timed_out = True

        with self._lock:
            audio = recorder.stop()
            self._recorder = None
            self._state = State.PROCESSING
        self._set_title(TITLE_PROCESSING)

        if timed_out:
            logger.info(
                "no answer within %ss — declining (fail closed)", ANSWER_TIMEOUT_SECONDS
            )
            await asyncio.to_thread(speak, "No answer heard — cancelling.")
            return False

        answer = (await asyncio.to_thread(transcribe, audio)).strip()
        logger.info("confirmation transcript: %r", answer)
        return parse_confirmation(answer)

    # --- asyncio thread lifetime --------------------------------------------

    async def _async_main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._shutdown = asyncio.Event()

        try:
            mcp_tools = await load_mcp_tools()
        except Exception as exc:  # e.g. GMAIL_MCP_SERVER_PATH unset
            logger.warning(
                "Gmail/Calendar tools unavailable: %s: %s", type(exc).__name__, exc
            )
            mcp_tools = []

        async with get_checkpointer() as checkpointer:
            self._graph = build_graph(checkpointer, [send_test_notification], mcp_tools)
            # First model load takes several seconds — pay it at startup,
            # not as latency on the user's first utterance.
            await asyncio.to_thread(preload_stt_model)
            logger.info("daemon ready — hotkey %s", HOTKEY)
            self._ready.set()
            await self._shutdown.wait()

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._async_main())
        except Exception:
            logger.exception("asyncio thread crashed")
            self._startup_error = True
            self._ready.set()  # unblock run() so it can exit non-zero

    # --- lifecycle (main thread) --------------------------------------------

    def _on_quit(self, _sender: rumps.MenuItem) -> None:
        logger.info("quit requested")
        if self._hotkeys is not None:
            self._hotkeys.stop()
        if self._loop is not None and self._shutdown is not None:
            self._loop.call_soon_threadsafe(self._shutdown.set)
        if self._thread is not None:
            self._thread.join(timeout=10)
        # Exits the process with code 0 — required for the LaunchAgent's
        # KeepAlive SuccessfulExit=false semantics: a clean quit must not
        # look like a crash, or launchd restarts us right after the user
        # quit.
        rumps.quit_application()

    def run(self) -> None:
        self._thread = threading.Thread(
            target=self._thread_main, name="assistant-voice-loop", daemon=True
        )
        self._thread.start()

        if not self._ready.wait(timeout=STARTUP_TIMEOUT_SECONDS) or self._startup_error:
            logger.error("daemon failed to start — see traceback above")
            sys.exit(1)

        self._app = rumps.App(APP_NAME, title=TITLE_IDLE, quit_button=None)
        self._app.menu = [rumps.MenuItem("Quit", callback=self._on_quit)]

        self._hotkeys = GlobalHotKeys({HOTKEY: self._on_trigger})
        self._hotkeys.start()

        self._app.run()


def _setup_logging() -> None:
    """Self-rotating file log (launchd's StandardOut/ErrorPath append forever
    with no rotation, so they're only a crash-traceback net, not the primary
    log) plus stderr for hand-run visibility."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    file_handler = RotatingFileHandler(
        LOG_DIR / "voice_daemon.log", maxBytes=1_000_000, backupCount=3
    )
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    pkg_logger = logging.getLogger("assistant")
    pkg_logger.setLevel(logging.INFO)
    pkg_logger.addHandler(file_handler)
    pkg_logger.addHandler(stream_handler)


def main() -> None:
    """Sync entry point (the `assistant-voice` console script)."""
    _setup_logging()
    VoiceDaemon().run()


if __name__ == "__main__":
    main()
