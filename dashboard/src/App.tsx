import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { CostPanel } from "@/components/cost/CostPanel";
import { CostSummaryCard } from "@/components/cost/CostSummaryCard";
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

  return (
    <div className="flex h-screen bg-background">
      <ThreadSidebar onActiveThreadChange={setActiveThreadId} />
      <main className="mx-auto flex h-screen min-w-0 max-w-2xl flex-1 flex-col gap-4 p-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="font-heading text-lg font-semibold tracking-tight">Oni</h1>
            <StatusPill agent={activeAgent} tool={activeTool} />
          </div>
          <ThemeToggle />
        </header>
        <Tabs defaultValue="chat" className="min-h-0 flex-1">
          <TabsList variant="line" className="border-b border-border">
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
          </TabsList>
          <TabsContent value="chat" className="min-h-0">
            <ChatPanel key={activeThreadId ?? "pending"} onActivity={handleActivity} />
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
        </Tabs>
      </main>
      <aside className="flex h-screen w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-sidebar-border bg-sidebar p-3 text-sidebar-foreground">
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
