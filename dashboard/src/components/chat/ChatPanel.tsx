import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ChatMessageList,
  ChatMessage,
  ChatMessageBubble,
  ChatComposer,
  ChatComposerDrawer,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text } from "@astryxdesign/core/Text";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { InterruptGate } from "./InterruptGate";
import { A2UIRenderer } from "./A2UIRenderer";
import {
  fetchHistory,
  fetchThreads,
  resumeChat,
  sendA2UIAction,
  sendChat,
  stopChat,
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

// PLAN.md Phase 19: how often to check whether ANOTHER client (chiefly
// voice I/O, which invokes the graph directly via its own ainvoke() —
// voice_daemon.py's module docstring — completely outside this panel's own
// SSE stream) has advanced this same thread. 4s is cheap (one /threads
// fetch, already used by the sidebar) and fast enough that voice output
// shows up without a manual reload, without polling aggressively enough to
// matter for cost/rate limits.
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
  // PLAN.md: set by App.tsx when the Home tab's landing composer (or one of
  // its prompt-suggestion cards) hands off a message — this panel sends it
  // through the exact same handleSend path a typed message would take, once
  // history has loaded. onConsumeInitialMessage clears the parent's copy so
  // it can't re-fire on a later re-render or a subsequent tab switch back to
  // Chat with nothing new to send.
  initialMessage?: string | null;
  onConsumeInitialMessage?: () => void;
}

export function ChatPanel({
  onActivity = () => {},
  initialMessage = null,
  onConsumeInitialMessage = () => {},
}: ChatPanelProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // File/photo upload feature: the only addition to this component's state
  // layer (see this file's own module docstring reasoning above) — every
  // other piece of ChatPanel's logic (streaming, interrupt, A2UI, the
  // external-update poll, stop handling) is completely unmodified.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
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

  // Fires once history has loaded, if the Home tab handed off a message.
  // Deliberately depends on `historyLoaded` only (not `initialMessage` or
  // `handleSend`, both of which are fresh closures every render) — this
  // must run exactly once per handed-off message, right when history
  // finishes loading, not on every re-render those closures would trigger.
  useEffect(() => {
    if (historyLoaded && initialMessage) {
      onConsumeInitialMessage();
      void handleSend(initialMessage);
    }
  }, [historyLoaded]);

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

  function applyResult(result: ChatTurnResult) {
    resetStreamingText();
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
      setError(err instanceof Error ? err.message : String(err));
    }
    stopRequestedRef.current = false;
    resetStreamingText();
    resetPendingA2ui();
    setBusy(false);
  }

  function handleFilesSelected(next: File | File[] | null) {
    const files = next == null ? [] : Array.isArray(next) ? next : [next];
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

  return (
    <div className="flex h-full flex-col gap-3">
      {/* min-h-0: flex items default to min-height:auto, so without this a
          growing message list expands past its allotted space instead of
          clipping and scrolling internally — pushes the whole page taller
          than the window and (combined with the auto-scroll-to-bottom
          effect below) leaves the header/tabs scrolled out of view above
          the fold. Found live in the real Tauri window, not in any test —
          jsdom doesn't do real layout, so this class of bug is invisible
          to vitest. ChatMessageList itself is a plain role="log" container
          (no built-in scroll — that's ChatLayout's job, not adopted here),
          so this wrapper div still owns scrolling exactly as ScrollArea
          used to. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
        <ChatMessageList density="balanced">
          {!historyLoaded && <Text color="secondary">Loading conversation…</Text>}
          {visibleMessages.map((message, index) => (
            <Fragment key={index}>
              {message.content.trim().length > 0 && (
                <ChatMessage sender={message.role === "user" ? "user" : "assistant"}>
                  <ChatMessageBubble variant={message.role === "user" ? "filled" : "ghost"}>
                    {message.content}
                  </ChatMessageBubble>
                </ChatMessage>
              )}
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
            <ChatMessage sender="assistant">
              <ChatMessageBubble variant="ghost" data-testid="streaming-bubble">
                {streamingText}
              </ChatMessageBubble>
            </ChatMessage>
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
        </ChatMessageList>
        <div ref={bottomRef} />
      </div>
      {error && (
        <Text size="sm" style={{ color: "var(--color-error)" }}>
          {error}
        </Text>
      )}
      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={() => void handleSend()}
        onStop={() => void handleStop()}
        isStopShown={busy}
        isDisabled={pendingInterrupt !== null}
        placeholder="Message the assistant…"
        input={
          // Astryx's default ChatComposerInput is a contentEditable div with
          // no `placeholder` attribute — swapped for a real TextArea here so
          // getByPlaceholderText(/message the assistant/i) in
          // ChatPanel.test.tsx keeps working unmodified. Trade-off, accepted
          // deliberately: this skips ChatComposerInput's token-chip/mention
          // affordances for now.
          <TextArea
            label="Message the assistant"
            isLabelHidden
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            placeholder="Message the assistant…"
            isDisabled={busy || pendingInterrupt !== null}
            rows={1}
          />
        }
        drawer={
          attachments.length > 0 ? (
            <ChatComposerDrawer count={attachments.length} label="Attachments">
              {attachments.map((a) => (
                <Thumbnail
                  key={a.id}
                  src={a.previewUrl}
                  alt={a.file.name}
                  label={a.file.name}
                  isLoading={a.status === "uploading"}
                  isDisabled={busy || pendingInterrupt !== null}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </ChatComposerDrawer>
          ) : undefined
        }
        footerActions={
          <FileInput
            label="Attach files"
            isLabelHidden
            isMultiple
            value={null}
            onChange={handleFilesSelected}
            accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json"
            maxSize={20_000_000}
            maxFiles={5}
            isDisabled={busy || pendingInterrupt !== null}
          />
        }
        sendButton={
          // Default ChatSendButton only enables on non-empty TEXT (canSend =
          // value.trim().length > 0) — doesn't know about attachments, which
          // would block sending a photo with no caption. Explicit isDisabled
          // override here mirrors handleSend's own guard exactly.
          <ChatSendButton
            isStopShown={busy}
            isDisabled={
              (!input.trim() && attachments.length === 0) ||
              pendingInterrupt !== null ||
              attachments.some((a) => a.status === "uploading")
            }
          />
        }
      />
    </div>
  );
}
