import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";

// PLAN.md Phase 9: chat (step 3), history (step 4), and memory (step 5)
// panels. Cost panel (step 6) is the last one, added as a further tab when
// it exists.
function App() {
  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Personal Assistant</h1>
      <Tabs defaultValue="chat" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="min-h-0">
          <ChatPanel />
        </TabsContent>
        <TabsContent value="history" className="min-h-0">
          <HistoryPanel />
        </TabsContent>
        <TabsContent value="memory" className="min-h-0">
          <MemoryPanel />
        </TabsContent>
      </Tabs>
    </main>
  );
}

export default App;
