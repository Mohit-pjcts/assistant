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
  // ChatPanel groups them onto the turn's closing assistant bubble to match
  // what a live turn looks like (see ChatPanel's own history-loading code).
  // The History panel draws the same cards, but reads them from
  // /history/trace (STEPS.md 158) rather than from here: each tool event
  // there carries its own `surfaces`, shown inline under the call that
  // produced them.
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

// STEPS.md 158 — the full-fidelity History panel's data. `fetchHistory`
// above stays as it is (ChatPanel's reload path); everything below is a
// separate, read-only family of endpoints that carries what that one never
// did: every tool call with its arguments, everything a specialist did and
// said inside a delegation, and Stage's own run logs.
//
// The backend answers ONLY loopback clients on all of these (403 otherwise):
// they expose complete tool I/O and Stage's screen contents, and the
// backend binds 0.0.0.0 for the iPhone channel with no auth. A 403 is
// therefore an expected, explainable state (opening the dashboard from the
// phone), not a broken request — the panel shows a plain message for it
// instead of the generic error line.
export class HistoryForbiddenError extends Error {}

export type TraceToolStatus = "ok" | "error" | "interrupted" | "pending";

// One tool call — a supervisor-level one, or (nested under `children`) one a
// specialist made inside a delegation. Fields that older rows simply don't
// have (calls recorded before call tracing existed carry no timing and no
// children) are optional/nullable rather than assumed present.
export interface TraceToolEvent {
  kind: "tool";
  id: string;
  agent: string;
  name: string;
  // The call's arguments exactly as the model sent them — an object, except
  // for an invalid call (arguments the model got wrong), which arrives as
  // status "error" with the raw string it sent. Typed `unknown` because the
  // panel never reads into it — it only pretty-prints it.
  input: unknown;
  output: string | null;
  status: TraceToolStatus;
  // The exception text when the call raised, as opposed to returning an
  // error as its output. Null/absent otherwise.
  error?: string | null;
  // The tool name when this call is a delegation to a specialist (or Stage),
  // null for an ordinary call. The panel only needs "is it one".
  delegation?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  // Set on backstage/stage_status calls whose output names a Backstage run;
  // the id GET /stage/runs/{id} takes.
  stage_run_id?: string | null;
  // The A2UI card(s) this call's ToolMessage carried — render_ui's own, or a
  // delegation forwarding what its specialist rendered. Filled on top-level
  // events only: a specialist's cards are already forwarded onto its
  // delegation, so repeating them on its inner calls would draw each twice.
  surfaces?: A2UISurface[];
  // Every other key the call's ToolMessage carried in additional_kwargs
  // (e.g. a phone_action to open a URL), as plain data. {} when none.
  extras?: Record<string, unknown>;
  // A delegation's inner steps, in the order they happened: the specialist's
  // own tool calls and its own model turns. Empty/null on a call that isn't a
  // delegation and on delegations recorded before inner steps were traced.
  children?: TraceChild[] | null;
}

// Token counts for one model call, as the backend recorded them. The cache
// fields are only there when the provider reported them.
export interface TraceUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
}

// What the assistant said and thought in one model turn. At the top level it
// is just {text, thinking} (the supervisor's turns come out of the
// checkpoint, which keeps no agent, timing or usage). Inside a delegation's
// `children` it is the specialist's own turn and the optional fields below
// are filled in — the specialist's reasoning between its tool calls, which
// nothing else records.
export interface TraceAssistantEvent {
  kind: "assistant";
  text: string;
  thinking?: string | null;
  id?: string;
  agent?: string;
  model?: string | null;
  status?: "ok" | "error";
  error?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  usage?: TraceUsage | null;
}

export type TraceChild = TraceToolEvent | TraceAssistantEvent;

// A graph-inserted message the model saw but the user never typed: recalled
// facts, the compaction summary, prior specialist results handed forward.
export interface TraceContextEvent {
  kind: "context";
  label: string;
  content: string;
}

