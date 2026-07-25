import { useState } from "react";
import { Menu, PanelRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { HomePage } from "@/components/home/HomePage";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { CostPanel } from "@/components/cost/CostPanel";
import { CostSummaryCard } from "@/components/cost/CostSummaryCard";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { InProgressTasksCard } from "@/components/board/InProgressTasksCard";
import { ThreadSidebar } from "@/components/threads/ThreadSidebar";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { AgentActivityGraph } from "@/components/activity/AgentActivityGraph";
import { ToolCallTimeline } from "@/components/activity/ToolCallTimeline";
import { StatusPill } from "@/components/activity/StatusPill";
import { useAgentActivity } from "@/components/activity/useAgentActivity";

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
  const { activeAgent, activeTool, timeline, handleActivity } = useAgentActivity();
  // Home tab landing composer hand-off: `activeTab` is controlled (rather
  // than Tabs' own uncontrolled defaultValue) specifically so submitting a
  // message on Home can switch to Chat programmatically. pendingHomeMessage
  // travels with it and is consumed exactly once by ChatPanel's own
  // initialMessage effect (see ChatPanel.tsx) — cleared via
  // onConsumeInitialMessage so it can't resend on a later tab revisit.
  const [activeTab, setActiveTab] = useState("home");
  const [pendingHomeMessage, setPendingHomeMessage] = useState<string | null>(null);
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

  function startChatFromHome(message: string) {
    setPendingHomeMessage(message);
    setActiveTab("chat");
  }

  return (
    <div className="flex h-screen bg-background">
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
        <ThreadSidebar onActiveThreadChange={setActiveThreadId} />
      </div>
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1">
          <TabsList variant="line" className="border-b border-border">
            <TabsTrigger
              value="home"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              Home
            </TabsTrigger>
            <TabsTrigger
              value="chat"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              Chat
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              History
            </TabsTrigger>
            <TabsTrigger
              value="memory"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              Memory
            </TabsTrigger>
            <TabsTrigger
              value="cost"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              Cost
            </TabsTrigger>
            <TabsTrigger
              value="board"
              className="panel-label text-xs after:bg-operator data-active:text-operator"
            >
              Board
            </TabsTrigger>
          </TabsList>
          <TabsContent value="home" className="min-h-0 h-full">
            <HomePage greetingName="Mohit" onStartChat={startChatFromHome} />
          </TabsContent>
          <TabsContent value="chat" className="min-h-0">
            <ChatPanel
              key={activeThreadId ?? "pending"}
              onActivity={handleActivity}
              initialMessage={pendingHomeMessage}
              onConsumeInitialMessage={() => setPendingHomeMessage(null)}
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
        </Tabs>
      </main>
      <aside
        className={cn(
          // Same Dynamic Island fix as the sidebar drawer above.
          "fixed top-[env(safe-area-inset-top)] bottom-0 right-0 z-50 flex w-96 max-w-[85vw] translate-x-full flex-col gap-3 overflow-y-auto border-l border-sidebar-border bg-sidebar p-3 text-sidebar-foreground transition-transform duration-200 md:static md:top-0 md:z-auto md:h-screen md:max-w-none md:translate-x-0 md:shrink-0",
          mobileNav === "rail" && "translate-x-0",
        )}
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
            <AgentActivityGraph activeAgent={activeAgent} />
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
