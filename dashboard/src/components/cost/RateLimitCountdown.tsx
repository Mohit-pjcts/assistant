import { useEffect, useMemo, useRef, useState } from "react";
import { animate } from "animejs";

// The user's own direct ask, 2026-08-09: when `/cost` is rate-limited,
// don't just say so — show a real, live-ticking "how long until this
// clears" countdown. Built with anime.js (the library instrument/
// DESIGN.md itself cites for this project's whole draw-on/count-up
// motion language, animejs.com/motion.dev) rather than another hand-
// rolled CSS keyframe: each digit is a small odometer-style reel that
// rolls to its new value on change, the same "mechanical" felt effect a
// handful of Codepen flip-clock/counter pens use for exactly this kind
// of live-ticking figure.
//
// Gated behind `prefers-reduced-motion`, same posture as every other
// motion primitive in this app (InstrumentCard.tsx's own `canTilt`) — a
// reduced-motion user still gets the correct digits, just without the
// roll.
function canAnimate(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

function Digit({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current === value) return;
    prevValue.current = value;
    const el = ref.current;
    if (!el || !canAnimate()) return;
    animate(el, {
      translateY: ["-45%", "0%"],
      opacity: [0.15, 1],
      duration: 420,
      ease: "outElastic(1, .6)",
    });
  }, [value]);

  return (
    <span ref={ref} className="rate-limit-countdown-digit">
      {value}
    </span>
  );
}

function Segment({ value, unit }: { value: number; unit: string }) {
  const padded = String(value).padStart(2, "0");
  return (
    <span className="rate-limit-countdown-segment">
      {padded.split("").map((digit, i) => (
        // Index keys are safe here: this is a FIXED slot count whose
        // VALUES change in place, never a reordered/inserted list.
        <Digit key={i} value={digit} />
      ))}
      <span className="rate-limit-countdown-unit">{unit}</span>
    </span>
  );
}

function useTickingNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function RateLimitCountdown({
  resetAt,
  onExpire,
}: {
  resetAt: string;
  onExpire?: () => void;
}) {
  const now = useTickingNow(1000);
  const target = useMemo(() => new Date(resetAt).getTime(), [resetAt]);
  const remainingMs = target - now;

  // Fires onExpire exactly once per distinct resetAt value — a real bug
  // this fixes: the countdown used to just silently render nothing past
  // expiry, with nothing telling CostPanel.tsx to fetch fresh figures.
  // Keyed on resetAt (not a plain "already fired" boolean) so a genuinely
  // NEW rate-limit window later can still fire its own expiry correctly.
  const firedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (Number.isNaN(target) || remainingMs > 0) return;
    if (firedForRef.current === resetAt) return;
    firedForRef.current = resetAt;
    onExpire?.();
  }, [remainingMs, target, resetAt, onExpire]);

  if (Number.isNaN(target) || remainingMs <= 0) return null;

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return (
    <span
      className="rate-limit-countdown"
      aria-label={`resets in ${days > 0 ? `${days} days ` : ""}${hours} hours ${minutes} minutes ${seconds} seconds`}
    >
      {days > 0 && <Segment value={days} unit="d" />}
      <Segment value={hours} unit="h" />
      <Segment value={minutes} unit="m" />
      <Segment value={seconds} unit="s" />
    </span>
  );
}
