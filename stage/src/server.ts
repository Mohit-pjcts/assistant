// The Stage server: the live panel, the overlay's socket, and the local API Oni drives Backstage and Onstage through.
//   Backstage = the background agents (a job → one coloured agent per app, in background windows)
//   Onstage   = the screen explainer (a question → one screenshot → spoken answer + drawings on the real controls)
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { AppInfo, BrainKind, LogLine, Observation, RunTotals, Task, WindowRef } from "./contracts.ts";
import { AGENT_COLOURS } from "./contracts.ts";
import { JevBrain, LlmBrain, jevModel } from "./decide.ts";
import { makeHelper } from "./helpers.ts";
import { CliDriver } from "./driver.ts";
import { folderIn } from "./fsops.ts";
import { LLM_BRAIN_MODEL, hasClaude } from "./llm.ts";
import { RunLogger } from "./logger.ts";
import { planTasks, runCommand, type PlannedTask } from "./manager.ts";
import { Explainer, type ToOverlay } from "./explain.ts";
import { perceive } from "./perceive.ts";
import { askOni, localControl, speakable, stopOni, viaOni } from "./hotkey.ts";
import { route } from "./router.ts";
import { agentLabel, spokenSummary, tidyAnswer } from "./results.ts";
import { LOCKED_MESSAGE, checkUrl, resolveAppStrict, screenLocked, suggestApps, windowsOf } from "./apps.ts";
import { AgentBrowser, type FieldAnswer } from "./webform.ts";
import { fromThisComputer } from "./localonly.ts";
import type { ServerWebSocket } from "bun";

/** who started a run: Oni (the API), the hotkey, or the panel page */
export type RunSource = "api" | "hotkey" | "panel";

interface RunRecord {
  runId: string;
  command: string;
  brain: BrainKind;
  model: string;
  source: RunSource;
  /** the caller's own id for this request (Oni sends its tool-call id), so a replayed request finds this run again */
  clientRunId?: string;
  status: "running" | "finished" | "stopped" | "error";
  /** once it's over: did the agents get it done? ("finished" alone also covers "every task failed") */
  outcome?: "done" | "partial" | "failed";
  tasks: Task[];
  totals?: RunTotals;
  error?: string;
  compareGroup?: string;
  startedAt: string;
  /** bumped on every change, so a long poll (GET /api/runs/:id?since=) returns as soon as something happened */
  version: number;
}

const MAX_RUNS = 20; // kept in memory (each holds every task's full record); older runs live on in runs/<id>/steps.jsonl
const MAX_LINES = 600; // step lines kept for the panel's feed
const REPLAY_LINES = 200; // replayed to a panel that connects mid-run
const MAX_WAIT_S = 30; // longest single long poll
const MAX_COMMAND = 2000;
// Oni's tasks ({tasks} on /api/run): how many a run takes (each is its own agent; the engine has nine names), and how
// long an app name, a goal and a purpose may be
const MAX_TASKS = 8;
const MAX_APP = 80;
const MAX_GOAL = 1000;
const MAX_PURPOSE = 300;
// /api/look: the most it hands back, and how long the window read may take
const LOOK_MAX_LINES = 400;
const LOOK_MAX_CHARS = 8000;
const LOOK_TIMEOUT_MS = 8000;
const LOOK_SESSION = "Look"; // a driver session of its own: a look never shares (or ends) an agent's

/** a run as the API reports it: everything a caller needs, none of the per-step bulk (plans, timings, counts) */
function summary(r: RunRecord) {
  return {
    runId: r.runId, command: r.command, brain: r.brain, model: r.model, source: r.source, clientRunId: r.clientRunId,
    status: r.status, outcome: r.outcome, error: r.error, startedAt: r.startedAt, version: r.version, totals: r.totals,
    tasks: r.tasks.map((t) => ({
      id: t.id, agent: t.agent, app: t.app, goal: t.goal, status: t.status, now: t.now, answer: t.answer,
      exception: t.exception, steps: t.steps, seconds: t.seconds, llmCalls: t.llmCalls,
    })),
  };
}

const outcomeOf = (tasks: Task[]): RunRecord["outcome"] => {
  const done = tasks.filter((t) => t.status === "done").length;
  return done === tasks.length && done > 0 ? "done" : done > 0 ? "partial" : "failed";
};

