import { Fragment, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import {
  SparklesIcon,
  PencilSquareIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  LightBulbIcon,
} from "@heroicons/react/24/outline";
import { cn } from "@/lib/utils";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { OniGreetingCloud } from "./OniGreetingCloud";
import { InterruptGate } from "./InterruptGate";
import { A2UIRenderer } from "./A2UIRenderer";
import { Markdown } from "./Markdown";
import {
  fetchHistory,
  fetchThreads,
  resumeChat,
  sendA2UIAction,
  sendChat,
  stopChat,
  transcribeVoice,
  uploadFile,
  type A2UISurface,
  type AgentActivityEvent,
  type Attachment,
  type ChatTurnResult,
  type HistoryMessage,
  type InterruptPayload,
} from "@/lib/api";

// File/photo upload feature: one entry per attached file, from the moment
// it's picked until its /uploads call resolves (or fails). Uploads happen
// immediately on attach (not deferred to send time) so the composer shows
// live thumbnail/loading feedback; only `result` (once "done") gets sent
// as an Attachment on the next message.
interface PendingAttachment {
  id: string;
  file: File;
  status: "uploading" | "done" | "error";
  result?: Attachment;
  error?: string;
  previewUrl?: string;
}

// PLAN.md Phase 19: how often to check whether ANOTHER client (the phone
// channel, or an unattended automation — both invoke the graph directly via
// their own ainvoke(), completely outside this panel's own SSE stream) has
// advanced this same thread. In-app voice (this panel's own mic button) no
// longer needs this — it flows through this panel's own handleSend, same as
// typing, so it shows up live without any poll. 4s is cheap (one /threads
// fetch, already used by the sidebar) and fast enough that an external
// write shows up without a manual reload, without polling aggressively
// enough to matter for cost/rate limits.
const EXTERNAL_UPDATE_POLL_MS = 4000;

// Phase 17 (PLAN.md): a completed assistant turn may carry zero or more
// A2UI surfaces it rendered along the way. Attached directly onto the
// message object that lands in `messages` (rather than tracked in a
// separate index-keyed map) so there's no risk of desyncing an index
// against `messages`' own async/batched updates — the surfaces travel with
// their message as one atomic unit. As of Phase 18 (PLAN.md) this is no
// longer ephemeral: attachPersistedSurfaces below reconstructs the same
// shape from /history's own per-message `surfaces` field on reload, so a
// page reload now re-renders the same UI instead of only render_ui's text
// summary — see assistant/a2ui.py's module docstring for the persistence
// design this mirrors.
interface DisplayMessage extends HistoryMessage {
  a2uiSurfaces?: A2UISurface[];
}

// Phase 18 (PLAN.md): /history now returns each message's OWN persisted
// surfaces (HistoryMessage.surfaces) on whichever raw message row actually
// carried them — a ToolMessage, filtered out entirely by visibleMessages
// below, same as any other tool row. To make a reload look like the live
// turn that produced it (where every surface rendered during the WHOLE
// turn lands on the one final assistant bubble, regardless of which
// underlying tool call — render_ui directly, or a specialist forwarding
// its own — produced it), accumulate surfaces across each raw row and
// attach them to the next assistant-role message, mirroring applyResult's
// live pendingA2uiRef->message hand-off below exactly, just replayed over
// already-persisted history instead of a live stream.
function attachPersistedSurfaces(raw: HistoryMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  let pending: A2UISurface[] = [];
  for (const message of raw) {
    if (message.surfaces?.length) {
      pending = [...pending, ...message.surfaces];
    }
    if (message.role === "assistant") {
      result.push(pending.length > 0 ? { ...message, a2uiSurfaces: pending } : message);
      pending = [];
    } else {
      result.push(message);
    }
  }
  return result;
}

// PLAN.md: the landing view shown on a genuinely empty/new thread —
// greeting, category filter, prompt-suggestion cards — folded in from the
// now-deleted standalone HomePage.tsx/Home tab at the user's direct
// request ("i dont want separate tabs for both... landing page comes up
// when i start a new chat then i go into chat mode when i send a
// prompt"). Content moved verbatim; only the composer it sits above
// changed — it's now the SAME composer this panel already renders at the
// bottom (attach/mic/send included), not a separate one, which is what
// makes the mic available on the landing view for free.
type Category = "writing" | "coding" | "research" | "creative";

const CATEGORIES: Array<{ key: Category; label: string; icon: typeof SparklesIcon }> = [
  { key: "writing", label: "Writing", icon: PencilSquareIcon },
  { key: "coding", label: "Coding", icon: CodeBracketIcon },
  { key: "research", label: "Research", icon: MagnifyingGlassIcon },
  { key: "creative", label: "Creative", icon: LightBulbIcon },
];

const CATEGORY_SUGGESTIONS: Record<
  Category,
  Array<{ heading: string; body: string; prompt: string }>
> = {
  writing: [
    {
      heading: "Draft a professional email",
      body: "Compose a clear, polished email for any audience",
      prompt: "Help me draft a professional email",
    },
    {
      heading: "Improve my writing",
      body: "Enhance the clarity, tone, and flow of my text",
      prompt: "Review and improve the following text:",
    },
  ],
  coding: [
    {
      heading: "Debug my code",
      body: "Find and fix issues in a code snippet",
      prompt: "Help me debug the following code:",
    },
    {
      heading: "Explain this code",
      body: "Break down complex code into understandable pieces",
      prompt: "Explain what the following code does:",
    },
  ],
  research: [
    {
      heading: "Compare options",
      body: "Analyze pros and cons of different approaches",
      prompt: "Compare the pros and cons of",
    },
    {
      heading: "Find best practices",
      body: "Research standards and recommended approaches",
      prompt: "What are the best practices for",
    },
  ],
  creative: [
    {
      heading: "Brainstorm ideas",
      body: "Generate creative concepts for a project",
      prompt: "Brainstorm ideas for",
    },
    {
      heading: "Write a story",
      body: "Create an engaging narrative with characters",
      prompt: "Write a short story about",
    },
  ],
};

// The dashboard's live chat panel — talks to assistant/server.py, which
// shares the CLI/voice daemon's actual conversation_memory.sqlite thread
// (STEPS.md 54/55). This is deliberately the SAME confirmation-gate loop
// main.py's `while "__interrupt__" in result` runs, just driven by button
// clicks instead of a blocking input() call (PLAN.md's Phase 9 step 3).
//
// Phase 14 streaming (STEPS.md 71/72): sendChat/resumeChat now stream
// tokens as they arrive instead of resolving once with the whole answer.
// `streamingTextRef` mirrors `streamingText` state — kept as a ref too so
// `handleStreamError` can read the CURRENT accumulated text synchronously
// without going through a setState-updater callback (which React Strict
// Mode double-invokes; calling other setters from inside one is unsafe).
interface ChatPanelProps {
  // PLAN.md Phase 19: forwards every `activity` SSE frame (server.py's
  // supervisor/specialist tool-call relay) up to App.tsx's shared
  // useAgentActivity() hook, which lives in the PARENT rather than here —
  // that's what lets the right rail keep showing the latest activity even
  // across a tab switch that unmounts THIS component (Base UI's Tabs
  // unmounts inactive panels by default): the callback closure this passes
  // to sendChat/resumeChat is the parent's own stable setState, not
  // anything tied to this component's own mount lifecycle, so events
  // arriving after an unmount still land correctly.
  onActivity?: (event: AgentActivityEvent) => void;
  // Called once whenever a stream settles WITHOUT a clean terminal frame —
  // a user-requested stop, a backend error frame, or the connection simply
  // dying mid-turn (a backend restart, a network drop). Lets App.tsx's
  // shared useAgentActivity() state force-clear itself: without this, a
  // tool call that was "running" when the stream died stays marked running
  // forever, since nothing else in the event stream ever says otherwise
  // (a real, live-observed bug — a stale "coding_agent" node stuck
  // highlighted in the activity graph long after that turn had ended).
  onStreamEnded?: () => void;
  // Shown by the landing view (below) on a genuinely empty/new thread —
  // "Hi, {greetingName}". Not persisted anywhere server-side; a plain
  // display-only prop, same as it was on the old, now-folded-in HomePage.
  greetingName?: string;
  // 2026-08-08 follow-up (live-wallpaper hero, App.tsx): fires whenever
  // THIS panel's own `isNewChat` changes. App.tsx is what actually needs
  // to know — the full-viewport video and the rest of the app shell's
  // glass treatment live there, not in this component, since a
  // panel-local background can't span wider than this panel's own
  // column. Read-only from here, mirroring `onActiveThreadChange`'s own
  // write-only pattern elsewhere in this codebase.
  onLandingViewChange?: (active: boolean) => void;
}

export function ChatPanel({
  onActivity = () => {},
  onStreamEnded = () => {},
  greetingName = "Mohit",
  onLandingViewChange = () => {},
}: ChatPanelProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Landing-view category filter — only meaningful while isNewChat (below)
  // is true; harmless, inert state once the thread has real messages.
  const [category, setCategory] = useState<Category | null>(null);
  // File/photo upload feature: the only addition to this component's state
  // layer (see this file's own module docstring reasoning above) — every
  // other piece of ChatPanel's logic (streaming, interrupt, A2UI, the
  // external-update poll, stop handling) is completely unmodified.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // In-app voice I/O: browser-side mic capture, shared by the Tauri
  // dashboard and the phone/PWA path (originally built as the iPhone-access
  // feature — the mechanism doesn't care which client uploads to it). Used
  // to be hidden inside Tauri behind an `isTauri()` check because the Mac
  // ALSO had a separate always-on hotkey daemon (voice_daemon.py) at the
  // time; that daemon is retired (see its own removal note) specifically
  // because it wrote turns via its own isolated `ainvoke()` outside this
  // panel's SSE stream, which is exactly why a voice turn never showed up
  // without a manual refresh. Routing voice through this component's own
  // handleSend instead means a voice turn IS a normal live turn — same
  // streaming, same auto-scroll, no separate sync mechanism needed.
  // "recording" and "transcribing" are mutually exclusive UI states on the
  // same mic button: tap to start, tap again to stop-and-upload, button
  // stays disabled while the /voice/transcribe round trip is in flight.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  // Set right before handleSend() fires for a voice-originated turn, read
  // (and cleared) once that turn's final message lands in applyResult —
  // that's the signal to speak the reply aloud, mirroring how Claude/
  // ChatGPT's voice mode answers back rather than just transcribing input.
  // Never set for a typed turn, so ordinary text chat stays silent.
  const voiceTurnRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef("");
  // Surfaces rendered so far by the turn CURRENTLY in flight. Kept live
  // (not cleared) across an interrupt — a gate mid-turn shouldn't hide UI
  // the agent already rendered before hitting it — and only committed onto
  // the completed message (or dropped, on stop/error) once the turn
  // actually finishes. Ref mirrors state for the same synchronous-read
  // reason streamingTextRef does (React Strict Mode double-invokes
  // updaters; appendA2UI can fire many times per turn).
  const [pendingA2ui, setPendingA2ui] = useState<A2UISurface[]>([]);
  const pendingA2uiRef = useRef<A2UISurface[]>([]);
  // Set right before calling stopChat(); checked once the in-flight
  // sendChat/resumeChat promise settles so a user-requested stop renders
  // as "Stopped", not a generic connection error — the stream ending
  // abruptly IS what a stop looks like from here (api.ts's streamSSE
  // docstring), so this flag is what distinguishes intent from failure.
  const stopRequestedRef = useRef(false);
  // Baseline for the external-update poll below — the active thread's own
  // `last_active_at` (thread_store's touch_thread marker) as of the last
  // time THIS panel loaded history, whether that was the initial mount or
  // a poll-triggered refresh. `null` until the initial fetch resolves.
  const lastActiveAtRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHistory(), fetchThreads()])
      .then(([history, threadsResult]) => {
        if (cancelled) return;
        setMessages(attachPersistedSurfaces(history));
        const active = threadsResult.threads.find((t) => t.id === threadsResult.activeThreadId);
        lastActiveAtRef.current = active?.last_active_at ?? null;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // PLAN.md Phase 19: a live-refresh channel independent of whatever SSE
  // stream THIS panel itself has open — the only way it previously learned
  // about a turn was its own sendChat/resumeChat call, so a turn another
  // process ran (voice I/O's own ainvoke(), same thread) never showed up
  // here without a manual reload. Polls the same cheap /threads list the
  // sidebar already fetches; re-fetches /history only when the active
  // thread's last_active_at has moved past this panel's own baseline, and
  // only while idle (never mid-stream/mid-gate — this must not race a live
  // token stream or clobber a pending interrupt with a stale snapshot).
  useEffect(() => {
    const interval = setInterval(() => {
      if (busy || pendingInterrupt) return;
      fetchThreads()
        .then(({ threads, activeThreadId }) => {
          const active = threads.find((t) => t.id === activeThreadId);
          if (!active || active.last_active_at === lastActiveAtRef.current) return;
          lastActiveAtRef.current = active.last_active_at;
          return fetchHistory().then((history) => setMessages(attachPersistedSurfaces(history)));
        })
        .catch(() => {
          // Best-effort — a transient poll failure just retries next tick,
          // same posture as the rest of this panel's non-fatal paths.
        });
    }, EXTERNAL_UPDATE_POLL_MS);
    return () => clearInterval(interval);
  }, [busy, pendingInterrupt]);

  useEffect(() => {
    // jsdom (component tests) has no scrollIntoView implementation.
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, pendingInterrupt, streamingText, pendingA2ui]);

  function appendToken(chunk: string) {
    streamingTextRef.current += chunk;
    setStreamingText(streamingTextRef.current);
  }

  function resetStreamingText() {
    streamingTextRef.current = "";
    setStreamingText("");
  }

  function appendA2UI(surface: A2UISurface) {
    pendingA2uiRef.current = [...pendingA2uiRef.current, surface];
    setPendingA2ui(pendingA2uiRef.current);
  }

  function resetPendingA2ui() {
    pendingA2uiRef.current = [];
    setPendingA2ui([]);
  }

  // Speaks a completed reply aloud via the browser's own Web Speech API —
  // no backend TTS endpoint needed (unlike STT, which needs the real
  // mlx-whisper model server-side). `speechSynthesis` is undefined in
  // jsdom (ChatPanel.test.tsx), hence the guard rather than an assumed
  // global.
  function speakReply(text: string) {
    if (!text.trim() || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function applyResult(result: ChatTurnResult) {
    resetStreamingText();
    const wasVoiceTurn = voiceTurnRef.current;
    voiceTurnRef.current = false;
    if (result.type === "interrupt") {
      setPendingInterrupt(result.payload);
    } else {
      const surfaces = pendingA2uiRef.current;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.content,
          ...(surfaces.length > 0 ? { a2uiSurfaces: surfaces } : {}),
        },
      ]);
      resetPendingA2ui();
      // Deliberately not extended to the interrupt branch above: a gated
      // action's confirmation card is still approve/decline-by-click only
      // (voice_daemon.py's spoken-confirmation-answer path went with it,
      // not rebuilt here — free-text gated payloads were never
      // voice-approvable anyway per CLAUDE.md's security model, and the
      // simple ones are one click away regardless).
      if (wasVoiceTurn) speakReply(result.content);
    }
    setBusy(false);
  }

  function handleStreamError(err: unknown) {
    if (stopRequestedRef.current) {
      const partial = streamingTextRef.current;
      if (partial.trim()) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${partial}\n\n_Stopped._` },
        ]);
      }
    } else {
      // `setError` alone isn't enough: it's local to this component, gets
      // wiped by the very next handleSend/handleResume's own `setError(null)`,
      // and disappears entirely the moment this panel unmounts (a tab
      // switch away from Chat — Base UI's Tabs unmounts inactive panels).
      // A real incident showed exactly that gap: a turn's connection died
      // mid-tool-call, the transient error banner came and went unnoticed,
      // and there was no other record anywhere that the turn never
      // finished. Appending it to the transcript instead — same treatment
      // "_Stopped._" already gets above — makes it a durable part of the
      // conversation instead of a banner that can vanish before it's seen.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      const partial = streamingTextRef.current;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${partial ? `${partial}\n\n` : ""}_Connection to Oni was lost before this turn finished (${message}). It may not have completed — check Cost/History or try again._`,
        },
      ]);
    }
    stopRequestedRef.current = false;
    resetStreamingText();
    resetPendingA2ui();
    setBusy(false);
    onStreamEnded();
  }

  // PLAN.md Phase 29 Stage 2: Astryx's own FileInput validated maxSize/
  // maxFiles before ever calling onChange — replaced by a native
  // <input type="file">, so those two limits move here instead, same
  // values the old props passed (20MB, 5 attachments).
  const MAX_ATTACHMENT_BYTES = 20_000_000;
  const MAX_ATTACHMENTS = 5;

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    handleFilesSelected(selected);
  }

  function handleFilesSelected(next: File | File[] | null) {
    const requested = next == null ? [] : Array.isArray(next) ? next : [next];
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const files = requested.filter((f) => f.size <= MAX_ATTACHMENT_BYTES).slice(0, room);
    for (const file of files) {
      const id = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [...prev, { id, file, status: "uploading", previewUrl }]);
      uploadFile(file)
        .then((result) => {
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: "done", result } : a)),
          );
        })
        .catch((err: unknown) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, status: "error", error: err instanceof Error ? err.message : String(err) }
                : a,
            ),
          );
        });
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    const uploading = attachments.some((a) => a.status === "uploading");
    if ((!text && attachments.length === 0) || busy || pendingInterrupt || uploading) return;
    const resolvedAttachments = attachments
      .filter(
        (a): a is PendingAttachment & { result: Attachment } => a.status === "done" && !!a.result,
      )
      .map((a) => a.result);
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setAttachments([]);
    setBusy(true);
    try {
      applyResult(await sendChat(text, appendToken, appendA2UI, onActivity, resolvedAttachments));
    } catch (err) {
      handleStreamError(err);
    }
  }

  // iPhone-access feature. Tap-to-start/tap-to-stop rather than
  // press-and-hold — simpler and more reliable across mobile Safari's
  // touch-event handling than trying to distinguish a hold from a tap.
  // On stop, `mediaRecorder.onstop` (set in startRecording) does the
  // upload+transcribe+send; this function's own job is just starting or
  // stopping the recorder.
  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (busy || pendingInterrupt || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        // Stop the mic indicator/permission light immediately — no reason
        // to hold the stream open through the upload+transcribe round trip.
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
        if (blob.size === 0) return;
        setTranscribing(true);
        transcribeVoice(blob)
          .then((text) => {
            if (text.trim()) {
              voiceTurnRef.current = true;
              void handleSend(text);
            }
          })
          .catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setTranscribing(false));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Microphone access failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleResume(approved: boolean) {
    setBusy(true);
    setPendingInterrupt(null);
    setError(null);
    try {
      applyResult(await resumeChat(approved, appendToken, appendA2UI, onActivity));
    } catch (err) {
      handleStreamError(err);
    }
  }

  // Phase 17 Part B: a Button on a rendered A2UI surface reports back here
  // (A2UIRenderer's onAction, presentational only — it never fetches
  // itself). Joins the SAME applyResult flow handleSend/handleResume use:
  // the resulting turn can end in a message OR another interrupt, and
  // either way flows through the unmodified gate exactly as if the user
  // had typed the request instead of submitting a form.
  async function handleA2UIAction(
    surfaceId: string,
    name: string,
    context: Record<string, unknown>,
  ) {
    if (busy || pendingInterrupt) return;
    setError(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `Submitted "${name}": ${JSON.stringify(context)}` },
    ]);
    setBusy(true);
    try {
      applyResult(
        await sendA2UIAction(surfaceId, name, context, appendToken, appendA2UI, onActivity),
      );
    } catch (err) {
      handleStreamError(err);
    }
  }

  async function handleStop() {
    stopRequestedRef.current = true;
    try {
      await stopChat();
    } catch {
      // Best-effort — whether the stream actually ends is the real
      // signal, handled by handleStreamError once sendChat/resumeChat's
      // promise settles either way.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  // Tool/system messages, empty-content assistant turns (tool-call-only),
  // and synthetic graph-inserted "user" messages (routing bridges, recalled
  // facts, compaction summaries — server.py's `synthetic` flag, found live
  // via STEPS.md 57's real multi-hop check) are all real graph state but
  // not real dialogue — the dedicated History panel (PLAN.md Phase 9 step
  // 4) is where full transcript fidelity belongs, not this live chat view.
  // A turn that called render_ui and then stopped without further prose
  // has empty `.content` but a real surface to show — kept visible via the
  // a2uiSurfaces check rather than the content-length check alone, so the
  // rendered UI never silently disappears just because the model didn't
  // also add trailing text.
  const visibleMessages = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      (m.content.trim().length > 0 || (m.a2uiSurfaces?.length ?? 0) > 0) &&
      !m.synthetic,
  );

  // PLAN.md Phase 29 Stage 2: instrument/DESIGN.md §2's own "zero chrome"
  // chat — no bubble, no fill, no border. A message is just a mono sender
  // label (`.who`) above plain body text (`.body`), exact selectors/values
  // from instrument.html's own CSS (`.msg`/`.msg .who`/`.msg .body`).
  // ChatMessageList/ChatMessage/ChatMessageBubble (Astryx) are gone
  // entirely — replaced by plain divs carrying the same semantics
  // (`role="log"` on the scroll container, same as Astryx's own default).
  const sendDisabled =
    (!input.trim() && attachments.length === 0) ||
    pendingInterrupt !== null ||
    attachments.some((a) => a.status === "uploading");

  // A genuinely empty/new thread — nothing sent, nothing streaming, no
  // gate, no rendered surface. Shows the landing view (below) in place of
  // the empty message log; flips to false the instant a first message is
  // sent (handleSend appends the user's own message to `messages`
  // synchronously, before the network call even starts), which is what
  // makes "send a prompt -> go into chat mode" feel instant rather than
  // waiting on a reply.
  const isNewChat =
    historyLoaded &&
    visibleMessages.length === 0 &&
    !streamingText &&
    !pendingInterrupt &&
    pendingA2ui.length === 0;
  const suggestions = category ? CATEGORY_SUGGESTIONS[category] : null;

  // Reports `isNewChat` up to App.tsx (see `onLandingViewChange`'s own
  // docstring) — and reports `false` on unmount, so switching away from
  // Chat entirely (Base UI unmounts inactive tab panels) can't leave
  // App.tsx's own hero flag stuck true. Harmless no-op for any caller
  // that doesn't pass the prop (ChatPanel.test.tsx doesn't).
  useEffect(() => {
    onLandingViewChange(isNewChat);
    return () => onLandingViewChange(false);
    // Deliberately keyed on `isNewChat` alone, not `onLandingViewChange` —
    // the real caller (App.tsx) passes its own stable `setState` function,
    // and re-running this effect on every render (as a fresh inline
    // default `() => {}` would otherwise cause) is pure waste for no
    // behavioral difference.
  }, [isNewChat]);

  // PLAN.md: the user's own direct follow-up — the composer itself
  // stays centered (with the greeting/suggestions) on a new chat, and
  // only relocates to the bottom bar once real chat mode starts. Built
  // as one shared JSX value rendered from exactly one of two positions
  // below (never both) — `isNewChat` flipping moves it in the tree, so
  // React unmounts/remounts it at its new position; harmless here since
  // `input` lives in this component's own state (survives the remount)
  // and the remount always happens at the exact moment `handleSend` has
  // just cleared it anyway.
  const composerBar = (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-3xl border border-graphite/30 bg-card/90 px-3 pb-2 pt-3 shadow-sm backdrop-blur-md transition-colors",
        "focus-within:border-accent-signal/60",
      )}
    >
      <textarea
        aria-label="Message the assistant"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message the assistant…"
        disabled={busy || pendingInterrupt !== null}
        rows={1}
        className="max-h-48 min-h-9 w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-[1.5] outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <div className="flex items-center gap-1">
        <label
          aria-label="Attach files"
          className={cn(
            "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            (busy || pendingInterrupt !== null) && "pointer-events-none opacity-50",
          )}
        >
          <Paperclip className="size-4" />
          <input
            type="file"
            multiple
            className="hidden"
            accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json"
            onChange={handleFileInputChange}
            disabled={busy || pendingInterrupt !== null}
          />
        </label>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={recording ? "Stop recording" : "Record a voice message"}
          onClick={() => void toggleRecording()}
          disabled={transcribing || busy || pendingInterrupt !== null}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
            recording && "animate-pulse text-destructive",
          )}
        >
          {recording ? <Square className="size-4" /> : <Mic className="size-4" />}
        </button>
        {busy ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={() => void handleStop()}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-signal text-white hover:opacity-90"
          >
            <Square className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            onClick={() => void handleSend()}
            disabled={sendDisabled}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-signal text-white transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );

  const attachmentsPreview = attachments.length > 0 && (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-1.5 rounded-md border border-graphite/40 py-1 pl-1.5 pr-2 text-xs"
        >
          {a.previewUrl ? (
            <img src={a.previewUrl} alt={a.file.name} className="size-5 rounded object-cover" />
          ) : (
            <Paperclip className="size-3.5 text-muted-foreground" />
          )}
          <span className="max-w-[140px] truncate">{a.file.name}</span>
          {a.status === "uploading" && <span className="text-muted-foreground">…</span>}
          {a.status === "error" && <span className="text-destructive">failed</span>}
          <button
            type="button"
            aria-label={`Remove ${a.file.name}`}
            onClick={() => removeAttachment(a.id)}
            disabled={busy || pendingInterrupt !== null}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );

  const errorBanner = error && <p className="text-sm text-destructive">{error}</p>;

  if (isNewChat) {
    return (
      <div className="relative flex h-full flex-col overflow-y-auto px-3 py-4">
        {/* No hero layer here anymore — App.tsx now owns it (a fixed,
            full-viewport, full-WIDTH live-wallpaper video behind the
            entire app shell, not just this panel; see App.tsx's own
            `showHero`/`landingActive`). That's the direct fix for the
            user's own follow-up: a background confined to this panel's
            own ~800px column necessarily cropped the wide source shot
            down; App.tsx's version is `object-contain` against the whole
            window, so nothing is ever cropped off the sides. This
            component's only remaining job for that feature is reporting
            ITS OWN `isNewChat` up via `onLandingViewChange`, below. */}
        <div className="relative z-10 flex flex-col items-center pt-2">
          <OniGreetingCloud name={greetingName} />
        </div>

        {/* Keeps the greeting pinned near the top and the dock below
            pinned to the bottom, with the middle left genuinely empty —
            exactly the artwork's own negative space, not filled with
            anything just because room happened to be there. */}
        <div className="relative z-10 min-h-8 flex-1" />

        {/* The "dock": category filter, suggestions, composer — the whole
            "start chatting" cluster, bottom-most edge first. Only dark
            mode gets the floating glass treatment (bg/blur/border/shadow);
            light mode has no hero image behind it, so it stays exactly as
            plain as it was before this change. */}
        <div className="relative z-10 mx-auto flex w-full max-w-[720px] flex-col gap-3 pb-1">
          <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Category">
            {CATEGORIES.map((cat) => {
              const active = category === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategory(active ? null : cat.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "border-accent-signal bg-accent-signal/10 text-accent-signal"
                      : "border-graphite/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <cat.icon className="size-4" />
                  {cat.label}
                </button>
              );
            })}
          </div>
          {suggestions && (
            // A horizontal-scrolling row rather than the old 2-col grid —
            // the grid's own height used to eat into the vertical middle
            // this redesign now deliberately keeps clear for the artwork.
            <div className="flex gap-3 overflow-x-auto pb-1">
              {suggestions.map((suggestion) => (
                <InstrumentCard
                  key={suggestion.heading}
                  className="w-[200px] shrink-0 cursor-pointer p-3"
                  onClick={() => void handleSend(suggestion.prompt)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex flex-col gap-0.5">
                    <h4 className="font-heading text-sm font-semibold">{suggestion.heading}</h4>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{suggestion.body}</p>
                  </div>
                </InstrumentCard>
              ))}
            </div>
          )}
          {errorBanner}
          {attachmentsPreview}
          {composerBar}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* min-h-0: flex items default to min-height:auto, so without this a
          growing message list expands past its allotted space instead of
          clipping and scrolling internally — pushes the whole page taller
          than the window and (combined with the auto-scroll-to-bottom
          effect below) leaves the header/tabs scrolled out of view above
          the fold. Found live in the real Tauri window, not in any test —
          jsdom doesn't do real layout, so this class of bug is invisible
          to vitest. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" role="log">
        <div className="flex w-full flex-col gap-7">
          {!historyLoaded && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
          {visibleMessages.map((message, index) => (
            <Fragment key={index}>
              {message.content.trim().length > 0 &&
                (message.role === "user" ? (
                  // Claude-app style: the user's turn is a soft, right-aligned
                  // pill; the assistant's turn below has no container at all.
                  <div
                    data-testid="user-message"
                    className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-[1.6]"
                  >
                    {message.content}
                  </div>
                ) : (
                  <Markdown className="text-[15.5px] leading-[1.75]">{message.content}</Markdown>
                ))}
              {message.a2uiSurfaces?.map((surface, surfaceIndex) => (
                <A2UIRenderer
                  key={surfaceIndex}
                  surface={surface}
                  onAction={handleA2UIAction}
                  disabled={busy || pendingInterrupt !== null}
                />
              ))}
            </Fragment>
          ))}
          {streamingText && (
            <div data-testid="streaming-bubble">
              <Markdown className="text-[15.5px] leading-[1.75]">{streamingText}</Markdown>
            </div>
          )}
          {pendingA2ui.map((surface, surfaceIndex) => (
            <A2UIRenderer
              key={surfaceIndex}
              surface={surface}
              onAction={handleA2UIAction}
              disabled={busy || pendingInterrupt !== null}
            />
          ))}
          {pendingInterrupt && (
            <InterruptGate
              payload={pendingInterrupt}
              onApprove={() => void handleResume(true)}
              onDecline={() => void handleResume(false)}
              disabled={busy}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="flex w-full flex-col gap-2 px-4 pb-4">
        {errorBanner}
        {attachmentsPreview}
        {composerBar}
      </div>
    </div>
  );
}
