// The loop's guards, offline: every click is guarded, Stop stops the next action, Enter can't fire a risky default,
// own text is the exact value the agent left, filled fields aren't blanked, and plans/counters behave.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, AxElement, Brain, Decision, Driver, Facts, Helper, Item, Observation, PlanStep, Task, WindowRef } from "../src/contracts.ts";
import { RunLogger } from "../src/logger.ts";
import { ignoresBackgroundKeys, runTask } from "../src/loop.ts";
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

// ---------- Oni's Instagram DM task (a real user task, through the real supervisor): what its run logs showed ----------

const WINDOW = { x: 0, y: 0, w: 1200, h: 800 };
/** an Instagram thread in a browser: the open conversation's title, and the message box a web page exposes with its prompt as its value */
const instagram = (conversation = "Rishabh Jain", box: Partial<AxElement> = {}) => {
  const app = new FakeApp([
    el(0, "AXWindow", "Brave Browser", { frame: WINDOW }),
    el(1, "AXWebArea", "Instagram"),
    el(2, "AXStaticText", conversation, { parent: 1, frame: { x: 600, y: 40, w: 160, h: 24 } }),
    el(3, "AXTextArea", "Message...", { parent: 1, value: "Message...", frame: { x: 400, y: 700, w: 500, h: 40 }, ...box }),
  ]);
  // a web text box: what is typed replaces its prompt
  app.typeText = async (_a, _w, t, text) => { app.typed.push(text); const e = app.els.find((x) => x.token === t); if (e) e.value = text; return OK; };
  return app;
};
const SEND_HI = "open the conversation with Rishabh and send a message that says: hi";
/** a run's context whose log also collects each step's description (what the agent did, or why it was blocked) */
const withSteps = (ctx: ReturnType<typeof ctxOf>) => {
  const acted: string[] = [];
  return { ctx: { ...ctx, log: { write(l: any) { if (l.type === "step") acted.push(l.acted); } } }, acted };
};

test("Instagram's message box shows 'Message...' as its value, so it is empty: the agent types into it and sends (live: every run was blocked as 'already contains someone else's text')", async () => {
  const app = instagram();
  const brain = new Scripted((items, n) => n === 0 ? decide("type_text", by(items, "Message..."), "hi") : n === 1 ? decide("press_enter", by(items, "Message...")) : decide("done"));
  const { ctx, acted } = withSteps(ctxOf(app, brain, new StubHelper([], { achieved: () => true }), undefined, 8));
  const task = await runTask(ctx, newTask(SEND_HI, "Brave Browser"));
  expect(app.typed).toEqual(["hi"]); // not "Message...hi"
  expect(app.keys).toEqual(["return"]); // and sent
  expect(app.sets).toEqual([]); // nothing to clear
  expect(acted.filter((a) => a.startsWith("blocked"))).toEqual([]); // nothing was blocked on the way
  expect(task.status).toBe("done");
});

test("a text box with real content in it is still protected: a value that differs from its label, or long text equal to it", async () => {
  const SEND = "send a message that says: hi";
  const attempt = async (app: FakeApp, label: string) => {
    const { ctx, acted } = withSteps(ctxOf(app, new Scripted((items) => decide("type_text", by(items, label), "hi")), new StubHelper(), undefined, 4));
    const task = await runTask(ctx, newTask(SEND, "Brave Browser"));
    return { task, blocked: acted.filter((a) => a.includes("already contains someone else's text")) };
  };
  const real = instagram("Rishabh Jain", { value: "see you at five" });
  const a = await attempt(real, "Message...");
  expect([real.typed, a.blocked.length > 0, a.task.status]).toEqual([[], true, "failed"]);
  const long = "x".repeat(70);
  const text = instagram("Rishabh Jain", { label: long, value: long });
  const b = await attempt(text, long);
  expect([text.typed, b.blocked.length > 0, b.task.status]).toEqual([[], true, "failed"]);
});

