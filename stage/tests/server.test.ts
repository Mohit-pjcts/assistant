// The Stage server's local API, as Oni uses it: token, validation, replay-safe runs, the long poll, stopping one run,
// the history cap, Onstage's API path, the tasks form of /api/run (Oni's own plan) and /api/look. Offline: the driver,
// the run itself and Onstage are fakes (the real ones launch the Swift fast lane and reach the model/voice APIs), so
// only the server's own logic runs here.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AppInfo, Observation, Task, WindowRaw, WindowRef } from "../src/contracts.ts";
import type { CliDriver } from "../src/driver.ts";
import type { Explainer, ExplainResult } from "../src/explain.ts";
import type { runCommand } from "../src/manager.ts";
import { startPanel } from "../src/server.ts";

const TOKEN = "test-token";
const H = { "X-Stage-Token": TOKEN, "Content-Type": "application/json" };

// a run that waits until the test lets it finish (or it's stopped)
let release: (() => void) | undefined;
let locked = false;
let lastSignal: AbortSignal | undefined;
let lastRun: Parameters<typeof runCommand>[0] | undefined; // what the server asked the engine to run
let update: ((tasks: Task[]) => void) | undefined;
const task = (status: Task["status"]): Task => ({
  id: "t1", agent: "Mint-3", app: "Calculator", goal: "compute", brain: "jev", status, steps: 1, seconds: 1,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 1, actions: 1, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 },
  decideMs: [], llmCalls: [], answer: status === "done" ? "12" : undefined,
});
const fakeRun = (async (o) => {
  lastRun = o;
  lastSignal = o.signal;
  update = o.onUpdate;
  o.onUpdate?.([task("running")]);
  await new Promise<void>((resolve) => {
    release = resolve;
    o.signal.addEventListener("abort", () => resolve());
  });
  const tasks = [task(o.signal.aborted ? "failed" : "done")];
  return { tasks, totals: { tasks: 1, done: tasks[0]!.status === "done" ? 1 : 0, failed: 0, seconds: 1, decisionsUsd: 0, helperUsd: 0, decisions: 1, actions: 1, medianDecideMs: 1 }, plan: [], planCostUsd: 0 };
}) as typeof runCommand;

const explainCalls: { q: string; opts: unknown }[] = [];
const fakeOnstage = (() => ({
  inLesson: false,
  askFromApi: async (q: string, opts: unknown): Promise<ExplainResult> => { explainCalls.push({ q, opts }); return { ok: true, steps: ["Click Insert."] }; },
  ask: async () => ({ ok: true, steps: [] }),
  begin() {}, go() {}, dismiss() {}, discard() {}, say() {},
})) as unknown as (send: unknown) => Explainer;

// the fake Mac: the apps installed and the windows open on it (the tasks form and /api/look read both through the driver)
const installed = (name: string, running = true): AppInfo => ({ name, bundle_id: `com.test.${name.replace(/\W/g, "")}`, running });
const DEFAULT_APPS = [installed("Calculator"), installed("Brave Browser"), installed("Notes"), installed("Finder"), installed("Weather"), installed("Spotify", false), installed("Photos"), installed("Photo Booth", false)];
let apps: AppInfo[] = DEFAULT_APPS;
let windows: WindowRaw[] = [];
let listAppsFails = false;
let listAppsDelayMs = 0; // slows the app list, so two requests can be in flight at once
let windowId = 0;
const openWindow = (app: string, title: string, width = 800, height = 600): WindowRaw => ({ app_name: app, title, pid: 100, window_id: ++windowId, bounds: { x: 0, y: 0, width, height } });
/** what a window reads as: static text lines (Cua's markdown rendering is where the agents get them) */
const observation = (w: WindowRef, lines: string[]): Observation => ({
  agent: "Look", window: w, truncated: false, ms: 1,
  elements: [{ index: 0, depth: 0, role: "AXWindow", label: w.title, actions: [] }],
  markdown: [`- [0] AXWindow "${w.title}"`, ...lines.map((l) => `  - AXStaticText = "${l}"`)].join("\n"),
});
let observeImpl: (w: WindowRef) => Promise<Observation> = async (w) => observation(w, []);
let observeOpts: unknown;
const sessions: string[] = []; // what the server did with driver sessions, in order
const fakeDriver = {
  medianClickMs: () => 0, fast: { on: false }, counts: {}, cuaCursors: true,
  listApps: async () => {
    if (listAppsDelayMs) await Bun.sleep(listAppsDelayMs);
    if (listAppsFails) throw new Error("cua-driver isn't answering");
    return apps;
  },
  listWindows: async () => ({ windows }),
  ensureSession: async (agent: string) => { sessions.push(`start ${agent}`); },
  endSession: async (agent: string) => { sessions.push(`end ${agent}`); },
  observe: async (agent: string, w: WindowRef, opts?: unknown) => { sessions.push(`observe ${agent}`); observeOpts = opts; return observeImpl(w); },
} as unknown as CliDriver;

