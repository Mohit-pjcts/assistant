import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface InstrumentCardProps {
  children: ReactNode;
  className?: string;
  eyebrow?: ReactNode;
  /** Triggers the shared `.reveal` clip-path entrance (index.css). */
  reveal?: boolean;
  /** Staggers multiple reveals (a list of arriving rows) via `--reveal-delay`. */
  revealDelayMs?: number;
  /**
   * The one card genuinely awaiting the user's approval gets a scanning
   * conic-gradient border instead of the static hairline — DESIGN.md §7's
   * "a warning light, not a trend," reserved for real gated confirmations,
   * never decoration. See `.instrument-card-scanning` below.
   */
  awaitingApproval?: boolean;
  onClick?: () => void;
  role?: string;
  tabIndex?: number;
  "aria-label"?: string;
  "data-testid"?: string;
}

// PLAN.md Phase 29 — the ONE card primitive every card-shaped object in
// the app shares (kanban, gate confirmations, generative-UI, memory
// rows, cost figures): a hairline border, 6px radius, spotlight-follow
// glow, and a whole-card 3D tilt, both driven by real pointer position
// (instrument/DESIGN.md §7's spotlight+tilt technique — CSS alone can't
// track a live cursor position into a transform, hence a real component
// here rather than a pure-CSS class).
//
// Spring-return on pointer leave reuses the exact "mechanical settle"
// cubic-bezier this design already names for panel switches
// (`cubic-bezier(.34,1.56,.64,1)`, index.css's own `.instrument-card`
// transition) rather than inventing a second easing curve for the same
// felt effect.
//
// Gated behind BOTH `prefers-reduced-motion` and `pointer: fine` — same
// posture instrument.html's own trailing cursor uses (never forced on
// touch, never forced on anyone who's asked for less motion). Reduced-
// motion/touch users still get the card, the border, and the reveal
// entrance — just not the live tilt/spotlight tracking.
export function InstrumentCard({
  children,
  className,
  eyebrow,
  reveal,
  revealDelayMs,
  awaitingApproval,
  onClick,
  role,
  tabIndex,
  ...aria
}: InstrumentCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canTiltRef = useRef<boolean | null>(null);

  function canTilt(): boolean {
    if (canTiltRef.current === null) {
      // jsdom/happy-dom (component tests) don't implement matchMedia at all
      // — a real environment gap, same class as the AnimationEvent/
      // setPointerCapture/createSVGPoint ones found during Phase 28's own
      // radial-selector build. Guarded rather than assumed.
      canTiltRef.current =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: no-preference)").matches &&
        window.matchMedia("(pointer: fine)").matches;
    }
    return canTiltRef.current;
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!canTilt()) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
    // Max ~6deg tilt (DESIGN.md §7), centered on the card's own midpoint —
    // (0.5, 0.5) is the resting/no-tilt position.
    const rotateY = (px - 0.5) * 12;
    const rotateX = (0.5 - py) * 12;
    el.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  }

  function handleMouseLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "rotateX(0deg) rotateY(0deg)";
  }

  return (
    <div
      ref={ref}
      className={cn(
        "instrument-card",
        reveal && "reveal",
        awaitingApproval && "instrument-card-scanning",
        className,
      )}
      style={
        revealDelayMs
          ? ({ "--reveal-delay": `${revealDelayMs}ms` } as React.CSSProperties)
          : undefined
      }
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      role={role}
      tabIndex={tabIndex}
      {...aria}
    >
      {eyebrow && <div className="instrument-card-eyebrow mb-1.5">{eyebrow}</div>}
      {children}
    </div>
  );
}