/** constant-time comparison, so the token can't be guessed byte by byte from response times */
function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Oni's tasks, checked. The error names the bad item ("tasks[2].goal is empty") so the caller can fix just that one. */
function parseTasks(raw: unknown): { ok: true; tasks: { app: string; goal: string }[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TASKS) return { ok: false, error: `tasks must be a list of 1 to ${MAX_TASKS} {app, goal}` };
  const tasks: { app: string; goal: string }[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `tasks[${i}] must be {app, goal}` };
    const row = { app: "", goal: "" };
    for (const [key, max] of [["app", MAX_APP], ["goal", MAX_GOAL]] as const) {
      const v = (item as Record<string, unknown>)[key];
      if (v !== undefined && v !== null && typeof v !== "string") return { ok: false, error: `tasks[${i}].${key} must be text` };
      const text = (v ?? "").trim();
      if (!text) return { ok: false, error: `tasks[${i}].${key} is empty` };
      if (text.length > max) return { ok: false, error: `tasks[${i}].${key} is too long (max ${max} characters)` };
      row[key] = text;
    }
    tasks.push(row);
  }
  return { ok: true, tasks };
}

/** how Oni's run reads in the panel and the log: "<purpose> — 1. <goal> [<App>] 2. <goal> [<App>]" (a display line only: the agents get the plan) */
function tasksCommand(purpose: string, plan: PlannedTask[]): string {
  const line = (s: string) => s.replace(/\s+/g, " ");
  return ((purpose ? `${line(purpose)} — ` : "") + plan.map((t, i) => `${i + 1}. ${line(t.goal)} [${t.app}]`).join(" ")).slice(0, MAX_COMMAND);
}

/** the reply for app names nothing installed matches: which ones, and the installed apps that look closest to each */
function noSuchApp(apps: AppInfo[], names: string[]) {
  const quoted = names.map((n) => `"${n}"`);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : quoted[0];
  return { error: `no installed app called ${list}`, suggestions: Object.fromEntries(names.map((n) => [n, suggestApps(apps, n)])) };
}

/** the first lines that fit in `maxLines` lines and `maxChars` characters (joined with line breaks); truncated says some were left out */
function capLines(all: string[], maxLines: number, maxChars: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let chars = 0;
  for (const line of all) {
    const next = chars + (lines.length ? 1 : 0) + line.length;
    if (lines.length >= maxLines || next > maxChars) return { lines, truncated: true };
    lines.push(line);
    chars = next;
  }
  return { lines, truncated: false };
}

/** what tests swap out (the real ones compile and launch the Swift fast lane, and Onstage warms up the voice) */
export interface PanelDeps {
  driver?: CliDriver;
  run?: typeof runCommand;
  onstage?: (send: (m: ToOverlay) => void) => Explainer;
  /** whether the Mac's screen is locked (the real check reads the login session) */
  locked?: () => Promise<boolean>;
  /** the agent's own browser for web forms (tests pass a fake) */
  forms?: Pick<AgentBrowser, "open" | "view" | "fill" | "press" | "front" | "close">;
}