const formCalls: string[] = [];
const fakeForms = {
  open: async (url: string) => { formCalls.push(`open ${url}`); return { title: "F", url, fields: [{ id: "q1", label: "Name", kind: "text" as const, required: true }], buttons: ["Next"] }; },
  view: async () => { formCalls.push("view"); return { title: "F", url: "u", fields: [], buttons: [] }; },
  fill: async (a: any[]) => { formCalls.push(`fill ${JSON.stringify(a)}`); return { results: a.map((x) => ({ field: x.field, status: "filled" as const })), view: { title: "F", url: "u", fields: [], buttons: [] } }; },
  press: async (b: string) => { formCalls.push(`press ${b}`); if (b === "nope") throw new Error('no "nope" button on this page (buttons: Next)'); return { title: "F", url: "u", fields: [], buttons: [], confirmation: "Your response has been recorded." }; },
  front: async (u?: string) => { formCalls.push(`front ${u ?? ""}`); return { title: "Sign in", url: u ?? "" }; },
  close: async () => { formCalls.push("close"); },
};
let server: ReturnType<typeof startPanel>;
let base = "";
const started: string[] = [];
beforeAll(() => {
  process.env.TYPESAFE_API_KEY ||= "test";
  server = startPanel(0, TOKEN, { driver: fakeDriver, run: fakeRun, onstage: fakeOnstage, locked: async () => locked, forms: fakeForms });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  release?.();
  release = undefined;
  apps = DEFAULT_APPS; windows = []; listAppsFails = false; listAppsDelayMs = 0; sessions.length = 0;
  observeImpl = async (w) => observation(w, []);
});
afterAll(() => {
  server.stop(true);
  for (const id of started) rmSync(join(import.meta.dir, "..", "runs", id), { recursive: true, force: true });
});

