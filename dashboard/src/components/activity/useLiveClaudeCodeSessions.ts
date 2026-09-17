import { useEffect, useState } from "react";
import { fetchLiveClaudeCodeSessions, type LiveClaudeCodeSession } from "@/lib/api";

// STEPS.md 149: same standing "never let a background process run
// silently" rule as useActiveTurns.ts, for a different shape of in-flight
// thing — a real run_claude_code subprocess, not a graph turn. Same 4s
// poll cadence as useActiveTurns for consistency, same best-effort
// failure posture (never surfaces a transient fetch error to the user).
const POLL_MS = 4000;

export function useLiveClaudeCodeSessions() {
  const [sessions, setSessions] = useState<LiveClaudeCodeSession[]>([]);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetchLiveClaudeCodeSessions()
        .then((live) => {
          if (!cancelled) setSessions(live);
        })
        .catch(() => {
          // Best-effort, same posture as useActiveTurns's own poll.
        });
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return sessions;
}
