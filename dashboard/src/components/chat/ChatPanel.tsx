import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { InterruptGate } from "./InterruptGate";
import {
  fetchHistory,
  resumeChat,
  sendChat,
  type ChatTurnResult,
  type HistoryMessage,
  type InterruptPayload,
} from "@/lib/api";

// The dashboard's live chat panel — talks to assistant/server.py, which
// shares the CLI/voice daemon's actual conversation_memory.sqlite thread
// (STEPS.md 54/55). This is deliberately the SAME confirmation-gate loop
// main.py's `while "__interrupt__" in result` runs, just driven by button
// clicks instead of a blocking input() call (PLAN.md's Phase 9 step 3).
export function ChatPanel() {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
  }, [messages, pendingInterrupt]);

  function applyResult(result: ChatTurnResult) {
    if (result.type === "interrupt") {
      setPendingInterrupt(result.payload);
    } else {
      setMessages((prev) => [...prev, { role: "assistant", content: result.content }]);
    }
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
      applyResult(await sendChat(text));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleResume(approved: boolean) {
    setBusy(true);
    setPendingInterrupt(null);
    setError(null);
    try {
      applyResult(await resumeChat(approved));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
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
      <ScrollArea className="flex-1 rounded-md border p-4">
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
        <Button
          onClick={() => void handleSend()}
          disabled={busy || pendingInterrupt !== null || !input.trim()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