const post = async (path: string, body: unknown, headers: Record<string, string> = H) => {
  const r = await fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const get = async (path: string) => {
  const r = await fetch(base + path, { headers: H });
  return { status: r.status, json: (await r.json()) as any };
};
const startRun = async (command: string, clientRunId?: string) => {
  const r = await post("/api/run", { command, clientRunId });
  if (r.json.runId && !r.json.existing) started.push(r.json.runId);
  return r;
};
/** the tasks form: Oni's own plan */
const startTasks = async (tasks: unknown, extra: Record<string, unknown> = {}) => {
  const r = await post("/api/run", { tasks, ...extra });
  if (r.json.runId && !r.json.existing) started.push(r.json.runId);
  return r;
};
const look = (app: unknown) => post("/api/look", { app });
const settle = async (runId: string) => {
  release?.();
  for (let i = 0; i < 50; i++) { if ((await get(`/api/runs/${runId}`)).json.run.status !== "running") return; await Bun.sleep(10); }
};

test("every route needs this launch's token", async () => {
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  expect((await fetch(`${base}/api/state`, { headers: { "X-Stage-Token": "wrong-token" } })).status).toBe(401);
  const ok = await get("/api/state");
  expect(ok.status).toBe(200);
  expect(ok.json.app).toBe("stage");
  expect(ok.json.overlay).toBe(0);
});

test("a malformed request gets 400, never a 500", async () => {
  expect((await post("/api/run", "{not json")).status).toBe(400);
  expect((await post("/api/run", { command: 42 })).status).toBe(400);
  expect((await post("/api/run", { command: "   " })).status).toBe(400);
  expect((await post("/api/run", { command: "x".repeat(2001) })).status).toBe(400);
  expect((await post("/api/explain", { nope: true })).status).toBe(400);
});

test("a replayed request gets the same run back; a different one while busy is refused", async () => {
  const first = await startRun("compute 15% of 80 in Calculator", "call-1");
  expect(first.json.ok).toBe(true);
  const replay = await startRun("compute 15% of 80 in Calculator", "call-1");
  expect(replay.json).toEqual({ ok: true, runId: first.json.runId, existing: true });
  const other = await startRun("open Safari", "call-2");
  expect(other.json.ok).toBe(false);
  expect(other.json.busy).toBe(true);
  await settle(first.json.runId);
});

test("the run is told who asked for it, for the log's run_start line: the source and the caller's own id", async () => {
  const oni = await startRun("compute 2 plus 2 in Calculator", "toolu_meta1");
  expect(lastRun?.meta).toEqual({ source: "api", clientRunId: "toolu_meta1" });
  await settle(oni.json.runId);
  const panel = await post("/api/run", { command: "compute 3 plus 3 in Calculator", source: "panel" });
  started.push(panel.json.runId);
  expect(lastRun?.meta).toEqual({ source: "panel", clientRunId: undefined }); // no id was sent, so none is passed
  await settle(panel.json.runId);
});

test("the long poll answers at once when behind, else the moment the run changes", async () => {
  const { json } = await startRun("compute 6 x 7 in Calculator", "call-lp");
  const now = await get(`/api/runs/${json.runId}?since=-1&wait=0`);
  expect(now.json.run.tasks[0].status).toBe("running");
  expect(now.json.run.source).toBe("api");
  const t0 = performance.now();
  const waiting = get(`/api/runs/${json.runId}?since=${now.json.version}&wait=20`);
  setTimeout(() => update?.([task("running")]), 50);
  const woke = await waiting;
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(woke.json.version).toBeGreaterThan(now.json.version);
  release?.();
  const end = await get(`/api/runs/${json.runId}?since=${woke.json.version}&wait=20`);
  expect(["finished"]).toContain(end.json.run.status);
  await settle(json.runId);
  const final = (await get(`/api/runs/${json.runId}`)).json.run;
  expect(final.outcome).toBe("done");
  expect(final.tasks[0]).not.toHaveProperty("decideMs"); // summaries only: no per-step bulk
});

test("stop aimed at one run stops only that run", async () => {
  const { json } = await startRun("open Calculator", "call-stop");
  expect((await post("/api/stop", { runId: "run-someone-else" })).json.stopped).toBe(false);
  expect(lastSignal?.aborted).toBe(false);
  expect((await post("/api/stop", { runId: json.runId })).json.stopped).toBe(true);
  await settle(json.runId);
  expect((await get(`/api/runs/${json.runId}`)).json.run.status).toBe("stopped");
});

test("only the last 20 runs are kept", async () => {
  for (let i = 0; i < 22; i++) {
    const { json } = await startRun(`open Calculator ${i}`);
    await settle(json.runId);
  }
  const state = await get("/api/state");
  expect(state.json.runs.length).toBe(20);
});

test("Onstage's API path passes control and skipApps through, and says whether the overlay is up", async () => {
  explainCalls.length = 0;
  const r = await post("/api/explain", { question: "next", control: true, skipApps: ["Oni", 7] });
  expect(r.json).toEqual({ ok: true, steps: ["Click Insert."], overlay: false });
  expect(explainCalls).toEqual([{ q: "next", opts: { controlOnly: true, skipApps: ["Oni"] } }]);
});

test("a locked screen is reported plainly, not as a per-app window error", async () => {
  locked = true;
  try {
    const r = await post("/api/run", { command: "open Calculator" });
    expect(r.json.ok).toBe(false);
    expect(r.json.locked).toBe(true);
    expect(r.json.error).toContain("screen is locked");
    expect((await get("/api/state")).json.locked).toBe(true);
    const e = await post("/api/explain", { question: "what is this?" });
    expect(e.json.locked).toBe(true);
  } finally {
    locked = false;
  }
});

// ---------- the tasks form of /api/run: Oni plans, the agents carry the plan out ----------

const oneTask = { app: "Calculator", goal: "compute 2 plus 2 and tell me the answer" };

test("the command form is unchanged: the sentence goes to Stage's planner, and same-app clauses still merge", async () => {
  const { json } = await startRun("  open Safari  ", "call-cmd");
  expect(json.ok).toBe(true);
  expect(lastRun?.command).toBe("open Safari");
  expect(lastRun?.plan).toBeUndefined(); // Stage's planner makes the plan
  expect(lastRun?.merge).toBeUndefined(); // so merging stays at its default (on)
  await settle(json.runId);
});

test("a tasks request that isn't well formed gets 400 naming the bad item, and starts nothing", async () => {
  const before = (await get("/api/state")).json.runs[0]?.runId;
  const refused: [unknown, string][] = [
    [{}, "send {command: string} or {tasks"],
    [{ command: "open Safari", tasks: [oneTask] }, "not both"],
    [{ tasks: "compute 2 plus 2" }, "tasks must be a list of 1 to 8"],
    [{ tasks: {} }, "tasks must be a list of 1 to 8"],
    [{ tasks: [] }, "tasks must be a list of 1 to 8"],
    [{ tasks: Array(9).fill(oneTask) }, "tasks must be a list of 1 to 8"],
    [{ tasks: [oneTask, "compute"] }, "tasks[1] must be {app, goal}"],
    [{ tasks: [null] }, "tasks[0] must be {app, goal}"],
    [{ tasks: [{ goal: "compute" }] }, "tasks[0].app is empty"],
    [{ tasks: [oneTask, { app: "  ", goal: "compute" }] }, "tasks[1].app is empty"],
    [{ tasks: [oneTask, oneTask, { app: "Notes", goal: "" }] }, "tasks[2].goal is empty"],
    [{ tasks: [{ app: "Notes", goal: " \n " }] }, "tasks[0].goal is empty"],
    [{ tasks: [{ app: "Notes" }] }, "tasks[0].goal is empty"],
    [{ tasks: [{ app: "Notes", goal: 5 }] }, "tasks[0].goal must be text"],
    [{ tasks: [{ app: "x".repeat(81), goal: "compute" }] }, "tasks[0].app is too long"],
    [{ tasks: [{ app: "Notes", goal: "g".repeat(1001) }] }, "tasks[0].goal is too long"],
  ];
  for (const [body, error] of refused) {
    const r = await post("/api/run", body);
    expect({ body, status: r.status, ok: r.json.ok, error: r.json.error }).toEqual({ body, status: 400, ok: false, error: expect.stringContaining(error) });
  }
  // the limits themselves are fine: these get as far as looking the app up (no such app), they are not 400s
  const edge = await post("/api/run", { tasks: [{ app: "x".repeat(80), goal: "g".repeat(1000) }] });
  expect([edge.status, edge.json.ok]).toEqual([200, false]);
  expect(edge.json.error).toContain("no installed app");
  const state = (await get("/api/state")).json;
  expect([state.runs[0]?.runId, state.busy]).toEqual([before, false]); // nothing started
});

test("a tasks request starts the run with Oni's plan as given: the apps' real names, no merging, a display line", async () => {
  const r = await startTasks(
    [
      { app: "calculator", goal: "compute 2026 minus 1911" },
      { app: "Brave", goal: "go to news.ycombinator.com and tell me the title of the top story" },
      { app: " Notes ", goal: " create a new note that says: I'll call Mum's phone\nand bring the charger " },
    ],
    { clientRunId: "oni-call-1", purpose: "History check" },
  );
  expect(r.json).toEqual({ ok: true, runId: expect.stringMatching(/^run-jev-/) });
  expect(lastRun?.plan).toEqual([
    { app: "Calculator", goal: "compute 2026 minus 1911" }, // "calculator" is found, and named as the app is
    { app: "Brave Browser", goal: "go to news.ycombinator.com and tell me the title of the top story" },
    { app: "Notes", goal: "create a new note that says: I'll call Mum's phone\nand bring the charger" }, // trimmed; the line break stays
  ]);
  expect(lastRun?.merge).toBe(false);
  const display = "History check — 1. compute 2026 minus 1911 [Calculator] 2. go to news.ycombinator.com and tell me the title of the top story [Brave Browser] 3. create a new note that says: I'll call Mum's phone and bring the charger [Notes]";
  expect(lastRun?.command).toBe(display);
  const rec = (await get(`/api/runs/${r.json.runId}`)).json.run;
  expect([rec.command, rec.clientRunId, rec.source, rec.brain]).toEqual([display, "oni-call-1", "api", "jev"]);
  await settle(r.json.runId);
});

test("with no purpose the display line is just the numbered tasks; it is clipped (the purpose to 300, all to 2000), the plan isn't", async () => {
  const bare = await startTasks([oneTask]);
  expect(lastRun?.command).toBe("1. compute 2 plus 2 and tell me the answer [Calculator]");
  await settle(bare.json.runId);
  const goal = "g".repeat(1000);
  const r = await startTasks(Array(8).fill({ app: "Notes", goal }), { purpose: "p".repeat(400) });
  expect(r.json.ok).toBe(true); // eight is the most a run takes
  expect(lastRun?.plan).toHaveLength(8);
  expect(lastRun!.plan!.every((t) => t.goal.length === 1000)).toBe(true);
  expect(lastRun?.command).toHaveLength(2000);
  expect(lastRun?.command.startsWith(`${"p".repeat(300)} — 1. `)).toBe(true);
  await settle(r.json.runId);
});

test("two tasks for the same app stay two tasks, in the order given, however the app is spelled", async () => {
  const r = await startTasks([
    { app: "Notes", goal: "create a new note that says: milk" },
    { app: "Weather", goal: "check the weather in Tokyo and tell me the temperature" },
    { app: "notes", goal: "create a new note that says: eggs" },
  ]);
  expect(lastRun?.merge).toBe(false); // the engine keeps the plan as it is; one app's tasks wait for each other there
  expect(lastRun?.plan?.map((t) => `${t.app}: ${t.goal}`)).toEqual([
    "Notes: create a new note that says: milk",
    "Weather: check the weather in Tokyo and tell me the temperature",
    "Notes: create a new note that says: eggs",
  ]);
  await settle(r.json.runId);
});

test("a Finder task opens the folder its goal names, as Stage's own planner does; no other app gets one", async () => {
  const r = await startTasks([
    { app: "Finder", goal: "organise the files in ~/Downloads/inbox into folders by type" },
    { app: "Finder", goal: "organise the files in my downloads" },
    { app: "Notes", goal: "create a new note that says: look in ~/Downloads/inbox" },
  ]);
  expect(lastRun?.plan).toEqual([
    { app: "Finder", goal: "organise the files in ~/Downloads/inbox into folders by type", url: "~/Downloads/inbox" },
    { app: "Finder", goal: "organise the files in my downloads" },
    { app: "Notes", goal: "create a new note that says: look in ~/Downloads/inbox" },
  ]);
  await settle(r.json.runId);
});

test("an unknown app is reported with suggestions before anything starts, even when the other apps are fine", async () => {
  const before = lastRun;
  const r = await startTasks([
    { app: "Calculator", goal: "compute 2 plus 2" },
    { app: "Spotfy", goal: "open Spotify" },
    { app: "Photomatic", goal: "open a photo" },
    { app: "Spotfy", goal: "pause" },
  ]);
  expect(r.status).toBe(200);
  expect(r.json).toEqual({
    ok: false,
    error: 'no installed app called "Spotfy" or "Photomatic"',
    unknownApps: ["Spotfy", "Photomatic"], // each wrong name once
    suggestions: { Spotfy: ["Spotify"], Photomatic: ["Photos", "Photo Booth"] },
  });
  expect(lastRun).toBe(before); // the engine was never asked: Calculator didn't run
  expect((await get("/api/state")).json.busy).toBe(false);
});

// a Mac with look-alike apps: the strict name lookup (resolveAppStrict) has to tell them apart
const LOOK_ALIKES = () => [...DEFAULT_APPS, installed("Safari"), installed("Microsoft Word"), installed("Brave Browser Beta"), installed("System Settings"), installed("System Information")];

test("the tasks form finds apps strictly: a name never lands in a different app, it comes back with suggestions", async () => {
  apps = LOOK_ALIKES();
  const before = lastRun;
  const r = await startTasks([
    { app: "Photoshop", goal: "open a photo" }, // contains "Photos" without being it
    { app: "Safari browser", goal: "go to example.com" }, // contains "Safari"
    { app: "System", goal: "open Wi-Fi settings" }, // System Settings and System Information
    { app: "calc", goal: "compute 2 plus 2" }, // a prefix is not a name
    { app: "Notes", goal: "create a new note that says: hi" }, // fine
  ]);
  expect(r.json.ok).toBe(false);
  expect(r.json.error).toBe('no installed app called "Photoshop", "Safari browser", "System" or "calc"');
  expect(r.json.unknownApps).toEqual(["Photoshop", "Safari browser", "System", "calc"]);
  expect(r.json.suggestions.Photoshop).toEqual(["Photos", "Photo Booth"]);
  expect(r.json.suggestions["Safari browser"][0]).toBe("Safari");
  expect(r.json.suggestions.System).toEqual(["System Information", "System Settings"]);
  expect(r.json.suggestions.calc).toEqual(["Calculator"]);
  expect(lastRun).toBe(before); // nothing ran, not even Notes
  expect((await get("/api/state")).json.busy).toBe(false);
});

test("the tasks form takes an exact name in any case, a short name (Brave, Word), or the one app that has the word", async () => {
  apps = LOOK_ALIKES();
  const r = await startTasks([
    { app: "CALCULATOR", goal: "compute 2 plus 2" },
    { app: "word", goal: "create a new document that says: hi" },
    { app: "Brave", goal: "go to example.com" }, // Brave Browser, not the Beta
    { app: "Settings", goal: "open the Wi-Fi pane" }, // only System Settings has the word
  ]);
  expect(r.json.ok).toBe(true);
  expect(lastRun?.plan?.map((t) => t.app)).toEqual(["Calculator", "Microsoft Word", "Brave Browser", "System Settings"]);
  await settle(r.json.runId);
});

test("the checks run in this order: a replay, the lock, a busy server, then the app names", async () => {
  const unknown = [{ app: "Nonexistent", goal: "do it" }];
  locked = true;
  try {
    const r = await startTasks(unknown);
    expect(r.json).toMatchObject({ ok: false, locked: true });
    expect(r.json.unknownApps).toBeUndefined();
  } finally {
    locked = false;
  }
  const first = await startTasks([oneTask], { clientRunId: "order-1" }); // now busy
  const busy = await startTasks(unknown);
  expect(busy.json).toEqual({ ok: false, error: "Backstage's agents are busy with another job: wait, or stop it", busy: true });
  locked = true; // a replay is answered before the lock check, as it always was
  try {
    expect((await startTasks([oneTask], { clientRunId: "order-1" })).json).toEqual({ ok: true, runId: first.json.runId, existing: true });
  } finally {
    locked = false;
  }
  await settle(first.json.runId);
  expect((await startTasks(unknown)).json.unknownApps).toEqual(["Nonexistent"]); // idle again: the names are checked
});

test("a replayed tasks request gets the same run back, never a second run; a bad body is still a 400 first", async () => {
  const first = await startTasks([oneTask], { clientRunId: "oni-replay" });
  const firstRun = lastRun;
  const replay = await startTasks([oneTask], { clientRunId: "oni-replay" });
  expect(replay.json).toEqual({ ok: true, runId: first.json.runId, existing: true });
  expect(lastRun).toBe(firstRun); // the engine was not asked again
  await settle(first.json.runId);
  expect((await startTasks([oneTask], { clientRunId: "oni-replay" })).json.existing).toBe(true); // also once it is over
  expect((await startTasks([{ app: "", goal: "x" }], { clientRunId: "oni-replay" })).status).toBe(400);
});

test("two tasks requests at once start one run: the other finds Backstage busy, or gets the same run back", async () => {
  listAppsDelayMs = 40; // both get past the first busy check while the installed apps are being read
  const [a, b] = await Promise.all([startTasks([oneTask]), startTasks([{ app: "Notes", goal: "create a new note that says: hi" }])]);
  const won = [a, b].filter((r) => r.json.ok);
  expect(won).toHaveLength(1);
  expect([a, b].find((r) => !r.json.ok)?.json.busy).toBe(true);
  await settle(won[0]!.json.runId);
  // the same request twice at once is one run, and both callers get it
  const [c, d] = await Promise.all([startTasks([oneTask], { clientRunId: "oni-twice" }), startTasks([oneTask], { clientRunId: "oni-twice" })]);
  expect(c.json.runId).toBe(d.json.runId);
  expect([c, d].filter((r) => r.json.existing)).toHaveLength(1);
  await settle(c.json.runId);
});

test("when the installed apps can't be listed the caller is told why, and nothing starts", async () => {
  listAppsFails = true;
  const r = await startTasks([oneTask]);
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);
  expect(r.json.error).toContain("couldn't list the installed apps");
  expect((await get("/api/state")).json.busy).toBe(false);
});

