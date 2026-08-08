import { useEffect, useRef, useState } from "react";

// PLAN.md Phase 29 Stage 3 — the design's own "count-up" motion technique,
// applied to CostPanel.tsx/CostSummaryCard.tsx's dollar/token figures.
// Deliberately compatible with this project's EXISTING no-sparkline
// decision (CostPanel.tsx's own code comment: Today/Last 7 days/All time
// are overlapping windows, not points on a timeline, so a trend line would
// misrepresent them) — this animates the NUMBER rolling to its new value,
// it draws no line and implies no trend.
//
// `useState(target)` as the initial value (not 0) means the very first
// render already shows the correct final number, before the animation
// effect below ever runs — this is what keeps CostPanel.test.tsx's
// synchronous `getByText("$1.2345")` (right after an awaited render, no
// extra wait) passing regardless of effect timing, not a coincidence.
// Only a SUBSEQUENT change to `target` (a real Refresh click) ever
// animates, and only when the environment can: jsdom has no
// `window.matchMedia` at all (same real gap `instrument-card.tsx` already
// guards for), so tests always take the immediate-set branch below.
export function useCountUp(target: number, durationMs = 500): number {
  const [value, setValue] = useState(target);
  const displayedRef = useRef(target);

  useEffect(() => {
    const canAnimate =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

    if (!canAnimate || displayedRef.current === target) {
      displayedRef.current = target;
      setValue(target);
      return;
    }

    const start = displayedRef.current;
    const delta = target - start;
    const startTime = performance.now();
    let raf = 0;

    function tick(now: number) {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(start + delta * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        displayedRef.current = target;
      }
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