export type TraceEvent = TraceAssistantEvent | TraceContextEvent | TraceToolEvent;

// One genuine human message and everything the graph did in answer to it.
// `user` is null only for graph activity that precedes the first real
// message. `reply` is the last assistant text of the turn — it is also the
// last assistant entry in `events`, so the panel doesn't render it twice.
export interface TraceTurn {
  index: number;
  user: { content: string; synthetic?: boolean } | null;
  events: TraceEvent[];
  reply: string | null;
}

export interface HistoryTrace {
  thread_id: string;
  total_turns: number;
  turns: TraceTurn[];
}

// Omit threadId for the active thread (what the History tab wants — it
// remounts per thread, see App.tsx). `before` is a turn index: the page is
// the most recent `limit` turns older than it.
export async function fetchHistoryTrace(
  threadId?: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HistoryTrace> {
  const params = new URLSearchParams();
  if (threadId) params.set("thread_id", threadId);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before !== undefined) params.set("before", String(opts.before));
  const query = params.toString();
  return getHistoryJSON<HistoryTrace>(`/history/trace${query ? `?${query}` : ""}`);
}

// Stage (the sibling computer-use project) writes every run to
// stage/runs/<runId>/steps.jsonl. These types follow stage/src/contracts.ts
// (Task, RunTotals, LogLine) — kept loose where Stage itself is (a task's
// `cost` is {decisionsUsd, helperUsd}; a bare number is tolerated).
export interface StageTaskCost {
  decisionsUsd?: number;
  helperUsd?: number;
}

export interface StageTaskSummary {
  id: string;
  agent: string;
  app: string;
  goal: string;
  status: string;
  answer?: string | null;
  exception?: { code: string; reason: string } | null;
  seconds?: number | null;
  steps?: number | null;
  cost?: StageTaskCost | number | null;
  // Stage's own field is the list of reasons each LLM call was needed; a
  // plain count is tolerated.
  llmCalls?: string[] | number | null;
}

export interface StageRunTotals {
  tasks: number;
  done: number;
  failed: number;
  seconds: number;
  decisionsUsd: number;
  helperUsd: number;
  decisions: number;
  actions: number;
  medianDecideMs: number;
}

export interface StageRunSummary {
  run_id: string;
  started_at: string | null;
  ended_at: string | null;
  command: string;
  brain: string | null;
  // "hotkey" | "panel" | "api" ("api" = started by Oni). Null on runs
  // logged before Stage recorded where a run came from.
  source: string | null;
  client_run_id: string | null;
  status: "finished" | "unfinished";
  // Only a run that wrote its run_end line has totals.
  totals: StageRunTotals | null;
  tasks: StageTaskSummary[];
}

export interface StageRunsPage {
  runs: StageRunSummary[];
  // Pass back as `before` for the next page; null when there is none.
  next: string | null;
}

export async function fetchStageRuns(
  opts: { limit?: number; before?: string } = {},
): Promise<StageRunsPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  const query = params.toString();
  return getHistoryJSON<StageRunsPage>(`/stage/runs${query ? `?${query}` : ""}`);
}

export interface StageItem {
  i: number;
  id?: string;
  text?: string;
  role?: string;
  value?: string;
  state?: string;
}

export interface StageActionResult {
  ok: boolean;
  channel?: string;
  effect?: string;
  route?: string;
  error?: { code: string; detail: string };
  ms?: number;
  cli?: string;
}

export interface StageDecision {
  kind: string;
  item?: number;
  text?: string;
  kindConf?: number;
  itemConf?: number;
  gate?: number;
  backend?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  ms?: number;
}

export interface StageRunStartLine {
  type: "run_start";
  runId?: string;
  t?: string;
  command?: string;
  brain?: string;
  source?: string;
  clientRunId?: string;
  tasks?: StageTaskSummary[];
}

