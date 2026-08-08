import { useState } from "react";
import { Menu, PanelRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NavRail } from "@/components/nav/NavRail";
import { BrandMark } from "@/components/nav/BrandMark";
import { TrailingCursor } from "@/components/nav/TrailingCursor";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { CostPanel } from "@/components/cost/CostPanel";
import { CostSummaryCard } from "@/components/cost/CostSummaryCard";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { AutomationsPanel } from "@/components/automations/AutomationsPanel";
import { WorkflowsPanel } from "@/components/workflows/WorkflowsPanel";
import { ClaudeCodeSessionsPanel } from "@/components/claude-code/ClaudeCodeSessionsPanel";
import { InProgressTasksCard } from "@/components/board/InProgressTasksCard";
import { ThreadSidebar } from "@/components/threads/ThreadSidebar";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { useResizableWidth } from "@/lib/useResizableWidth";
import { AgentActivityGraph } from "@/components/activity/AgentActivityGraph";
import { ToolCallTimeline } from "@/components/activity/ToolCallTimeline";
import { StatusPill } from "@/components/activity/StatusPill";
import { useAgentActivity } from "@/components/activity/useAgentActivity";
import { ActiveTurnBanner } from "@/components/activity/ActiveTurnBanner";

// PLAN.md Phase 9's initial panel set, all four now wired: chat (step 3),
// history (step 4), memory (step 5), cost (step 6). Phase 15 added the
// persistent thread sidebar (Claude-style, visible from every tab). Phase
// 19 ("Oni" redesign, layout/structure only — current color tokens kept
// per the user's explicit call) added the right-hand context rail below.
//
// `activeThreadId` lives here, not inside ChatPanel/HistoryPanel — it's
// passed to ChatPanel/HistoryPanel only as a `key`, forcing a fresh mount
// (and therefore a fresh fetch) whenever the sidebar switches threads.
// Neither panel needs to know its own thread_id explicitly: both already
// call their fetch functions with no thread_id, which server.py resolves
// against the SAME active pointer the sidebar just moved.
//
// `useAgentActivity()` lives HERE, not inside ChatPanel, specifically so
// the right rail's activity graph/timeline survive a tab switch away from
// Chat (Base UI's Tabs unmounts inactive panels by default) — see
// ChatPanel's own `onActivity` prop docstring for the full reasoning.
function App() {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const { activeAgent, activeTool, timeline, handleActivity, resetActivity } = useAgentActivity();
  // The user's own explicit call: no separate Home/Chat tabs — Chat itself
  // shows the landing view (greeting, category suggestions) whenever the
  // active thread is genuinely empty, and switches into normal chat mode
  // the instant a first message is sent, all inside ChatPanel.tsx itself
  // (see its own `isNewChat` — this file no longer hands anything off to
  // it). Defaults straight to "chat" — there's no separate landing tab to
  // default to anymore.
  const [activeTab, setActiveTab] = useState("chat");
  // iPhone-access feature: below the `md` breakpoint the thread sidebar
  // and right context rail (both fixed-width, together wider than a
  // phone screen) stop taking up permanent layout space and become
  // slide-over drawers instead, toggled from the mobile-only header
  // buttons below. `null` = both closed; at most one open at a time
  // (opening one closes the other, matching a single-drawer mental
  // model rather than letting them stack). Desktop/Tauri layout (`md:`
  // and up) ignores this entirely — both stay always-visible flex
  // siblings exactly as before.
  const [mobileNav, setMobileNav] = useState<"sidebar" | "rail" | null>(null);
  // Draggable column widths, persisted (localStorage, same shape as
  // uiScale.tsx) so a resize survives a reload/relaunch. NavRail stays
  // fixed-width (it's a 52px icon-only column, not a candidate for
  // resizing); main always fills whatever space these two leave it.
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useResizableWidth({
    storageKey: "pa-sidebar-width",
    defaultWidth: 216,
    min: 180,
    max: 420,
  });
  const { width: railWidth, setWidth: setRailWidth } = useResizableWidth({
    storageKey: "pa-rail-width",
    defaultWidth: 260,
    min: 220,
    max: 480,
  });

  return (
    <div className="flex h-screen bg-background">
      {/* PLAN.md Phase 29 Stage 4 — mounted once, app-wide; the component
          itself no-ops entirely on touch/reduced-motion (see its own
          guard), so this is never forced on anyone it shouldn't be. */}
      <TrailingCursor />
      {/* Backdrop: mobile-only, closes whichever drawer is open on tap.
          Absent on md+ (mobileNav never gets set there since the toggle
          buttons that set it are themselves md:hidden). */}
      {mobileNav && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileNav(null)}
          aria-hidden
        />
      )}
      {/* PLAN.md Phase 29's own left icon rail — always visible, even on
          mobile (52px is thin enough not to need the slide-over-drawer
          treatment the wider thread list/right rail still get below). */}
      <NavRail activeTab={activeTab} onChange={setActiveTab} />
      <div
        className={cn(
          // iPhone-access feature, PWA fix: `top-[env(safe-area-inset-top)]`
          // instead of `inset-y-0`'s implicit top-0 — on an iPhone with a
          // Dynamic Island/notch, `viewport-fit=cover` (index.html) draws
          // this app edge-to-edge, so a bare top-0 renders the sidebar's
          // own header content straight under the island. env() resolves
          // to 0 wherever there's no inset to clear (desktop, older
          // iPhones), so this is a no-op everywhere but where it's needed.
          "fixed top-[env(safe-area-inset-top)] bottom-0 left-0 z-50 -translate-x-full transition-transform duration-200 md:static md:top-0 md:z-auto md:translate-x-0",
          mobileNav === "sidebar" && "translate-x-0",
        )}
      >
        <ThreadSidebar onActiveThreadChange={setActiveThreadId} width={sidebarWidth} />
      </div>
      <ResizeHandle
        ariaLabel="Resize thread sidebar"
        onResize={(delta) => setSidebarWidth((prev) => prev + delta)}
      />
      <main className="flex h-screen min-w-0 flex-1 flex-col gap-4 p-4">
        {/* PWA fix (same reasoning as the sidebar drawer above): the
            hamburger/title/status row is the exact content that was
            rendering under the Dynamic Island — this is the actual
            reported bug, not just the drawer. */}
        <header className="flex items-center justify-between gap-3 pt-[env(safe-area-inset-top)]">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Open threads"
              className="text-muted-foreground md:hidden"
              onClick={() => setMobileNav((v) => (v === "sidebar" ? null : "sidebar"))}
            >
              <Menu className="size-5" />
            </button>
            <BrandMark />
            <h1 className="font-heading text-lg font-semibold tracking-tight">Oni</h1>
            <StatusPill agent={activeAgent} tool={activeTool} />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open activity panel"
              className="text-muted-foreground md:hidden"
              onClick={() => setMobileNav((v) => (v === "rail" ? null : "rail"))}
            >
              <PanelRight className="size-5" />
            </button>
            <ThemeToggle />
          </div>
        </header>
        {/* STEPS.md 121-122: visible from every tab, not just Chat — a
            turn started by voice/phone/an automation is otherwise
            invisible to the dashboard entirely, which is exactly how a
            43-retry, 28-minute loop went unnoticed. */}
        <ActiveTurnBanner />
        {/* PLAN.md Phase 29 — the horizontal TabsList/TabsTrigger bar is
            gone entirely, replaced by NavRail (the left icon column
            above); Tabs/TabsContent still own the actual panel-switching
            logic, just with no visible tab strip of their own anymore. */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1">
          <TabsContent value="chat" className="min-h-0">
            <ChatPanel
              key={activeThreadId ?? "pending"}
              greetingName="Mohit"
              onActivity={handleActivity}
              onStreamEnded={resetActivity}
            />
          </TabsContent>
          <TabsContent value="history" className="min-h-0">
            <HistoryPanel key={activeThreadId ?? "pending"} />
          </TabsContent>
          <TabsContent value="memory" className="min-h-0">
            <MemoryPanel />
          </TabsContent>
          <TabsContent value="cost" className="min-h-0">
            <CostPanel />
          </TabsContent>
          <TabsContent value="board" className="min-h-0 h-full">
            <KanbanBoard />
          </TabsContent>
          <TabsContent value="automations" className="min-h-0">
            <AutomationsPanel />
          </TabsContent>
          <TabsContent value="workflows" className="min-h-0">
            <WorkflowsPanel />
          </TabsContent>
          <TabsContent value="claude-code" className="min-h-0">
            <ClaudeCodeSessionsPanel />
          </TabsContent>
        </Tabs>
      </main>
      <ResizeHandle
        ariaLabel="Resize activity rail"
        onResize={(delta) => setRailWidth((prev) => prev - delta)}
      />
      <aside
        className={cn(
          // Same Dynamic Island fix as the sidebar drawer above.
          // PLAN.md Phase 29: 384px (w-96) -> 260px, matching
          // instrument/DESIGN.md §3's own frame-body proportions — now
          // just the default until dragged (see useResizableWidth above).
          "fixed top-[env(safe-area-inset-top)] bottom-0 right-0 z-50 flex w-[260px] max-w-[85vw] translate-x-full flex-col gap-3 overflow-y-auto border-l border-sidebar-border bg-sidebar p-3 text-sidebar-foreground transition-transform duration-200 md:static md:top-0 md:z-auto md:h-screen md:max-w-none md:translate-x-0 md:shrink-0",
          mobileNav === "rail" && "translate-x-0",
        )}
        style={{ width: railWidth }}
      >
        <Card size="sm">
          <CardHeader>
            <CardTitle className="panel-label text-[0.65rem] text-muted-foreground">
              In progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InProgressTasksCard />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="panel-label text-[0.65rem] text-muted-foreground">
              Live agent activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AgentActivityGraph activeAgent={activeAgent} activeTool={activeTool} />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="panel-label text-[0.65rem] text-muted-foreground">
              Tool call timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ToolCallTimeline entries={timeline} />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="panel-label text-[0.65rem] text-muted-foreground">
              Cost — 7 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CostSummaryCard />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

export default App;
