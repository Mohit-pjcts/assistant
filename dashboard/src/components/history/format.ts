import type { TraceUsage } from "@/lib/api";

// Small display helpers shared by the History panel's components. Pure and
// forgiving on purpose: nearly every input can be null/undefined (a call
// recorded before call tracing existed has no timing, a Stage run logged
// before it recorded its source has none) and the answer is always "show
// nothing" or "show it raw", never a throw.

// Tailwind class strings for the status chips. One table so a tool-call
// status, a Stage task status and a Stage run outcome all use the same
// colors for the same meaning: moss = went fine, rust = failed, signal =
// waiting/unfinished (the app's "pending approval" amber), unstyled = no
// news. Kept as full literal class names (not built from pieces) so
// Tailwind's source scan can see every one of them.
export const TONE_CLASSES = {
  ok: "border-moss/40 text-moss",
  error: "border-rust/50 text-rust",
  warn: "border-signal/50 text-signal",
  muted: "",
} as const;

export type Tone = keyof typeof TONE_CLASSES;

/** 340 -> "340 ms", 1234 -> "1.2 s", 125000 -> "2m 05s". Missing/invalid -> null. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** Stage reports task/run time in (fractional) seconds. */
export function formatSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return formatDuration(seconds * 1000);
}

// Up to 5 decimals, not the cost panel's 4: a single Stage helper call
// costs fractions of a cent ($0.00031), and rounding that to $0.0003 would
// hide exactly the figure someone opens this panel to look at.
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export function formatUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return usdFormatter.format(value);
}

/** 12345 -> "12,345" (fixed locale so a count reads the same everywhere). */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * One model call's token use: "1,204 in / 310 out · cache read 900 · cache
 * write 120". The cache figures appear whenever the provider reported them,
 * zero included — "cache read 0" is exactly what a prompt-cache miss looks
 * like, and the reason anyone looks at these numbers.
 */
export function formatUsage(usage: TraceUsage | null | undefined): string | null {
  if (!usage) return null;
  const parts = [
    `${formatCount(usage.input_tokens ?? 0)} in / ${formatCount(usage.output_tokens ?? 0)} out`,
  ];
  if (typeof usage.cache_read_tokens === "number") {
    parts.push(`cache read ${formatCount(usage.cache_read_tokens)}`);
  }
  if (typeof usage.cache_creation_tokens === "number") {
    parts.push(`cache write ${formatCount(usage.cache_creation_tokens)}`);
  }
  return parts.join(" · ");
}

/** Local date + time for an ISO string; anything unparseable is returned as is. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Local clock time (HH:MM:SS) — for a line inside an already-dated run. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * One line of an arbitrary value, cut to `max` characters — what a
 * collapsed row shows so you can tell calls apart without opening them.
 * Only a preview: the full value is always one click away, never lost here.
 */
export function previewText(value: unknown, max = 140): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  // Cut before collapsing whitespace so a 200,000-character argument isn't
  // regex-scanned just to show 140 characters of it.
  const head = text.length > max * 4 ? text.slice(0, max * 4) : text;
  const oneLine = head.replace(/\s+/g, " ").trim();
  return head.length < text.length || oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
