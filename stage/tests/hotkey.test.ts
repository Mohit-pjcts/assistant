// The hotkey goes hotkey → Oni's supervisor → a sub-agent (STEPS.md 163). Offline: Oni is a fake local server, Onstage
// and the run engine are fakes, so only Stage's own side runs here: what it sends, what it speaks, what it keeps
// local, what it does when Oni is missing, and that it never runs one request twice.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { CliDriver } from "../src/driver.ts";
import type { Explainer } from "../src/explain.ts";
import { askOni, localControl, speakable } from "../src/hotkey.ts";
import type { runCommand } from "../src/manager.ts";
import { startPanel } from "../src/server.ts";

const TOKEN = "t";

// ---------- pure pieces ----------

test("only words that control something running stay local; everything else is Oni's", () => {
  const idle = { lesson: false, working: false };
  expect(localControl("stop", { ...idle, working: true })).toBe("stop");
  expect(localControl("cancel everything", { ...idle, working: true })).toBe("stop");
  expect(localControl("stop", idle)).toBe("lesson"); // nothing running: it just clears the drawings
  expect(localControl("never mind", idle)).toBe("lesson");
  expect(localControl("next", { ...idle, lesson: true })).toBe("lesson");
  expect(localControl("go back", idle)).toBe(null);
  expect(localControl("next", idle)).toBe(null); // no lesson: "next" is a request like any other
  expect(localControl("update these exams into my calendar", { lesson: true, working: true })).toBe(null);
  expect(localControl("how do i make a pivot table", idle)).toBe(null); // used to be decided in code; now Oni's call
  expect(localControl("open calculator", idle)).toBe(null);
});

test("a reply is made speakable: no markdown, links or bullets, at most two sentences", () => {
  expect(speakable("**Added** three exams.\n\n- COMP2119 on 11 Dec\n- MATH2014 on 14 Dec")).toBe("Added three exams. COMP2119 on 11 Dec.");
  expect(speakable("See [the docs](https://example.com/x) for more.")).toBe("See the docs for more.");
  expect(speakable("```\ncode\n```")).toBe("Done.");
  expect(speakable("")).toBe("Done.");
});

// ---------- a fake Oni ----------

type Handler = (body: any, req: Request) => Response | Promise<Response>;
let oni: ReturnType<typeof Bun.serve>;
let handler: Handler;
let oniCalls: any[] = [];
let stopCalls = 0;
beforeAll(() => {
  oni = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/chat/stop") { stopCalls++; return Response.json({ stopped: true }); }
      if (url.pathname !== "/hotkey/turn") return new Response("nope", { status: 404 });
      const body = await req.json();
      oniCalls.push(body);
      return handler(body, req);
    },
  });
});
afterAll(() => oni.stop(true));
beforeEach(() => {
  oniCalls = [];
  stopCalls = 0;
  process.env.ONI_URL = `http://127.0.0.1:${oni.port}`;
  delete process.env.STAGE_HOTKEY_VIA_ONI;
  handler = () => Response.json({ type: "message", content: "Done." });
});
afterEach(() => { delete process.env.ONI_URL; delete process.env.STAGE_HOTKEY_VIA_ONI; });

test("askOni: a reply, an old Oni without the endpoint, Oni off, an error — and which of those may be retried locally", async () => {
  const sig = new AbortController().signal;
  handler = () => Response.json({ type: "message", content: "Hi" });
  expect(await askOni({ text: "x" }, sig)).toEqual({ ok: true, reply: { type: "message", content: "Hi" } });

  const old = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nf", { status: 404 }) });
  process.env.ONI_URL = `http://127.0.0.1:${old.port}`;
  expect(await askOni({ text: "x" }, sig)).toMatchObject({ ok: false, unreachable: true });
  old.stop(true);
  expect(await askOni({ text: "x" }, sig)).toMatchObject({ ok: false, unreachable: true }); // now closed: connection refused

  process.env.ONI_URL = `http://127.0.0.1:${oni.port}`;
  handler = () => Response.json({ detail: "boom" }, { status: 500 });
  expect(await askOni({ text: "x" }, sig)).toEqual({ ok: false, unreachable: false, error: "boom" }); // might have run: never local
  handler = () => new Response("not json", { status: 200 });
  expect(await askOni({ text: "x" }, sig)).toMatchObject({ ok: false, unreachable: false });
});

