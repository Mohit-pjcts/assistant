import type {
  A2UISurface,
  OnstageEntry,
  StageLogLine,
  StageRunDetail,
  StageRunSummary,
  StageTaskSummary,
  TraceAssistantEvent,
  TraceToolEvent,
  TraceTurn,
} from "@/lib/api";

// Builders for the History panel's tests. Each returns a complete, valid
// object matching what the backend's contract describes, with just the
// fields a test cares about overridden — so a test reads as "a failed call"
// rather than as thirty lines of fixture.

export function tool(overrides: Partial<TraceToolEvent> = {}): TraceToolEvent {
  return {
    kind: "tool",
    id: "toolu_1",
    agent: "supervisor",
    name: "web_search",
    input: { query: "weather in Austin" },
    output: "72F and sunny",
    status: "ok",
    error: null,
    delegation: null,
    started_at: "2026-10-05T12:00:00+00:00",
    ended_at: "2026-10-05T12:00:01+00:00",
    duration_ms: 1234,
    stage_run_id: null,
    surfaces: [],
    extras: {},
    children: [],
    ...overrides,
  };
}

// A specialist's own model turn, the way it arrives inside a delegation's
// `children` (a supervisor turn has none of these extra fields).
export function modelTurn(overrides: Partial<TraceAssistantEvent> = {}): TraceAssistantEvent {
  return {
    kind: "assistant",
    id: "run-model-1",
    agent: "research_agent",
    model: "claude-sonnet-5",
    text: "I'll search for flights first.",
    thinking: null,
    status: "ok",
    error: null,
    started_at: "2026-10-05T12:00:00+00:00",
    ended_at: "2026-10-05T12:00:03+00:00",
    duration_ms: 3400,
    usage: {
      input_tokens: 1204,
      output_tokens: 310,
      cache_read_tokens: 900,
      cache_creation_tokens: 0,
    },
    ...overrides,
  };
}

// A minimal A2UI card: one Text node saying `text`.
export function surface(text = "hello from history", surfaceId = "history-surface-1"): A2UISurface {
  return {
    surfaceId,
    components: [{ id: "root", component: "Text", text }],
  };
}

export function turn(index: number, overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    index,
    user: { content: `question ${index}`, synthetic: false },
    events: [{ kind: "assistant", text: `answer ${index}`, thinking: null }],
    reply: `answer ${index}`,
    ...overrides,
  };
}

export const STAGE_RUN_ID = "run-jev-2026-10-04T19-18-41-018Z-p5q8";

const DONE_TASK: StageTaskSummary = {
  id: "t1",
  agent: "Mint-3",
  app: "Calculator",
  goal: "compute 2+2",
  status: "done",
  answer: "4",
  seconds: 8.2,
  steps: 2,
  cost: { decisionsUsd: 0, helperUsd: 0.00031 },
  llmCalls: ["plan"],
};

const FAILED_TASK: StageTaskSummary = {
  id: "t2",
  agent: "Red-7",
  app: "Notes",
  goal: "make a note called groceries",
  status: "failed",
  exception: { code: "stalled", reason: "nothing changed for 3 steps" },
  seconds: 5,
  steps: 3,
  cost: { decisionsUsd: 0.001, helperUsd: 0 },
  llmCalls: [],
};

export function stageSummary(overrides: Partial<StageRunSummary> = {}): StageRunSummary {
  return {
    run_id: STAGE_RUN_ID,
    started_at: "2026-10-04T19:18:41.018Z",
    ended_at: "2026-10-04T19:18:55.000Z",
    command: "compute 2+2 and make a note called groceries",
    brain: "jev",
    source: "api",
    client_run_id: "oni-run-7",
    status: "finished",
    totals: {
      tasks: 2,
      done: 1,
      failed: 1,
      seconds: 13.9,
      decisionsUsd: 0.001,
      helperUsd: 0.00031,
      decisions: 5,
      actions: 4,
      medianDecideMs: 6,
    },
    tasks: [DONE_TASK, FAILED_TASK],
    ...overrides,
  };
}

// A run with two tasks — one that finished, one that failed — and every
// kind of line Stage writes, in the order it writes them.
export function stageDetail(overrides: Partial<StageRunDetail> = {}): StageRunDetail {
  const summary = stageSummary();
  const lines: StageLogLine[] = [
    {
      type: "run_start",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:41.018Z",
      command: summary.command,
      brain: "jev",
      source: "api",
      clientRunId: "oni-run-7",
      tasks: summary.tasks,
    },
    {
      type: "helper",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:42.000Z",
      taskId: "t1",
      agent: "Mint-3",
      what: "plan",
      detail: "[llm] click '2' → click '+' → click '2' → click '='",
      costUsd: 0.00031,
      ms: 1203,
    },
    {
      type: "step",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:43.000Z",
      taskId: "t1",
      agent: "Mint-3",
      step: 1,
      items: [
        { i: 0, id: "a0", role: "AXButton", text: "2", state: "n/a" },
        { i: 1, id: "a1", role: "AXButton", text: "plus", state: "n/a" },
        { i: 2, id: "a2", role: "AXStaticText", text: "0", value: "0", state: "filled" },
      ],
      decision: {
        kind: "click",
        item: 1,
        kindConf: 0.97,
        itemConf: 0.88,
        gate: 0.8,
        backend: "jev",
        model: "jev-small",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        ms: 4,
      },
      acted: "click 'plus'",
      results: [
        {
          ok: true,
          channel: "ax",
          effect: "pressed",
          route: "background",
          ms: 31,
          cli: "cua click --token tok-plus",
        },
      ],
      ms: { observe: 120, decide: 4, act: 31 },
    },
    {
      type: "step",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:44.000Z",
      taskId: "t1",
      agent: "Mint-3",
      step: 2,
      items: [],
      decision: { kind: "done", kindConf: 1, gate: 0, backend: "code", model: "none" },
      acted: "nothing left to do",
      results: [],
      ms: { observe: 90, decide: 0, act: 0 },
    },
    {
      type: "task_end",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:45.000Z",
      task: DONE_TASK,
    },
    {
      type: "step",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:46.000Z",
      taskId: "t2",
      agent: "Red-7",
      step: 1,
      items: [{ i: 0, role: "AXButton", text: "New Note", state: "n/a" }],
      decision: { kind: "click", item: 0, kindConf: 0.4, gate: 0.8, backend: "llm", model: "m" },
      acted: "refused: low confidence",
      results: [
        {
          ok: false,
          channel: "ax",
          error: { code: "refused", detail: "element not actionable" },
        },
      ],
      ms: { observe: 100, decide: 700, act: 0 },
      truncated: true,
    },
    {
      type: "task_end",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:50.000Z",
      task: FAILED_TASK,
    },
    {
      type: "run_end",
      runId: STAGE_RUN_ID,
      t: "2026-10-04T19:18:55.000Z",
      totals: summary.totals ?? undefined,
      tasks: summary.tasks,
    },
  ];
  return { run_id: STAGE_RUN_ID, summary, lines, ...overrides };
}

export function onstageEntry(overrides: Partial<OnstageEntry> = {}): OnstageEntry {
  return {
    t: "2026-10-04T19:20:00.000Z",
    question: "what does this button do?",
    app: "Calendar",
    window: "Week of Oct 4",
    steps: [
      { say: "That's the Today button.", shapes: 1 },
      { say: "It jumps back to the current week.", shapes: 0 },
    ],
    model: "claude-haiku",
    usd: 0.00231,
    ms: 2100,
    captureMs: 340,
    controls: 41,
    ...overrides,
  };
}
