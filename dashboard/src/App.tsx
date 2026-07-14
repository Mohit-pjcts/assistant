import { ChatPanel } from "@/components/chat/ChatPanel";

// PLAN.md Phase 9 step 3: chat panel wired to assistant/server.py. History,
// memory, and cost panels are later steps — single-panel layout for now.
function App() {
  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Personal Assistant</h1>
      <div className="min-h-0 flex-1">
        <ChatPanel />
      </div>
    </main>
  );
}

export default App;