// ---------- /api/look: what an agent would read in an app's window, nothing touched ----------

test("look returns the text the agents read in the app's window, in a session of its own", async () => {
  windows = [openWindow("Calculator", "Calculator", 230, 408)];
  observeImpl = async (w) => observation(w, ["128×37", "4,736"]);
  const r = await look("calculator"); // any case
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, app: "Calculator", window: "Calculator", lines: ["128×37", "4,736"], truncated: false });
  expect(sessions).toEqual(["start Look", "observe Look", "end Look"]);
  expect(observeOpts).toEqual({ timeoutMs: 8000 });
});

test("look reads a note's whole text, line by line, from the window with the most area", async () => {
  windows = [openWindow("Notes", "Shopping", 300, 200), openWindow("Notes", "Packing", 900, 700)];
  observeImpl = async (w) => ({
    ...observation(w, ["Packing"]),
    elements: [
      { index: 0, depth: 0, role: "AXWindow", label: w.title, actions: [] },
      { index: 1, parent: 0, depth: 1, role: "AXTextArea", label: "Note", value: "Packing\nPassport\nCharger", actions: [] },
    ],
  });
  const r = await look("Notes");
  expect([r.json.window, r.json.lines]).toEqual(["Packing", ["Packing", "Passport", "Charger"]]);
});

