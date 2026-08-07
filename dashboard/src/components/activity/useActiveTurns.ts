import { useEffect, useState } from "react";
import { fetchActiveTurns, type ActiveTurnInfo, type RecentlyEndedTurn } from "@/lib/api";

// STEPS.md 121-122: a real turn silently retried a failing render_ui call
// 43 times over ~28 minutes with no visible signal it was even happening —
// the user's own standing ask this closes: "I always want to know if
// there's a process going on in the background." Polls
// GET /activity/active (assistant/active_turns.py's in-memory registry)
// rather than listening to any single SSE stream, since the whole point is
// visibility into turns THIS browser tab didn't start (voice, phone,
// automations) — no per-request stream covers that. Same 4s cadence as
// ChatPanel's own external-update poll (Phase 19) — an established,
// deliberately un-aggressive interval for this kind of background check.
const POLL_MS = 4000;

export function useActiveTurns() {
  const [turns, setTurns] = useState<ActiveTurnInfo[]>([]);
  // Follow-up to the above: a turn that ends abnormally on a channel other
  // than this browser tab (voice/phone/an automation) was otherwise
  // invisible everywhere the instant it dropped out of `active` — nothing
  // distinguished "it finished fine" from "it just broke." Server-side
  // time-windowed already (active_turns.list_recent()'s own 30s default),
  // so this is just whatever the last poll returned, no separate client
  // expiry needed.
  const [recentlyEnded, setRecentlyEnded] = useState<RecentlyEndedTurn[]>([]);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetchActiveTurns()
        .then(({ active, recentlyEnded: recent }) => {
          if (!cancelled) {
            setTurns(active);
            setRecentlyEnded(recent);
          }
        })
        .catch(() => {
          // Best-effort, same posture as ChatPanel's own poll — a transient
          // failure here must never surface as an error to the user; it
          // just tries again next tick.
        });
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { turns, recentlyEnded };
}