test("the conversation check still stops a message aimed at someone else's chat, now that the box is empty", async () => {
  const app = instagram("Maria"); // the open conversation is not Rishabh's
  const task = await runTask(ctxOf(app, new Scripted((items) => decide("type_text", by(items, "Message..."), "hi")), new StubHelper(), undefined, 4), newTask(SEND_HI, "Brave Browser"));
  expect(app.typed).toEqual([]);
  expect(task.exception?.reason).toContain("not with Rishabh");
});

/** the goal Oni sent in the 18:07 run, which names the conversation only as "the 'Rishabh Jain' conversation" */
const PICKED_BY_NAME = "On the open Instagram Direct Messages page, click directly on the 'Rishabh Jain' conversation in the left sidebar to open it, then click into the 'Message...' text box at the bottom of that conversation (clearing it first if it has any leftover text), and send a message that says: hi";
test("the conversation check runs however the goal names the recipient, not only 'the conversation with X' (live gap: with no target, a message went to whatever chat was open)", async () => {
  for (const goal of [
    "send a message to Rishabh Jain that says: hi", "Send Rishabh Jain a message that says: hi", "send it to Rishabh Jain", // send phrasings
    "Message Rishabh Jain that says: hi", // a capitalised verb opens the goal
    PICKED_BY_NAME, // the conversation is picked by its name
  ]) {
    const wrong = instagram("Maria"); // the open conversation is not Rishabh Jain's
    const stopped = await runTask(ctxOf(wrong, new Scripted((items) => decide("type_text", by(items, "Message..."), "hi")), new StubHelper(), undefined, 4), newTask(goal, "Brave Browser"));
    expect([goal, wrong.typed]).toEqual([goal, []]);
    expect([goal, stopped.exception?.reason]).toEqual([goal, expect.stringContaining("not with Rishabh Jain")]);
    // and in his conversation it is typed and sent
    const right = instagram("Rishabh Jain");
    const brain = new Scripted((items, n) => n === 0 ? decide("type_text", by(items, "Message..."), "hi") : n === 1 ? decide("press_enter", by(items, "Message...")) : decide("done"));
    const sent = await runTask(ctxOf(right, brain, new StubHelper([], { achieved: () => true }), undefined, 8), newTask(goal, "Brave Browser"));
    expect([goal, right.typed, right.keys, sent.status]).toEqual([goal, ["hi"], ["return"], "done"]);
  }
});

/** a browser: its own address bar in the toolbar, and a web page below */
const browser = (label: string, page: AxElement[] = []) => new FakeApp([
  el(0, "AXWindow", "Brave Browser", { frame: WINDOW }),
  el(1, "AXTextField", label, { value: "instagram.com", frame: { x: 200, y: 10, w: 600, h: 24 } }),
  el(2, "AXWebArea", "Instagram"),
  ...page,
]);
const BARS: [string, string][] = [
  ["Brave Browser", "Address and search bar"], ["Google Chrome", "Address and Search Bar"], ["Safari", "Smart Search Field"],
  ["Safari", "Search or enter website name"], ["Brave Browser", "Address bar"], ["Google Chrome", "URL"],
];

test("never type into a browser's address bar (live: 'hi' went into Brave's, and a later run left 'Send message' there for Enter to Google)", async () => {
  for (const [app, label] of BARS) {
    const page = browser(label);
    const task = await runTask(ctxOf(page, new Scripted((items) => decide("type_text", by(items, label), "hi")), new StubHelper(), undefined, 4), newTask("type hi", app));
    expect([label, page.typed, page.sets, page.clicks]).toEqual([label, [], [], []]);
    expect([label, task.exception?.code, task.exception?.reason]).toEqual([label, "stalled", "blocked: websites open with open_url; the address bar is never typed into"]);
  }
});

test("never press Enter in a browser's address bar, whether the agent chose it or Enter would fall back to the first filled field", async () => {
  for (const [app, label] of BARS) {
    const page = browser(label);
    const task = await runTask(ctxOf(page, new Scripted((items) => decide("press_enter", by(items, label))), new StubHelper(), undefined, 4), newTask("type hi", app));
    expect([label, page.keys]).toEqual([label, []]);
    expect(task.exception?.reason).toContain("the address bar is never typed into");
  }
  // no field chosen: Enter goes to no field of the browser's own (the bar is the only filled one, and is skipped)
  const quiet = browser("Address and search bar");
  await runTask(ctxOf(quiet, new Scripted(() => decide("press_enter")), new StubHelper(), undefined, 3), newTask("type hi", "Brave Browser"));
  expect(quiet.keys.every((k) => !k.startsWith("confirm"))).toBe(true);
});

