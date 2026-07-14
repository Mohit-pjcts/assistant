import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { CostPanel } from "@/components/cost/CostPanel";
import { ThreadSidebar } from "@/components/threads/ThreadSidebar";

// PLAN.md Phase 9's initial panel set, all four now wired: chat (step 3),
// history (step 4), memory (step 5), cost (step 6). Phase 15 added the
// persistent thread sidebar (Claude-style, visible from every tab).
//
// `activeThreadId` lives here, not inside ChatPanel/HistoryPanel — it's
// passed to ChatPanel/HistoryPanel only as a `key`, forcing a fresh mount
// (and therefore a fresh fetch) whenever the sidebar switches threads.
// Neither panel needs to know its own thread_id explicitly: both already
// call their fetch functions with no thread_id, which server.py resolves
// against the SAME active pointer the sidebar just moved.
function App() {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  return (
    <div className="flex h-screen">
      <ThreadSidebar onActiveThreadChange={setActiveThreadId} />
      <main className="mx-auto flex h-screen min-w-0 max-w-2xl flex-1 flex-col gap-4 p-4">
        <h1 className="text-lg font-semibold">Personal Assistant</h1>
        <Tabs defaultValue="chat" className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="cost">Cost</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="min-h-0">
            <ChatPanel key={activeThreadId ?? "pending"} />
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
    </div>
  );
}

export default App;
