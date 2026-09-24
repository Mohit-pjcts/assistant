// PLAN.md Phase 29 / instrument/DESIGN.md §11's own cost-view idea: "a
// sparkline traces in behind [the stat cells] via the same pathLength/
// stroke-dashoffset draw-on used everywhere else." Ported as a purely
// DECORATIVE abstract waveform, deliberately not bound to any real
// figure — CostPanel.tsx's own WindowCard comment already establishes
// why a literal trend line would misrepresent Today/Last 7 days/All
// time (overlapping windows, not points on a timeline); this reuses the
// exact draw-on technique (see BrandMark.tsx/index.css's own
// `.brand-mark` for the pattern this mirrors) without reintroducing that
// problem. Draws itself once on mount, same "arrival, not every update"
// posture the rest of the app's `.reveal` usage already follows.
export function CostTrace({ className, delayMs = 0 }: { className?: string; delayMs?: number }) {
  return (
    <svg
      className={className ? `cost-trace draw ${className}` : "cost-trace draw"}
      viewBox="0 0 60 20"
      aria-hidden
      style={
        delayMs ? ({ "--cost-trace-delay": `${delayMs}ms` } as React.CSSProperties) : undefined
      }
    >
      <path pathLength={100} d="M1 10 Q6 2 12 10 T24 10 T36 10 T48 10 T59 10" />
    </svg>
  );
}
