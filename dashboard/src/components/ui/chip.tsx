import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// PLAN.md Phase 29 Stage 2: the one small "pill" primitive every badge/tag
// in the app shares (interrupt-gate source/voice badges, A2UI Badge nodes
// and board priority/ref tags, the real Board tab's own ref/priority
// tags) — mono, hairline border, matching instrument/DESIGN.md's own
// label vocabulary. Replaces Astryx's Badge component everywhere it was
// used for this purpose.
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-graphite/40 px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
