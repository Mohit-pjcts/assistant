import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { InterruptGate } from "./InterruptGate";
import {
  fetchHistory,
  resumeChat,
  sendChat,
  stopChat,
  type ChatTurnResult,
  type HistoryMessage,
  type InterruptPayload,
} from "@/lib/api";

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
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef("");
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
  }, [messages, pendingInterrupt, streamingText]);

  function appendToken(chunk: string) {
    streamingTextRef.current += chunk;
    setStreamingText(streamingTextRef.current);
  }

  function resetStreamingText() {
    streamingTextRef.current = "";
    setStreamingText("");
  }

  function applyResult(result: ChatTurnResult) {
    resetStreamingText();
    if (result.type === "interrupt") {
      setPendingInterrupt(result.payload);
    } else {
      setMessages((prev) => [...prev, { role: "assistant", content: result.content }]);
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
      applyResult(await sendChat(text, appendToken));
    } catch (err) {
      handleStreamError(err);
    }
  }

  async function handleResume(approved: boolean) {
    setBusy(true);
    setPendingInterrupt(null);
    setError(null);
    try {
      applyResult(await resumeChat(approved, appendToken));
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
  const visibleMessages = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      m.content.trim().length > 0 &&
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
          {!historyLoaded && (
            <p className="text-sm text-muted-foreground">Loading conversation…</p>
          )}
          {visibleMessages.map((message, index) => (
            <div
              key={index}
              className={cn(
                "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                message.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted",
              )}
            >
              {message.content}
            </div>
          ))}
          {streamingText && (
            <div
              data-testid="streaming-bubble"
              className="max-w-[80%] self-start rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
            >
              {streamingText}
            </div>
          )}
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
