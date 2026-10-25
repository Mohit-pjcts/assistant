// Offline tests for the A-Z review branch: compiled-plan replay, batched sort decisions (chooseMany),
// and fast-lane visibility in the run log and totals.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, Brain, Choice, Decision, Facts, Helper, Item, LogLine, PlanStep, Task } from "../src/contracts.ts";
import { JevBrain } from "../src/decide.ts";
import { RunLogger } from "../src/logger.ts";
import { runTask } from "../src/loop.ts";
import { runCommand } from "../src/manager.ts";
import { SimCalc } from "./sim-calc.ts";

const newTask = (goal: string): Task => ({
  id: "t1", agent: "Mint-3", app: "Calculator", goal, brain: "jev", status: "queued", steps: 0, seconds: 0,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [],
});
const clicks = (...labels: string[]): PlanStep[] => labels.map((target) => ({ action: "click", target }));

class PlanFollower implements Brain {
  readonly kind = "jev" as const; readonly model = "replay"; calls = 0;
  async classify(f: Facts, items: Item[]): Promise<Decision> {
    this.calls++;
    const st = f.plan?.[f.planPos ?? 0];
    const it = st ? items.find((i) => i.text === st.target) : undefined;
    return { kind: st ? "click" : "done", item: it?.i, kindConf: 0.95, itemConf: 0.95, gate: 0.95, backend: "jev", model: "replay", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 };
  }
}
class Explosive implements Brain {
  readonly kind = "jev" as const; readonly model = "boom";
  async classify(): Promise<Decision> { throw new Error("classify must not be called during a compiled replay"); }
}
class CompiledHelper implements Helper {
  readonly lastSource = "compiled"; verifies = 0;
  constructor(private expected: string, private steps: PlanStep[]) {}
  async plan() { return { steps: this.steps, costUsd: 0, ms: 1 }; }
  async writeText() { return { text: "", costUsd: 0, ms: 1 }; }
  async verify(_g: string, screen: string[]) {
    this.verifies++;
    const ok = screen.includes(this.expected);
    return { achieved: ok, answer: ok ? this.expected : "", reason: ok ? "shown" : "not shown", costUsd: 0, ms: 1 };
  }
}
const ctxOf = (driver: SimCalc, brain: Brain, helper: Helper) => ({
  runId: "test", driver, brain, helper, signal: new AbortController().signal, win: driver.win, sleep: async () => {},
  log: new RunLogger("t-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
});

test("compiled replay: a compiled click plan runs without a classify call per step", async () => {
  const d = new SimCalc();
  const helper = new CompiledHelper("42", clicks("All Clear", "6", "Multiply", "7", "Equals"));
  const ctx = ctxOf(d, new Explosive(), helper);
  const task = await runTask(ctx, newTask("compute 6 times 7"));
  const lines = ctx.log.lines;
  expect(task.status).toBe("done");
  expect(task.answer).toBe("42");
  expect(d.calls).toEqual(["All Clear", "6", "Multiply", "7", "Equals"]);
  const replay = lines.filter((l) => l.type === "step" && l.decision.model === "compiled_replay");
  expect(replay.length).toBe(1);
  expect(task.counts.decisions).toBe(0); // no classifier decisions at all
});

test("compiled replay: a planned control that is not on screen declines the replay (normal loop decides)", async () => {
  const d = new SimCalc();
  const brain = new PlanFollower();
  const helper = new CompiledHelper("42", clicks("All Clear", "No Such Button", "6"));
  const task = await runTask(ctxOf(d, brain, helper), newTask("compute 6 times 7"));
  expect(brain.calls).toBeGreaterThan(0); // the classifier decided
  expect(d.calls).toEqual(["All Clear"]); // pressed through the normal path, never the phantom button
  expect(task.status).toBe("failed");
});

test("compiled replay: a failed press stops the replay; the rest is decided step by step", async () => {
  class FlakyCalc extends SimCalc {
    private failed = false;
    override async click(agent: any, w: any, token: string): Promise<ActionResult> {
      const b = (this as any).tokens.get(token);
      if (!this.failed && b === "Multiply") { this.failed = true; return { ok: false, channel: "ax", ms: 1, cli: "sim", error: { code: "other", detail: "simulated press failure" } }; }
      return super.click(agent, w, token);
    }
  }
  const d = new FlakyCalc();
  const brain = new PlanFollower();
  const helper = new CompiledHelper("42", clicks("All Clear", "6", "Multiply", "7", "Equals"));
  const task = await runTask(ctxOf(d, brain, helper), newTask("compute 6 times 7"));
  expect(task.status).toBe("done");
  expect(task.answer).toBe("42");
  expect(d.calls).toEqual(["All Clear", "6", "Multiply", "7", "Equals"]); // replay pressed 2, the loop the rest
  expect(brain.calls).toBeGreaterThan(0); // after the surprise, every step was decided
});

test("chooseMany: several questions in ONE systemOne call, one Choice per question, cost on the first", async () => {
  const seen: any[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    seen.push({ url: String(input), body: JSON.parse(init?.body ?? "{}") });
    const answers = Object.fromEntries(Object.keys(seen[0].body.questions).map((q: string, i: number) => [q, { choice: i === 0 ? "PDFs" : "leave_in_place", confidence: i === 0 ? 0.9 : 0.3, probabilities: {} }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 500 }, model: "jev-test" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const brain = new JevBrain("jev-test", { apiKey: "test", fetch: fakeFetch });
  const options = { PDFs: 'the "PDFs" folder', Images: 'the "Images" folder', leave_in_place: "Leave it" };
  const choices = await brain.chooseMany({ goal: "sort", files: ["a.pdf", "x"] }, [
    { question: 'Which folder for "a.pdf"?', options },
    { question: 'Which folder for "x"?', options },
  ]);
  expect(seen.length).toBe(1); // one round trip
  expect(Object.keys(seen[0].body.questions)).toEqual(["q0", "q1"]);
  expect(choices.map((c: Choice) => c.choice)).toEqual(["PDFs", "leave_in_place"]);
  expect(choices.map((c: Choice) => c.confidence)).toEqual([0.9, 0.3]); // per-question confidence kept
  expect(choices[0]!.costUsd).toBeGreaterThan(0);
  expect(choices[1]!.costUsd).toBe(0); // the one call's cost is reported once
});

test("fast-lane visibility: run_start logs the lane's state and reason; totals carry the lane counts", async () => {
  class LaneOffCalc extends SimCalc {
    readonly fast = { on: false, reason: "no Accessibility permission (sim)" };
    readonly counts = { fast: 0, cua: 5, fellBack: 2, uncertain: 0 };
  }
  const stopped = new AbortController();
  stopped.abort(); // only the run bookkeeping is under test
  const lines: LogLine[] = [];
  const res = await runCommand({
    runId: "t", command: "x", brainKind: "jev", makeBrain: () => { throw new Error("not reached"); }, helper: {} as Helper,
    driver: new LaneOffCalc(), log: { write: (l) => { lines.push(l); } }, signal: stopped.signal,
    plan: [{ app: "Calculator", goal: "compute 6 times 7" }],
  });
  const start = lines.find((l) => l.type === "run_start")!;
  expect(start).toMatchObject({ type: "run_start", fastLane: { on: false, reason: "no Accessibility permission (sim)" } });
  expect(res.totals.fastLane).toEqual({ fast: 0, cua: 5, fellBack: 2, uncertain: 0 });
});

test("fast-lane visibility: a driver without a lane logs and totals nothing new", async () => {
  const stopped = new AbortController();
  stopped.abort();
  const lines: LogLine[] = [];
  const res = await runCommand({
    runId: "t", command: "x", brainKind: "jev", makeBrain: () => { throw new Error("not reached"); }, helper: {} as Helper,
    driver: new SimCalc(), log: { write: (l) => { lines.push(l); } }, signal: stopped.signal,
    plan: [{ app: "Calculator", goal: "compute 6 times 7" }],
  });
  const start = lines.find((l) => l.type === "run_start")!;
  expect("fastLane" in start).toBe(false);
  expect(res.totals.fastLane).toBeUndefined();
});

test("sort_into: every file's folder is decided in ONE batched chooseMany call, with the per-file gate kept", async () => {
  const { mkdtempSync: mkdtemp, writeFileSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const root = mkdtemp(join(homedir(), "sort-test-")); // inside home, not hidden: safeRoot accepts it
  writeFileSync(join(root, "a.pdf"), "x");
  writeFileSync(join(root, "b.png"), "x");
  writeFileSync(join(root, "c.txt"), "x");
  const name = root.split("/").pop()!;
  const parts = root.split("/").filter(Boolean);
  const els = [
    { index: 0, depth: 0, role: "AXList", label: "path", actions: [] },
    ...["Macintosh HD", ...parts].map((v, k) => ({ index: k + 1, parent: 0, depth: 1, role: "AXStaticText", label: v, value: v, actions: [] })),
  ];
  const finder = {
    win: { pid: 1, windowId: 1, app: "Finder", title: name },
    async observe(agent: any, w: any) { return { agent, window: w, elements: els, truncated: false, ms: 1 }; },
    async ensureSession() {}, async endSession() {}, async listWindows() { return { windows: [] }; }, async listApps() { return []; },
    async launchApp() { return { pid: 1 }; },
    async click() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
    async typeText() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
    async pressKey() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
    async scroll() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
    async confirm() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
    async setValue() { return { ok: true, channel: "ax", ms: 1, cli: "sim" } as ActionResult; },
  } as any;
  class BatchBrain implements Brain {
    readonly kind = "jev" as const; readonly model = "batch";
    manyCalls: { question: string; options: Record<string, string> }[][] = [];
    async classify(): Promise<Decision> { throw new Error("not reached"); }
    async choose(): Promise<Choice> { throw new Error("sequential choose must not run when chooseMany exists"); }
    async chooseMany(_state: object, calls: { question: string; options: Record<string, string> }[]): Promise<Choice[]> {
      this.manyCalls.push(calls);
      return calls.map((c) => {
        const file = c.question.match(/"([^"]+)"/)![1]!;
        const choice = file.endsWith(".pdf") ? "PDFs" : file.endsWith(".png") ? "Images" : "leave_in_place";
        return { choice, confidence: file.endsWith(".txt") ? 0.3 : 0.9, costUsd: 0.00001, ms: 1 };
      });
    }
  }
  class SortHelper implements Helper {
    async plan(): Promise<{ steps: PlanStep[]; costUsd: number; ms: number }> { return { steps: [{ action: "sort_into", text: "PDFs, Images" }], costUsd: 0, ms: 1 }; }
    async writeText() { return { text: "", costUsd: 0, ms: 1 }; }
    async verify() { return { achieved: true, answer: "sorted", reason: "checked", costUsd: 0, ms: 1 }; }
  }
  const brain = new BatchBrain();
  const task: Task = {
    id: "t1", agent: "Mint-3", app: "Finder", goal: "organise these files by type", brain: "jev", status: "queued", steps: 0, seconds: 0,
    cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [],
  };
  const done = await runTask({
    runId: "test", driver: finder, brain, helper: new SortHelper(), signal: new AbortController().signal, win: finder.win, sleep: async () => {},
    log: new RunLogger("t-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
  }, task);
  expect(brain.manyCalls.length).toBe(1); // one round trip
  expect(brain.manyCalls[0]!.length).toBe(3); // all three files in it
  expect(done.status).toBe("done");
  expect(existsSync(join(root, "PDFs", "a.pdf"))).toBe(true);
  expect(existsSync(join(root, "Images", "b.png"))).toBe(true);
  expect(existsSync(join(root, "c.txt"))).toBe(true); // below the gate: left in place
  expect(done.answer).toContain("2 file(s) moved");
});
