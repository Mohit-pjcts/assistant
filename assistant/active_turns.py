"""In-memory registry of in-flight agent turns, across every channel
(dashboard `/chat`/`/resume`, voice, phone, unattended automations) — built
2026-08-04 (STEPS.md 122) after a real, live-diagnosed incident where a
single turn silently retried a failing `render_ui` call 43 times over ~28
minutes with nothing telling the user it was even happening. That incident
is what `circuit_breaker.py`'s `RepeatedToolFailureCircuitBreaker` now stops
outright, but the user's own, separate, standing ask was broader: "I always
want to know if there's a process going on in the background" — a stuck (or
just slow) turn should be VISIBLE, not just eventually capped.

**Deliberately NOT a durable SQLite store like `thread_store.py`/
`board_store.py`/etc.** — this tracks transient, in-flight state only
(nothing here should ever need to survive a server restart; a restarted
server has no in-flight turns by definition), so a plain in-process dict is
the right amount of mechanism, not an under-engineered shortcut.

**Keyed by `thread_id`, not a generated run id.** The simplest correct key
for this project's actual usage pattern (one user, normally one active turn
per thread at a time) — accepted limitation: two genuinely concurrent turns
against the SAME thread_id (e.g. voice and dashboard racing, the exact
scenario Phase 15's thread registry was built to reduce) would overwrite
each other's entry here rather than showing both. That's a monitoring-UI
gap, not a correctness bug (nothing here gates or blocks anything) — not
worth a generated-id registry for a single-user personal assistant.

**Scope, deliberate:** `touch()` is only ever called from
`RepeatedToolFailureCircuitBreaker.awrap_model_call` (see circuit_breaker.py),
which reliably has `thread_id` via `langgraph.config.get_config()` at the
SUPERVISOR's own top level. A nested specialist's own inner tool loop
(`_invoke_agent_graph`'s isolated, checkpointer-less `ainvoke()`) has no
`configurable.thread_id` in its own config — `get_config()` there would
raise — so `circuit_breaker.py` best-effort no-ops when it's unavailable
rather than raising into the graph. This means the registry's `current_tool`
reflects the SUPERVISOR's own view (delegating to a specialist, or calling
render_ui/render_form directly) but does not drill into what a specialist
is doing internally the way the separate `agent_activity` SSE mechanism
(Phase 19's `_AgentActivityRelay`) does — an accepted, narrower scope than
that mechanism, since the actual incident this fixes was a supervisor-level
loop. Extending this to specialist-internal visibility would need
`_invoke_agent_graph` to forward `configurable.thread_id` into its nested
`ainvoke()` config, a real change to a carefully-scoped existing function —
left as a documented follow-up, not done here.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

Channel = Literal["dashboard", "voice", "phone", "automation", "cli"]
Outcome = Literal["completed", "error", "cancelled"]


@dataclass
class ActiveTurn:
    thread_id: str
    channel: Channel
    agent: str
    started_at: float = field(default_factory=time.monotonic)
    last_updated: float = field(default_factory=time.monotonic)
    step_count: int = 0
    current_tool: str | None = None
    consecutive_failures: int = 0

    def to_dict(self) -> dict[str, object]:
        now = time.monotonic()
        return {
            "thread_id": self.thread_id,
            "channel": self.channel,
            "agent": self.agent,
            "elapsed_seconds": round(now - self.started_at, 1),
            "seconds_since_update": round(now - self.last_updated, 1),
            "step_count": self.step_count,
            "current_tool": self.current_tool,
            "consecutive_failures": self.consecutive_failures,
            "stuck": self.consecutive_failures >= 2,
        }


_active: dict[str, ActiveTurn] = {}

# STEPS.md follow-up to 121-122: `list_active()` alone can only ever show
# "a turn is currently running" — the moment a turn ends, whether cleanly or
# because it errored/got cancelled, it just disappears with no trace. That
# was the exact gap behind the dashboard's own stuck-activity-graph bug (a
# stream dying mid-turn with nothing telling the browser it had ended) —
# fixed there by having the client itself notice its OWN stream failing, but
# the same silent-disappearance problem exists for every OTHER channel
# (voice/phone/automation) as far as any OTHER tab/observer is concerned,
# since nothing about a turn started by one channel is visible from another
# except through this shared registry. `_recently_ended` is a small,
# bounded, time-windowed log finish_turn() appends to, so a caller (the
# dashboard's ActiveTurnBanner) can show a brief notice for a turn that
# just ended abnormally instead of it just vanishing from list_active()'s
# output with nothing to distinguish "it finished fine" from "it broke."
_RECENTLY_ENDED_LIMIT = 20
_recently_ended: list[dict[str, object]] = []


def start_turn(thread_id: str, channel: Channel, agent: str = "supervisor") -> None:
    """Registers a new in-flight turn. Safe to call even if one is already
    registered for this thread_id (overwrites — see module docstring on the
    accepted same-thread-concurrency limitation)."""
    _active[thread_id] = ActiveTurn(thread_id=thread_id, channel=channel, agent=agent)


def touch(
    thread_id: str,
    *,
    tool: str | None = None,
    consecutive_failures: int = 0,
) -> None:
    """Updates the live state for an already-started turn. A silent no-op if
    no turn is registered for this thread_id (e.g. called from a context
    that never called `start_turn` — best-effort monitoring, never a hard
    dependency for the actual agent loop)."""
    turn = _active.get(thread_id)
    if turn is None:
        return
    turn.step_count += 1
    turn.current_tool = tool
    turn.consecutive_failures = consecutive_failures
    turn.last_updated = time.monotonic()


def finish_turn(thread_id: str, *, outcome: Outcome = "completed") -> None:
    """Removes a turn from the registry. Always call from a `finally` block
    around the top-level graph invocation so a raised exception or a
    cancelled request never leaves a stale entry behind.

    Also appends a `_recently_ended` record (see `list_recent()`) — a
    no-op when `thread_id` was never registered (mirrors the pre-existing
    silent-no-op contract `finish_turn` already had), so this stays safe
    to call unconditionally from a `finally` block even on a path that
    never reached `start_turn()` in the first place."""
    turn = _active.pop(thread_id, None)
    if turn is None:
        return
    now = time.monotonic()
    _recently_ended.append(
        {
            "thread_id": turn.thread_id,
            "channel": turn.channel,
            "agent": turn.agent,
            "outcome": outcome,
            "elapsed_seconds": round(now - turn.started_at, 1),
            "ended_at": now,
        }
    )
    del _recently_ended[:-_RECENTLY_ENDED_LIMIT]


def list_active() -> list[dict[str, object]]:
    """Every currently in-flight turn, across all channels, oldest first."""
    return [t.to_dict() for t in sorted(_active.values(), key=lambda t: t.started_at)]


def list_recent(within_seconds: float = 30.0) -> list[dict[str, object]]:
    """Turns that ended within the last `within_seconds`, oldest first —
    lets a poller (the dashboard's ActiveTurnBanner) show a brief notice
    when a turn ended with `outcome != "completed"` instead of silently
    dropping off `list_active()`'s output with no trace it ever ran.
    Deliberately a plain elapsed-time cutoff rather than an explicit-ack
    mechanism ("has this been shown yet") — nothing here needs a client to
    confirm it saw an entry, so there's no reason to track that."""
    now = time.monotonic()
    result = []
    for entry in _recently_ended:
        age = now - entry["ended_at"]
        if age <= within_seconds:
            result.append(
                {
                    "thread_id": entry["thread_id"],
                    "channel": entry["channel"],
                    "agent": entry["agent"],
                    "outcome": entry["outcome"],
                    "elapsed_seconds": entry["elapsed_seconds"],
                    "seconds_since_ended": round(age, 1),
                }
            )
    return result
