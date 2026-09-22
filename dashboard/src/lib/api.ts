import { isTauri } from "@tauri-apps/api/core";

// Client for assistant/server.py (Phase 9's backend wrapper — STEPS.md 55).
// Talks to the SAME shared graph/thread the CLI and voice daemon use; see
// server.py's own module docstring for why that matters.
//
// Base URL: two real deployments now share this file (iPhone-access
// feature). Inside the Tauri app, the window itself loads from a custom
// `tauri://localhost` scheme — `window.location.origin` there is useless
// for reaching the backend, so it stays the fixed 127.0.0.1:8000 the Tauri
// shell has always spawned/managed (Phase 14, STEPS.md 71/72:
// src-tauri/src/lib.rs). In a plain browser (a phone on the same
// Tailscale/LAN reaching the Mac directly), server.py now serves the
// dashboard's own build as static files from itself — same-origin — so
// `window.location.origin` IS the backend's real address there, whatever
// host/IP was actually used to reach it. `isTauri()` (the official
// `@tauri-apps/api/core` detection helper, not a hand-rolled
// `window.__TAURI__` check) is what tells the two cases apart.
const API_BASE_URL = isTauri() ? "http://127.0.0.1:8000" : window.location.origin;

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
  // Optional flat, string-keyed data model (assistant/a2ui.py's
  // validate_surface) — a component's {"path": ...} binding resolves
  // against this instead of a literal value, for data the AGENT never
  // typed out itself (e.g. board_tools.py's render_board_ui binds real
  // board_store rows here rather than having the model retype them).
  // number/string[] added for the full basic-catalog parity pass
  // (Slider.value / ChoicePicker.value are DynamicNumber/DynamicStringList).
  dataModel?: Record<string, string | boolean | number | string[]>;
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

