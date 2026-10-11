import type { TraceContextEvent, TraceEvent, TraceTurn } from "@/lib/api";
import { Chip } from "@/components/ui/chip";
import { Disclosure } from "./Disclosure";
import { AssistantEventView, UnknownEventView } from "./EventViews";
import { RenderBoundary } from "./RenderBoundary";
import { TextBlock } from "./TextBlock";
import { ToolCallRow } from "./ToolCallRow";

// The Conversation tab's body: each turn is the user's message, then
// everything the graph did about it in the order it happened — the
// assistant's words, graph-inserted context, and every tool call (with a
// delegation's inner steps — the specialist's own calls and model turns —
// nested under it). Laid out like the chat itself
// (a small mono label over plain text, no bubbles) with the events set off by
// a left rule, so a turn reads as one exchange rather than a flat list.
//
// Presentational: the parent owns fetching, filtering and the two global
// toggles, which arrive here as `showThinking` / `showContext`.

interface TraceTimelineProps {
  turns: TraceTurn[];
  // Open every thinking block / every context block (each can still be
  // toggled on its own afterwards). Off = collapsed, which is the default.
  showThinking: boolean;
  showContext: boolean;
}

// React keys for events. An event's position in its turn can't be the key:
// under the Conversation tab's filter a turn shows only some of its events,
// so "the event at index 1" is a different event from one render to the next
// — and with an index key React would hand the expanded/collapsed state of
// one call to another. Only tool calls carry an id; rather than special-case
// them, every event object gets a number the first time it's seen. The
// objects are stable (they live in the tab's state), so the number is too.
const eventKeys = new WeakMap<TraceEvent, number>();
let nextEventKey = 0;

function eventKey(event: TraceEvent): number {
  let key = eventKeys.get(event);
  if (key === undefined) {
    key = nextEventKey++;
    eventKeys.set(event, key);
  }
  return key;
}

function ContextEventView({
  event,
  showContext,
}: {
  event: TraceContextEvent;
  showContext: boolean;
}) {
  return (
    <div data-testid="trace-context">
      <Disclosure
        forceOpen={showContext}
        buttonClassName="gap-1.5"
        label={
          <>
            <Chip>context</Chip> <span>{event.label}</span>
          </>
        }
      >
        <TextBlock text={event.content} copyLabel={`context ${event.label}`} />
      </Disclosure>
    </div>
  );
}

function EventView({
  event,
  showThinking,
  showContext,
}: {
  event: TraceEvent;
  showThinking: boolean;
  showContext: boolean;
}) {
  if (event.kind === "tool") return <ToolCallRow event={event} showThinking={showThinking} />;
  if (event.kind === "context") return <ContextEventView event={event} showContext={showContext} />;
  if (event.kind === "assistant") {
    return <AssistantEventView event={event} showThinking={showThinking} />;
  }
  return <UnknownEventView event={event} />;
}

function TurnView({
  turn,
  showThinking,
  showContext,
}: {
  turn: TraceTurn;
  showThinking: boolean;
  showContext: boolean;
}) {
  return (
    <section
      aria-label={`Turn ${turn.index + 1}`}
      className="flex flex-col gap-2.5"
      data-testid="trace-turn"
    >
      <div className="flex flex-col">
        <div className="panel-label mb-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
          <span>{turn.user ? "You" : "Before the first message"}</span>
          <span>{`· turn ${turn.index + 1}`}</span>
          {turn.user?.synthetic && <Chip>internal</Chip>}
        </div>
        {turn.user && (
          <div className="whitespace-pre-wrap text-[14.5px] leading-[1.7] text-muted-foreground">
            {turn.user.content}
          </div>
        )}
      </div>
      {turn.events.length > 0 && (
        <div className="flex flex-col gap-2 border-l border-graphite/20 pl-3">
          {turn.events.map((event) => (
            <EventView
              key={eventKey(event)}
              event={event}
              showThinking={showThinking}
              showContext={showContext}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function TraceTimeline({ turns, showThinking, showContext }: TraceTimelineProps) {
  return (
    <div className="flex flex-col gap-6" data-testid="trace-timeline">
      {turns.map((turn) => (
        <RenderBoundary key={turn.index} what={`turn ${turn.index + 1}`}>
          <TurnView turn={turn} showThinking={showThinking} showContext={showContext} />
        </RenderBoundary>
      ))}
    </div>
  );
}