test("look is not blocked by a job that is running", async () => {
  const run = await startRun("compute 6 x 7 in Calculator", "call-look-busy");
  windows = [openWindow("Calculator", "Calculator", 230, 408)];
  observeImpl = async (w) => observation(w, ["42"]);
  expect((await look("Calculator")).json.lines).toEqual(["42"]);
  expect((await get("/api/state")).json.busy).toBe(true); // still running: the look didn't wait for it or end it
  await settle(run.json.runId);
});

test("look returns at most 400 lines and 8000 characters, and says when it cut something", async () => {
  windows = [openWindow("Calculator", "Calculator", 230, 408)];
  observeImpl = async (w) => observation(w, Array.from({ length: 500 }, (_, i) => `line ${i}`));
  const many = (await look("Calculator")).json;
  expect([many.lines.length, many.lines[399], many.truncated]).toEqual([400, "line 399", true]);
  observeImpl = async (w) => observation(w, Array.from({ length: 200 }, (_, i) => String(i).padStart(100, "x")));
  const long = (await look("Calculator")).json;
  expect(long.lines.join("\n").length).toBeLessThanOrEqual(8000);
  expect([long.lines.length, long.truncated]).toEqual([79, true]); // 79 lines of 100 + 78 line breaks = 7978; an 80th would make 8079
  observeImpl = async (w) => ({ ...observation(w, ["a long page"]), truncated: true }); // the window read itself was cut off
  expect((await look("Calculator")).json.truncated).toBe(true);
});

