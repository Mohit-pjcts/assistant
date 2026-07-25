// Client for assistant/server.py (Phase 9's backend wrapper — STEPS.md 55).
// Talks to the SAME shared graph/thread the CLI and voice daemon use; see
// server.py's own module docstring for why that matters.
//
// Base URL is fixed — the Tauri shell now spawns/manages the backend's
// process lifecycle itself (Phase 14 packaging step, STEPS.md 71/72:
// src-tauri/src/lib.rs), always on 127.0.0.1:8000, so this doesn't need to
// be configurable.
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
  // Phase 18 (PLAN.md): the full A2UI surface(s) persisted on this
  // message — either render_ui's own direct ToolMessage, or a
  // specialist-delegation ToolMessage forwarding what a sub-agent rendered
  // during its own isolated run (server.py's /history, assistant/a2ui.py's
  // A2UI_SURFACE_KEY). Empty/absent on every message that carries none.
  // HistoryPanel renders these inline on that row; ChatPanel groups them
  // onto the turn's closing assistant bubble to match what a live turn
  // looks like (see ChatPanel's own history-loading code).
  surfaces?: A2UISurface[];
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
  { type: "message"; content: string } | { type: "interrupt"; payload: InterruptPayload };

// A validated A2UI component-tree surface (Phase 17, PLAN.md) — forwarded
// verbatim from assistant/a2ui.py's render_ui tool the same way
// InterruptPayload is: an open record per component, since different
// component types carry different fields. Rendered live via the SSE `a2ui`
// frame for the turn that produced it; as of Phase 18 (PLAN.md) the same
// tree also comes back from /history (HistoryMessage.surface above), so a
// reload can re-render it instead of only ever showing render_ui's text
// summary.
export interface A2UIComponent extends Record<string, unknown> {
  id?: string;
  component?: string;
}

export interface A2UISurface {
  surfaceId: string;
  components: A2UIComponent[];
}

// PLAN.md Phase 19: server.py's `activity` SSE frame — supervisor.py's
// _AgentActivityRelay (a specialist's own inner tool calls) and
// call_specialist (the supervisor->specialist boundary itself) both
// dispatch this via the same adispatch_custom_event mechanism a2ui/
// research_fa_token already use. Ephemeral, non-terminal, never persisted —
// purely a live "what's running right now" signal for the dashboard's
// right-rail activity graph, tool-call timeline, and header status pill.
export interface AgentActivityEvent {
  phase: "tool_start" | "tool_end";
  agent: string;
  tool: string;
}

// File/photo upload feature: what POST /uploads returns, echoed back
// verbatim as a ChatRequest.attachments entry (server.py's Attachment
// model). `kind` is the only thing this client branches on — the
// image/multimodal vs. document/read_file split happens entirely
// server-side in _build_user_content.
export interface Attachment {
  path: string;
  mime_type: string;
  kind: "image" | "document";
  filename: string;
}

export async function uploadFile(file: File): Promise<Attachment> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE_URL}/uploads`, { method: "POST", body: formData });
  if (!response.ok) {
    throw new Error(`/uploads failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<Attachment>;
}

// Startup-time GETs (fetchThreads/fetchHistory/fetchCost) race a real bug
// (PLAN.md Phase 19): the Tauri shell shows the window before uvicorn
// (assistant/server.py) is actually listening, so the very first mount-time
// fetch can hit ECONNREFUSED before the backend finishes booting. A THROWN
// network error (not a resolved non-OK response — that means the backend IS
// up and answered, e.g. a real 503/404) is retried on a short fixed interval
// until the backend comes up or a generous cap elapses; a non-OK response is
// returned immediately; it's the caller's real answer, not a startup race.
async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  { retries = 30, delayMs = 500 }: { retries?: number; delayMs?: number } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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

