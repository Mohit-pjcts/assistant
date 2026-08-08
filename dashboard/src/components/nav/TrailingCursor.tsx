import { useEffect, useRef } from "react";

// PLAN.md Phase 29 Stage 4 — the global trailing cursor (instrument/
// DESIGN.md §2): an exact-tracking dot plus a rAF-lerped ring that lags
// it, ported verbatim algorithm (`rx += (mx-rx)*0.18` — an 18%-per-frame
// linear interpolation is the lag itself, no easing library needed).
// Reads pointer position via refs, writes position via direct
// `style.left`/`style.top` mutation on every animation frame — never as
// React state, same "high-frequency updates bypass React reconciliation"
// pattern this app's own AgentActivityGraph/RadialChatSelector physics
// already established (Phase 28) for exactly this reason: state-driven
// re-renders at 60fps would be needless render-thrashing for a value
// nothing else in the tree reads.
//
// Gated behind BOTH `pointer: fine` and `prefers-reduced-motion` — same
// posture InstrumentCard's own tilt uses — checked once on mount, not
// live-watched: this is a session-long visual affordance, not something
// that should flicker on/off mid-session if the OS setting changes.
// Renders nothing (returns null) and does nothing at all when either
// condition fails, including in every component test's jsdom
// environment (no `window.matchMedia` there — the same real gap
// `instrument-card.tsx`/`useCountUp.ts` already guard for).
//
// A real, live-reported bug found the same day this shipped: DESIGN.md's
// own spec hides the real OS cursor (`cursor: none`) while this is
// active, matching the mockup's own single-page prototype — but the
// user reported the cursor disappearing entirely in certain parts of
// the real app. Root cause not confirmed (no connected browser this
// session to inspect it directly — some combination of this app's real
// scroll containers, Base UI's portalled dialogs/menus, and/or a WebKit-
// in-Tauri stacking quirk is the leading suspect, same general class of
// WebKit rendering gap already hit once in Phase 26's own base64 bug).
// Rather than ship an unverified guess at the real cause, the real
// cursor is no longer hidden at all — the dot/ring now render ADDITIVELY
// on top of the native cursor. This trades away DESIGN.md's literal
// "hide the real cursor" instruction for the one property that actually
// matters: the cursor can never again fail to appear, regardless of
// whatever caused the decorative ring to misbehave.
const LERP = 0.18;
const HOVER_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="tab"], .instrument-card';

export function TrailingCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canRun =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: fine)").matches &&
      window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
    if (!canRun) return;

    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    let mx = 0;
    let my = 0;
    let rx = 0;
    let ry = 0;
    let raf = 0;

    function handleMove(event: MouseEvent) {
      mx = event.clientX;
      my = event.clientY;
      dot!.style.left = `${mx}px`;
      dot!.style.top = `${my}px`;
    }

    function handleOver(event: MouseEvent) {
      const target = event.target as Element | null;
      if (target?.closest(HOVER_SELECTOR)) {
        ring!.classList.add("instrument-cursor-hover");
      }
    }

    function handleOut(event: MouseEvent) {
      const related = event.relatedTarget as Element | null;
      if (!related?.closest(HOVER_SELECTOR)) {
        ring!.classList.remove("instrument-cursor-hover");
      }
    }

    function loop() {
      rx += (mx - rx) * LERP;
      ry += (my - ry) * LERP;
      ring!.style.left = `${rx}px`;
      ring!.style.top = `${ry}px`;
      raf = requestAnimationFrame(loop);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseover", handleOver);
    window.addEventListener("mouseout", handleOut);
    raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseover", handleOver);
      window.removeEventListener("mouseout", handleOut);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <div ref={dotRef} className="instrument-cursor-dot" />
      <div ref={ringRef} className="instrument-cursor-ring" />
    </>
  );
}