test("look on an unknown app suggests installed ones; on an app with no window it says so", async () => {
  expect((await look("Spotfy")).json).toEqual({ ok: false, error: 'no installed app called "Spotfy"', suggestions: { Spotfy: ["Spotify"] } });
  expect((await look("Notes")).json).toEqual({ ok: false, error: "Notes has no open window on this desktop" });
  expect((await look("Spotify")).json).toEqual({ ok: false, error: "Spotify has no open window on this desktop (it isn't running)" });
  // a window on another desktop is not one an agent could read either
  windows = [{ ...openWindow("Notes", "Plans"), on_current_space: false }];
  expect((await look("Notes")).json.error).toBe("Notes has no open window on this desktop");
  expect(sessions).toEqual([]); // nothing was started for any of these
});

test("look finds the app as strictly as the tasks form: it never reads a different app's window", async () => {
  apps = LOOK_ALIKES();
  windows = [openWindow("Microsoft Word", "Report", 900, 700), openWindow("Photos", "Library", 900, 700)];
  observeImpl = async (w) => observation(w, [`this is ${w.app}`]);
  expect((await look("word")).json).toEqual({ ok: true, app: "Microsoft Word", window: "Report", lines: ["this is Microsoft Word"], truncated: false });
  expect(sessions).toEqual(["start Look", "observe Look", "end Look"]);
  // Photos has a window open, but "Photoshop" is not Photos; the same for the other sloppy names
  for (const sloppy of ["Photoshop", "Safari browser", "System", "calc"]) {
    const r = await look(sloppy);
    expect([sloppy, r.json.ok, Object.keys(r.json.suggestions)]).toEqual([sloppy, false, [sloppy]]);
  }
  expect((await look("Photoshop")).json.suggestions.Photoshop).toEqual(["Photos", "Photo Booth"]);
  expect((await look("calc")).json.suggestions.calc).toEqual(["Calculator"]);
  expect(sessions).toHaveLength(3); // only the first look read a window
});