test("the page's own fields are not the address bar: a search box, or a form field labelled 'Address' or 'URL', is typed into", async () => {
  const page = browser("Address and search bar", [
    el(3, "AXTextArea", "Search", { parent: 2, frame: { x: 100, y: 100, w: 300, h: 30 } }),
    el(4, "AXTextField", "Address", { parent: 2, frame: { x: 100, y: 200, w: 300, h: 30 } }),
    el(5, "AXTextField", "URL", { parent: 2, frame: { x: 100, y: 300, w: 300, h: 30 } }),
  ]);
  const brain = new Scripted((items, n) => decide("type_text", by(items, ["Search", "Address", "URL"][n]!), ["hello", "12 Main Street", "example.com"][n]));
  await runTask(ctxOf(page, brain, new StubHelper(), undefined, 12), newTask("fill in the form: hello, 12 Main Street, example.com", "Brave Browser"));
  expect(page.typed).toEqual(["hello", "12 Main Street", "example.com"]);
  // and the same label outside a browser is not special either (a native single-line field has its text SET, not typed)
  const notes = new FakeApp([el(0, "AXWindow", "Notes", { frame: WINDOW }), el(1, "AXTextField", "Address bar", { frame: { x: 10, y: 10, w: 300, h: 24 } })]);
  await runTask(ctxOf(notes, new Scripted((items) => decide("type_text", by(items, "Address bar"), "hello")), new StubHelper(), undefined, 3), newTask("type hello", "Notes"));
  expect(notes.sets).toContainEqual(["t1", "hello"]);
});

test("the search for a name that is not on screen never uses the address bar, whose label says 'search' too (it would be blanked, then typed into)", async () => {
  // Rishabh is not on screen and the only 'search' field is the browser's own address bar
  const bar = browser("Address and search bar");
  await runTask(ctxOf(bar, new Scripted(() => decide("scroll_down")), new StubHelper(), undefined, 3), newTask(SEND_HI, "Brave Browser"));
  expect([bar.typed, bar.sets, bar.keys]).toEqual([[], [], []]);
});

test("pressing the page's Search link does not retype the address bar's text (it holds the goal's own 'instagram.com') and press Enter in it", async () => {
  const page = browser("Address and search bar", [el(3, "AXButton", "Search", { parent: 2, frame: { x: 20, y: 200, w: 80, h: 30 } })]);
  await runTask(ctxOf(page, new Scripted((items) => decide("click", by(items, "Search"))), new StubHelper(), undefined, 3), newTask("open instagram.com and search for Rishabh", "Brave Browser"));
  expect(page.clicks).toContain("Search");
  expect([page.typed, page.sets, page.keys]).toEqual([[], [], []]);
});

/**
 * WhatsApp (live, 6 Oct): background key events are ignored (the call says ok, the box stays empty and reports NO value), a
 * Return sent nothing, and jev wandered onto the "changed their phone number" notice. The box only shows a Send button once real text is
 * in it. Foreground keystrokes land; pressing the Send button sends.
 */
