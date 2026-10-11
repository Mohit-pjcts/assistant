import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// The small "Copy" beside every Input/Output/raw block. It always copies the
// FULL text it was given, never what's on screen — a block shows only its
// first few thousand characters until "show all" is clicked, and copying a
// truncated tool output would be a quiet trap.
//
// `what` names the thing for assistive tech ("Copy input"), since a page of
// identical "Copy" buttons is unusable by ear.
export function CopyButton({
  text,
  what,
  className,
}: {
  text: string;
  what: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    try {
      // navigator.clipboard is missing outside a secure context and throws
      // if the OS denies it — either way the honest answer is "failed",
      // not a button that looks like it worked.
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${what}`}
      disabled={text === ""}
      onClick={() => void handleCopy()}
      className={cn(
        "rounded border border-graphite/40 px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        state === "copied" && "text-moss",
        state === "failed" && "text-rust",
        className,
      )}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}
    </button>
  );
}
