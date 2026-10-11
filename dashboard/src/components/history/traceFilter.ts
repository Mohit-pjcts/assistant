import type { TraceEvent, TraceTurn } from "@/lib/api";

// The Conversation tab's text filter: a case-insensitive substring match over
// everything a turn holds — what was said, and for tool calls the name,
// agent, status, arguments, output, error, attached data and (recursively)
// every inner step, which includes what a specialist said and thought
// between its calls. Matching text that happens to be collapsed on screen is
// deliberate: the point of a filter is "find the turn where X came up", and
// X is most often a path or an address that only appears inside a call's
// arguments. A call's A2UI cards are left out: their text is mostly the same
// as the call's own output, and their component trees would match every
// query that names a field type ("text", "button").
//
// Each event's lowercased searchable text is computed once and cached
// against the event object (events are stable objects held in state), so a
// keystroke costs one `includes` per event instead of re-serializing and
// re-lowercasing every 50 KB tool output in the loaded history.
const haystacks = new WeakMap<TraceEvent, string>();

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function hasKeys(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function eventText(event: TraceEvent): string {
  const cached = haystacks.get(event);
  if (cached !== undefined) return cached;

  let parts: string[];
  if (event.kind === "assistant") {
    // agent/model/error are only set on a specialist's own model turn.
    parts = [
      event.text,
      event.thinking ?? "",
      event.agent ?? "",
      event.model ?? "",
      event.error ?? "",
    ];
  } else if (event.kind === "context") {
    parts = [event.label, event.content];
  } else {
    parts = [
      event.agent,
      event.name,
      event.status,
      typeof event.delegation === "string" ? event.delegation : "",
      event.stage_run_id ?? "",
      asText(event.input),
      event.output ?? "",
      event.error ?? "",
      hasKeys(event.extras) ? asText(event.extras) : "",
      ...(event.children ?? []).map(eventText),
    ];
  }
  const text = parts.join("\n").toLowerCase();
  haystacks.set(event, text);
  return text;
}

export function eventMatches(event: TraceEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || eventText(event).includes(needle);
}

/**
 * Narrows turns to the ones that match. A turn whose user message matches
 * is kept whole (the question is the anchor, so the whole exchange is
 * relevant); otherwise only its matching events are kept, so one call in a
 * 40-call turn isn't buried among the other 39. A matching tool call keeps
 * all of its inner calls — a delegation matched through one of them still
 * reads as a delegation.
 */
export function filterTurns(turns: TraceTurn[], query: string): TraceTurn[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return turns;

  const kept: TraceTurn[] = [];
  for (const turn of turns) {
    if (turn.user && turn.user.content.toLowerCase().includes(needle)) {
      kept.push(turn);
      continue;
    }
    const events = turn.events.filter((event) => eventText(event).includes(needle));
    if (events.length > 0) kept.push({ ...turn, events });
  }
  return kept;
}