// iPhone-access feature: uploads a browser-recorded utterance (whatever
// format MediaRecorder produced — webm/opus on most browsers, mp4/aac on
// Safari/iOS) to server.py's /voice/transcribe, which runs it through the
// same mlx-whisper model the Mac's own voice daemon uses and hands back
// plain text. ChatPanel sends that text through the normal handleSend
// path, same as a typed message — this function's job ends at "here's
// the transcript."
export async function transcribeVoice(blob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("file", blob, `utterance.${blob.type.split("/")[1]?.split(";")[0] ?? "webm"}`);
  const response = await fetch(`${API_BASE_URL}/voice/transcribe`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`/voice/transcribe failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { text: string };
  return body.text;
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
  // PLAN.md Phase 28 — null means ungrouped, not "no project yet vs.
  // some project" ambiguity; every thread that existed before this field
  // was added is (and stays) ungrouped, no backfill. Optional (not just
  // nullable) purely to avoid touching every existing ThreadSummary test
  // fixture across the codebase that predates this field — real API
  // responses always include it; consuming code treats a missing value
  // exactly like `null` (ungrouped), never as a distinct third state.
  project_id?: string | null;
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

// PLAN.md Phase 28 — Projects group Threads in the sidebar (`Oni ->
// Project -> Thread`, see CONTEXT.md). `color` is assigned server-side,
// round-robin, at creation — never computed client-side, so it stays
// stable as other projects are added/removed (thread_store.py's own
// create_project docstring).
export interface Project {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE_URL}/projects`);
  if (!response.ok) {
    throw new Error(`/projects failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { projects: Project[] };
  return body.projects;
}

export async function createProject(name: string): Promise<Project> {
  return postJSON<Project>("/projects", { name });
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(
      `rename /projects/${projectId} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<Project>;
}

// Unassigns rather than deletes every Thread in this Project — see
// thread_store.delete_project's own docstring (PLAN.md Phase 28 Decision
// 4) for why. The caller (ThreadSidebar) is responsible for re-fetching
// threads afterward to see them fall out of this project's group.
export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/projects/${projectId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(
      `delete /projects/${projectId} failed (${response.status}): ${await response.text()}`,
    );
  }
}

// The one endpoint behind both of Phase 28's UI paths for moving a
// Thread — the sidebar's "Move to project" menu action and its tree
// drag-and-drop both call this. `projectId: null` clears the
// assignment (thread becomes ungrouped again), not "no-op."
export async function assignThreadProject(
  threadId: string,
  projectId: string | null,
): Promise<ThreadSummary> {
  const response = await fetch(`${API_BASE_URL}/threads/${threadId}/project`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!response.ok) {
    throw new Error(
      `assign /threads/${threadId}/project failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<ThreadSummary>;
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

// User-authored fact, typed directly into the panel rather than proposed by
// the agent's extraction gate. Deliberately NOT behind interrupt() either —
// same reasoning as deleteMemoryFact below, this is the user adding to
// their own store, not a new agent-authored side effect. The backend tags
// it provenance="user" so the panel can show where it came from.
export async function createMemoryFact(content: string): Promise<MemoryFact> {
  const response = await fetch(`${API_BASE_URL}/memory/facts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(`create /memory/facts failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as MemoryFact;
}

// Editing an already-saved fact — same non-gated curation category as
// deleteMemoryFact below.
export async function updateMemoryFact(id: number, content: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/memory/facts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(
      `update /memory/facts/${id} failed (${response.status}): ${await response.text()}`,
    );
  }
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

// Nightly memory-review queue (2026-07-28): memory_review_agent.py's
// batch pass, run once a day at midnight (or on demand via
// triggerMemoryReview below), proposes candidates here instead of blocking
// the live conversation with a per-turn interrupt() the way the old
// extraction flow did. A PendingFact is NOT yet a known fact — approving
// or declining it is the actual confirmation step.
export interface PendingFact {
  id: number;
  content: string;
  provenance: string | null;
  created_at: string;
}

export async function fetchPendingFacts(): Promise<PendingFact[]> {
  const response = await fetch(`${API_BASE_URL}/memory/pending`);
  if (!response.ok) {
    throw new Error(`/memory/pending failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { pending: PendingFact[] };
  return body.pending;
}

// The actual confirmation click — moves the candidate into the real facts
// table. Not behind interrupt(): this request IS the human approval.
export async function approvePendingFact(id: number): Promise<MemoryFact> {
  const response = await fetch(`${API_BASE_URL}/memory/pending/${id}/approve`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `approve /memory/pending/${id} failed (${response.status}): ${await response.text()}`,
    );
  }
  return (await response.json()) as MemoryFact;
}

export async function declinePendingFact(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/memory/pending/${id}/decline`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `decline /memory/pending/${id} failed (${response.status}): ${await response.text()}`,
    );
  }
}

// On-demand "check now" — the same nightly pass the midnight scheduler
// runs automatically, exposed here so the user doesn't have to wait for an
// actual midnight to see it work.
export async function triggerMemoryReview(): Promise<number> {
  const response = await fetch(`${API_BASE_URL}/memory/review/run-now`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`/memory/review/run-now failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { queued: number };
  return body.queued;
}

// Token/cost tracking (PLAN.md Phase 9 step 6) — real Langfuse aggregates
// (server.py's `/cost`), not computed locally from a pricing table. Source
// swapped from LangSmith to Langfuse (2026-07-25) after LangSmith's own
// monthly trace-ingestion quota silently stopped accepting new traces —
// see server.py's `/cost` docstring for the full story.
//
// `stale`/`no_data`/`read_at` and the top-level `rate_limited` were added
// 2026-08-09 after a real, live Langfuse rate limit (100 requests/window)
// made this endpoint throw — the user's own direct ask, TWICE, after a
// first fix still left the UI showing a bare error: never do that, always
// show the last real numbers read, say how stale they are, and say how
// long until the limit clears. The backend now NEVER throws for this —
// see `/cost`'s own docstring — so there is no rate-limit error class
// here anymore; a thrown Error from `fetchCost` means something else
// entirely broke (this backend unreachable, a genuine 500).
export interface CostWindow {
  run_count: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_cost: number;
  prompt_cost: number;
  completion_cost: number;
  stale: boolean;
  no_data: boolean;
  read_at: string | null;
}

export interface CostRateLimit {
  message: string;
  retry_after_seconds: number | null;
  reset_at: string | null;
}

export interface CostStats {
  project: string;
  windows: {
    today: CostWindow;
    week: CostWindow;
    all_time: CostWindow;
  };
  rate_limited: CostRateLimit | null;
}

// Thrown specifically on the backend's 503 ("LANGFUSE_PUBLIC_KEY/
// LANGFUSE_SECRET_KEY missing or invalid") so the panel can show a
// distinct, actionable message instead of a generic error banner — this
// isn't a broken request, it's a feature that isn't set up. Still the
// one case with no fallback: never configured means no history exists
// to fall back to either.
export class CostSourceNotConfiguredError extends Error {}

export async function fetchCost(): Promise<CostStats> {
  const response = await fetchWithRetry(`${API_BASE_URL}/cost`);
  if (response.status === 503) {
    throw new CostSourceNotConfiguredError(await response.text());
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

// Unattended pre-approved automations (PLAN.md Phase 24) — a new,
// deliberately narrow, explicitly-named exception to the standing
// confirmation rule. `action` is server-validated against
// AUTOMATION_ELIGIBLE_ACTIONS (server.py) — messaging-shaped actions
// only, not the full GATED_ACTIONS set; the backend 400s a request
// outside that allowlist, this panel doesn't duplicate the check.
export type AutomationAction = "send_imessage" | "send_email";

export interface Automation {
  id: string;
  name: string;
  trigger_description: string;
  target: string;
  goal: string;
  action: AutomationAction;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  fired_at: string;
  outcome: "fired" | "skipped" | "error";
  detail: string;
}

export async function fetchAutomations(): Promise<Automation[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/automations`);
  if (!response.ok) {
    throw new Error(`/automations failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { automations: Automation[] };
  return body.automations;
}

export async function fetchAutomationRuns(): Promise<AutomationRun[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/automations/runs`);
  if (!response.ok) {
    throw new Error(`/automations/runs failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { runs: AutomationRun[] };
  return body.runs;
}

export async function createAutomation(params: {
  name: string;
  trigger_description: string;
  target: string;
  goal: string;
  action: AutomationAction;
}): Promise<Automation> {
  return postJSON<Automation>("/automations", params);
}

export async function updateAutomation(
  automationId: string,
  changes: Partial<{
    name: string;
    trigger_description: string;
    target: string;
    goal: string;
    action: AutomationAction;
    enabled: boolean;
  }>,
): Promise<Automation> {
  const response = await fetch(`${API_BASE_URL}/automations/${automationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!response.ok) {
    throw new Error(
      `PATCH /automations/${automationId} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<Automation>;
}

export async function deleteAutomation(automationId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/automations/${automationId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(
      `DELETE /automations/${automationId} failed (${response.status}): ${await response.text()}`,
    );
  }
}

// Cross-app workflow runs (PLAN.md Phase 25) — read-only from this API's
// side. A run is only ever created by supervisor.py's propose_workflow
// tool (a real /chat -> gate -> /resume round trip) and only ever updated
// by supervisor.py's own _record_workflow_progress as specialist calls
// actually execute; there is no create/update/delete endpoint here to call.
export interface WorkflowStep {
  step_index: number;
  action: string;
  planned_summary: string;
  executed_args: Record<string, unknown> | null;
  outcome: "success" | "failed" | "never_ran" | null;
  detail: string;
  executed_at: string | null;
  diverged: boolean;
}

export interface WorkflowRun {
  id: string;
  thread_id: string;
  goal: string;
  status: "running" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
  steps: WorkflowStep[];
}

export async function fetchWorkflows(): Promise<WorkflowRun[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/workflows`);
  if (!response.ok) {
    throw new Error(`/workflows failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { workflows: WorkflowRun[] };
  return body.workflows;
}

// A real, live-diagnosed incident (STEPS.md 121-122): a turn silently
// retried a failing render_ui call 43 times over ~28 minutes with nothing
// telling the user it was even happening. This polls assistant/
// active_turns.py's in-memory registry so ActiveTurnBanner can show any
// in-flight turn — across every channel, not just the dashboard's own
// current tab — regardless of who's watching. Polling, not SSE: the whole
// point is visibility into turns this browser tab didn't itself start
// (voice, phone, automations), so a per-request SSE stream can't cover it.
export interface ActiveTurnInfo {
  thread_id: string;
  channel: "dashboard" | "voice" | "phone" | "automation" | "cli";
  agent: string;
  elapsed_seconds: number;
  seconds_since_update: number;
  step_count: number;
  current_tool: string | null;
  consecutive_failures: number;
  stuck: boolean;
}

// Follow-up to the above: a turn that ends abnormally (backend error, a
// cancellation) is otherwise invisible to any tab/channel other than the
// one that started it the instant it drops out of ActiveTurnInfo — assistant/
// active_turns.py's list_recent() keeps a short, time-windowed record of how
// every turn ended so ActiveTurnBanner can show a brief notice instead of
// silence.
export interface RecentlyEndedTurn {
  thread_id: string;
  channel: "dashboard" | "voice" | "phone" | "automation" | "cli";
  agent: string;
  outcome: "completed" | "error" | "cancelled";
  elapsed_seconds: number;
  seconds_since_ended: number;
}

export async function fetchActiveTurns(): Promise<{
  active: ActiveTurnInfo[];
  recentlyEnded: RecentlyEndedTurn[];
}> {
  const response = await fetchWithRetry(`${API_BASE_URL}/activity/active`);
  if (!response.ok) {
    throw new Error(`/activity/active failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    active: ActiveTurnInfo[];
    recently_ended: RecentlyEndedTurn[];
  };
  return { active: body.active, recentlyEnded: body.recently_ended };
}

// STEPS.md 151's durable activity log — the "what happened while I wasn't
// watching the dashboard" complement to fetchActiveTurns' live/recent-30s
// view above. Covers every completed supervisor->specialist delegation on
// any channel, persisted (assistant/activity_log.sqlite), not just the last
// 30 seconds. Polling, same reasoning as fetchActiveTurns.
export interface ActivityLogEvent {
  id: string;
  thread_id: string;
  agent: string;
  outcome: "success" | "error";
  detail: string;
  started_at: string;
  finished_at: string;
}

export async function fetchActivityLog(limit = 50): Promise<ActivityLogEvent[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/activity/log?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`/activity/log failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { events: ActivityLogEvent[] };
  return body.events;
}

// run_claude_code's own nested Claude Code sessions (2026-08-06) — read-only
// from this API's side, same as Workflows above: assistant/
// claude_code_sessions.py parses the .jsonl transcripts Claude Code's own
// CLI process writes, this server never writes them. These sessions are
// invisible in Claude Code's own interactive session browser (tagged
// entrypoint="sdk-cli", not a terminal session), so this panel is the only
// place to see them. Polling, not SSE, per the same reasoning as
// fetchActiveTurns above — a new session can land at any time from a turn
// this browser tab didn't itself start.
export interface ClaudeCodeSessionSummary {
  session_id: string;
  title: string;
  prompt_preview: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  is_live: boolean;
}

// STEPS.md 149: live visibility + a kill switch for run_claude_code
// sessions, at the user's own direct request — the same standing "never
// let a background process run silently" rule as ActiveTurnBanner/
// useActiveTurns above. A lightweight, separate poll target (not the full
// ClaudeCodeSessionSummary list, which re-reads and re-parses every
// .jsonl on disk) for ActiveTurnBanner specifically.
export interface LiveClaudeCodeSession {
  session_id: string;
  prompt_preview: string;
  elapsed_seconds: number;
}

export async function fetchLiveClaudeCodeSessions(): Promise<LiveClaudeCodeSession[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/claude-code-sessions/live`);
  if (!response.ok) {
    throw new Error(
      `/claude-code-sessions/live failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { sessions: LiveClaudeCodeSession[] };
  return body.sessions;
}

export async function stopClaudeCodeSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/claude-code-sessions/${sessionId}/stop`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `/claude-code-sessions/${sessionId}/stop failed (${response.status}): ${await response.text()}`,
    );
  }
}

export type ClaudeCodeSessionBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; content: unknown; is_error: boolean };

export interface ClaudeCodeSessionTurn {
  role: string;
  blocks: ClaudeCodeSessionBlock[];
  timestamp: string | null;
}

export interface ClaudeCodeSessionDetail {
  session_id: string;
  title: string | null;
  turns: ClaudeCodeSessionTurn[];
}

export async function fetchClaudeCodeSessions(): Promise<ClaudeCodeSessionSummary[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/claude-code-sessions`);
  if (!response.ok) {
    throw new Error(`/claude-code-sessions failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { sessions: ClaudeCodeSessionSummary[] };
  return body.sessions;
}

export async function fetchClaudeCodeSession(sessionId: string): Promise<ClaudeCodeSessionDetail> {
  const response = await fetchWithRetry(`${API_BASE_URL}/claude-code-sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(
      `/claude-code-sessions/${sessionId} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<ClaudeCodeSessionDetail>;
}