test("askOni: aborting ends the request and is not 'unreachable'", async () => {
  handler = () => new Promise<Response>(() => {}); // never answers
  const ctl = new AbortController();
  const p = askOni({ text: "x" }, ctl.signal);
  await Bun.sleep(30);
  ctl.abort();
  expect(await p).toEqual({ ok: false, unreachable: false, error: "stopped" });
});

// ---------- the server's hotkey path ----------

let said: { text: string; ms?: number }[] = [];
let discards = 0;
let asked: string[] = [];
let lesson = false;
let explained = 0;
let screenshot: { png: string; app?: string; window?: string } | undefined = { png: "AAAA", app: "Safari", window: "Final exam timetable" };
const fakeOnstage = (() => ({
  get inLesson() { return lesson; },
  get explained() { return explained; },
  peekScreenshot: async () => screenshot,
  ask: async (q: string) => { asked.push(q); return { ok: true, steps: [] }; },
  begin() {}, go() {}, dismiss() {},
  discard() { discards++; },
  say(text: string, ms?: number) { said.push({ text, ms }); },
})) as unknown as (send: unknown) => Explainer;

let release: (() => void) | undefined;
let ran: string[] = [];
const fakeRun = (async (o: any) => {
  ran.push(o.command);
  await new Promise<void>((resolve) => { release = resolve; o.signal.addEventListener("abort", () => resolve()); });
  const t = { id: "t1", agent: "Mint-3", app: "Calculator", goal: "compute", brain: "jev", status: "done", steps: 1, seconds: 1, cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 1, actions: 1, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [], answer: "12" };
  return { tasks: [t], totals: { tasks: 1, done: 1, failed: 0, seconds: 1, decisionsUsd: 0, helperUsd: 0, decisions: 1, actions: 1, medianDecideMs: 1 }, plan: [], planCostUsd: 0 };
}) as unknown as typeof runCommand;
const fakeDriver = { medianClickMs: () => 0, fast: { on: false }, counts: {}, cuaCursors: true, listApps: async () => [], listWindows: async () => ({ windows: [] }) } as unknown as CliDriver;

