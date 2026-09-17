import { useEffect, useRef } from "react";
// Tried `animejs/animation`/`animejs/scope`/etc. subpath imports first,
// on the assumption that skipping the barrel (which also re-exports
// SVG path-morphing, text-scramble, draggable, and a Three.js adapter
// this component never touches) would shrink the bundle — checked with
// a real `npm run build` size diff rather than assumed, and it made no
// difference at all (Rollup already tree-shakes the bare import down to
// the same bytes). Kept the plain barrel import since it's simpler with
// no real cost.
import { animate, createScope, spring, stagger, type JSAnimation, type Scope } from "animejs";
import { BrandMark } from "@/components/nav/BrandMark";

// Replaces the old plain "Hi, {name}" / "Where should we start?" text
// block (STEPS.md 140/141) at the user's own direct follow-up request:
// something dynamic and interactive, reading as a dialogue CLOUD
// "spoken" by the landing view's own hero artwork (App.tsx's
// live-wallpaper video, dark mode only) rather than plain copy floating
// independently above it. Oni's own hand-drawn logo (`BrandMark`,
// already built for the header in Phase 29 Stage 4) sits inside the
// cloud and draws itself fresh every time this mounts — that's "the
// logo coming from her," reusing an existing signature technique rather
// than inventing a bespoke particle/emission effect. Renders identically
// in light mode too (no video there for it to visually emerge from) —
// Oni's own greeting doesn't need the artwork to make sense on its own.
//
// Motion is real anime.js (v4, `animejs` — the user's own suggestion,
// checked against the actual installed package's real .d.ts files
// before writing any of this, per this project's own verification
// discipline), not hand-rolled CSS keyframes: a spring-eased pop-in for
// the cloud and its trailing dots, an idle float once that settles, and
// a hover-triggered "greet" wiggle for the "interactive" part of the
// ask — genuinely reactive to the user's own cursor, not just decorative
// ambient motion. `createScope`/`.revert()` is anime.js's own documented
// React lifecycle pattern (scope all animations to this component's own
// root, tear them all down together on unmount — no manual bookkeeping
// of individual animation instances).
//
// `prefers-reduced-motion` skips the whole effect outright rather than
// swapping in a reduced version: every element's CSS rest state
// (index.css's own `.oni-cloud*` rules) IS already the fully-visible,
// fully-settled appearance — the entrance animation only ever displaces
// FROM that rest state and back TO it, so never running it at all still
// leaves a perfectly normal, fully static, fully legible greeting.
export function OniGreetingCloud({ name }: { name: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<Scope | null>(null);
  // Captured explicitly rather than relied on for scope auto-tracking:
  // this animation is started from inside the pop-in spring's onComplete
  // callback, i.e. AFTER createScope(...).add(...)'s own synchronous
  // callback has already returned — anime.js's documented auto-tracking
  // covers animations created synchronously during that callback, not
  // ones kicked off later from a nested async callback. Without this,
  // scopeRef.current?.revert() on unmount might not actually stop the
  // infinite loop:true/alternate:true idle-float tween, leaving it
  // running against a detached DOM node.
  const idleFloatRef = useRef<JSAnimation | null>(null);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    scopeRef.current = createScope({ root: rootRef }).add((self) => {
      // anime.js's own type signature has this as optional (it's never
      // actually undefined at runtime for a scope's own constructor
      // callback) — narrowed here rather than asserted, so `self.add`
      // below type-checks cleanly.
      if (!self) return;
      // Pop-in: a real spring, not a linear/cubic-bezier ease — settles
      // with a touch of overshoot rather than easing flatly to rest.
      animate(".oni-cloud", {
        opacity: [0, 1],
        scale: [0.5, 1],
        translateY: [14, 0],
        ease: spring({ stiffness: 210, damping: 15 }),
        onComplete: () => {
          // Idle float only starts once the spring has actually settled
          // (chained via onComplete, not a guessed delay) — otherwise
          // the two translateY tweens would fight over the same
          // property from the same instant.
          idleFloatRef.current = animate(".oni-cloud", {
            translateY: [0, -7],
            loop: true,
            alternate: true,
            duration: 2600,
            ease: "inOutSine",
          });
        },
      });
      // The three trailing dots pop in right behind the cloud itself,
      // smallest/farthest one last — reads as the cloud "forming" down
      // toward the artwork below it rather than all four pieces
      // appearing at once.
      animate(".oni-cloud-dot", {
        opacity: [0, 1],
        scale: [0, 1],
        delay: stagger(90, { start: 140 }),
        ease: spring({ stiffness: 260, damping: 16 }),
      });

      // The interactive half of the ask: hovering the cloud plays a
      // real reaction — a quick elastic wiggle — rather than a static
      // CSS `:hover` transform. Registered as a named scope method
      // (anime.js's own documented pattern for calling into a scoped
      // animation from a React event handler) so it's independent of
      // the entrance/idle tweens above and safe to fire repeatedly.
      self.add("greet", () => {
        animate(".oni-cloud", {
          rotate: [0, -5, 4, -2, 0],
          scale: [1, 1.07, 1],
          duration: 520,
          ease: "outElastic(1, .6)",
        });
      });
    });

    return () => {
      idleFloatRef.current?.revert();
      scopeRef.current?.revert();
    };
  }, []);

  return (
    <div ref={rootRef} className="oni-cloud-wrap">
      <div className="oni-cloud" onMouseEnter={() => scopeRef.current?.methods.greet?.()}>
        <BrandMark />
        <span className="oni-cloud-text">Hey, {name}</span>
      </div>
      <span aria-hidden="true" className="oni-cloud-dot oni-cloud-dot-1" />
      <span aria-hidden="true" className="oni-cloud-dot oni-cloud-dot-2" />
      <span aria-hidden="true" className="oni-cloud-dot oni-cloud-dot-3" />
    </div>
  );
}