// Phase 14 streaming (STEPS.md 71/72): /chat and /resume now respond with
// text/event-stream instead of one JSON object — see server.py's
// `_stream_turn` docstring for the full design (verified live against the
// real graph before being written). `onToken` fires for every incremental
// text delta as it arrives; the returned promise resolves to exactly the
// same ChatTurnResult shape the old single-shot response used to be,
// taken from the stream's terminal frame — callers that don't care about
// live tokens can ignore `onToken` entirely and nothing else changes.
//
// Manual SSE parsing over `fetch()`'s streaming body, not the browser's
// built-in `EventSource` — EventSource only supports GET, and both
// endpoints need a POST body (the message, or the approval decision).
async function streamSSE(
  path: string,
  body: unknown,
  onToken: (text: string) => void,
  onA2UI: (surface: A2UISurface) => void = () => {},
  onActivity: (event: AgentActivityEvent) => void = () => {},
): Promise<ChatTurnResult> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(`${path} failed (${response.status}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: ChatTurnResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? ""; // a trailing partial frame stays buffered
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice("data: ".length)) as
        | { type: "token"; text: string }
        | { type: "a2ui"; surface: A2UISurface }
        | { type: "message"; content: string }
        | { type: "interrupt"; payload: InterruptPayload }
        | ({ type: "activity" } & AgentActivityEvent)
        | { type: "error"; detail: string };
      if (event.type === "token") {
        onToken(event.text);
      } else if (event.type === "a2ui") {
        onA2UI(event.surface);
      } else if (event.type === "activity") {
        onActivity(event);
      } else if (event.type === "error") {
        throw new Error(`${path} stream error: ${event.detail}`);
      } else {
        terminal = event;
      }
    }
  }

  if (!terminal) {
    // A stop-mid-run cancellation ends the connection without a terminal
    // frame — this is the normal, expected shape of that case, not a bug;
    // ChatPanel's stop handling checks for it via its own "did I just
    // request a stop" flag rather than this function guessing intent.
    throw new Error(`${path}: stream ended without a terminal event`);
  }
  return terminal;
}

export async function sendChat(
  message: string,
  onToken: (text: string) => void = () => {},
  onA2UI: (surface: A2UISurface) => void = () => {},
  onActivity: (event: AgentActivityEvent) => void = () => {},
  attachments: Attachment[] = [],
): Promise<ChatTurnResult> {
  return streamSSE("/chat", { message, attachments }, onToken, onA2UI, onActivity);
}

export async function resumeChat(
  approved: boolean,
  onToken: (text: string) => void = () => {},
  onA2UI: (surface: A2UISurface) => void = () => {},
  onActivity: (event: AgentActivityEvent) => void = () => {},
): Promise<ChatTurnResult> {
  return streamSSE("/resume", { approved }, onToken, onA2UI, onActivity);
}

// Phase 17 Part B: what an A2UIRenderer's Button reports (POST /a2ui/action)
// when the user submits an interactive surface. Streams through the exact
// same SSE contract as sendChat/resumeChat — server.py's a2ui_action
// endpoint treats this as an ordinary new user turn, so it can resolve to
// a message OR another interrupt, same as any other turn.
export async function sendA2UIAction(
  surfaceId: string,
  name: string,
  context: Record<string, unknown>,
  onToken: (text: string) => void = () => {},
  onA2UI: (surface: A2UISurface) => void = () => {},
  onActivity: (event: AgentActivityEvent) => void = () => {},
): Promise<ChatTurnResult> {
  return streamSSE(
    "/a2ui/action",
    { surface_id: surfaceId, name, context },
    onToken,
    onA2UI,
    onActivity,
  );
}

// Cancels whatever turn is currently streaming for the active thread, if
// any (server.py's POST /chat/stop). `stopped: false` just means nothing
// was in flight — not an error.
export async function stopChat(): Promise<{ stopped: boolean }> {
  return postJSON<{ stopped: boolean }>("/chat/stop", {});
}

export async function fetchHistory(): Promise<HistoryMessage[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/history`);
  if (!response.ok) {
    throw new Error(`/history failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { messages: HistoryMessage[]; thread_id: string };
  return body.messages;
}

// Phase 15: multi-thread conversation support. Full thread management
// (list/rename/switch/start-new) lives in the GUI's History panel — the
// only surface that can actually show a picker (PLAN.md Phase 15's
// scope-split decision, STEPS.md 66). Switching or creating a thread moves
// the SHARED active pointer server.py's other endpoints (and the CLI/voice
// daemon) fall back to when they don't specify a thread_id of their own —
// a deliberately global effect, same as it always implicitly was when
// there was only one thread.
export interface ThreadSummary {
  id: string;
  title: string | null;
  created_at: string;
  last_active_at: string;
}

export async function fetchThreads(): Promise<{
  threads: ThreadSummary[];
  activeThreadId: string;
}> {
  const response = await fetchWithRetry(`${API_BASE_URL}/threads`);
  if (!response.ok) {
    throw new Error(`/threads failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { threads: ThreadSummary[]; active_thread_id: string };
  return { threads: body.threads, activeThreadId: body.active_thread_id };
}

export async function createThread(title?: string): Promise<ThreadSummary> {
  return postJSON<ThreadSummary>("/threads", { title: title ?? null });
}

export async function setActiveThread(threadId: string): Promise<ThreadSummary> {
  return postJSON<ThreadSummary>("/threads/active", { thread_id: threadId });
}

export async function renameThread(threadId: string, title: string): Promise<ThreadSummary> {
  const response = await fetch(`${API_BASE_URL}/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(
      `rename /threads/${threadId} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<ThreadSummary>;
}

// Does not purge the deleted thread's own conversation history server-side
// (server.py's docstring on DELETE /threads/{id}) — just removes it from
// the picker. Returns the active_thread_id AFTER deletion: deleting the
// currently-active thread reassigns the shared pointer (thread_store's
// "always exactly one active thread" invariant), so the caller needs to
// know what's active now, not just that the delete succeeded.
export async function deleteThread(threadId: string): Promise<{ activeThreadId: string }> {
  const response = await fetch(`${API_BASE_URL}/threads/${threadId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(
      `delete /threads/${threadId} failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { deleted: boolean; active_thread_id: string };
  return { activeThreadId: body.active_thread_id };
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
    throw new Error(
      `delete /memory/facts/${id} failed (${response.status}): ${await response.text()}`,
    );
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
  const response = await fetchWithRetry(`${API_BASE_URL}/cost`);
  if (response.status === 503) {
    throw new LangSmithNotConfiguredError(await response.text());
  }
  if (!response.ok) {
    throw new Error(`/cost failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<CostStats>;
}

// Kanban board — same store both the dashboard's Board tab and
// life_admin_agent's board_tools.py read/write (server.py's /board/tasks,
// full agent access per the user's explicit request). No confirmation gate
// on any of these: board changes are the user's own in-app data, same
// reasoning as deleteMemoryFact above, not a new agent-authored side effect
// in the email/calendar/filter sense.
export type BoardColumnId = "todo" | "in-progress" | "in-review" | "done";
export type BoardPriority = "high" | "medium" | "low";

export interface BoardTask {
  id: string;
  column: BoardColumnId;
  ref: string;
  priority: BoardPriority;
  title: string;
  description: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export async function fetchBoardTasks(): Promise<BoardTask[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/board/tasks`);
  if (!response.ok) {
    throw new Error(`/board/tasks failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { tasks: BoardTask[] };
  return body.tasks;
}

export async function createBoardTask(params: {
  column: BoardColumnId;
  title: string;
  description?: string;
  priority?: BoardPriority;
}): Promise<BoardTask> {
  return postJSON<BoardTask>("/board/tasks", params);
}

export async function updateBoardTask(
  taskId: string,
  changes: {
    column?: BoardColumnId;
    position?: number;
    title?: string;
    description?: string;
    priority?: BoardPriority;
  },
): Promise<BoardTask> {
  const response = await fetch(`${API_BASE_URL}/board/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!response.ok) {
    throw new Error(
      `PATCH /board/tasks/${taskId} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<BoardTask>;
}

export async function deleteBoardTask(taskId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/board/tasks/${taskId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(
      `DELETE /board/tasks/${taskId} failed (${response.status}): ${await response.text()}`,
    );
  }
}