export function startPanel(port = Number(process.env.PORT ?? 3000), token = "", deps: PanelDeps = {}) {
  const driver = deps.driver ?? new CliDriver();
  const run = deps.run ?? runCommand;
  const isLocked = deps.locked ?? screenLocked;
  const helper = makeHelper();
  const forms = deps.forms ?? new AgentBrowser();
  const viewerDir = join(import.meta.dir, "..", "viewer");
  // Oni's fonts are inlined into the page (not served from a route: every route needs the launch token, which a CSS font
  // fetch can't send). Read per request so editing either file shows up on refresh, as it did when this was a Bun.file.
  const page = async () => {
    const fonts = await Bun.file(join(viewerDir, "oni-fonts.css")).text();
    return (await Bun.file(join(viewerDir, "index.html")).text()).replace("/*ONI_FONTS*/", () => fonts);
  };
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const runs: RunRecord[] = [];
  const lines: LogLine[] = [];
  const aborts = new Map<string, AbortController>(); // one per running run, so a stop aimed at one run stops only that one
  const waiters = new Map<string, Set<() => void>>(); // long polls waiting on a run to change
  let busy = false; // one job at a time: the agents share one input lane and the user's apps
  const overlays = new Set<ServerWebSocket<unknown>>();

  const send = (event: string, data: unknown) => {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of clients) {
      try { c.enqueue(msg); } catch { clients.delete(c); }
    }
  };
  const snapshot = () => ({
    app: "stage", // how a client (Oni) knows it reached Stage and not something else on this port
    busy,
    overlay: overlays.size, // 0: Onstage can't speak or draw, and Backstage has no widgets
    runs: runs.map(summary),
    colours: AGENT_COLOURS,
    keys: { typesafe: !!process.env.TYPESAFE_API_KEY, anthropic: hasClaude() },
    llmModel: LLM_BRAIN_MODEL,
    medianClickMs: driver.medianClickMs(),
    fastLane: { on: driver.fast.on, ...driver.counts },
  });
  /** a run changed: wake its long polls, refresh the panel and the overlay's widgets */
  const changed = (rec?: RunRecord) => {
    if (rec) {
      rec.version++;
      for (const wake of waiters.get(rec.runId) ?? []) wake();
      waiters.delete(rec.runId);
    }
    send("state", snapshot());
    dock();
  };

  /**
   * start a run (the caller has checked guard() and set busy). Everything up to the first await is synchronous, so the
   * returned record is already in `runs` when this returns. Never throws: a failure is recorded on the run.
   */
  function execute(command: string, brain: BrainKind, source: RunSource, opts: { plan?: PlannedTask[]; merge?: boolean; compareGroup?: string; clientRunId?: string } = {}): { rec: RunRecord; done: Promise<RunRecord> } {
    const runId = `run-${brain}-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    const rec: RunRecord = {
      runId, command, brain, model: brain === "jev" ? jevModel() : LLM_BRAIN_MODEL, source, clientRunId: opts.clientRunId,
      status: "running", tasks: [], compareGroup: opts.compareGroup, startedAt: new Date().toISOString(), version: 0,
    };
    runs.unshift(rec);
    runs.splice(MAX_RUNS);
    const abort = new AbortController();
    aborts.set(runId, abort);
    const done = (async () => {
      try {
        const log = new RunLogger(runId);
        log.subscribe((l) => {
          lines.push(l);
          if (lines.length > MAX_LINES) lines.shift();
          send("line", l);
        });
        changed(rec);
        const res = await run({
          runId, command, brainKind: brain,
          makeBrain: () => (brain === "llm" ? new LlmBrain() : new JevBrain()),
          helper, driver, log, signal: abort.signal, plan: opts.plan, merge: opts.merge,
          meta: { source, clientRunId: opts.clientRunId }, // written on the log's run_start line, for Oni's History panel
          onUpdate: (tasks) => { rec.tasks = tasks; changed(rec); },
        });
        rec.tasks = res.tasks;
        rec.totals = res.totals;
        rec.status = abort.signal.aborted ? "stopped" : "finished";
        rec.outcome = outcomeOf(res.tasks);
      } catch (e: any) {
        rec.status = "error";
        rec.outcome = "failed";
        rec.error = String(e?.message ?? e).slice(0, 300);
      } finally {
        aborts.delete(runId);
        changed(rec);
      }
      return rec;
    })();
    return { rec, done };
  }

  function guard(brain: BrainKind | "both"): string | null {
    if (busy) return "Backstage's agents are busy with another job: wait, or stop it";
    if ((brain === "jev" || brain === "both") && !process.env.TYPESAFE_API_KEY) return "TYPESAFE_API_KEY is missing in stage/.env";
    if ((brain === "llm" || brain === "both") && !hasClaude()) return "ANTHROPIC_API_KEY is missing in stage/.env";
    return null;
  }

  /** stop one run by id, or (no id) whatever is running now */
  function stop(runId?: string): boolean {
    if (runId) {
      const a = aborts.get(runId);
      a?.abort();
      return !!a;
    }
    for (const a of aborts.values()) a.abort();
    return aborts.size > 0;
  }

  /** wait until the run changes past `since` (or `waitS` seconds pass) */
  function waitFor(rec: RunRecord, since: number, waitS: number): Promise<void> {
    if (rec.version > since || rec.status !== "running" || waitS <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const set = waiters.get(rec.runId) ?? new Set();
      const wake = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { set.delete(wake); resolve(); }, waitS * 1000);
      set.add(wake);
      waiters.set(rec.runId, set);
    });
  }

  // the native overlay app (overlay/) connects here. It sends what you said or typed with the hotkey; we answer with
  // what to say and draw (Onstage), or start the agents and keep their widgets (bottom right) up to date (Backstage).
  const toOverlays = (m: object) => { const s = JSON.stringify(m); for (const ws of overlays) ws.send(s); };
  const onstage = deps.onstage ? deps.onstage((m) => toOverlays(m)) : new Explainer(driver, (m: ToOverlay) => toOverlays(m), join(import.meta.dir, "..", "runs"));
  // Cursors: the agents' cursors are Cua's own (the look of the first, all-Cua prototypes), also for fast-lane actions
  // (the driver glides Cua's cursor there first). So the overlay must not draw a second cursor: a Cua action needs no
  // overlay mark at all (Cua animates its own click), and a fast-lane action gets just the ring (`agent` left empty =
  // the overlay's ring without its cursor). STAGE_CURSORS=overlay restores the overlay's coloured, named cursors.
  const cuaLook = process.env.STAGE_CURSORS !== "overlay";
  driver.cuaCursors = cuaLook;
  driver.onAction = (n) => {
    if (cuaLook && n.via === "cua") return;
    toOverlays({ type: "tap", agent: cuaLook ? "" : agentLabel(n.agent), colour: AGENT_COLOURS[n.agent] ?? "#2bb39a", kind: n.kind, via: n.via, x: n.frame.x, y: n.frame.y, w: n.frame.w, h: n.frame.h });
  };

  /** the agents' widgets: the latest run's tasks */
  function dock() {
    const rec = runs[0];
    if (!rec || !overlays.size) return;
    toOverlays({
      type: "agents", runId: rec.runId, running: rec.status === "running",
      tasks: rec.tasks.map((t) => ({
        id: `${rec.runId}/${t.id}`, name: agentLabel(t.agent), colour: AGENT_COLOURS[t.agent] ?? "#888888", app: t.app, goal: t.goal.charAt(0).toUpperCase() + t.goal.slice(1),
        status: t.status, now: t.now ?? "", answer: tidyAnswer(t.answer ?? ""), reason: t.exception?.reason ?? "",
        seconds: Math.round(t.seconds * 10) / 10, steps: t.steps, llm: t.llmCalls.length, windowId: t.windowId ?? 0,
      })),
    });
  }

  let oniTurn: AbortController | undefined; // the hotkey request Oni is working on right now (one at a time)

  /**
   * the hotkey's words. EVERY request goes hotkey → Oni's supervisor → a sub-agent (STEPS.md 163): Stage sends the words
   * and the screenshot it took at key-down, Oni decides what they mean and who does it (Backstage, Onstage, the vault,
   * the calendar, ...), and Stage speaks the reply. Only words that control something already running (a lesson's
   * next/back, "clear", "stop") are handled here, with no model. If Oni isn't running, the old local router answers.
   */
  async function hotkey(text: string, cursor?: { x: number; y: number }) {
    const q = text.trim();
    if (!q) return onstage.ask(q, cursor);
    const control = localControl(q, { lesson: onstage.inLesson, working: busy || !!oniTurn });
    if (control === "stop") {
      onstage.discard();
      const hadTurn = !!oniTurn;
      oniTurn?.abort();
      if (hadTurn) void stopOni();
      stop();
      return onstage.say("Stopping.", 4000);
    }
    if (control === "lesson") return onstage.ask(q, cursor);
    if (!viaOni()) return localHotkey(q, cursor);
    if (oniTurn) {
      onstage.discard();
      return onstage.say("Still on your last request. Say stop to cancel it.", 5000);
    }

    const ctl = new AbortController();
    oniTurn = ctl;
    try {
      const shot = await onstage.peekScreenshot();
      onstage.say("On it.", 3000);
      const spokeBefore = onstage.explained;
      const res = await askOni({ text: q, screenshot: shot?.png, app: shot?.app, window: shot?.window }, ctl.signal);
      if (!res.ok && res.unreachable) {
        console.log(`[hotkey] Oni isn't answering (${res.error}) → local router`);
        oniTurn = undefined;
        return await localHotkey(q, cursor);
      }
      onstage.discard();
      if (!res.ok) {
        console.log(`[hotkey] Oni → error: ${res.error}`);
        if (ctl.signal.aborted) return; // stopped: "Stopping." was already said
        return onstage.say(`Oni couldn't do that: ${res.error.replace(/[.\s]+$/, "")}.`, 8000);
      }
      const r = res.reply;
      // Onstage already spoke and drew its answer during the turn: a second spoken line would clear the drawing
      const alreadySpoken = onstage.explained > spokeBefore && r.type === "message" && !r.declined_actions?.length;
      console.log(`[hotkey] Oni → ${r.type}${alreadySpoken ? " (Onstage already spoke)" : ""} "${r.content.slice(0, 80)}"`);
      if (alreadySpoken) return;
      return onstage.say(speakable(r.content), 12000);
    } finally {
      if (oniTurn === ctl) oniTurn = undefined;
    }
  }

  /** the old local router, kept for when Oni isn't running (or STAGE_HOTKEY_VIA_ONI=0): a job for Backstage, or a question for Onstage */
  async function localHotkey(q: string, cursor?: { x: number; y: number }) {
    const r = await route(q, { lesson: onstage.inLesson, agentsBusy: busy });
    console.log(`[route] "${q.slice(0, 60)}" → ${r.to} (${r.via}${r.confidence !== undefined ? ` ${r.confidence.toFixed(2)}` : ""}, ${r.ms} ms)`);
    if (r.to === "explain") return onstage.ask(q, cursor);
    onstage.discard();
    if (r.to === "stop") { stop(); return onstage.say("Stopping the agents.", 4000); }
    const err = guard("jev");
    if (err) return onstage.say(`${err[0]!.toUpperCase()}${err.slice(1)}.`, 6000);
    busy = true;
    onstage.say("On it.", 3000);
    void execute(q, "jev", "hotkey").done
      .then((rec) => onstage.say(spokenSummary(rec.tasks, rec.status, rec.error), 12000))
      .finally(() => { busy = false; changed(); });
  }

  /** a JSON body, or null for a malformed one (answered with 400, never a 500) */
  async function body(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const b = await req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** one read of a window, in a driver session of its own that is ended whatever happens (a look never leaves one open) */
  async function readWindow(win: WindowRef): Promise<Observation> {
    try {
      await driver.ensureSession(LOOK_SESSION);
      return await driver.observe(LOOK_SESSION, win, { timeoutMs: LOOK_TIMEOUT_MS });
    } finally {
      try { await driver.endSession(LOOK_SESSION); } catch { /* it ended already, or never started: nothing to clean up */ }
    }
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1", // this computer only: nobody else on the Wi-Fi can reach the panel or start agents
    idleTimeout: 0,
    websocket: {
      open(ws) { overlays.add(ws); console.log(`[onstage] overlay connected (${overlays.size})`); dock(); send("state", snapshot()); },
      close(ws) { overlays.delete(ws); send("state", snapshot()); },
      message(_ws, raw) {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "begin") onstage.begin(); // hotkey down: capture the screen now (dropped if it's a job for the agents)
        else if (m.type === "stop") stop(); // the overlay's menu: Stop agents
        else if (m.type === "step") onstage.go(m.go === "back" ? "back" : m.go === "repeat" ? "repeat" : "next"); // ⌃⌥ → / ←
        else if (m.type === "dismiss") onstage.dismiss(); // Esc twice
        else if (m.type === "key") console.log(`[keys] ${String(m.what ?? "").slice(0, 60)}`);
        else if (m.type === "ask") {
          console.log(`[hotkey] "${String(m.text ?? "").slice(0, 80)}"`);
          void hotkey(String(m.text ?? ""), m.cursor).catch((e) => console.error("[hotkey]", e));
        }
      },
    },
    error(e) {
      console.error("[server]", e);
      return Response.json({ ok: false, error: "internal error" }, { status: 500 });
    },
    async fetch(req, srv) {
      if (!fromThisComputer(req)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      // every route needs this launch's token (main.ts writes it to a 0600 file only this user can read): another local
      // process or a sandboxed app must not be able to start agents or get the screen described through Stage
      if (token && !sameToken(req.headers.get("x-stage-token") ?? url.searchParams.get("token"), token)) {
        return new Response("missing or wrong Stage token", { status: 401 });
      }
      if (url.pathname === "/overlay") return srv.upgrade(req) ? undefined : new Response("websocket only", { status: 400 });
      const json = (o: unknown, status = 200) => Response.json(o, { status });
      if (url.pathname === "/") return new Response(await page(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/events") {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              clients.add(c);
              c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`));
              for (const l of lines.slice(-REPLAY_LINES)) c.enqueue(enc.encode(`event: line\ndata: ${JSON.stringify(l)}\n\n`));
            },
            cancel() { clients.delete(ctl); },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
        );
      }
      if (url.pathname === "/api/state") return json({ ...snapshot(), locked: await isLocked() });

      // one run, long-polled: answers at once if the run changed after `since` (or is over), else when it next changes
      const one = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === "GET" && one) {
        const rec = runs.find((r) => r.runId === one[1]);
        if (!rec) return json({ ok: false, error: `no run ${one[1]} (only the last ${MAX_RUNS} are kept)` }, 404);
        const since = Number(url.searchParams.get("since") ?? -1);
        const waitS = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0));
        await waitFor(rec, Number.isFinite(since) ? since : -1, waitS);
        return json({ ok: true, version: rec.version, run: summary(rec) });
      }

      // a job for the agents, in one of two forms: {command}, a sentence Stage's own planner splits into tasks (the
      // hotkey and the panel), or {tasks}, the plan Oni's supervisor made itself (it works out the steps and which app
      // each needs; the agents only carry them out). Never both.
      if (req.method === "POST" && url.pathname === "/api/run") {
        const b = await body(req);
        if (!b || (b.command === undefined && b.tasks === undefined)) return json({ ok: false, error: "send {command: string} or {tasks: [{app, goal}]}" }, 400);
        if (b.command !== undefined && b.tasks !== undefined) return json({ ok: false, error: "send {command} or {tasks}, not both" }, 400);
        let command = "";
        let asked: { app: string; goal: string }[] | undefined;
        if (b.tasks !== undefined) {
          const parsed = parseTasks(b.tasks);
          if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
          asked = parsed.tasks;
        } else {
          if (typeof b.command !== "string") return json({ ok: false, error: "send {command: string}" }, 400);
          command = b.command.trim();
          if (!command) return json({ ok: false, error: "type a command first" }, 400);
          if (command.length > MAX_COMMAND) return json({ ok: false, error: `command too long (max ${MAX_COMMAND} characters)` }, 400);
        }
        const purpose = typeof b.purpose === "string" ? b.purpose.trim().slice(0, MAX_PURPOSE) : "";
        const clientRunId = typeof b.clientRunId === "string" && b.clientRunId ? b.clientRunId.slice(0, 200) : undefined;
        // a replayed request (Oni retrying after a timeout, or replaying an approved step) gets the SAME run back, never
        // a second real run in real apps
        const replay = () => (clientRunId ? runs.find((r) => r.clientRunId === clientRunId) : undefined);
        const existing = replay();
        if (existing) return json({ ok: true, runId: existing.runId, existing: true });
        const brain: BrainKind = b.brain === "llm" ? "llm" : "jev";
        if (await isLocked()) return json({ ok: false, error: LOCKED_MESSAGE, locked: true });
        let err = guard(brain);
        if (err) return json({ ok: false, error: err, busy });
        let plan: PlannedTask[] | undefined;
        if (asked) {
          // every app is found BEFORE anything starts: a wrong name comes back with suggestions, not as one failed task
          // in a run that has already worked in the other apps. Found strictly (resolveAppStrict, not the hotkey's
          // forgiving matchApp): a sloppy name must never end up working in a different app
          let apps: AppInfo[];
          try {
            apps = await driver.listApps();
          } catch (e: any) {
            return json({ ok: false, error: `couldn't list the installed apps: ${String(e?.message ?? e).slice(0, 200)}` });
          }
          const found = asked.map((t) => resolveAppStrict(apps, t.app));
          const unknown = [...new Set(asked.filter((_, i) => !found[i]).map((t) => t.app))];
          if (unknown.length) return json({ ok: false, ...noSuchApp(apps, unknown), unknownApps: unknown });
          // the app's real name (so "brave" and "Brave Browser" are one app, and its tasks wait for each other); a Finder
          // task opens the folder its goal names, as the planner does (else the agent works in whatever Finder shows)
          plan = asked.map((t, i) => {
            const app = found[i]!.name;
            const url = app === "Finder" ? folderIn(t.goal) : undefined;
            return url ? { app, goal: t.goal, url } : { app, goal: t.goal };
          });
          command = tasksCommand(purpose, plan);
          // the await above let other requests in: look again, with nothing awaited between here and `busy = true`
          const again = replay();
          if (again) return json({ ok: true, runId: again.runId, existing: true });
          err = guard(brain);
          if (err) return json({ ok: false, error: err, busy });
        }
        busy = true;
        const source: RunSource = b.source === "panel" ? "panel" : "api";
        // merge off: Oni's tasks are each one concrete job, so two for the same app stay two agents, in the order given
        const { rec, done } = execute(command, brain, source, { clientRunId, ...(plan ? { plan, merge: false } : {}) });
        void done.finally(() => { busy = false; changed(); });
        return json({ ok: true, runId: rec.runId });
      }

      // the text an agent would read in an app's window, with nothing touched: Oni's way to see an app before it plans
      // a step, or to find out why one failed. Never blocked by a running job: it only reads, so it can't get in the
      // agents' way.
      if (req.method === "POST" && url.pathname === "/api/look") {
        const b = await body(req);
        const asked = typeof b?.app === "string" ? b.app.trim() : "";
        if (!asked) return json({ ok: false, error: "send {app: string}" }, 400);
        if (asked.length > MAX_APP) return json({ ok: false, error: `app too long (max ${MAX_APP} characters)` }, 400);
        if (await isLocked()) return json({ ok: false, error: LOCKED_MESSAGE, locked: true });
        try {
          const apps = await driver.listApps();
          const app = resolveAppStrict(apps, asked); // as strict as the tasks form: a look must not read a different app
          if (!app) return json({ ok: false, ...noSuchApp(apps, [asked]) });
          const win = (await windowsOf(driver, app.name))[0]; // the biggest window on this desktop
          if (!win) return json({ ok: false, error: `${app.name} has no open window on this desktop${app.running ? "" : " (it isn't running)"}` });
          const obs = await readWindow(win);
          if (!obs.elements.length) return json({ ok: false, error: `couldn't read the ${app.name} window (${obs.degraded ?? "empty"}): is it minimised, in full screen or on another desktop?` });
          // what the agents read; the title line perceive() puts first is left out, the reply names the window itself
          const screen = perceive(obs).screen;
          const { lines, truncated } = capLines(screen[0] === `window title: ${obs.window.title}` ? screen.slice(1) : screen, LOOK_MAX_LINES, LOOK_MAX_CHARS);
          return json({ ok: true, app: app.name, window: win.title, lines, truncated: truncated || obs.truncated });
        } catch (e: any) {
          return json({ ok: false, error: `couldn't read ${asked}: ${String(e?.message ?? e).slice(0, 200)}` });
        }
      }

      // ---- web forms (Oni's form_* tools): the agent's own browser window, driven through Cua's browser tools (webform.ts) ----
      if (req.method === "POST" && url.pathname.startsWith("/api/form/")) {
        const b = (await body(req)) ?? {};
        const formReply = async (fn: () => Promise<object>) => {
          try { return json({ ok: true, ...(await fn()) }); } catch (e: any) { return json({ ok: false, error: String(e?.message ?? e).slice(0, 500) }); }
        };
        // an address: public http(s) only, by the same rules as every other address Stage opens (no local or private-network host,
        // no user:password@, no long text carried off to an unfamiliar site). STAGE_FORMS_ALLOW_LOCAL=1 lets a developer's own test page through.
        const address = (raw: unknown): { ok: true; url: string } | { ok: false; error: string } => {
          const u = typeof raw === "string" ? raw.trim() : "";
          if (!u || u.length > 4000) return { ok: false, error: "send {url: string} (an http(s) address)" };
          if (!/^https?:\/\//i.test(u)) return { ok: false, error: "only http(s) addresses open as forms" };
          if (process.env.STAGE_FORMS_ALLOW_LOCAL === "1") {
            try { new URL(u); return { ok: true, url: u }; } catch { return { ok: false, error: "not a valid web address" }; }
          }
          const c = checkUrl(u, "Brave Browser");
          return c.ok ? { ok: true, url: c.url } : { ok: false, error: `not opened: ${c.why}` };
        };
        const op = url.pathname.slice("/api/form/".length);
        if (op === "open") {
          const a = address(b.url);
          if (!a.ok) return json({ ok: false, error: a.error }, 400);
          return formReply(async () => ({ form: await forms.open(a.url) }));
        }
        if (op === "read") return formReply(async () => ({ form: await forms.view() }));
        if (op === "fill") {
          const list = Array.isArray(b.answers) ? (b.answers as unknown[]) : null;
          if (!list || !list.length || list.length > 80) return json({ ok: false, error: "send {answers: [{field, value}]} (1 to 80 answers)" }, 400);
          const answers: FieldAnswer[] = [];
          for (const x of list as any[]) {
            const okValue = typeof x?.value === "string" || (Array.isArray(x?.value) && x.value.every((v: unknown) => typeof v === "string"));
            if (typeof x?.field !== "string" || !x.field.trim() || x.field.length > 300 || !okValue || JSON.stringify(x.value).length > 6000) return json({ ok: false, error: "each answer is {field: string, value: string | string[]}" }, 400);
            answers.push({ field: x.field, value: x.value });
          }
          return formReply(async () => await forms.fill(answers));
        }
        if (op === "press") {
          if (typeof b.button !== "string" || !b.button.trim() || b.button.length > 60) return json({ ok: false, error: "send {button: string} (next, back, submit, or a button's text)" }, 400);
          return formReply(async () => ({ form: await forms.press(b.button as string) }));
        }
        if (op === "login") {
          let target: string | undefined;
          if (b.url !== undefined) { const a = address(b.url); if (!a.ok) return json({ ok: false, error: a.error }, 400); target = a.url; }
          return formReply(async () => ({ window: await forms.front(target), note: "the agent's browser is in front: sign in there once; the login is kept for next time" }));
        }
        if (op === "close") return formReply(async () => { await forms.close(); return {}; });
        return json({ ok: false, error: "unknown form operation" }, 404);
      }

      // Onstage without the hotkey (Oni): ONLY ever explains — never routed to the agents, so a sentence that sounds like
      // a job can't make anything happen — and never shares the hotkey's screenshot or lesson. `control: true` handles a
      // lesson word (next/back/repeat/stop) and refuses anything that would need a screenshot (`needsCapture`), so a
      // caller can ask for approval only when a screenshot is really about to be taken.
      if (req.method === "POST" && url.pathname === "/api/explain") {
        const b = await body(req);
        if (!b || typeof b.question !== "string" || !b.question.trim()) return json({ ok: false, error: "send {question: string}" }, 400);
        if (b.control !== true && (await isLocked())) return json({ ok: false, error: LOCKED_MESSAGE, locked: true, overlay: overlays.size > 0 });
        const skip = Array.isArray(b.skipApps) ? b.skipApps.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
        const result = await onstage.askFromApi(b.question.trim().slice(0, 1000), { controlOnly: b.control === true, skipApps: skip });
        return json({ ...result, overlay: overlays.size > 0 });
      }

      if (req.method === "POST" && url.pathname === "/api/compare") {
        const b = await body(req);
        const command = typeof b?.command === "string" ? b.command.trim() : "";
        if (!command) return json({ ok: false, error: "type a command first" }, 400);
        const err = guard("both");
        if (err) return json({ ok: false, error: err });
        busy = true;
        void (async () => {
          // plan ONCE so both brains get identical tasks; both start from a clean state
          const apps = await driver.listApps();
          const p = await planTasks(command, apps);
          const plan = p.tasks.map((t) => ({ ...t, goal: `${t.goal} (Do the whole task from the beginning, even if its result is already visible.)` }));
          const group = `cmp-${Date.now()}`;
          const first = await execute(command, "jev", "panel", { plan, compareGroup: group }).done;
          if (first.status !== "stopped") await execute(command, "llm", "panel", { plan, compareGroup: group }).done;
        })().catch((e) => console.error(e)).finally(() => { busy = false; changed(); });
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        const b = await body(req);
        const runId = typeof b?.runId === "string" ? b.runId : undefined;
        return json({ ok: true, stopped: stop(runId) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}
