import { useState } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";
import { formatCount } from "./format";

// How much of a long text a block shows before "show all". A tool output can
// run to 200,000 characters (the backend's own storage cap); laying that out
// for every expanded row would make the panel crawl, while ~4,000 is enough
// to recognize what you're looking at. The rest is one click — or the copy
// button, which copies everything — away.
export const TEXT_PREVIEW_LIMIT = 4000;

interface TextBlockProps {
  text: string;
  // Heading shown above the block ("Output"); also names the copy button.
  // Leave unset for a block that sits under its own disclosure label.
  label?: string;
  // What to show when `text` is empty — differs by caller ("no output
  // recorded" is not the same fact as "the tool returned nothing").
  emptyLabel?: string;
  // Overrides the copy button's accessible name when there is no `label`.
  copyLabel?: string;
  limit?: number;
  className?: string;
}

// Verbatim, pre-wrapped text with a copy button and a length guard — the
// panel's one way of showing a possibly-huge string (tool output, thinking,
// a context message, a raw log line). Same no-re-summarization principle as
// the rest of this app: what's shown is the exact string, never a rewrite.
export function TextBlock({
  text,
  label,
  emptyLabel = "(empty)",
  copyLabel,
  limit = TEXT_PREVIEW_LIMIT,
  className,
}: TextBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const tooLong = text.length > limit;
  const shown = tooLong && !expanded ? text.slice(0, limit) : text;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2">
        {label ? (
          <span className="panel-label text-[0.65rem] text-muted-foreground">{label}</span>
        ) : (
          <span />
        )}
        <CopyButton text={text} what={copyLabel ?? label?.toLowerCase() ?? "text"} />
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-graphite/30 bg-muted/40 p-2 font-mono text-xs">
        {text === "" ? <span className="italic text-muted-foreground">{emptyLabel}</span> : shown}
        {tooLong && !expanded ? <span className="text-muted-foreground">…</span> : null}
      </pre>
      {tooLong && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="self-start font-mono text-[0.7rem] text-accent-signal hover:underline"
        >
          {expanded ? "show less" : `show all (${formatCount(text.length)} chars)`}
        </button>
      )}
    </div>
  );
}
