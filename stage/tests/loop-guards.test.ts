// The loop's guards, offline: every click is guarded, Stop stops the next action, Enter can't fire a risky default,
// own text is the exact value the agent left, filled fields aren't blanked, and plans/counters behave.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, AxElement, Brain, Decision, Driver, Facts, Helper, Item, Observation, PlanStep, Task, WindowRef } from "../src/contracts.ts";
import { RunLogger } from "../src/logger.ts";
import { runTask } from "../src/loop.ts";
import { SimCalc } from "./sim-calc.ts";

const OK: ActionResult = { ok: true, channel: "ax", ms: 1, cli: "fake" };
const newTask = (goal: string, app = "Notes"): Task => ({
  id: "t1", agent: "Mint-3", app, goal, brain: "jev", status: "queued", steps: 0, seconds: 0,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [],
});
const ctxOf = (driver: Driver & { win: WindowRef }, brain: Brain, helper: Helper, ac = new AbortController(), maxSteps?: number) => ({
  runId: "test", driver, brain, helper, signal: ac.signal, win: driver.win, sleep: async () => {}, maxSteps,
  log: new RunLogger("t-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
});
const decide = (kind: Decision["kind"], item?: number, text?: string): Decision =>
  ({ kind, item, text, kindConf: 1, itemConf: 1, gate: 1, backend: "jev", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 });

/** a scripted brain: picks by label (or a function of the screen) */
class Scripted implements Brain {
  readonly kind = "jev" as const; readonly model = "x"; calls = 0;
  constructor(private pick: (items: Item[], n: number) => Decision) {}
  async classify(_f: Facts, items: Item[]) { return this.pick(items, this.calls++); }
}
const by = (items: Item[], text: string) => items.find((i) => i.text === text)?.i;

class StubHelper implements Helper {
  canEscalate = false; plans = 0; verifies = 0;
  constructor(private steps: PlanStep[] = [], public opts: { source?: string; achieved?: (screen: string[]) => boolean; write?: () => string; failVerifyOnce?: boolean } = {}) {}
  async plan() { this.plans++; return { steps: this.steps, costUsd: 0, ms: 0, source: this.opts.source ?? "none" }; }
  async writeText() { return { text: this.opts.write?.() ?? "", costUsd: 0, ms: 0 }; }
  async verify(_g: string, screen: string[]) {
    this.verifies++;
    if (this.opts.failVerifyOnce && this.verifies === 1) throw new Error("jev blip");
    const ok = this.opts.achieved?.(screen) ?? false;
    return { achieved: ok, answer: ok ? "done" : "", reason: ok ? "shown" : "not shown", costUsd: 0, ms: 0 };
  }
}

/** a one-window app made of plain elements; actions are recorded */
class FakeApp implements Driver {
  readonly win: WindowRef = { pid: 1, windowId: 1, app: "Notes", title: "Notes" };
  clicks: string[] = []; typed: string[] = []; keys: string[] = []; sets: [string, string][] = [];
  tick = 0; ticking = false;
  constructor(public els: AxElement[]) {}
  static el(index: number, role: string, label: string, extra: Partial<AxElement> = {}): AxElement {
    return { index, parent: index === 0 ? undefined : 0, depth: index === 0 ? 0 : 1, role, label, token: index === 0 ? undefined : `t${index}`, actions: [], ...extra };
  }
  private byToken(t: string) { return this.els.find((e) => e.token === t); }
  async ensureSession() {}
  async endSession() {}
  async listApps() { return []; }
  async listWindows() { return { windows: [] }; }
  async launchApp() { return { pid: 1 }; }
  async observe(agent: string, w: WindowRef): Promise<Observation> {
    const extra = this.ticking ? [FakeApp.el(99, "AXStaticText", `clock ${this.tick++}`)] : [];
    return { agent, window: w, truncated: false, ms: 1, elements: [...this.els, ...extra].map((e) => ({ ...e })) };
  }
  async click(_a: string, _w: WindowRef, t: string) { this.clicks.push(this.byToken(t)?.label ?? t); return OK; }
  async typeText(_a: string, _w: WindowRef, t: string, text: string) {
    this.typed.push(text);
    const e = this.byToken(t);
    if (e) e.value = (e.role === "AXTextArea" ? e.value ?? "" : e.value ?? "") + text;
    return OK;
  }
  async pressKey(_a: string, _w: WindowRef, k: string) { this.keys.push(k); return OK; }
  async scroll() { return OK; }
  async confirm(_a: string, _w: WindowRef, t: string) { this.keys.push(`confirm ${t}`); return OK; }
  async setValue(_a: string, _w: WindowRef, t: string, v: string) { this.sets.push([t, v]); const e = this.byToken(t); if (e) e.value = v; return OK; }
}
const { el } = FakeApp;

test("a click the window talks the agent into is blocked: 'Delete All' when the goal deletes one draft", async () => {
  const app = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXButton", "Delete All"), el(2, "AXButton", "Delete")]);
  const brain = new Scripted((items) => decide("click", by(items, "Delete All")));
  const task = await runTask(ctxOf(app, brain, new StubHelper()), newTask("delete the draft"));
  expect(app.clicks).toEqual([]);
  expect(task.exception?.code).toBe("stalled");
});

test("Stop is checked after the classifier and after the writer, right before acting", async () => {
  const app2 = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXButton", "New Note")]);
  const ac = new AbortController();
  const brain = new Scripted((items) => { ac.abort(); return decide("click", by(items, "New Note")); }); // Stop while deciding
  const t2 = await runTask(ctxOf(app2, brain, new StubHelper(), ac), newTask("make a new note"));
  expect(app2.clicks).toEqual([]);
  expect(t2.exception?.code).toBe("stopped");
  // the writer takes seconds: Stop during it means nothing is typed
  const ac3 = new AbortController();
  const app3 = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXTextArea", "Note", { frame: { x: 10, y: 10, w: 300, h: 300 } })]);
  const helper = new StubHelper([], { write: () => { ac3.abort(); return "a packing list"; } });
  const t3 = await runTask(ctxOf(app3, new Scripted((items) => decide("type_text", by(items, "Note"))), helper, ac3), newTask("write a packing list"));
  expect(app3.typed).toEqual([]);
  expect(t3.exception?.code).toBe("stopped");
});

test("Enter can't press a dialog's risky default button", async () => {
  const app = new FakeApp([el(0, "AXWindow", "Finder"), el(1, "AXSheet", "", { token: undefined }), el(2, "AXButton", "Replace", { parent: 1 }), el(3, "AXButton", "Stop", { parent: 1 }), el(4, "AXTextField", "Save As", { value: "notes.txt" })]);
  const task = await runTask(ctxOf(app, new Scripted(() => decide("press_enter")), new StubHelper()), newTask("save the file as notes.txt", "Finder"));
  expect(app.keys).toEqual([]);
  expect(task.exception?.code).toBe("stalled");
});

test("own text = the exact value the agent left: a different note that also says 'milk' is not the agent's", async () => {
  const frame = { x: 10, y: 10, w: 300, h: 300 };
  const app = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXTextArea", "Note", { frame })]);
  const observe = app.observe.bind(app);
  let reads = 0;
  // read 1: the step; read 2: the read-back after typing "milk"; read 3: the window now shows the user's own note
  app.observe = async (a, w) => { if (++reads === 3) app.els[1]!.value = "Buy milk tomorrow (Mum's note)"; return observe(a, w); };
  const brain = new Scripted((items, n) => decide("type_text", by(items, "Note"), n === 0 ? "milk" : "eggs"));
  await runTask(ctxOf(app, brain, new StubHelper(), undefined, 4), newTask("write milk and eggs"));
  expect(app.typed).toEqual(["milk"]);
});

test("a filled form field is not blanked; a search field is replaced", async () => {
  const form = new FakeApp([el(0, "AXWindow", "Form"), el(1, "AXTextField", "Email", { value: "me@example.com", frame: { x: 0, y: 0, w: 200, h: 20 } }), el(2, "AXButton", "Clear")]);
  await runTask(ctxOf(form, new Scripted((items) => decide("type_text", by(items, "Email"), "hello")), new StubHelper(), undefined, 3), newTask("type hello"));
  expect(form.sets).toEqual([]);
  expect(form.typed).toEqual([]);
  expect(form.clicks).toEqual([]);
  const search = new FakeApp([el(0, "AXWindow", "Mail"), el(1, "AXSearchField", "Search", { value: "old query", frame: { x: 0, y: 0, w: 200, h: 20 } })]);
  await runTask(ctxOf(search, new Scripted((items) => decide("type_text", by(items, "Search"), "invoice")), new StubHelper([], { achieved: () => true }), undefined, 3), newTask("search my mail for invoice"));
  // emptied, then the term TYPED (a search box filters on key presses, not on a value set through accessibility) and
  // read back: it landed whole, so nothing is set over it
  expect(search.sets[0]).toEqual(["t1", ""]);
  expect(search.typed[0]).toBe("invoice");
  expect(search.sets).not.toContainEqual(["t1", "invoice"]);
  // keys dropped on the way (SwiftUI: "Tokyo" became "oy"): the read-back sees it and the whole term is set
  const lossy = new FakeApp([el(0, "AXWindow", "Weather"), el(1, "AXSearchField", "Search", { frame: { x: 0, y: 0, w: 200, h: 20 } })]);
  lossy.typeText = async (_a, _w, t, text) => { lossy.typed.push(text); const e = lossy.els.find((x) => x.token === t); if (e) e.value = text.slice(2); return { ok: true, channel: "synthetic", ms: 1 } as any; };
  await runTask(ctxOf(lossy, new Scripted((items) => decide("type_text", by(items, "Search"), "Tokyo")), new StubHelper([], { achieved: () => true }), undefined, 3), newTask("search for Tokyo"));
  expect(lossy.sets).toContainEqual(["t1", "Tokyo"]);
});

test("an empty plan is not 'finished': jev decides step by step", async () => {
  const app = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXButton", "Show")]);
  const brain = new Scripted(() => decide("done"));
  const helper = new StubHelper([], { source: "llm", achieved: () => true });
  const task = await runTask(ctxOf(app, brain, helper), newTask("show the notes"));
  expect(brain.calls).toBeGreaterThan(0);
  expect(task.status).toBe("done");
});

test("a plan compiled in code clicks exact, unique targets without a classifier call", async () => {
  const d = new SimCalc();
  const brain = new Scripted(() => { throw new Error("no classifier call expected"); });
  const steps: PlanStep[] = ["All Clear", "6", "Multiply", "7", "Equals"].map((target) => ({ action: "click", target }));
  const helper = new StubHelper(steps, { source: "compiled", achieved: (s) => s.includes("42") });
  const task = await runTask(ctxOf(d, brain, helper), newTask("compute 6 times 7", "Calculator"));
  expect(d.calls).toEqual(["All Clear", "6", "Multiply", "7", "Equals"]);
  expect(task.status).toBe("done");
  expect(task.counts.decisions).toBe(0);
});

test("an uncertain press that changed the window counts as done (not a failure, not repeated)", async () => {
  const d = new SimCalc();
  const click = d.click.bind(d);
  d.click = async (a, w, t) => { const r = await click(a, w, t); return { ...r, ok: false, effect: "uncertain", error: { code: "timeout", detail: "fast lane" } }; };
  const steps: PlanStep[] = ["All Clear", "6", "Multiply", "7", "Equals"].map((target) => ({ action: "click", target }));
  const task = await runTask(ctxOf(d, new Scripted(() => { throw new Error("x"); }), new StubHelper(steps, { source: "compiled", achieved: (s) => s.includes("42") })), newTask("compute 6 times 7", "Calculator"));
  // presses that change nothing visible ("All Clear" on 0, "Multiply") are retried once, then the plan moves on
  expect(d.calls).toEqual(["All Clear", "All Clear", "6", "Multiply", "Multiply", "7", "Equals"]);
  expect(task.status).toBe("done");
  expect(task.answer).toBe("done");
});

test("an uncertain insert is never typed twice where the field can't be read", async () => {
  const app = new FakeApp([el(0, "AXWindow", "WhatsApp"), el(1, "AXTextArea", "Note")]);
  app.typeText = async (_a, _w, _t, text) => { app.typed.push(text); return { ...OK, ok: false, effect: "uncertain", error: { code: "timeout", detail: "fast lane" } }; };
  await runTask(ctxOf(app, new Scripted((items) => decide("type_text", by(items, "Note"), "hello")), new StubHelper(), undefined, 5), newTask("write hello"));
  expect(app.typed).toEqual(["hello"]);
});

test("a verifier blip is retried once instead of ending a finished task as an error", async () => {
  const d = new SimCalc();
  const steps: PlanStep[] = ["6", "Multiply", "7", "Equals"].map((target) => ({ action: "click", target }));
  const helper = new StubHelper(steps, { source: "compiled", achieved: (s) => s.includes("42"), failVerifyOnce: true });
  const task = await runTask(ctxOf(d, new Scripted(() => { throw new Error("x"); }), helper), newTask("compute 6 times 7", "Calculator"));
  expect(task.status).toBe("done");
  expect(helper.verifies).toBe(2);
});

test("blocked actions on different screens don't add up to a stall", async () => {
  const app = new FakeApp([el(0, "AXWindow", "Notes"), el(1, "AXButton", "Delete")]);
  app.ticking = true; // the screen changes every read (a clock)
  const task = await runTask(ctxOf(app, new Scripted((items) => decide("click", by(items, "Delete"))), new StubHelper(), undefined, 4), newTask("open my notes"));
  expect(app.clicks).toEqual([]);
  expect(task.exception?.code).toBe("step_limit");
});
