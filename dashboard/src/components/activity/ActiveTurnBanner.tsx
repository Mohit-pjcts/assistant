import { useState } from "react";
import { useActiveTurns } from "@/components/activity/useActiveTurns";
import { useLiveClaudeCodeSessions } from "@/components/activity/useLiveClaudeCodeSessions";
import { stopClaudeCodeSession } from "@/lib/api";

// STEPS.md 121-122: mounted in App.tsx's shell (not inside ChatPanel), so
// it's visible on every tab and reflects every channel — the exact gap that
// let a 28-minute, 43-retry render_ui loop run with nothing to see. A
// "stuck" turn (assistant/active_turns.py's own `stuck` field — 2+
// consecutive identical tool failures) uses --alarm, matching this app's
// existing rail-grammar token meaning ("needs attention") rather than
// inventing a new color for the same concept; a merely long-running turn
// uses --signal ("in progress, not yet actionable").
const CHANNEL_LABEL: Record<string, string> = {
  dashboard: "Dashboard",
  voice: "Voice",
  phone: "Phone",
  automation: "Automation",
  cli: "CLI",
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function ActiveTurnBanner() {
  const { turns, recentlyEnded } = useActiveTurns();
  const liveClaudeCodeSessions = useLiveClaudeCodeSessions();
  // Per-session "stopping..." state so a double-click can't fire two stop
  // requests, and so the button reflects the in-flight request instead of
  // just sitting there until the next 4s poll happens to notice the
  // session is gone.
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());

  function handleStop(sessionId: string) {
    setStoppingIds((prev) => new Set(prev).add(sessionId));
    stopClaudeCodeSession(sessionId).catch(() => {
      // Best-effort — if this failed, the next poll will just keep showing
      // the session as live, and the user can try again.
    });
  }

  // Only the non-clean outcomes are worth an unprompted notice — a turn
  // that finished normally doesn't need one (ChatPanel's own transcript
  // already shows a normal reply); this is specifically for the case a
  // turn on ANY channel ended broken with nothing else around to say so.
  const failedRecently = recentlyEnded.filter((t) => t.outcome !== "completed");
  if (turns.length === 0 && failedRecently.length === 0 && liveClaudeCodeSessions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="active-turn-banner">
      {liveClaudeCodeSessions.map((session) => (
        <div
          key={session.session_id}
          data-testid="active-claude-code-session"
          className="flex items-center gap-2 rounded-md border border-signal/35 bg-signal/10 px-3 py-1.5 text-xs text-signal"
        >
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-signal" />
          <span className="font-medium">Claude Code</span>
          <span className="opacity-70">·</span>
          <span className="truncate">{session.prompt_preview}</span>
          <span className="opacity-70">·</span>
          <span>{formatElapsed(session.elapsed_seconds)}</span>
          <span className="opacity-70">
            — see the Claude Code Sessions tab for the live transcript
          </span>
          <button
            type="button"
            onClick={() => handleStop(session.session_id)}
            disabled={stoppingIds.has(session.session_id)}
            className="ml-auto shrink-0 rounded border border-alarm/40 px-2 py-0.5 font-medium text-alarm hover:bg-alarm/10 disabled:opacity-50"
          >
            {stoppingIds.has(session.session_id) ? "Stopping…" : "Stop"}
          </button>
        </div>
      ))}
      {turns.map((turn) => (
        <div
          key={turn.thread_id}
          data-testid={turn.stuck ? "active-turn-stuck" : "active-turn-running"}
          className={
            "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs " +
            (turn.stuck
              ? "border-alarm/40 bg-alarm/10 text-alarm"
              : "border-signal/35 bg-signal/10 text-signal")
          }
        >
          <span
            aria-hidden
            className={
              "size-1.5 shrink-0 rounded-full " +
              (turn.stuck ? "bg-alarm" : "animate-pulse bg-signal")
            }
          />
          <span className="font-medium">{CHANNEL_LABEL[turn.channel] ?? turn.channel}</span>
          <span className="opacity-70">·</span>
          <span>{turn.agent}</span>
          {turn.current_tool && (
            <>
              <span className="opacity-70">·</span>
              <span>{turn.current_tool}</span>
            </>
          )}
          <span className="opacity-70">·</span>
          <span>{formatElapsed(turn.elapsed_seconds)}</span>
          {turn.stuck && (
            <span className="font-semibold">
              — retried {turn.consecutive_failures}x in a row, may be stuck
            </span>
          )}
        </div>
      ))}
      {failedRecently.map((turn) => (
        <div
          key={`${turn.thread_id}-ended`}
          data-testid={
            turn.outcome === "error" ? "recently-ended-error" : "recently-ended-cancelled"
          }
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs border-alarm/40 bg-alarm/10 text-alarm"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-alarm" />
          <span className="font-medium">{CHANNEL_LABEL[turn.channel] ?? turn.channel}</span>
          <span className="opacity-70">·</span>
          <span>{turn.agent}</span>
          <span className="opacity-70">·</span>
          <span className="font-semibold">
            {turn.outcome === "error" ? "ended with an error" : "cancelled"}
          </span>
          <span className="opacity-70">·</span>
          <span>{formatElapsed(turn.seconds_since_ended)} ago</span>
        </div>
      ))}
    </div>
  );
}
