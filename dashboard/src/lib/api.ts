// Client for assistant/server.py (Phase 9's backend wrapper — STEPS.md 55).
// Talks to the SAME shared graph/thread the CLI and voice daemon use; see
// server.py's own module docstring for why that matters.
//
// Base URL is fixed for now — the Python backend is started by hand
// (`uvicorn assistant.server:app`), not spawned/supervised by the Tauri
// shell yet. Automating that lifecycle (spawn on app launch, kill on quit)
// is a deliberately separate, not-yet-done step (STEPS.md), kept out of
// this one so "wire the chat panel" doesn't grow into "own a child
// process's lifecycle" in the same change.
const API_BASE_URL = "http://127.0.0.1:8000";

export interface HistoryMessage {
  role: string;
  content: string;
  // True for a HumanMessage the graph itself inserted (Phase 6's routing
  // bridge, Phase 7's recalled-facts injection, the compaction summary) —
  // NOT something the real user typed, even though it carries role "user".
  // Optional so older/mocked shapes without it default to "not synthetic"
  // (see ChatPanel's filter).
  synthetic?: boolean;
  // The message's own `.name`, meaning depends on role (checked against
  // real graph output, not assumed — STEPS.md 58): on a "tool" message,
  // the tool that ran; on an "assistant" message in this multi-agent
  // graph, which node produced it ("supervisor" / "coding_agent" / etc.);
  // null/absent otherwise.
  name?: string | null;
}

// The raw payload a gated tool constructed via LangGraph's interrupt() —
// passed through by server.py UNMODIFIED (its own docstring, STEPS.md 54).
// Deliberately typed as an open record, not a fixed shape: different gated
// tools attach different fields (interrupts.py's `spoken_prompt`,
// memory_extraction.py's `fact`/`provenance`/`voice_approvable`), and the
// UI must render whatever a tool actually sent, not a shape this client
// guessed at ahead of time.
export type InterruptPayload = Record<string, unknown> & {
  action?: string;
};

export type ChatTurnResult =
  | { type: "message"; content: string }
  | { type: "interrupt"; payload: InterruptPayload };

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${path} failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<T>;
}

export async function sendChat(message: string): Promise<ChatTurnResult> {
  return postJSON<ChatTurnResult>("/chat", { message });
}

export async function resumeChat(approved: boolean): Promise<ChatTurnResult> {
  return postJSON<ChatTurnResult>("/resume", { approved });
}

export async function fetchHistory(): Promise<HistoryMessage[]> {
  const response = await fetch(`${API_BASE_URL}/history`);
  if (!response.ok) {
    throw new Error(`/history failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { messages: HistoryMessage[] };
  return body.messages;
}

// Phase 7 Part B's durable facts, reviewed/managed here (PLAN.md Phase 9
// step 5). `content` is the exact string the agent's extraction gate
// (memory_extraction.py) got approved for — render it verbatim, same
// no-re-summarization principle as the chat panel's interrupt gate, even
// though deleting isn't itself gated (see deleteMemoryFact below).
export interface MemoryFact {
  id: number;
  content: string;
  provenance: string | null;
  created_at: string;
}

export async function fetchMemoryFacts(): Promise<MemoryFact[]> {
  const response = await fetch(`${API_BASE_URL}/memory/facts`);
  if (!response.ok) {
    throw new Error(`/memory/facts failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { facts: MemoryFact[] };
  return body.facts;
}

// Deliberately NOT behind the interrupt/confirmation gate on the backend
// (server.py's own docstring: the user curating their own already-saved
// data is not a new agent-authored side effect, so memory_extraction.py's
// gate doesn't apply). Still an irreversible action from the user's own
// point of view, so the UI (MemoryPanel) requires an explicit confirm
// dialog before calling this — a client-side UX safeguard, not a security
// boundary.
export async function deleteMemoryFact(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/memory/facts/${id}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`delete /memory/facts/${id} failed (${response.status}): ${await response.text()}`);
  }
}

// Token/cost tracking (PLAN.md Phase 9 step 6) — real LangSmith aggregates
// (server.py's `/cost`), not computed locally from a pricing table.
export interface CostWindow {
  run_count: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_cost: number;
  prompt_cost: number;
  completion_cost: number;
}

export interface CostStats {
  project: string;
  windows: {
    today: CostWindow;
    week: CostWindow;
    all_time: CostWindow;
  };
}

// Thrown specifically on the backend's 503 ("LANGSMITH_API_KEY missing or
// invalid") so the panel can show a distinct, actionable message instead of
// a generic error banner — this isn't a broken request, it's a feature
// that isn't set up.
export class LangSmithNotConfiguredError extends Error {}

export async function fetchCost(): Promise<CostStats> {
  const response = await fetch(`${API_BASE_URL}/cost`);
  if (response.status === 503) {
    throw new LangSmithNotConfiguredError(await response.text());
  }
  if (!response.ok) {
    throw new Error(`/cost failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<CostStats>;
}
