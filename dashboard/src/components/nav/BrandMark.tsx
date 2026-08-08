// PLAN.md Phase 29 Stage 4 — the design's own hand-drawn brand mark,
// ported verbatim from instrument/instrument.html's `#brand-mark` (one
// circle, two asymmetric strokes, one arc — "optional flavor on top of
// the system, not the system itself," per DESIGN.md §4). Draws itself
// once on mount via index.css's `.brand-mark.draw` animation; the `.draw`
// class is always present here (this app has no "redraw on every tab
// switch" requirement the mockup's own rail icons have — that's a
// separate, deliberately-not-built sub-technique, see NavRail.tsx's own
// comment on why).
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `brand-mark draw ${className}` : "brand-mark draw"}
      viewBox="0 0 32 32"
      aria-hidden
    >
      <circle className="m1" pathLength={100} cx="16" cy="10.5" r="3.6" />
      <path
        className="m2"
        pathLength={100}
        d="M13.2 7.6C14.5 5.3 18 5 19.3 7C20.6 9 19.8 12 19 14.5C18.3 16.8 20.5 19.5 23.5 22.5"
      />
      <path
        className="m3"
        pathLength={100}
        d="M12.8 8.5C11.3 10 11.6 13 10.3 15.8"
        opacity={0.65}
      />
      <path className="m4" pathLength={100} d="M8.5 23.5C11 20 21 20 23.5 23.5" />
    </svg>
  );
}
