// The Stage server's local API, as Oni uses it: token, validation, replay-safe runs, the long poll, stopping one run,
// the history cap, and Onstage's API path. Offline: the driver, the run itself and Onstage are fakes (the real ones
// launch the Swift fast lane and reach the model/voice APIs), so only the server's own logic runs here.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../src/contracts.ts";
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
let update: ((tasks: Task[]) => void) | undefined;
const task = (status: Task["status"]): Task => ({
  id: "t1", agent: "Mint-3", app: "Calculator", goal: "compute", brain: "jev", status, steps: 1, seconds: 1,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 1, actions: 1, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 },
  decideMs: [], llmCalls: [], answer: status === "done" ? "12" : undefined,
});
const fakeRun = (async (o) => {
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

const fakeDriver = { medianClickMs: () => 0, fast: { on: false }, counts: {}, cuaCursors: true, listApps: async () => [] } as unknown as CliDriver;

let server: ReturnType<typeof startPanel>;
let base = "";
const started: string[] = [];
beforeAll(() => {
  process.env.TYPESAFE_API_KEY ||= "test";
  server = startPanel(0, TOKEN, { driver: fakeDriver, run: fakeRun, onstage: fakeOnstage, locked: async () => locked });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => { release?.(); release = undefined; });
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