let panel: ReturnType<typeof startPanel>;
let ws: WebSocket;
beforeAll(async () => {
  process.env.TYPESAFE_API_KEY ||= "test";
  panel = startPanel(0, TOKEN, { driver: fakeDriver, run: fakeRun, onstage: fakeOnstage, locked: async () => false });
  ws = new WebSocket(`ws://127.0.0.1:${panel.port}/overlay?token=${TOKEN}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("overlay socket failed")); });
});
afterAll(() => { release?.(); ws.close(); panel.stop(true); });
beforeEach(() => { said = []; discards = 0; asked = []; lesson = false; explained = 0; ran = []; screenshot = { png: "AAAA", app: "Safari", window: "Final exam timetable" }; });
afterEach(() => { release?.(); release = undefined; });

const hotkey = (text: string) => ws.send(JSON.stringify({ type: "ask", text }));
async function until(cond: () => boolean, ms = 2000) {
  for (let i = 0; i < ms / 10 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
}

test("a request goes to Oni with the screenshot and the front window, and Oni's reply is what gets spoken", async () => {
  handler = () => Response.json({ type: "message", content: "**Added** three exams to the Oni calendar." });
  hotkey("update these exams into my calendar");
  await until(() => said.some((s) => s.text.startsWith("Added")));
  expect(oniCalls).toEqual([{ text: "update these exams into my calendar", screenshot: "AAAA", app: "Safari", window: "Final exam timetable" }]);
  expect(said.map((s) => s.text)).toEqual(["On it.", "Added three exams to the Oni calendar."]);
  expect(discards).toBeGreaterThan(0); // the screenshot is deleted after the answer
  expect(ran).toEqual([]); // Stage's own planner ran nothing: Oni decides
  expect(asked).toEqual([]);
});

test("even a request the old router would have called a job or a question goes to Oni, never decided in Stage", async () => {
  for (const text of ["open calculator and compute 3 times 4", "how do i make a pivot table", "what does this button do"]) {
    oniCalls.length = 0;
    hotkey(text);
    await until(() => oniCalls.length === 1);
    expect(oniCalls[0].text).toBe(text);
    await until(() => said.some((s) => s.text === "Done."));
    said = [];
  }
  expect(ran).toEqual([]);
  expect(asked).toEqual([]);
});

test("when Onstage already spoke and drew during the turn, the reply is not spoken over it", async () => {
  handler = () => { explained++; return Response.json({ type: "message", content: "Shown." }); };
  hotkey("how do i make a pivot table");
  await until(() => oniCalls.length === 1);
  await Bun.sleep(80);
  expect(said.map((s) => s.text)).toEqual(["On it."]);
});

test("held-back approvals are always spoken, even if Onstage also spoke", async () => {
  handler = () => { explained++; return Response.json({ type: "message", content: "I held back send_email: approve it in the Oni window.", declined_actions: ["send_email"] }); };
  hotkey("email my professor");
  await until(() => said.some((s) => s.text.includes("held back")));
});

test("a screenshot that could not be taken still reaches Oni as a request without one", async () => {
  screenshot = undefined;
  hotkey("what time is it in tokyo");
  await until(() => oniCalls.length === 1);
  expect(oniCalls[0]).toEqual({ text: "what time is it in tokyo" });
});

test("busy, cancelled and error replies are spoken as given / explained", async () => {
  handler = () => Response.json({ type: "busy", content: "Oni is in the middle of another request. Try again in a moment." });
  hotkey("hello");
  await until(() => said.some((s) => s.text.startsWith("Oni is in the middle")));
  said = [];
  handler = () => Response.json({ detail: "kaput" }, { status: 500 });
  hotkey("hello again");
  await until(() => said.some((s) => s.text === "Oni couldn't do that: kaput."));
});

test("lesson words and 'clear' stay in Stage: no Oni call, no model", async () => {
  lesson = true;
  hotkey("next");
  await until(() => asked.includes("next"));
  hotkey("clear");
  await until(() => asked.includes("clear"));
  expect(oniCalls).toEqual([]);
});

test("while Oni works on a request, a second one is refused instead of started; stop cancels Oni's turn and the agents", async () => {
  let answer!: (r: Response) => void;
  handler = () => new Promise<Response>((resolve) => { answer = resolve; });
  hotkey("organise my downloads folder");
  await until(() => oniCalls.length === 1);

  hotkey("also tidy my desktop");
  await until(() => said.some((s) => s.text.startsWith("Still on your last request")));
  expect(oniCalls).toHaveLength(1);

  hotkey("stop");
  await until(() => said.some((s) => s.text === "Stopping."));
  await until(() => stopCalls === 1);
  expect(oniCalls).toHaveLength(1);

  // and the hotkey works again afterwards
  handler = () => Response.json({ type: "message", content: "Ready." });
  hotkey("hello");
  await until(() => oniCalls.length === 2);
  answer(Response.json({ type: "message", content: "late" })); // the stopped request's answer, if it ever came, is ignored
  await until(() => said.some((s) => s.text === "Ready."));
  expect(said.some((s) => s.text === "late")).toBe(false);
});

test("Oni not running: the old local router answers, once", async () => {
  process.env.ONI_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
  hotkey("open calculator and compute 3 times 4");
  await until(() => ran.length === 1);
  expect(ran).toEqual(["open calculator and compute 3 times 4"]);
  expect(oniCalls).toEqual([]);
  release?.();
  await until(() => said.some((s) => s.text === "12." || s.text === "12"));
});

test("an Oni that has no hotkey endpoint yet (not restarted) also falls back to the local router", async () => {
  const old = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nf", { status: 404 }) });
  process.env.ONI_URL = `http://127.0.0.1:${old.port}`;
  hotkey("how do i make a pivot table");
  await until(() => asked.includes("how do i make a pivot table")); // the old router calls this a question for Onstage
  old.stop(true);
});

test("an Oni that failed after taking the request is never retried locally (no double run)", async () => {
  handler = () => Response.json({ detail: "boom" }, { status: 500 });
  hotkey("open calculator and compute 3 times 4");
  await until(() => said.some((s) => s.text.startsWith("Oni couldn't do that")));
  await Bun.sleep(80);
  expect(ran).toEqual([]);
});

test("STAGE_HOTKEY_VIA_ONI=0 puts the local router back without touching Oni", async () => {
  process.env.STAGE_HOTKEY_VIA_ONI = "0";
  hotkey("how do i make a pivot table");
  await until(() => asked.includes("how do i make a pivot table"));
  expect(oniCalls).toEqual([]);
});