export interface StageStepLine {
  type: "step";
  runId?: string;
  t?: string;
  taskId?: string;
  agent?: string;
  step: number;
  items?: StageItem[];
  decision?: StageDecision;
  acted?: string;
  results?: StageActionResult[];
  ms?: { observe?: number; decide?: number; act?: number };
  truncated?: boolean;
}

export interface StageHelperLine {
  type: "helper";
  runId?: string;
  t?: string;
  taskId?: string;
  agent?: string;
  what: string;
  detail: string;
  costUsd?: number;
  ms?: number;
}

export interface StageTaskEndLine {
  type: "task_end";
  runId?: string;
  t?: string;
  task: StageTaskSummary;
}

export interface StageRunEndLine {
  type: "run_end";
  runId?: string;
  t?: string;
  totals?: StageRunTotals;
  tasks?: StageTaskSummary[];
}

// Every line of a run's steps.jsonl, parsed and in file order. The panel
// shows each one somewhere (header, a task's timeline, or an "other" group)
// so nothing Stage logged is unreachable.
export type StageLogLine =
  StageRunStartLine | StageStepLine | StageHelperLine | StageTaskEndLine | StageRunEndLine;

export interface StageRunDetail {
  run_id: string;
  summary: StageRunSummary;
  lines: StageLogLine[];
}

export async function fetchStageRun(runId: string): Promise<StageRunDetail> {
  return getHistoryJSON<StageRunDetail>(`/stage/runs/${encodeURIComponent(runId)}`);
}

// Onstage = Stage's "explain what's on my screen" mode; each question it
// answered is one line of explain-journal.jsonl. The endpoint passes the
// objects through raw, so unknown extra fields are expected.
export interface OnstageStep {
  say: string;
  shapes?: number;
}

export interface OnstageEntry {
  t: string;
  question: string;
  app?: string | null;
  window?: string | null;
  steps?: OnstageStep[];
  model?: string;
  usd?: number;
  ms?: number;
  captureMs?: number;
  controls?: number;
  [key: string]: unknown;
}

export async function fetchOnstageJournal(limit = 50): Promise<OnstageEntry[]> {
  const body = await getHistoryJSON<{ entries: OnstageEntry[] }>(`/stage/onstage?limit=${limit}`);
  return body.entries;
}

