import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { TraceChild, TraceToolEvent, TraceToolStatus } from "@/lib/api";
import { A2UIRenderer } from "@/components/chat/A2UIRenderer";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";
import { Disclosure } from "./Disclosure";
import { AssistantEventView, UnknownEventView } from "./EventViews";
import { JsonBlock } from "./JsonBlock";
import { RenderBoundary } from "./RenderBoundary";
import { StageRunLoader } from "./StageRunLoader";
import { TextBlock } from "./TextBlock";
import { TONE_CLASSES, formatDuration, formatTimestamp, previewText, type Tone } from "./format";

// One tool call. Collapsed it is a single line — who called what, how it
// went, how long it took, plus a one-line peek at the arguments so a run of
// similar calls can be told apart without opening each. Expanded it shows
// the call's complete Input and Output with copy buttons, the exception text
// if it raised, and anything else its result carried ("Attached data").
//
// Three things hang off a row rather than hiding inside its expansion,
// because they are usually the reason you're looking at it: the A2UI card(s)
// the call produced (as the old History panel showed them inline), a
// Backstage call's Stage run (what the agents did on screen), and a
// delegation's inner steps (what the specialist did and said). The Stage run
// and the inner steps are collapsible, but start visible.

const STATUS_STYLE: Record<TraceToolStatus, { rail: string; tone: Tone }> = {
  ok: { rail: "border-graphite/50", tone: "ok" },
  error: { rail: "border-rust", tone: "error" },
  interrupted: { rail: "border-signal", tone: "warn" },
  pending: { rail: "border-muted-foreground/40", tone: "muted" },
};

// A null output means different things by status, and saying the wrong one
// would mislead: a pending call may simply not have returned yet; an
// interrupted one is stopped at a confirmation gate.
function missingOutputLabel(status: TraceToolStatus): string {
  if (status === "pending") {
    return "(no result yet — still running, or the turn ended before it returned)";
  }
  if (status === "interrupted") return "(stopped at a confirmation gate — no result)";
  return "(no output recorded)";
}

// React keys for a delegation's inner steps: the step's own id (a tool call's
// id, a model turn's message id), so a row's open/closed state stays with the
// step it belongs to if the list is refreshed while the delegation is still
// running. The kind prefix keeps a tool call and a model turn apart, and the
// counter only matters if two steps ever share an id (or lack one).
function stepKeys(steps: TraceChild[]): string[] {
  const seen = new Map<string, number>();
  return steps.map((step, index) => {
    const base = `${step?.kind}:${step?.id ?? `at-${index}`}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}~${count}`;
  });
}

// The specialist the inner steps belong to: a delegation's own `delegation`
// names it; failing that, whoever its first step says it was.
function innerAgentName(event: TraceToolEvent, steps: TraceChild[]): string {
  if (typeof event.delegation === "string" && event.delegation) return event.delegation;
  return steps.find((step) => step?.agent)?.agent ?? event.name;
}

function InnerStep({ step, showThinking }: { step: TraceChild; showThinking: boolean }) {
  if (step.kind === "tool") return <ToolCallRow event={step} showThinking={showThinking} />;
  if (step.kind === "assistant") {
    return <AssistantEventView event={step} showThinking={showThinking} />;
  }
  return <UnknownEventView event={step} />;
}

export function ToolCallRow({
  event,
  showThinking = false,
}: {
  event: TraceToolEvent;
  // The Conversation tab's "open every thinking block" switch, passed down
  // so it reaches the specialist's own model turns inside a delegation too.
  showThinking?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const style = STATUS_STYLE[event.status] ?? STATUS_STYLE.pending;
  const duration = formatDuration(event.duration_ms);
  const steps = event.children ?? [];
  const surfaces = Array.isArray(event.surfaces) ? event.surfaces : [];
  const hasExtras =
    typeof event.extras === "object" &&
    event.extras !== null &&
    Object.keys(event.extras).length > 0;
  const isSupervisor = event.agent === "supervisor";
  const preview = useMemo(() => previewText(event.input), [event.input]);
  const keys = stepKeys(steps);

  return (
    <div
      className={cn("border-l-2 pl-2.5", style.rail)}
      data-testid="tool-row"
      data-status={event.status}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-left"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {/* The literal spaces between the parts are for the button's
            accessible name: flex `gap` spaces them on screen, but only real
            whitespace stops a screen reader running "supervisor",
            "research_agent", "delegation" and "ok" together into one word. */}
        <Chip
          className={cn("shrink-0", !isSupervisor && "border-accent-signal/40 text-accent-signal")}
        >
          {event.agent}
        </Chip>{" "}
        <span className="shrink-0 font-mono text-xs font-medium">{event.name}</span>{" "}
        {event.delegation && (
          <>
            <Chip className="shrink-0 bg-accent-signal/10 text-accent-signal">delegation</Chip>{" "}
          </>
        )}
        <Chip className={cn("shrink-0", TONE_CLASSES[style.tone])}>{event.status}</Chip>{" "}
        {duration && (
          <>
            <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
              {duration}
            </span>{" "}
          </>
        )}
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-muted-foreground/70">
            {preview}
          </span>
        )}
      </button>

      {open && (
        <div id={bodyId} className="flex flex-col gap-2 pb-2 pl-5">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.7rem] text-muted-foreground">
            <span>{`call ${event.id}`}</span>
            {event.started_at && <span>{`started ${formatTimestamp(event.started_at)}`}</span>}
            {event.ended_at && <span>{`ended ${formatTimestamp(event.ended_at)}`}</span>}
          </div>
          <JsonBlock label="Input" value={event.input} />
          {event.error && <TextBlock label="Error" text={event.error} />}
          <TextBlock
            label="Output"
            text={event.output ?? ""}
            emptyLabel={event.output == null ? missingOutputLabel(event.status) : "(empty output)"}
          />
          {hasExtras && <JsonBlock label="Attached data" value={event.extras} />}
        </div>
      )}

      {surfaces.length > 0 && (
        <div className="flex flex-col gap-2 pb-1 pl-5" data-testid="tool-surfaces">
          {surfaces.map((surface, index) => (
            <RenderBoundary key={`${surface?.surfaceId}-${index}`} what="this card">
              {/* No onAction, on purpose: a Button on a card from a past turn
                  would POST a brand-new user turn if it were wired up, which
                  isn't what "viewing history" means here — without it every
                  Button on the card is inert (A2UIRenderer's own docstring
                  gives the same reasoning for omitting it). */}
              <A2UIRenderer surface={surface} />
            </RenderBoundary>
          ))}
        </div>
      )}

      {event.stage_run_id && (
        <Disclosure
          className="pb-1 pl-5"
          // The literal space matters: flex gap spaces the two parts on
          // screen, but only a real space keeps "Stage run" and the id from
          // running together in the button's accessible name.
          label={
            <>
              <span className="panel-label">Stage run</span> <span>{event.stage_run_id}</span>
            </>
          }
          buttonClassName="gap-1.5"
        >
          <StageRunLoader runId={event.stage_run_id} />
        </Disclosure>
      )}

      {steps.length > 0 && (
        <Disclosure
          defaultOpen
          className="pb-1 pl-5"
          label={
            <span className="panel-label">
              {`inside ${innerAgentName(event, steps)} (${steps.length} step${steps.length === 1 ? "" : "s"})`}
            </span>
          }
        >
          <div className="flex flex-col gap-1 border-l border-graphite/30 pl-3">
            {steps.map((step, index) => (
              <RenderBoundary key={keys[index]} what="this step">
                <InnerStep step={step} showThinking={showThinking} />
              </RenderBoundary>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
