import type { TraceAssistantEvent } from "@/lib/api";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";
import { Disclosure } from "./Disclosure";
import { JsonBlock } from "./JsonBlock";
import { TextBlock } from "./TextBlock";
import { TONE_CLASSES, formatClock, formatDuration, formatTimestamp, formatUsage } from "./format";

// The two small renderers shared by the Conversation timeline and by a
// delegation's inner steps (ToolCallRow): what the assistant said and
// thought in one model turn, and the fallback for an event kind this panel
// doesn't know. Their own file so ToolCallRow and TraceTimeline can both use
// them without importing each other.

// Who ran a specialist's model turn, on what, for how long, at what token
// cost — the line a supervisor turn doesn't have (the checkpoint keeps no
// agent, timing or usage for it). Timestamps and the message id are in the
// hover text rather than the line, to keep it to one row.
function ModelTurnMeta({ event }: { event: TraceAssistantEvent }) {
  const duration = formatDuration(event.duration_ms);
  const usage = formatUsage(event.usage);
  const hover = [
    event.id ? `model turn ${event.id}` : null,
    event.started_at ? `started ${formatTimestamp(event.started_at)}` : null,
    event.ended_at ? `ended ${formatTimestamp(event.ended_at)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.7rem] text-muted-foreground"
      data-testid="trace-model-meta"
      title={hover || undefined}
    >
      <Chip className="border-accent-signal/40 text-accent-signal">{event.agent}</Chip>
      {event.model && <span>{event.model}</span>}
      {event.status === "error" && <Chip className={TONE_CLASSES.error}>error</Chip>}
      {event.started_at && <span>{formatClock(event.started_at)}</span>}
      {duration && <span>{duration}</span>}
      {usage && <span>{usage}</span>}
    </div>
  );
}

/**
 * One assistant turn: its text, with its thinking behind a toggle. A turn
 * with an `agent` is a specialist's own (a delegation's inner step) and gets
 * the meta line and a rail so it lines up with the tool rows beside it;
 * without one it's the supervisor's, labelled "Oni" like the chat.
 *
 * `showThinking` is the Conversation tab's "open every thinking block"
 * switch; the block can still be toggled on its own afterwards.
 */
export function AssistantEventView({
  event,
  showThinking,
}: {
  event: TraceAssistantEvent;
  showThinking: boolean;
}) {
  const specialist = Boolean(event.agent);
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        specialist && "border-l-2 border-accent-signal/30 py-1 pl-2.5",
      )}
      data-testid="trace-assistant"
    >
      {specialist ? (
        <ModelTurnMeta event={event} />
      ) : (
        <div className="panel-label text-[10px] text-accent-signal">Oni</div>
      )}
      {event.text && (
        <div className="whitespace-pre-wrap text-[14.5px] leading-[1.7]">{event.text}</div>
      )}
      {event.thinking && (
        <Disclosure label="thinking" forceOpen={showThinking}>
          <TextBlock text={event.thinking} copyLabel="thinking" />
        </Disclosure>
      )}
      {event.error && <TextBlock label="Error" text={event.error} />}
    </div>
  );
}

// An event kind the backend added after this panel was written. Shown whole
// instead of dropped or rendered blank — same rule as Stage's unknown lines.
export function UnknownEventView({ event }: { event: unknown }) {
  const kind =
    typeof event === "object" && event !== null && "kind" in event ? String(event.kind) : "unknown";
  return (
    <div className="flex flex-col gap-1" data-testid="trace-unknown">
      <span className="font-mono text-xs font-medium">{kind}</span>
      <Disclosure label="raw">
        <JsonBlock value={event} copyLabel={`raw ${kind} event`} />
      </Disclosure>
    </div>
  );
}