// Shared by the four fetchers above: all are startup-race-safe GETs
// (fetchWithRetry, same as fetchHistory — the panel mounts the moment its
// tab opens), and all share the 403 meaning described at
// HistoryForbiddenError.
async function getHistoryJSON<T>(path: string): Promise<T> {
  const response = await fetchWithRetry(`${API_BASE_URL}${path}`);
  const route = path.split("?")[0];
  if (response.status === 403) {
    throw new HistoryForbiddenError(`${route} is only served to the Mac it runs on (403)`);
  }
  if (!response.ok) {
    throw new Error(`${route} failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<T>;
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
  // fetchWithRetry, matching fetchThreads above (a real, live-reproduced
  // bug, 2026-09-24): ThreadSidebar.tsx calls both in one
  // `Promise.all([fetchThreads(), fetchProjects()])` at mount — the SAME
  // startup race this file's own module comment already documents for
  // fetchThreads/fetchHistory/fetchCost (the Tauri window can appear
  // before uvicorn is actually listening). Since fetchThreads already
  // retries past that window, a bare fetchProjects failing immediately on
  // the very first attempt was enough to fail the whole Promise.all and
  // permanently show "Load failed" in the sidebar for the rest of that
  // session, even though fetchThreads alone would have recovered fine —
  // caught testing a real packaged (non-dev) build, where a cold uvicorn
  // start (first-time torch/sentence-transformers imports) took long
  // enough to actually land inside this exact race.
  const response = await fetchWithRetry(`${API_BASE_URL}/projects`);
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

// Daily diary — user-authored entries stored as plain Notes in Oni's own
// Obsidian vault, under a Diary/ subfolder (assistant/diary_store.py). No
// confirmation gate on any of these, same "curating your own data"
// reasoning as the board tasks above; Oni itself never gets write/delete
// access to these (it can only read/search them), see diary_store.py's own
// module docstring.
export interface DiaryEntry {
  date: string; // ISO (YYYY-MM-DD)
  content: string;
  created_at: string;
  updated_at: string | null;
}

export async function fetchDiaryEntries(): Promise<DiaryEntry[]> {
  const response = await fetchWithRetry(`${API_BASE_URL}/diary`);
  if (!response.ok) {
    throw new Error(`/diary failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { entries: DiaryEntry[] };
  return body.entries;
}

// Upsert — saving again for a day that already has an entry replaces it
// whole (diary_store.py's own docstring). `date` defaults to today when
// omitted.
export async function saveDiaryEntry(content: string, date?: string): Promise<DiaryEntry> {
  return postJSON<DiaryEntry>("/diary", date ? { content, date } : { content });
}

export async function deleteDiaryEntry(date: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/diary/${date}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`DELETE /diary/${date} failed (${response.status}): ${await response.text()}`);
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

// Semester calendar (assistant/calendar_store.py): classes, tutorials and
// deadlines parsed from the vault's timetable / deadlines / tutorials notes
// on every request, so the notes stay the one source of truth. Loopback-only
// on the backend (server.py), like /history/trace.
export type CalendarEventKind = "class" | "tutorial" | "study" | "exam" | "deadline";

export interface CalendarEvent {
  id: string;
  date: string; // ISO start date
  end_date: string | null; // inclusive end of a multi-day window
  title: string;
  course: string;
  kind: CalendarEventKind;
  start_time: string | null; // "HH:MM", HKT
  end_time: string | null;
  location: string | null;
  weight: string | null;
  detail: string | null; // full item text when `title` is shortened
  note: string | null; // e.g. "time not stated"
  tbc: boolean; // a real session whose time/room is not in the vault
  source: string;
}

export interface CalendarData {
  events: CalendarEvent[];
  undated: { text: string; source: string }[];
  courses: { code: string; title: string }[];
  sources: string[];
  warnings: string[];
}

export async function fetchCalendar(): Promise<CalendarData> {
  const response = await fetchWithRetry(`${API_BASE_URL}/calendar`);
  if (!response.ok) {
    throw new Error(`/calendar failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<CalendarData>;
}

// Calendar edits (POST/PATCH/DELETE /calendar/events). Everything lands in the
// vault's "Calendar — Added Events" note (calendar_store.py); editing or
// deleting an event that comes from another note hides the original and stores
// the change there, so those notes are never rewritten.
export interface CalendarEventInput {
  title: string;
  date: string; // YYYY-MM-DD
  kind: CalendarEventKind;
  course?: string;
  start_time?: string | null; // HH:MM, HKT
  end_time?: string | null;
  end_date?: string | null;
  location?: string | null;
  weight?: string | null;
}

async function calendarEdit(
  method: "POST" | "PATCH" | "DELETE",
  eventId: string | null,
  body?: unknown,
): Promise<CalendarEvent> {
  const query = eventId === null ? "" : `?id=${encodeURIComponent(eventId)}`;
  const response = await fetch(`${API_BASE_URL}/calendar/events${query}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // A refused edit carries the store's own sentence in `detail` — show that.
    const detail = await response
      .json()
      .then((j: { detail?: unknown }) => (typeof j.detail === "string" ? j.detail : null))
      .catch(() => null);
    throw new Error(detail ?? `/calendar/events failed (${response.status})`);
  }
  return response.json() as Promise<CalendarEvent>;
}

export const addCalendarEvent = (event: CalendarEventInput) => calendarEdit("POST", null, event);

export const updateCalendarEvent = (eventId: string, changes: Partial<CalendarEventInput>) =>
  calendarEdit("PATCH", eventId, changes);

export const deleteCalendarEvent = (eventId: string) => calendarEdit("DELETE", eventId);
