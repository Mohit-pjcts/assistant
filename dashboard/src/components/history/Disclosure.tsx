import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface DisclosureProps {
  // What the toggle button says. Plain text, or a few inline elements (a
  // chip and a name) — it all becomes the button's accessible name.
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  // A parent's global "show all" switch. Whenever it changes, this
  // disclosure snaps to it; clicking the toggle afterwards still overrides
  // just this one until the next change — what makes the Conversation tab's
  // "show thinking / show context" pair work alongside each block's own
  // toggle without either fighting the other.
  forceOpen?: boolean;
  className?: string;
  buttonClassName?: string;
}

// The one expand/collapse control the History panel uses for everything
// that is "there, but not worth the space until asked for": thinking, a
// context message, a Stage step's control list, a raw JSON line, an inner-
// calls list. A real button with aria-expanded; the content isn't mounted
// while closed, so a conversation of hundreds of collapsed blocks stays a
// small DOM.
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  forceOpen,
  className,
  buttonClassName,
}: DisclosureProps) {
  const [open, setOpen] = useState(forceOpen ?? defaultOpen);
  const contentId = useId();

  useEffect(() => {
    if (forceOpen !== undefined) setOpen(forceOpen);
  }, [forceOpen]);

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-fit max-w-full items-center gap-1 text-left font-mono text-[0.7rem] text-muted-foreground hover:text-foreground",
          buttonClassName,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {label}
      </button>
      {open && <div id={contentId}>{children}</div>}
    </div>
  );
}