const whatsapp = (conversation = "Rishabh", earlier = false) => {
  const app = new FakeApp([
    el(0, "AXWindow", "WhatsApp", { frame: WINDOW }),
    el(1, "AXStaticText", conversation, { parent: 0, frame: { x: 600, y: 40, w: 160, h: 24 } }),
    el(2, "AXTextArea", "Compose message", { parent: 0, frame: { x: 400, y: 700, w: 500, h: 40 } }), // no value while empty
    ...(earlier ? [el(8, "AXStaticText", `Your message, hi, 3:51 AM, Sent to ${conversation}, Delivered`, { parent: 0 })] : []), // an identical message sent earlier
  ]);
  const how: string[] = [];
  const log: string[] = [];
  let sent: string | undefined;
  app.typeText = async (_a: string, _w: WindowRef, t: string, text: string, foreground?: boolean) => {
    how.push(foreground ? "foreground" : "background");
    const e = app.els.find((x) => x.token === t);
    if (!foreground || !e) return OK; // a background key event: reported ok, ignored
    app.typed.push(text);
    e.value = text;
    app.els.push(el(9, "AXButton", "‎Send", { parent: 0, frame: { x: 920, y: 700, w: 40, h: 40 } })); // appears once there is text
    return { ...OK, channel: "foreground" as const };
  };
  app.click = async (_a, _w, t) => {
    const e = app.els.find((x) => x.token === t);
    app.clicks.push(e?.label ?? t);
    if (e?.label?.includes("Send")) {
      sent = app.els.find((x) => x.role === "AXTextArea")?.value;
      log.push(`sent:${sent}`);
      const box = app.els.find((x) => x.role === "AXTextArea"); if (box) box.value = undefined;
      app.els = app.els.filter((x) => x.label?.includes("Send") !== true);
      app.els.push(el(10, "AXStaticText", `Your message, ${sent}, 4:05 AM, Sent to ${conversation}`, { parent: 0 })); // the new bubble
    }
    return OK;
  };
  return { app, how, log, sent: () => sent };
};

test("WhatsApp: text that a background key event dropped is typed again as foreground keys, then the Send button is pressed (not Return)", async () => {
  const w = whatsapp();
  const brain = new Scripted((items, n) => n === 0 ? decide("type_text", by(items, "Compose message"), "hi") : n === 1 ? decide("press_enter", by(items, "Compose message")) : decide("done"));
  const { ctx, acted } = withSteps(ctxOf(w.app, brain, new StubHelper([], { achieved: () => true }), undefined, 8));
  const task = await runTask(ctx, newTask("open the chat with Rishabh and send a message that says: hi", "WhatsApp"));
  expect(w.how).toEqual(["background", "foreground"]); // dropped once, then real keys
  expect(w.sent()).toBe("hi");
  expect(w.log).toEqual(["sent:hi"]); // exactly one send
  expect(w.app.keys).toEqual([]); // and no Return afterwards (it would have been a second send)
  expect(acted.some((a) => a.includes("then pressed Send"))).toBe(true);
  expect(acted.some((a) => a.startsWith("skipped: the message was already sent"))).toBe(true);
  expect(task.status).toBe("done");
});

test("WhatsApp: a goal that does not ask to send never types, never presses Send", async () => {
  const w = whatsapp();
  const brain = new Scripted((items) => decide("type_text", by(items, "Compose message"), "hi"));
  await runTask(ctxOf(w.app, brain, new StubHelper(), undefined, 3), newTask("open the chat with Rishabh and look at it", "WhatsApp"));
  expect(w.how).toEqual([]);
  expect(w.log).toEqual([]);
});

test("WhatsApp: a chat that is not the named person's is never typed into", async () => {
  const w = whatsapp("Maria");
  const brain = new Scripted((items) => decide("type_text", by(items, "Compose message"), "hi"));
  const task = await runTask(ctxOf(w.app, brain, new StubHelper(), undefined, 4), newTask("open the chat with Rishabh and send a message that says: hi", "WhatsApp"));
  expect(w.how).toEqual([]);
  expect(w.log).toEqual([]);
  expect(task.exception?.reason).toContain("not with Rishabh");
});

test("Instagram: once the text is confirmed in the box, the Send button is pressed once, and a following Return is skipped", async () => {
  const app = instagram();
  app.els.push(el(5, "AXButton", "Send", { parent: 1, frame: { x: 920, y: 700, w: 60, h: 40 } }));
  const clicks: string[] = [];
  app.click = async (_a, _w, t) => { clicks.push(app.els.find((x) => x.token === t)?.label ?? t); return OK; };
  const brain = new Scripted((items, n) => n === 0 ? decide("type_text", by(items, "Message..."), "hi") : n === 1 ? decide("press_enter", by(items, "Message...")) : decide("done"));
  const { ctx } = withSteps(ctxOf(app, brain, new StubHelper([], { achieved: () => true }), undefined, 8));
  await runTask(ctx, newTask(SEND_HI, "Brave Browser"));
  expect(app.typed).toEqual(["hi"]);
  expect(clicks.filter((c) => c === "Send")).toEqual(["Send"]);
  expect(app.keys).toEqual([]);
});

