import { useActiveTurns } from "@/components/activity/useActiveTurns";

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
  // Only the non-clean outcomes are worth an unprompted notice — a turn
  // that finished normally doesn't need one (ChatPanel's own transcript
  // already shows a normal reply); this is specifically for the case a
  // turn on ANY channel ended broken with nothing else around to say so.
  const failedRecently = recentlyEnded.filter((t) => t.outcome !== "completed");
  if (turns.length === 0 && failedRecently.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="active-turn-banner">
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