test("look ends its session even when the read fails, and says when the window can't be read", async () => {
  windows = [openWindow("Calculator", "Calculator", 230, 408)];
  observeImpl = async () => { throw new Error("cua-driver crashed"); };
  const failed = await look("Calculator");
  expect(failed.json.ok).toBe(false);
  expect(failed.json.error).toContain("cua-driver crashed");
  expect(sessions).toEqual(["start Look", "observe Look", "end Look"]);
  observeImpl = async (w) => ({ ...observation(w, []), elements: [], degraded: "timeout" });
  expect((await look("Calculator")).json.error).toContain("couldn't read the Calculator window (timeout)");
});

test("look needs an app name, the token, and an unlocked screen", async () => {
  for (const body of [{}, { app: "" }, { app: "   " }, { app: 5 }, { app: "x".repeat(81) }]) {
    expect([JSON.stringify(body), (await post("/api/look", body)).status]).toEqual([JSON.stringify(body), 400]);
  }
  expect((await post("/api/look", "{not json")).status).toBe(400);
  expect((await fetch(`${base}/api/look`, { method: "POST", body: JSON.stringify({ app: "Calculator" }) })).status).toBe(401);
  locked = true;
  try {
    const r = await look("Calculator");
    expect(r.json).toMatchObject({ ok: false, locked: true });
    expect(r.json.error).toContain("screen is locked");
  } finally {
    locked = false;
  }
});

