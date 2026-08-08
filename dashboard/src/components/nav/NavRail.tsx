import {
  Brain,
  DollarSign,
  History,
  Kanban,
  MessageSquare,
  Terminal,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  value: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { value: "chat", label: "Chat", icon: MessageSquare },
  { value: "history", label: "History", icon: History },
  { value: "memory", label: "Memory", icon: Brain },
  { value: "cost", label: "Cost", icon: DollarSign },
  { value: "board", label: "Board", icon: Kanban },
  { value: "automations", label: "Automations", icon: Zap },
  { value: "workflows", label: "Workflows", icon: Workflow },
  { value: "claude-code", label: "Claude Code", icon: Terminal },
];

interface NavRailProps {
  activeTab: string;
  onChange: (tab: string) => void;
}

// PLAN.md Phase 29's own left icon rail (instrument/DESIGN.md §3/§5) —
// replaces the horizontal TabsList entirely, not just restyles it. The
// mockup's own rail only ever needed 5 icons; this app has 8 real
// destinations (Home folded into Chat itself at the user's own request —
// see ChatPanel.tsx's own `isNewChat` landing view), so the rail is a
// vertical stack of 8 rather than 5 — same mechanism (hover-reveals a
// floating mono label,
// `position:absolute; left:60px`, DESIGN.md's own "four lines of CSS, no
// JS positioning library"), just taller. `Tabs`/`TabsContent` (App.tsx)
// still own the actual panel-switching; this only drives `activeTab`,
// the same way `TabsList`/`TabsTrigger` used to.
//
// Icon redraw-on-switch (the mockup's own `pathLength=100` stroke-
// dashoffset draw-on, reused from the brand mark) is PLAN.md Phase 29
// Stage 4's job, not this one — lucide's stock icon paths don't carry a
// normalized `pathLength`, and building that per-icon is real, separate
// work; these render as plain static icons for now.
export function NavRail({ activeTab, onChange }: NavRailProps) {
  return (
    <nav
      className="flex h-screen w-[52px] shrink-0 flex-col items-center gap-1 border-r border-graphite/30 bg-void py-3"
      aria-label="Views"
    >
      {NAV_ITEMS.map(({ value, label, icon: Icon }) => {
        const isActive = activeTab === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            data-testid={`nav-rail-${value}`}
            className={cn(
              "group relative flex size-9 shrink-0 items-center justify-center rounded-md transition-colors",
              isActive
                ? "bg-accent-signal/15 text-accent-signal"
                : "text-muted-foreground hover:bg-accent-signal/10 hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" strokeWidth={1.75} />
            <span
              role="tooltip"
              className="pointer-events-none absolute left-[46px] z-50 rounded-md border border-graphite/40 bg-popover px-2 py-1 font-mono text-[0.65rem] whitespace-nowrap text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