test("WhatsApp: an identical earlier message on screen does not make a send goal 'done' (live: a second \"hi\" to Rishabh was never typed or sent)", async () => {
  const w = whatsapp("Rishabh", true);
  const brain = new Scripted((items, n) => n < 4 ? decide("done") : decide("done")); // jev sees "hi" already in the chat and keeps saying done
  const { ctx, acted } = withSteps(ctxOf(w.app, brain, new StubHelper([], { achieved: (screen) => screen.some((l) => l.includes("4:05 AM")) }), undefined, 10));
  const task = await runTask(ctx, newTask("open the chat with Rishabh and send a message that says: hi", "WhatsApp"));
  expect(w.log).toEqual(["sent:hi"]); // sent exactly once, by this task
  expect(w.how).toEqual(["background", "foreground"]);
  expect(acted.some((a) => a.includes("then pressed Send"))).toBe(true);
  expect(task.status).toBe("done");
});

test("a goal that is not about sending a message can still be 'done' straight away", async () => {
  const w = whatsapp("Rishabh", true);
  const task = await runTask(ctxOf(w.app, new Scripted(() => decide("done")), new StubHelper([], { achieved: () => true }), undefined, 4), newTask("tell me what the last message in the chat with Rishabh says", "WhatsApp"));
  expect(w.how).toEqual([]);
  expect(w.log).toEqual([]);
  expect(task.status).toBe("done");
});

test("a plan that only opens or clicks something is not 'done' for a send goal: the verifier's page-text 'achieved' is not enough (live: Instagram's inbox opened, nothing sent, reported as sent)", async () => {
  const w = whatsapp();
  const plan: PlanStep[] = [{ action: "click", target: "Rishabh" }];
  const brain = new Scripted((items, n) => n === 0 ? decide("type_text", by(items, "Compose message"), "hi") : decide("done"));
  const helper = new StubHelper(plan, { source: "compiled", achieved: () => true }); // a verifier that approves anything
  const { ctx, acted } = withSteps(ctxOf(w.app, brain, helper, undefined, 10));
  const task = await runTask(ctx, newTask("open the chat with Rishabh and send a message that says: hi", "WhatsApp"));
  expect(w.log).toEqual(["sent:hi"]); // the message really went out before the task counted as done
  expect(task.status).toBe("done");
  expect(acted.some((a) => a.includes("then pressed Send"))).toBe(true);
});

test("a send goal whose message never goes out ends as failed, not done", async () => {
  const w = whatsapp("Maria"); // the open chat is not Rishabh's: typing is refused, nothing can be sent
  const brain = new Scripted((items) => decide("done"));
  const task = await runTask(ctxOf(w.app, brain, new StubHelper([], { achieved: () => true }), undefined, 12), newTask("open the chat with Rishabh and send a message that says: hi", "WhatsApp"));
  expect(w.log).toEqual([]);
  expect(task.status).toBe("failed");
});

test("which apps get the foreground typing fallback: WhatsApp by default, others only when named in STAGE_FOREGROUND_TYPING_APPS", () => {
  expect(ignoresBackgroundKeys("WhatsApp", "")).toBe(true);
  expect(ignoresBackgroundKeys("\u200eWhatsApp", "")).toBe(true);
  expect(ignoresBackgroundKeys("Notes", "")).toBe(false);
  expect(ignoresBackgroundKeys("Discord", "")).toBe(false);
  expect(ignoresBackgroundKeys("Discord", "discord, Slack")).toBe(true);
  expect(ignoresBackgroundKeys("Slack", " discord ,Slack ")).toBe(true);
  expect(ignoresBackgroundKeys("Safari", "discord, .*")).toBe(false); // names are plain text, not patterns
});
