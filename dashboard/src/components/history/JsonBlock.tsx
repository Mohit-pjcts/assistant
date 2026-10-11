import { useMemo } from "react";
import { TextBlock } from "./TextBlock";

/**
 * Pretty-printed JSON (2-space indent) for any value. A string that is
 * itself a JSON object/array — an input that reached the browser still
 * encoded — is decoded first, so it reads as structure instead of one long
 * escaped line; any other string is returned untouched.
 */
export function prettyJson(value: unknown): string {
  let data = value;
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) data = parsed;
    } catch {
      // Not JSON — plain text, shown as is.
    }
    if (typeof data === "string") return data;
  }
  try {
    return JSON.stringify(data, null, 2) ?? "";
  } catch {
    return String(data);
  }
}

// A labelled, copyable JSON view (a tool call's Input, a raw Stage log
// line). Long ones get TextBlock's show-all guard — pretty-printing a
// 100-control Stage step easily passes the preview limit.
export function JsonBlock({
  value,
  label,
  copyLabel,
  emptyLabel = "(none)",
  className,
}: {
  value: unknown;
  label?: string;
  copyLabel?: string;
  emptyLabel?: string;
  className?: string;
}) {
  // Memoized: stringifying a 100 KB argument on every re-render (every
  // keystroke in the conversation filter re-renders the open rows) adds up.
  const text = useMemo(() => prettyJson(value), [value]);
  return (
    <TextBlock
      text={text}
      label={label}
      copyLabel={copyLabel}
      emptyLabel={emptyLabel}
      className={className}
    />
  );
}
