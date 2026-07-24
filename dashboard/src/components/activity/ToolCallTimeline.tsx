import { cn } from "@/lib/utils";
import type { TimelineEntry } from "./useAgentActivity";

interface ToolCallTimelineProps {
  entries: TimelineEntry[];
}

function relativeTime(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// The redesign's "Tool call timeline" widget — most-recent-first, capped
// list (useAgentActivity's MAX_TIMELINE_ENTRIES) of every tool call any
// agent has made this session, live via server.py's `activity` SSE frame.
// Current color tokens only (--operator for still-running, --border for
// finished) — layout from the mock, not its rust/border palette.
export function ToolCallTimeline({ entries }: ToolCallTimelineProps) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No tool activity yet this session.</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="tool-call-timeline">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            "border-l-2 py-0.5 pl-2.5",
            entry.status === "running" ? "border-operator" : "border-border",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-foreground">
              {entry.tool}
              <span className="text-muted-foreground"> · {entry.agent}</span>
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {entry.status === "running" ? "running…" : relativeTime(entry.startedAt)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
