// PLAN.md Phase 29 Stage 2: replaces Astryx's <Timestamp format="relative">
// (KanbanBoard.tsx, A2UIRenderer.tsx's BoardSurfaceView) — both call sites
// pass an ISO date string (BoardTask.updated_at / the board surface's own
// "/<id>/updated_at" dataModel field), never a raw epoch number, unlike
// ToolCallTimeline.tsx's own local relativeTime() (kept separate — that one
// take a number and needs sub-minute resolution for live tool calls).
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
