// The Stage server: the live panel, the overlay's socket, and the local API Oni drives Backstage and Onstage through.
//   Backstage = the background agents (a job → one coloured agent per app, in background windows)
//   Onstage   = the screen explainer (a question → one screenshot → spoken answer + drawings on the real controls)
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { BrainKind, LogLine, RunTotals, Task } from "./contracts.ts";
import { AGENT_COLOURS } from "./contracts.ts";
import { JevBrain, LlmBrain, jevModel } from "./decide.ts";
import { makeHelper } from "./helpers.ts";
import { CliDriver } from "./driver.ts";
import { LLM_BRAIN_MODEL, hasClaude } from "./llm.ts";
import { RunLogger } from "./logger.ts";
import { planTasks, runCommand, type PlannedTask } from "./manager.ts";
import { Explainer, type ToOverlay } from "./explain.ts";
import { route } from "./router.ts";
import { agentLabel, spokenSummary, tidyAnswer } from "./results.ts";
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

/** what tests swap out (the real ones compile and launch the Swift fast lane, and Onstage warms up the voice) */
export interface PanelDeps {
  driver?: CliDriver;
  run?: typeof runCommand;
  onstage?: (send: (m: ToOverlay) => void) => Explainer;
}

export function startPanel(port = Number(process.env.PORT ?? 3000), token = "", deps: PanelDeps = {}) {
  const driver = deps.driver ?? new CliDriver();
  const run = deps.run ?? runCommand;
  const helper = makeHelper();
  const html = Bun.file(join(import.meta.dir, "..", "viewer", "index.html"));
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
  function execute(command: string, brain: BrainKind, source: RunSource, opts: { plan?: PlannedTask[]; compareGroup?: string; clientRunId?: string } = {}): { rec: RunRecord; done: Promise<RunRecord> } {
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
          helper, driver, log, signal: abort.signal, plan: opts.plan,
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
  // every press / text insert flashes in the agent's colour where it happened (fast-lane actions have no Cua cursor)
  driver.cuaCursors = false; // the overlay draws each agent's cursor (gliding to every action, at fast-lane speed)
  driver.onAction = (n) => toOverlays({ type: "tap", agent: agentLabel(n.agent), colour: AGENT_COLOURS[n.agent] ?? "#2bb39a", kind: n.kind, via: n.via, x: n.frame.x, y: n.frame.y, w: n.frame.w, h: n.frame.h });

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

  /** the hotkey's words: a job for Backstage, or a question for Onstage */
  async function hotkey(text: string, cursor?: { x: number; y: number }) {
    const q = text.trim();
    if (!q) return onstage.ask(q, cursor);
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
      if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      if (url.pathname === "/api/state") return json(snapshot());

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

      if (req.method === "POST" && url.pathname === "/api/run") {
        const b = await body(req);
        if (!b || typeof b.command !== "string") return json({ ok: false, error: "send {command: string}" }, 400);
        const command = b.command.trim();
        if (!command) return json({ ok: false, error: "type a command first" }, 400);
        if (command.length > MAX_COMMAND) return json({ ok: false, error: `command too long (max ${MAX_COMMAND} characters)` }, 400);
        const clientRunId = typeof b.clientRunId === "string" && b.clientRunId ? b.clientRunId.slice(0, 200) : undefined;
        // a replayed request (Oni retrying after a timeout, or replaying an approved step) gets the SAME run back, never
        // a second real run in real apps
        const existing = clientRunId ? runs.find((r) => r.clientRunId === clientRunId) : undefined;
        if (existing) return json({ ok: true, runId: existing.runId, existing: true });
        const brain: BrainKind = b.brain === "llm" ? "llm" : "jev";
        const err = guard(brain);
        if (err) return json({ ok: false, error: err, busy });
        busy = true;
        const source: RunSource = b.source === "panel" ? "panel" : "api";
        const { rec, done } = execute(command, brain, source, { clientRunId });
        void done.finally(() => { busy = false; changed(); });
        return json({ ok: true, runId: rec.runId });
      }

      // Onstage without the hotkey (Oni): ONLY ever explains — never routed to the agents, so a sentence that sounds like
      // a job can't make anything happen — and never shares the hotkey's screenshot or lesson. `control: true` handles a
      // lesson word (next/back/repeat/stop) and refuses anything that would need a screenshot (`needsCapture`), so a
      // caller can ask for approval only when a screenshot is really about to be taken.
      if (req.method === "POST" && url.pathname === "/api/explain") {
        const b = await body(req);
        if (!b || typeof b.question !== "string" || !b.question.trim()) return json({ ok: false, error: "send {question: string}" }, 400);
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
