import { Button } from "@/components/ui/button";

// Placeholder scaffold (Phase 9 step 2, STEPS.md) — proves the Tauri +
// React + shadcn/ui wiring compiles end-to-end. Real panels (chat, history,
// memory, cost) replace this in later steps, talking to assistant/server.py.
function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Personal Assistant Dashboard</h1>
      <p className="text-muted-foreground">Scaffold check — Tauri + React + shadcn/ui wired up.</p>
      <Button>It works</Button>
    </main>
  );
}

export default App;
