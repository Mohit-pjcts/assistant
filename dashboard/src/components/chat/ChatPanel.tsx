import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { InterruptGate } from "./InterruptGate";
import { A2UIRenderer } from "./A2UIRenderer";
import {
  fetchHistory,
  resumeChat,
  sendA2UIAction,
  sendChat,
  stopChat,
  type A2UISurface,
  type ChatTurnResult,
  type HistoryMessage,
  type InterruptPayload,
} from "@/lib/api";

// Phase 17 (PLAN.md): a completed assistant turn may carry zero or more
// A2UI surfaces it rendered along the way. Attached directly onto the
// message object that lands in `messages` (rather than tracked in a
// separate index-keyed map) so there's no risk of desyncing an index
// against `messages`' own async/batched updates — the surfaces travel with
// their message as one atomic unit. Ephemeral by design: never round-trips
// through fetchHistory/`/history` (assistant/a2ui.py's module docstring),
// so a page reload loses the rendered surface and keeps only render_ui's
// persisted text summary, same as every other message.
interface DisplayMessage extends HistoryMessage {
  a2uiSurfaces?: A2UISurface[];
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
export function ChatPanel() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    fetchHistory()
      .then((history) => {
        if (!cancelled) setMessages(history);
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

  async function handleSend() {
    const text = input.trim();
    if (!text || busy || pendingInterrupt) return;
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    try {
      applyResult(await sendChat(text, appendToken, appendA2UI));
    } catch (err) {
      handleStreamError(err);
    }
  }

  async function handleResume(approved: boolean) {
    setBusy(true);
    setPendingInterrupt(null);
    setError(null);
    try {
      applyResult(await resumeChat(approved, appendToken, appendA2UI));
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
      applyResult(await sendA2UIAction(surfaceId, name, context, appendToken, appendA2UI));
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
          to vitest. */}
      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-3">
          {!historyLoaded && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
          {visibleMessages.map((message, index) => (
            <Fragment key={index}>
              {message.content.trim().length > 0 && (
                <div
                  className={cn(
                    "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                    message.role === "user"
                      ? "self-end bg-primary text-primary-foreground"
                      : "self-start bg-muted",
                  )}
                >
                  {message.content}
                </div>
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
            <div
              data-testid="streaming-bubble"
              className="max-w-[80%] self-start rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
            >
              {streamingText}
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
      </ScrollArea>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the assistant…"
          disabled={busy || pendingInterrupt !== null}
          className="min-h-[44px] flex-1 resize-none"
        />
        {busy ? (
          <Button variant="outline" onClick={() => void handleStop()} className="gap-1.5">
            <Square className="size-3.5 fill-current" />
            Stop
          </Button>
        ) : (
          <Button
            onClick={() => void handleSend()}
            disabled={busy || pendingInterrupt !== null || !input.trim()}
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
