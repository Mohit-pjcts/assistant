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