// The agents' cursors are Cua's own (also for fast-lane actions); the overlay must not draw a second one.
async function overlayTaps(cursors: "cua" | "overlay", actions: Array<{ via: "fast" | "cua" }>): Promise<any[]> {
  const prev = process.env.STAGE_CURSORS;
  if (cursors === "overlay") process.env.STAGE_CURSORS = "overlay"; else delete process.env.STAGE_CURSORS;
  const driver: any = { ...fakeDriver, cuaCursors: undefined, onAction: undefined };
  const srv = startPanel(0, TOKEN, { driver, run: fakeRun, onstage: fakeOnstage, locked: async () => false });
  if (prev === undefined) delete process.env.STAGE_CURSORS; else process.env.STAGE_CURSORS = prev;
  try {
    const got: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/overlay?token=${TOKEN}`);
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "tap") got.push(m); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("overlay socket failed")); });
    for (const a of actions) driver.onAction({ agent: "Mint-3", frame: { x: 10, y: 20, w: 40, h: 30 }, kind: "press", via: a.via });
    await Bun.sleep(150);
    ws.close();
    expect(driver.cuaCursors).toBe(cursors === "cua");
    return got;
  } finally {
    srv.stop(true);
  }
}

test("Cua look: Cua keeps its own cursor on, a Cua action sends the overlay nothing, a fast-lane action only the ring", async () => {
  const taps = await overlayTaps("cua", [{ via: "cua" }, { via: "fast" }]);
  expect(taps).toHaveLength(1);
  expect(taps[0]).toMatchObject({ via: "fast", agent: "", x: 10, y: 20, w: 40, h: 30 });
});

test("STAGE_CURSORS=overlay restores the overlay's own named cursors for every action", async () => {
  const taps = await overlayTaps("overlay", [{ via: "cua" }, { via: "fast" }]);
  expect(taps).toHaveLength(2);
  expect(taps.every((t) => t.agent !== "")).toBe(true);
});

// ---- web forms (Oni's form_* tools) ----
test("form routes need the token like every other route", async () => {
  expect((await fetch(`${base}/api/form/read`, { method: "POST", body: "{}" })).status).toBe(401);
});

test("form open: only public http(s) addresses; local, private and non-web addresses are refused before anything opens", async () => {
  formCalls.length = 0;
  for (const url of ["http://127.0.0.1:8765/f", "http://localhost/f", "http://192.168.1.5/f", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/f", "", 5, "https://user:pw@example.com/f"]) {
    const r = await post("/api/form/open", { url });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
  }
  expect(formCalls).toEqual([]);
  const ok = await post("/api/form/open", { url: "https://docs.google.com/forms/d/e/abc/viewform" });
  expect(ok.json.ok).toBe(true);
  expect(ok.json.form.fields[0].label).toBe("Name");
  expect(formCalls).toEqual(["open https://docs.google.com/forms/d/e/abc/viewform"]);
});

test("form open: a developer's own local page opens only with STAGE_FORMS_ALLOW_LOCAL=1", async () => {
  process.env.STAGE_FORMS_ALLOW_LOCAL = "1";
  try {
    expect((await post("/api/form/open", { url: "http://127.0.0.1:8765/form3.html" })).json.ok).toBe(true);
    expect((await post("/api/form/open", { url: "file:///etc/passwd" })).status).toBe(400); // still http(s) only
  } finally { delete process.env.STAGE_FORMS_ALLOW_LOCAL; }
});

test("form fill: validates every answer and passes them on; read, press, login and close reach the browser", async () => {
  formCalls.length = 0;
  for (const answers of [undefined, [], "x", [{ field: "", value: "a" }], [{ field: "a", value: 5 }], [{ field: "a", value: [1] }], [{ value: "a" }], Array(81).fill({ field: "a", value: "b" })]) {
    expect((await post("/api/form/fill", { answers })).status).toBe(400);
  }
  expect(formCalls).toEqual([]);
  const r = await post("/api/form/fill", { answers: [{ field: "Name", value: "Mohit" }, { field: "Courses", value: ["A", "B"] }] });
  expect(r.json.ok).toBe(true);
  expect(r.json.results.map((x: any) => x.status)).toEqual(["filled", "filled"]);
  expect((await post("/api/form/read", {})).json.form.title).toBe("F");
  const done = await post("/api/form/press", { button: "submit" });
  expect(done.json.form.confirmation).toBe("Your response has been recorded.");
  expect((await post("/api/form/login", { url: "https://accounts.google.com/" })).json.window.title).toBe("Sign in");
  expect((await post("/api/form/close", {})).json.ok).toBe(true);
  expect(formCalls.map((c) => c.split(" ")[0])).toEqual(["fill", "view", "press", "front", "close"]);
});

test("form press / login: a bad button or address is a clear error, a failure inside the browser is reported, not thrown", async () => {
  expect((await post("/api/form/press", {})).status).toBe(400);
  expect((await post("/api/form/press", { button: "x".repeat(61) })).status).toBe(400);
  const bad = await post("/api/form/press", { button: "nope" });
  expect(bad.status).toBe(200);
  expect(bad.json).toMatchObject({ ok: false });
  expect(bad.json.error).toContain('no "nope" button');
  expect((await post("/api/form/login", { url: "file:///x" })).status).toBe(400);
  expect((await post("/api/form/unknown", {})).status).toBe(404);
});
