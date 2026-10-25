// One agent doing one task in one window:
//   observe (accessibility tree, text only) -> perceive (<=40 controls + text on screen) -> brain decides
//   -> confidence gate (escalate rather than guess) -> act (click / type / key / scroll) -> ... -> "done"?
//   -> verifier reads the screen -> achieved (with the answer) or keep going / give up with a reason.
import type { AxElement, ActionResult, Brain, Choice, Decision, Driver, ExceptionCode, Facts, Helper, Item, Logger, PlanStep, Rect, Task, WindowRef } from "./contracts.ts";
import { stepText } from "./contracts.ts";
import { GATE, isTextInput } from "./decide.ts";
import { LOCKED_MESSAGE, openUrl, restoreMinimized, screenLocked, windowsOf } from "./apps.ts";
import { FileOps, finderFolder, folderIn, listTree, looseFiles, safeRoot, sameFolder } from "./fsops.ts";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { nowIso } from "./logger.ts";
import { asksQuestion, FIND_FIELD, goalValues, MESSAGE_FIELD, openOnly, SEARCH_FIELD, sendIntent, explicitText } from "./compile.ts";
import { PLACEHOLDER, perceive, screenFromMarkdown, screenText, showsPrompt, signature, TEXT_INPUT } from "./perceive.ts";
import { addressBarForbidden, clickBlocked, editAllowed, enterForbidden, typingForbidden } from "./safety.ts";
import { isSaveNameField, parseChord, runSaveDialog, type SaveDeps } from "./savedialog.ts";

export const MAX_STEPS = 25;

/** a step decided in code (no classifier call), for the log */
const codeDecision = (model: string, kind: Decision["kind"] = "click", item?: number): Decision =>
  ({ kind, item, kindConf: 1, gate: 1, backend: "code", model, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 });

/** an action the guards refused (never sent to the app); `cli: "blocked"` tells it apart from a driver refusal */
const refused = (why: string): ActionResult => ({ ok: false, channel: "ax", ms: 0, cli: "blocked", error: { code: "refused", detail: why } });
const blockedBy = (r: ActionResult) => (r.cli === "blocked" ? r.error?.detail ?? "blocked" : undefined);
/** background input refused for a reason a foreground action can get past (Electron fields, apps with 2 windows, a Save panel in its own window) */
const refusedInBackground = (r?: ActionResult) =>
  !!r && !r.ok && (r.error?.code === "background_unavailable" || r.error?.code === "keyboard_ambiguity" || r.error?.code === "minimized_or_hidden" || r.error?.code === "outside_window");
/** the fast lane could not tell whether its press / insert happened (it is not retried by the driver) */
const uncertain = (r?: ActionResult) => !!r && !r.ok && r.effect === "uncertain";
/**
 * Apps measured to ignore key events posted in the background: the call reports success and nothing arrives (live, 6 Oct:
 * "hi" into WhatsApp's compose box, then Return, left it empty and sent nothing). Their message boxes get the text again as
 * real foreground keystrokes when it did not land. WhatsApp is the one measured; add others you see doing the same (the
 * agent's step log shows a message box that stayed empty after "type ... (synthetic_events)") with
 * STAGE_FOREGROUND_TYPING_APPS="Discord, Slack" (names, case-insensitive, matched anywhere in the app's name).
 */
export function ignoresBackgroundKeys(app: string, extra = process.env.STAGE_FOREGROUND_TYPING_APPS ?? ""): boolean {
  const names = ["whatsapp", ...extra.split(",").map((n) => n.trim()).filter(Boolean)];
  return names.some((n) => app.toLowerCase().includes(n.toLowerCase()));
}

/** a search box's OWN clear button: inside it, or right next to it on the same row (never a form's "Clear" that
 *  resets every field) */
export function clearButtonOf(els: AxElement[], f: AxElement): AxElement | undefined {
  const mid = (r: { y: number; h: number }) => r.y + r.h / 2;
  return els.find((e) => e.token && e.role === "AXButton" && /^clear( text)?$/i.test((e.label ?? "").trim()) && (e.parent === f.index ||
    (e.parent === f.parent && !!e.frame && !!f.frame && Math.abs(mid(e.frame) - mid(f.frame)) < f.frame.h / 2 && e.frame.x >= f.frame.x && e.frame.x <= f.frame.x + f.frame.w + 30)));
}

export interface TaskCtx {
  runId: string;
  driver: Driver;
  brain: Brain;
  helper: Helper;
  log: Logger;
  signal: AbortSignal;
  /** test seam: front-app, home folder and waits for the Save panel step (defaults are the real ones) */
  saveDeps?: Partial<SaveDeps>;
  win: WindowRef;
  /** when background input is refused (Electron text fields, apps with 2 windows), retry once in the foreground (counted) */
  allowForeground?: boolean;
  maxSteps?: number;
  onUpdate?: (t: Task) => void;
  sleep?: (ms: number) => Promise<void>;
}

const topOf = (p?: Record<string, number>) =>
  p ? Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ") : "";

const BROWSERS = /safari|chrome|brave|arc|edge|firefox|vivaldi|opera/i;
// a field whose label says it searches (strict: not SEARCH_FIELD's "address"/"location" or FIND_FIELD's "name"/"number",
// where Enter could submit a form), and a goal that is a search
const SEARCH_BOX = /\b(search|find|filter)\b/i;
const SINGLE_LINE = new Set(["AXTextField", "AXSearchField", "AXComboBox"]);
const SEARCH_GOAL = /\b(search(es|ing)?|look(s|ing)? up|find|google)\b/i;
/** apps that open a link of their own (a folder, a maps:// route, a stocks:// symbol) */
const URL_APPS = /^(Finder|Maps|Stocks)$/;

/** browser tabs: AXRadioButtons whose parent is the window itself (Brave, Chrome and Safari all expose them this way) */
/** how much two rectangles overlap, as a share of the smaller one (1 = one sits inside the other) */
export function overlapShare(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

function tabsOf(obs?: { elements: any[] }): { label?: string }[] {
  const els = obs?.elements ?? [];
  const byIndex = new Map(els.map((e) => [e.index, e]));
  return els.filter((e) => e.role === "AXRadioButton" && byIndex.get(e.parent)?.role === "AXWindow");
}

export async function runTask(ctx: TaskCtx, task: Task): Promise<Task> {
  const { driver, brain, helper, log, signal } = ctx;
  let win = ctx.win;
  task.windowId = win.windowId;
  const allowForeground = ctx.allowForeground ?? true;
  // set once an app turns out to be slow to read (e.g. Notes with hundreds of notes): a shallower, longer read
  let slowOpts: { timeoutMs: number; maxDepth?: number } | undefined;
  // the agent's own text: field -> the exact value the agent left in it. A field still holding exactly that is the
  // agent's work (a note that merely CONTAINS the same words is not)
  const wrote = new Map<string, string>();
  const typedInto = new Map<string, string>(); // field -> the text typed into it (not again, even if unreadable)
  const submittedSearch = new Set<string>(); // field|term already submitted with Enter (once each)
  const uncertainTyped = new Set<string>(); // field|text whose insert may or may not have happened
  const retriedTyping = new Set<string>(); // ... and was retried once already
  const sendAsked = sendIntent(task.goal);
  /** "send a message that says: hi" -> "hi": a goal that sends a message is not done until this task has sent one */
  const sendText = sendAsked && /\b(send|reply)\b[^.]*\b(message|dm|text)\b/i.test(task.goal) ? explicitText(task.goal) : null;
  let messageSent = false;
  // a text field is known by its POSITION, and what it is for by the FIRST label it had: some apps rename a field to
  // its contents (WhatsApp: "Name, number, @username" becomes "+91 83096 51677" once typed into)
  const firstLabel = new Map<string, string>();
  /** names compared by their letters and digits only: accessibility spells numbers out ("+ 9 1,8 3 0 9 6,5 1 6 7 7")
   *  and adds marks and punctuation, so "+91 83096 51677" must match "+ 9 1,8 3 0 9 6,5 1 6 7 7, You" */
  const compact = (x: string) => (x ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  /** the open content is about `name`: its title (top of the window, right of any sidebar) starts with it */
  const headed = (o: { elements: AxElement[] }, name: string) => {
    const winEl = o.elements.find((e) => e.role === "AXWindow" && e.frame);
    const W = winEl?.frame;
    return o.elements.some((e) => e.frame && !TEXT_INPUT.has(e.role) && compact(e.label ?? "").startsWith(compact(name)) &&
      (!W || (e.frame.y < W.y + 110 && e.frame.x > W.x + W.w * 0.3)));
  };
  const notReached = new Set<string>(); // clicked, but it did not become the open content
  // a field's identity follows it when it shifts or grows (a toolbar search box widens once it holds text: Dictionary):
  // the same role, overlapping where it was, is the same field. An exact-position key made typing look like it landed
  // in "another" field, which the agent then undid
  const knownFields: { key: string; role: string; frame: Rect }[] = [];
  const fieldKey = (e?: AxElement) => {
    if (!e?.frame) return "";
    const hit = knownFields.find((k) => k.role === e.role && overlapShare(k.frame, e.frame!) >= 0.6);
    if (hit) { hit.frame = e.frame; return hit.key; }
    const key = `${e.role}@${Math.round(e.frame.x)},${Math.round(e.frame.y)}`;
    knownFields.push({ key, role: e.role, frame: e.frame });
    return key;
  };
  /** a field's identity: its position; without a frame, its role and order among the window's fields of that role */
  const fieldId = (o: { elements: AxElement[] }, token: string | undefined, role: string) => {
    const e = o.elements.find((x) => x.token === token);
    if (e?.frame) return fieldKey(e);
    return `${role}#${Math.max(0, o.elements.filter((x) => x.role === role).indexOf(e!))}`;
  };
  const owns = (id: string, value: string) => wrote.has(id) && norm(wrote.get(id)) === norm(value);
  let lastTyped: { id: string; label: string; text: string; foreground: boolean } | undefined;
  /** the step at which a message was sent by pressing the app's Send button (a Return right after must not send it again) */
  let justSentAt = -99;
  const retyped = new Set<string>(); // one re-type per field and text (not one for the whole task)
  let baseline: string[] | undefined; // the screen text when the task started
  let waitedAfterSend = false;
  let fileOps: FileOps | undefined;
  // opening sites: the browser's tab strip is the ground truth (tabs are AXRadioButtons directly under the window)
  let opened: { expect: number; tabsBefore: number; windowId: number; urls: string[] } | undefined;
  let savedDoc: { path: string; checked: boolean; openedIn?: string } | undefined; // a document saved by code (save_as)
  let safetyReplans = 0;
  let replayOff = false; // a compiled replay press that failed: the rest of the task is decided step by step
  const searchedFor = new Set<string>(); // things the agent already searched for (once each)
  const reached = new Set<string>(); // things the goal asks to reach that the agent already clicked (once each)
  const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = ctx.maxSteps ?? MAX_STEPS;
  const agent = task.agent;
  const t0 = performance.now();
  task.status = "running";
  const update = (now?: string) => {
    task.now = now;
    task.seconds = (performance.now() - t0) / 1000;
    ctx.onUpdate?.(task);
  };
  const finish = (code: ExceptionCode | null, reason = "", answer?: string): Task => {
    task.seconds = (performance.now() - t0) / 1000;
    task.status = code ? "failed" : "done";
    if (code) task.exception = { code, reason };
    if (answer !== undefined) task.answer = answer;
    task.now = undefined;
    log.write({ type: "task_end", runId: ctx.runId, t: nowIso(), task });
    ctx.onUpdate?.(task);
    return task;
  };

  const prev: string[] = [];
  const tried: string[] = [];
  let lastSig = "";
  let focusOnly = false; // the last action only put the cursor in a text field (nothing visible is expected to change)
  let idle = 0;
  // separate counts of what went wrong on THIS screen (all reset when it changes): the same choice again, a guard
  // refusing, the driver failing. Two unrelated incidents ten steps apart must not add up to a stall
  let sameChoice = 0;
  let blockedHere = 0;
  let failedHere = 0;
  let uncertainRetried = false; // one retry of an action whose effect was uncertain, on an unchanged screen
  const resetCounts = () => { sameChoice = 0; blockedHere = 0; failedHere = 0; uncertainRetried = false; };
  let notDone = 0;
  let notDoneReason: string | undefined;
  let pictureRead = false; // the picture fallback for reading an answer: once per task
  let searchOpenedAt = -99; // the step when the agent last pressed a "Search" control
  let plan: PlanStep[] | undefined;
  let planPos = 0;
  let planSource = "none"; // where the current plan came from (per call, not a helper-wide field shared by agents)
  const usePlan = brain.kind === "jev"; // the LLM arm decides every step itself, like a normal LLM agent
  let freeMode = false; // no plan available: jev decides step by step from the goal alone
  const planActive = () => usePlan && !!plan && !freeMode;
  // every LLM call is recorded with the reason it was needed. A pure-LLM helper (HELPER=haiku) counts every call.
  const llmHelper = helper.canEscalate === undefined;

  const makePlan = async (screen: string[], items: Item[], why?: string, obsForFiles?: { elements: unknown[] }) => {
    update(why ? "re-planning" : "planning");
    // Finder: the compiler needs the real file names (from the file system, not from Finder's view)
    let files: string[] | undefined;
    if (task.app === "Finder" && obsForFiles) {
      const dir = finderFolder(obsForFiles as any);
      if (dir && !safeRoot(dir)) files = looseFiles(dir);
    }
    const r = await helper.plan(task.goal, task.app, screen, items, why, files);
    task.counts.helperCalls++;
    task.cost.helperUsd += r.costUsd;
    plan = r.steps;
    planPos = 0;
    // several explicit moves -> one sort_into: the cheap classifier decides each file's folder (and may leave unclear ones)
    const moves = plan.filter((s) => s.action === "move_file");
    const folders = plan.filter((s) => s.action === "make_folder").map((s) => s.text ?? "").filter(Boolean);
    if (brain.choose && moves.length >= 3 && folders.length >= 2) {
      plan = [{ action: "sort_into", text: [...new Set([...folders, ...moves.map((m) => m.text ?? "")])].filter(Boolean).join(", ") }];
    }
    // SAFETY, in code: a task that CREATES something in a window showing existing content starts with the app's
    // own "New ..." button (New Note, New Document, ...) even if the planner forgot it
    const creates = /\b(create|write|make|new|add|draft|compose)\b/i.test(task.goal);
    const existing = items.some((i) => i.role === "AXTextArea" && i.state === "filled");
    const newBtn = items.find((i) => (i.role === "AXButton" || i.role === "AXMenuButton") && /^new\b/i.test(i.text));
    const willType = plan.some((s) => s.action === "type"); // only matters when the agent is about to WRITE text
    if (creates && willType && existing && newBtn && !plan.some((s) => s.action === "click" && /^new\b/i.test(s.target ?? ""))) {
      plan.unshift({ action: "click", target: newBtn.text });
    }
    task.plan = plan;
    planSource = (r as { source?: string }).source ?? (llmHelper ? "llm" : "none");
    freeMode = plan.length === 0; // an empty plan never means "finished": jev carries on step by step
    log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "plan", detail: `[${planSource}] ` + (plan.length ? plan.map(stepText).join(" → ") : "(no plan: jev decides step by step)"), costUsd: r.costUsd, ms: r.ms });
  };

  const noteLlm = (what: string) => task.llmCalls.push(what);
  let escalations = 0;
  let curObs: { elements: unknown[] } | undefined;
  /**
   * Why a browser's own address bar may not be used, or null (it is not one, or the app is no browser). The element is
   * found by token among `els` (what the agent last read, unless given). Sites open with open_url: nothing is ever typed
   * there, and no Enter pressed in it, whoever chose it (jev, a plan, the search for a missing contact, code).
   */
  const addressBarOf = (token: string | undefined, els: AxElement[] = (curObs?.elements ?? []) as AxElement[]): string | null => {
    if (!token || !BROWSERS.test(task.app)) return null;
    const e = els.find((x) => x.token === token);
    return e ? addressBarForbidden(els, e) : null;
  };
  /** jev is stuck: ask the LLM for a plan from the CURRENT screen, once or twice per task. false = no LLM available */
  const escalate = async (p: { screen: string[]; items: Item[] }, reason: string): Promise<boolean> => {
    if (!usePlan || llmHelper || !helper.canEscalate || escalations >= 2) return false;
    escalations++;
    noteLlm(`plan (jev stuck: ${reason.slice(0, 90)})`);
    await makePlan(p.screen, p.items, `jev was stuck: ${reason}`, curObs).catch(() => {});
    idle = 0; resetCounts(); tried.length = 0;
    return (plan?.length ?? 0) > 0;
  };

  /**
   * EVERY click the agent makes goes through here: the Send rule, the irreversible rule (also for a dialog's OK) and
   * Stop are checked right before acting, whoever chose the target (jev, a plan, a search result, code).
   */
  const guardedClick = async (token: string, label: string, role: string, els: AxElement[]): Promise<ActionResult> => {
    if (signal.aborted) return refused("stopped by the user");
    const why = clickBlocked({ role, label, token }, task.goal, els);
    if (why) return refused(why);
    const r = await driver.click(agent, win, token);
    // refused in the background (a Save panel is its own window: Cua will not attribute its controls to this one):
    // one counted foreground retry, the rung Cua itself recommends
    if (refusedInBackground(r) && allowForeground && !signal.aborted) {
      task.counts.foreground++;
      return driver.click(agent, win, token, true);
    }
    return r;
  };
  /** submit a search field: a real Return first (live, App Store ignored the field's accessibility "confirm" and only a
   * key press ran the search), the accessibility confirm when keys are refused in the background */
  const submitField = async (token: string, actions?: string[]): Promise<ActionResult> => {
    const bar = addressBarOf(token);
    if (bar) return refused(bar);
    const r = await driver.pressKey(agent, win, "return", token);
    if (r.ok || !actions?.includes("AXConfirm")) return r;
    return driver.confirm(agent, win, token);
  };

  const typeInto = async (token: string, text: string, foreground?: boolean, role?: string, searchBox?: AxElement): Promise<ActionResult> => {
    if (signal.aborted) return refused("stopped by the user");
    const bar = addressBarOf(token);
    if (bar) return refused(bar);
    // a SEARCH box filters as keys arrive, and a value set through accessibility fires nothing (live: Font Book's box
    // held "Helvetica" while the list stayed unfiltered; typed, 147 rows became the Helvetica family). So type it for
    // real, read it back, and set the whole text only if keys were dropped (live: Weather's "Tokyo" became "oy")
    if (searchBox?.frame && role && SINGLE_LINE.has(role) && !BROWSERS.test(task.app) && !foreground) {
      const t = await driver.typeText(agent, win, token, text);
      if (t.ok) {
        const now = (await driver.observe(agent, win)).elements.find((e) => e.token && e.role === role && e.frame && overlapShare(e.frame, searchBox.frame!) > 0.8);
        if (now?.value !== undefined && norm(now.value) === norm(text)) return t;
        const fix = now?.token ? await driver.setValue(agent, win, now.token, text) : undefined;
        return fix?.ok ? fix : t;
      }
    }
    // any other native single-line field gets its whole text SET (complete and instant): background keystrokes drop
    // letters in SwiftUI fields, and setting it still brings up the app's suggestions. Same result as typing, since these
    // fields are emptied first. Not in browsers (some pages react only to real key presses) and not in a foreground retry
    if (role && SINGLE_LINE.has(role) && !BROWSERS.test(task.app) && !foreground) {
      const r = await driver.setValue(agent, win, token, text);
      if (r.ok) return r;
    }
    return driver.typeText(agent, win, token, text, foreground);
  };

  /**
   * Browsers: the page text must belong to the tab the window shows. Safari sometimes keeps exposing ANOTHER tab's page
   * (seen in tests: window titled "how tall Lion Rock…", page text from an older "population of Hong Kong" tab), and
   * the agent would then read and verify the wrong page. Compare the live window title with the page's title; on a
   * mismatch, wait and re-read, then press the browser's Reload button once.
   */
  const freshPage = async (o: Awaited<ReturnType<Driver["observe"]>>) => {
    const key = (s?: string) => (s ?? "").toLowerCase().replace(/\s+-\s+(brave|google chrome|chrome|safari|arc)$/i, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 30);
    const liveTitle = async () => (await driver.listWindows().catch(() => ({ windows: [] as any[] }))).windows.find((w: any) => w.window_id === win.windowId)?.title as string | undefined;
    const matches = (x: typeof o, title?: string) => {
      const page = x.elements.find((e) => e.role === "AXWebArea")?.label;
      return !title || !page ? !title || page !== undefined : key(page) === key(title) || key(title).startsWith(key(page)) || key(page).startsWith(key(title));
    };
    let title = await liveTitle();
    if (title) o = { ...o, window: { ...o.window, title } };
    for (let attempt = 0; attempt < 4 && !matches(o, title); attempt++) {
      if (attempt === 2) {
        const reload = o.elements.find((e) => e.role === "AXButton" && /^reload( this page)?$/i.test(e.label ?? "") && e.token);
        if (reload?.token) {
          update("the page shown is stale: reloading");
          const r = await guardedClick(reload.token, reload.label ?? "", reload.role, o.elements).catch(() => undefined);
          if (r && !blockedBy(r)) task.counts.actions++;
        }
      } else update("waiting for the page to load");
      await sleep(attempt === 2 ? 2000 : 1000);
      const again = await driver.observe(agent, win, slowOpts);
      title = (await liveTitle()) ?? title;
      if (again.elements.length) o = { ...again, window: { ...again.window, title: title ?? again.window.title } };
    }
    return o;
  };

  /** returns the finished task if the goal is achieved (or given up on), undefined to keep going */
  const checkDone = async (p: { screen: string[]; items: Item[] }, why: string): Promise<Task | undefined> => {
    update("checking the result");
    // a goal that sends a message is not achieved until THIS task has sent one, whatever the page shows: new text on the
    // inbox, or an older identical message in the chat. (Live, 6 Oct: the plan only opened Instagram's inbox, the verifier
    // saw 65 new lines and said done; Oni told the user it was sent. Nothing was typed.)
    if (sendText && !messageSent) {
      const reason = "the message has not been sent yet: open the chat with the person, type the message and send it";
      log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `${why} → NOT achieved: ${reason} (checked in code)`, costUsd: 0, ms: 0 });
      notDone++;
      notDoneReason = reason;
      prev.push(`(checked: ${reason})`);
      if (notDone >= 3) return finish("not_achieved", `the message was never sent: ${reason}`);
      if (usePlan) {
        if (llmHelper) { noteLlm("re-plan"); await makePlan(p.screen, p.items, reason).catch(() => {}); }
        else if (!(await escalate(p, `not done yet: ${reason}`))) { freeMode = true; plan = []; planPos = 0; }
      }
      return undefined;
    }
    // a planned save is part of the goal: not done until the file is saved
    if (!savedDoc && plan?.some((s, i) => s.action === "save_as" && i >= planPos)) return undefined;
    // a document saved in code is checked in code: the file exists and holds the text from the window
    if (savedDoc && plan?.length && planPos >= plan.length) {
      if (savedDoc.checked) return finish(null, "", `saved ${savedDoc.path.replace(homedir(), "~")}${savedDoc.openedIn ? ` and opened it in ${savedDoc.openedIn}` : ""}`);
      return finish("not_achieved", `the document was not saved correctly: ${savedDoc.path}`);
    }
    // a plan that only OPENS sites is checked by counting tabs, not by reading the page (a window title shows one tab only)
    // (never for a question: "find how tall X is" also compiles to one open step, but it needs the answer read off the page)
    if (opened && plan?.length && plan.every((s) => s.action === "open_url") && opened.windowId === win.windowId && openOnly(task.goal)) {
      const tabs = tabsOf(curObs as any);
      const added = tabs.length - opened.tabsBefore;
      if (added >= opened.expect) {
        const titles = tabs.slice(-opened.expect).map((t) => t.label ?? "").join(" | ");
        log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `${why} → achieved: ${added} new tab(s) in the window (checked in code: ${titles.slice(0, 200)})`, costUsd: 0, ms: 0 });
        const where = opened.tabsBefore === 0 ? "in a new window" : "as new tabs";
        return finish(null, "", `opened ${where}: ${opened.urls.map((u) => u.replace(/^https?:\/\//, "")).join(", ")}`.slice(0, 300));
      }
      // fewer tabs than asked (e.g. Safari hides the tab strip for a single tab): fall through to the verifier
    }
    // for file tasks the file system itself is the ground truth: give the verifier the real folder contents
    const evidence = fileOps ? [`(contents of ${fileOps.root}, read from the file system:)`, ...listTree(fileOps.root)] : [];
    const verify = () => helper.verify(task.goal, [...evidence, ...p.screen], p.items, baseline, { acted: task.counts.actions > 0 });
    // a jev blip must not turn a finished task into an error: one retry
    const v = await verify().catch(async () => { await sleep(500); return verify(); });
    task.counts.helperCalls++;
    task.cost.helperUsd += v.costUsd;
    if (v.llm || llmHelper) noteLlm(llmHelper ? "verify" : "verify (jev borderline)");
    log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `${why} → ${v.achieved ? "achieved" : "NOT achieved"}: ${v.answer} (${v.reason})`, costUsd: v.costUsd, ms: v.ms });
    // (LLM plans are never cached: they are re-plans made from window text, and an injected plan would become
    // permanent once it "verified". Compiled plans need no cache.)
    if (v.achieved) return finish(null, "", v.answer);
    // a question the window's TEXT can't answer, in an app that draws its content without accessibility (live: App
    // Store's search results aren't in the tree at all): read the answer off one picture of THIS window, once per task.
    // Read only — nothing is clicked from a picture — and the picture is deleted right after
    // Also a search whose results aren't in the tree (live: Music showed Taylor Swift's results, but its tree held only
    // the search box): the picture says whether results for the term are shown
    const searched = !asksQuestion(task.goal) ? task.goal.match(/\bsearch(?:es|ed)?\s+(?:for\s+)?["“]?(.+?)["”]?\s*[.?!]?$/i)?.[1] : undefined;
    if ((asksQuestion(task.goal) || searched) && !pictureRead && task.counts.actions > 0 && helper.readPicture && driver.windowPicture && !signal.aborted) {
      pictureRead = true;
      const png = await driver.windowPicture(agent, win).catch(() => undefined);
      if (png) {
        // "found" must mean results are SHOWN: live, asked "does it show results?", the reader answered "No. … no search
        // results are displayed" with found=true, and the task was reported done
        const question = searched ? `Name the first few search results shown for "${searched}" (results, not the term typed in a search box). If no results are shown, it is not found.` : task.goal;
        const pr = await helper.readPicture(question, png).catch(() => undefined);
        try { rmSync(png, { force: true }); } catch { /* gone */ }
        if (pr) {
          task.cost.helperUsd += pr.costUsd;
          noteLlm("read the answer from a picture of the window");
          log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `picture of the window → ${pr.found ? `found: ${pr.answer}` : "not shown"}`, costUsd: pr.costUsd, ms: pr.ms });
          // and a reader that says "no" in its answer did not find it, whatever its flag says
          if (pr.found && !/^\s*(no|none|not|nothing|there (are|is) no)\b/i.test(pr.answer)) return finish(null, "", `${pr.answer} (read from a picture of the ${task.app} window)`);
        }
      }
    }
    notDone++;
    notDoneReason = v.reason;
    prev.push(`(checked: the screen does not show the goal achieved yet: ${v.reason})`);
    if (notDone >= 3) return finish("not_achieved", `the screen does not show the goal achieved: ${v.reason}`);
    if (usePlan) {
      if (llmHelper) { noteLlm("re-plan"); await makePlan(p.screen, p.items, v.reason).catch(() => {}); }
      else if (!(await escalate(p, `not done yet: ${v.reason}`))) { freeMode = true; plan = []; planPos = 0; } // no LLM: jev carries on alone
    }
    return undefined;
  };

  for (let step = 1; step <= max; step++) {
    if (signal.aborted) return finish("stopped", "stopped by the user");
    task.steps = step;

    update("reading the window");
    let obs = await driver.observe(agent, win, slowOpts);
    const learnFields = (o: typeof obs) => { for (const e of o.elements) if (TEXT_INPUT.has(e.role) && e.frame && !firstLabel.has(fieldKey(e))) firstLabel.set(fieldKey(e), e.label ?? ""); };
    learnFields(obs);
    if (obs.truncated && !slowOpts && !BROWSERS.test(task.app)) {
      // the accessibility walk ran out of time (it gets lost in long lists): read the top levels only, with more time.
      // Measured on Notes with many notes: depth 4 = 3.8 s and complete (toolbar + note body); depth 6+ timed out at 10 s.
      // "truncated" also means "hit the element cap" (a long web page): a shallower read must be complete or read more.
      // Browsers never take this path: a depth-3 read of a web page is just the window frame (Wikipedia: 3 lines).
      update("reading the window (slow app)");
      const full = obs;
      let best = obs;
      for (const maxDepth of [4, 3]) {
        const o = await driver.observe(agent, win, { timeoutMs: 10000, maxDepth });
        // a COMPLETE read wins (Notes: depth 4 is complete, the full read timed out); among cut-off reads, the larger one
        const better = (!o.truncated && best.truncated) || (o.truncated === best.truncated && o.elements.length > best.elements.length);
        if (better && o.elements.length) { best = o; slowOpts = { timeoutMs: 10000, maxDepth }; }
        if (!o.truncated) break;
      }
      obs = best;
      if (best === full) slowOpts = { timeoutMs: 10000 }; // the full read was the best: keep reading fully, with more time
    }
    for (let retry = 0; obs.elements.length === 0 && retry < 2; retry++) {
      // often transient (an app that was just brought forward and back, a window still opening): wait, re-pick, re-read
      await sleep(900);
      await restoreMinimized(task.app).catch(() => false); // the user minimised it during the task
      const ws = await windowsOf(driver, task.app).catch(() => [] as WindowRef[]);
      // the same window again after a failed read only if there is no other one
      win = (retry === 0 ? ws.find((w) => w.windowId === win.windowId) : ws.find((w) => w.windowId !== win.windowId)) ?? ws[0] ?? win;
      task.windowId = win.windowId;
      obs = await driver.observe(agent, win, slowOpts);
    }
    if (obs.elements.length === 0) {
      // the screen locked during the task: say that, not a puzzle about one app's window
      if (await screenLocked()) return finish("window_lost", LOCKED_MESSAGE);
      return finish("window_lost", `could not read the ${task.app} window (${obs.degraded ?? "empty"}). Is it closed, minimised, or in full screen?`);
    }
    if (BROWSERS.test(task.app) && opened) obs = await freshPage(obs); // only pages the agent opened (never reload the user's page)
    const nextStep = planActive() ? plan![planPos] : undefined;
    const p = perceive(obs, task.goal, undefined, nextStep?.target ?? "");
    if (!baseline) baseline = p.screen;
    const sig = signature(p);
    if (sig === lastSig) { if (!focusOnly) idle++; }
    else {
      idle = 0;
      tried.length = 0;
      resetCounts();
    }
    focusOnly = false;
    lastSig = sig;
    if (idle >= 3 && !(await escalate(p, "three actions changed nothing on screen"))) return finish("stalled", "three actions in a row changed nothing on screen");

    curObs = obs;
    if (usePlan && !plan) {
      try {
        if (llmHelper) noteLlm("plan");
        await makePlan(p.screen, p.items, undefined, obs);
      } catch (e: any) {
        return finish("error", `planning failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    if (signal.aborted) return finish("stopped", "stopped by the user"); // stop as soon as possible: planning and reading take seconds
    // the plan is finished: check the screen directly (no classifier call needed). If the last action SENT something
    // (Enter / confirm), give the app a moment to answer first (chat apps reply after a few seconds)
    if (planActive() && planPos >= plan!.length && !waitedAfterSend && /^(press return|confirm )/.test(prev[prev.length - 1] ?? "")) {
      waitedAfterSend = true;
      update("waiting for the app to respond");
      await sleep(3000);
      continue;
    }
    if (planActive() && planPos >= plan!.length) {
      const r = await checkDone(p, "plan finished");
      if (r) return r;
      continue;
    }

    // a planned open_url needs no decision: the code opens the address without the keyboard
    if (planActive() && plan![planPos]?.action === "open_url" && !(BROWSERS.test(task.app) || URL_APPS.test(task.app))) {
      // an LLM plan once tried to "open icloud.com/pages" inside Notes: addresses only open in a browser or Finder
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("open_url"), acted: `skipped: open url only works in a browser or Finder, not in ${task.app}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
      planPos++;
      continue;
    }
    // a key chord (Cmd+Shift+G ...): the step's text is the chord. Foreground, because a native menu key-equivalent ignores a
    // chord posted in the background; disclosed and counted like every foreground action
    if (planActive() && plan![planPos]?.action === "hotkey") {
      const t1 = performance.now();
      const chord = parseChord(plan![planPos]!.text);
      const tokenEl = plan![planPos]!.target ? p.items.find((i) => i.text === plan![planPos]!.target && i.token) : undefined;
      let acted: string;
      const res: ActionResult[] = [];
      if (!chord) acted = `blocked: "${plan![planPos]!.text ?? ""}" is not a key chord (modifiers, then one key: cmd+shift+g)`;
      else if (!driver.hotkey) acted = "blocked: this driver has no key chords";
      else {
        // never twice: a chord has no read-back, so a background try followed by a foreground one could fire it two times
        const r = await driver.hotkey(agent, win, chord, tokenEl?.token, allowForeground);
        res.push(r);
        if (allowForeground) task.counts.foreground++;
        task.counts.actions++;
        acted = `press ${chord.join("+")}${r.channel === "foreground" ? " (foreground)" : ""}${r.ok ? "" : ` FAILED (${r.error?.detail ?? r.effect})`}`;
      }
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("hotkey"), acted, results: res, ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (acted.startsWith("blocked")) return finish("not_achieved", acted);
      await sleep(400);
      continue;
    }
    // an open Save / Open panel: folder, name and Save done in code (savedialog.ts). The step's text is a folder or a full file path
    if (planActive() && plan![planPos]?.action === "save_dialog") {
      const t1 = performance.now();
      update("filling the Save panel");
      const r = await runSaveDialog(plan![planPos]!.text ?? "", { driver, agent, win, allowForeground, sleep, signal, ...ctx.saveDeps });
      task.counts.scripted++;
      task.counts.actions += r.results.length;
      task.counts.foreground += r.foreground;
      const acted = r.ok ? r.detail : `Save panel FAILED: ${r.detail} (${r.steps.join(" > ")})`;
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("save_dialog"), acted, results: r.results, ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (!r.ok) return finish("not_achieved", acted);
      // the new file on disk is the proof, and the panel is gone: the generic "did the screen change" check would find
      // nothing to see, call the task not done and replan against a closed panel (live: a saved file, a failed task)
      if (planPos >= plan!.length) return finish(null, "", acted);
      continue;
    }
    if (planActive() && plan![planPos]?.action === "save_as") {
      // scripted (disclosed): the text in THIS window is converted by macOS's textutil into a real document file
      const fmt = /^(docx|doc|rtf|odt|html)$/i.test(plan![planPos]!.text ?? "") ? plan![planPos]!.text!.toLowerCase() : "docx";
      const codeDec = codeDecision("save_as");
      const t1 = performance.now();
      const area = obs.elements.filter((e) => e.role === "AXTextArea" && (e.value ?? "").trim()).sort((a, b) => (b.value?.length ?? 0) - (a.value?.length ?? 0))[0];
      const content = area?.value ?? "";
      let acted: string;
      if (!content.trim()) acted = "blocked: there is no text in the window to save";
      else {
        const title = (content.split("\n").find((l) => l.trim()) ?? "Document").replace(/[\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Document";
        const dir = join(homedir(), "Documents", "Backstage");
        mkdirSync(dir, { recursive: true });
        let path = join(dir, `${title}.${fmt}`);
        for (let n = 2; existsSync(path); n++) path = join(dir, `${title} ${n}.${fmt}`); // never overwrite
        // textutil reads a file: the window's text goes through a scratch file that is deleted right after
        const tmp = join(import.meta.dir, "..", "runs", ctx.runId, `${task.id}-save.txt`);
        mkdirSync(join(import.meta.dir, "..", "runs", ctx.runId), { recursive: true });
        writeFileSync(tmp, content);
        const conv = (() => { try { return Bun.spawnSync(["textutil", "-convert", fmt, "-output", path, tmp]); } finally { rmSync(tmp, { force: true }); } })();
        // read the saved file back: it must hold the text from the window
        const back = existsSync(path) ? Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", path]).stdout.toString() : "";
        const checked = conv.exitCode === 0 && norm(back).includes(norm(content).slice(0, 80));
        savedDoc = { path, checked };
        task.counts.scripted++;
        task.counts.actions++;
        acted = checked ? `saved the text as ${path.replace(homedir(), "~")} (scripted: textutil, read back and checked)` : `saving as ${fmt} FAILED (${conv.stderr.toString().slice(0, 100)})`;
        const viewer = plan![planPos]!.target;
        if (checked && viewer) {
          const app = (await driver.listApps().catch(() => [])).find((a) => a.name === viewer);
          if (app) {
            await driver.launchApp(agent, app.bundle_id, [path]).catch(() => {});
            savedDoc.openedIn = viewer;
            acted += `, opened in ${viewer} (background)`;
          }
        }
      }
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (!savedDoc) return finish("not_achieved", acted);
      continue;
    }
    if (planActive() && plan![planPos]?.action === "open_url" && plan![planPos]!.text && task.bundleId) {
      const url = plan![planPos]!.text!;
      update(`opening ${url}`);
      const t1 = performance.now();
      let acted = `open ${url}`;
      const tabsHere = tabsOf(obs).length, winHere = win.windowId;
      try {
        // opening can wait several seconds for the page: "stop" doesn't wait for it
        const stopped = new Promise<"stopped">((res) => (signal.aborted ? res("stopped") : signal.addEventListener("abort", () => res("stopped"), { once: true })));
        const r = await Promise.race([openUrl(driver, agent, { name: task.app, bundle_id: task.bundleId, running: true }, url, plan![planPos]!.target === "new window"), stopped]);
        if (r === "stopped") return finish("stopped", "stopped by the user");
        win = r.win;
        task.windowId = win.windowId;
        if (r.tookFront) { task.counts.foreground++; acted += " (the browser came to the front; your app was put back)"; }
        task.counts.actions++;
        const urls = url.split(/\s+/).filter(Boolean);
        const same = opened?.windowId === winHere;
        opened = r.win.windowId === winHere
          ? { expect: (same ? opened!.expect : 0) + urls.length, tabsBefore: same ? opened!.tabsBefore : tabsHere, windowId: winHere, urls: [...(same ? opened!.urls : []), ...urls] }
          : { expect: urls.length, tabsBefore: 0, windowId: r.win.windowId, urls }; // a new window: every tab in it was opened now
      } catch (e: any) {
        acted = `open ${url} FAILED: ${String(e?.message ?? e).slice(0, 120)}`;
      }
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("open_url"), acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (task.app === "Maps" && /daddr=/.test(url)) {
        // a background Maps window takes 3-11 s to show a new route, and shows the OLD route's time meanwhile: wait for
        // the destination to be filled in and a travel time that wasn't there before (or any time after 6 s: same route)
        update("waiting for Maps to plan the route");
        const dest = decodeURIComponent(url.match(/daddr=([^&]+)/)![1]!).toLowerCase();
        const TIME = /\b\d+\s*(min|hr|h)\b/i;
        const oldTimes = new Set(p.screen.filter((l) => TIME.test(l)));
        const t2 = performance.now();
        while (performance.now() - t2 < 15000 && !signal.aborted) {
          await sleep(1000);
          const o = await driver.observe(agent, win);
          const lines = o.markdown ? screenFromMarkdown(o.markdown) : screenText(o.elements);
          const hasDest = lines.some((l) => l.toLowerCase().includes(dest));
          const times = lines.filter((l) => TIME.test(l));
          if (hasDest && (times.some((l) => !oldTimes.has(l)) || (times.length && performance.now() - t2 > 6000))) break;
        }
        continue;
      }
      await sleep(task.app === "Stocks" ? 2000 : 1200); // let the page start loading
      continue;
    }

    // Weather: switch to a city in code (the search lists airports and look-alikes first; jev and the LLM both
    // picked "Hong Kong International Airport" or nothing): clear the search, type the city, pick the result that
    // STARTS with the city's name and isn't an airport
    if (planActive() && plan![planPos]?.action === "pick_city" && task.app === "Weather") {
      const city = plan![planPos]!.text ?? "";
      const t1 = performance.now();
      update(`looking up ${city}`);
      let acted = `searched Weather for ${city}: no search field`;
      const isField = (e: AxElement) => (e.role === "AXTextField" || e.role === "AXSearchField") && !!e.token;
      let field = obs.elements.find(isField);
      if (field?.token) {
        // the search field's own clear button (never another "Clear"); without one, the search text is set to empty
        const clear = clearButtonOf(obs.elements, field);
        if (clear?.token) {
          await guardedClick(clear.token, clear.label ?? "", clear.role, obs.elements);
          await sleep(300);
          field = (await driver.observe(agent, win)).elements.find(isField) ?? field; // the cleared field is a new element
        }
        // emptied either way: a clear button doesn't always clear, and a leftover term turns "Tokyo" into "Tokyo <old
        // text>", which matches no city (live)
        await driver.setValue(agent, win, field.token!, "").catch(() => undefined);
        // put the cursor in the field first: text typed into an unfocused search field goes nowhere (reported as ok)
        await guardedClick(field.token!, field.label ?? "", field.role, obs.elements);
        await sleep(300);
        const o1 = await driver.observe(agent, win);
        field = o1.elements.find(isField) ?? field;
        await typeInto(field.token!, city, false, field.role);
        // read back: anything but the city alone gets one clean retry
        const typedField = (await driver.observe(agent, win)).elements.find(isField);
        if (typedField?.token && typedField.value !== undefined && norm(typedField.value) !== norm(city)) {
          await driver.setValue(agent, win, typedField.token, "").catch(() => undefined);
          await typeInto(typedField.token, city, false, typedField.role);
          field = typedField;
        }
        const noEnter = enterForbidden(o1.elements, field.token, task.goal);
        if (!noEnter && !signal.aborted) await driver.pressKey(agent, win, "return", field.token);
        task.counts.actions += noEnter ? 1 : 2;
        acted = noEnter ? `searched Weather for ${city}: Enter blocked (${noEnter})` : `searched Weather for ${city}: no matching result`;
        const want = city.toLowerCase();
        for (let i = 0; i < 8 && !signal.aborted; i++) {
          await sleep(500);
          const o = await driver.observe(agent, win);
          const text = (e: AxElement) => (e.label || e.value || "").trim();
          const match = o.elements
            .filter((e) => /^AX(Button|Cell|Row|StaticText|GenericElement)$/.test(e.role) && text(e).toLowerCase().startsWith(want) && !/airport/i.test(text(e)))
            .sort((a, b) => text(a).length - text(b).length)[0];
          // the matching text may be a plain label inside a clickable row: click the nearest clickable ancestor
          let hit: AxElement | undefined = match;
          for (let k = 0; hit && !hit.token && k < 4; k++) hit = hit.parent !== undefined ? o.elements.find((e) => e.index === hit!.parent) : undefined;
          if (match && hit?.token) {
            const r = await guardedClick(hit.token, text(hit) || text(match), hit.role, o.elements);
            if (blockedBy(r)) { acted = `searched Weather for ${city}: did not open "${text(match)}" (blocked: ${blockedBy(r)})`; break; }
            task.counts.actions++;
            acted = `searched Weather for ${city} and opened "${text(match)}"`;
            // a city not seen before fetches its forecast first: wait for "<City>, 21 degrees …" (up to 8 s)
            for (let j = 0; j < 16; j++) {
              await sleep(500);
              const f = await driver.observe(agent, win);
              if (f.elements.some((e) => text(e).toLowerCase().startsWith(want) && /\bdegrees?\b|°/i.test(text(e)))) break;
            }
            break;
          }
        }
      }
      if (signal.aborted) return finish("stopped", "stopped by the user");
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("pick_city"), acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      continue;
    }

    // Finder file steps: scripted (disclosed), confined to the folder this window shows
    const fstep = planActive() ? plan![planPos] : undefined;
    if (fstep && (fstep.action === "make_folder" || fstep.action === "move_file" || fstep.action === "sort_into")) {
      const t1 = performance.now();
      const lines: string[] = [];
      const codeDec = codeDecision(fstep.action);
      if (!fileOps) {
        const dir = finderFolder(obs);
        // the command names a folder: only that folder, whatever Finder happens to show (live, a lost path made the
        // agent sort the folder an earlier task had left open)
        const named = folderIn(task.goal);
        const why = !dir ? "could not read the folder from Finder's path bar (View › Show Path Bar)"
          : named && !sameFolder(named, dir) ? `Finder shows ${dir}, not ${named}, the folder the command names`
          : safeRoot(dir);
        if (!dir || why) {
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted: `refused: ${why}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
          return finish("driver_refused", `file organising refused: ${why}`);
        }
        // FileOps resolves the folder to its real path (the one safeRoot checked) and works only there
        fileOps = new FileOps(dir, join(import.meta.dir, "..", "runs", ctx.runId), task.id);
      }
      if (fstep.action === "make_folder") {
        const r = fileOps.makeFolder(fstep.text ?? "");
        lines.push(r.detail);
        if (r.ok) task.counts.scripted++;
      } else if (fstep.action === "move_file") {
        const r = fileOps.moveFile(fstep.target ?? "", fstep.text ?? "");
        lines.push(r.detail);
        if (r.ok) task.counts.scripted++;
      } else {
        // sort_into: the cheap classifier decides, file by file, which folder each one belongs in
        const cats = (fstep.text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (looseFiles(fileOps.root).length === 0) {
          // nothing to sort: say so honestly instead of creating empty folders and asking an LLM to re-plan
          const inside = listTree(fileOps.root).slice(0, 8).join("; ");
          const msg = `nothing to sort: there are no loose files in ${fileOps.root.split("/").pop()} (everything is already inside subfolders: ${inside})`;
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted: `scripted sort_into: ${msg}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
          return finish(null, "", msg);
        }
        for (const c of cats) {
          const r = fileOps.makeFolder(c);
          lines.push(r.detail);
          if (r.ok && r.detail.startsWith("created")) task.counts.scripted++;
        }
        // the file list comes from the file system, not from Finder's current view (icon / list / column)
        const files = looseFiles(fileOps.root).map((name) => ({ text: name }));
        const left: string[] = [];
        const moved: string[] = [];
        const options: Record<string, string> = Object.fromEntries(cats.map((c) => [c, `the "${c}" folder`]));
        options.leave_in_place = "Leave it where it is: none of the folders fits, or it is unclear";
        // one batched call for every file when the brain supports it (jev does): N round trips become one
        let batched: Choice[] | undefined;
        if (brain.chooseMany && brain.choose && files.length > 1 && !signal.aborted) {
          update(`sorting ${files.length} files`);
          batched = await brain.chooseMany(
            { goal: task.goal, files: files.map((f) => f.text), folders: cats },
            files.map((f) => ({
              question: `Which folder should the file "${f.text}" be moved into, to achieve the goal: ${task.goal}`,
              options,
            })),
          );
        }
        for (const [fi, f] of files.entries()) {
          if (signal.aborted) break;
          if (!brain.choose) { lines.push(`no classifier for "${f.text}": left in place`); left.push(f.text); continue; }
          update(`sorting ${f.text}`);
          const c = batched?.[fi] ?? await brain.choose(
            `Which folder should the file "${f.text}" be moved into, to achieve the goal: ${task.goal}`,
            options,
            { goal: task.goal, file_name: f.text, folders: cats },
          );
          task.counts.decisions++;
          task.cost.decisionsUsd += c.costUsd;
          task.decideMs.push(c.ms);
          if (c.choice === "leave_in_place" || (brain.kind === "jev" && c.confidence < GATE)) {
            const why = c.choice === "leave_in_place" ? "no folder fits" : `unsure: confidence ${c.confidence.toFixed(2)}`;
            lines.push(`left "${f.text}" in place (${why})`);
            left.push(`${f.text} (${why})`);
            continue;
          }
          const r = fileOps.moveFile(f.text, c.choice);
          lines.push(`${r.detail} (confidence ${c.confidence.toFixed(2)}, ${c.ms} ms)`);
          if (r.ok) { task.counts.scripted++; moved.push(`${f.text} → ${c.choice}`); }
          else left.push(`${f.text} (${r.detail})`);
        }
        // deterministic check: the file system is the ground truth; every file is moved or explicitly left with a reason
        const loose = looseFiles(fileOps.root);
        const unexplained = loose.filter((n) => !left.some((l) => l.startsWith(n + " ")));
        const acted = `scripted sort_into: ${lines.join("; ")}`;
        log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
        if (files.length && !unexplained.length && (plan?.length ?? 0) === planPos + 1) {
          const summary = `${moved.length} file(s) moved: ${moved.join(", ") || "none"}.${left.length ? ` Left in place: ${left.join(", ")}.` : ""} Undo script: ${fileOps.undoFile}`;
          return finish(null, "", summary);
        }
        prev.push(acted.slice(0, 400));
        planPos++;
        await sleep(800);
        continue;
      }
      const acted = `scripted ${fstep.action}: ${lines.join("; ")}`;
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted.slice(0, 400));
      planPos++;
      await sleep(800); // Finder refreshes the window
      continue;
    }

    if (signal.aborted) return finish("stopped", "stopped by the user");

    // what the agent needs isn't on screen, but there is a search field: search for it (what a person does) instead
    // of clicking whatever else is there. "What it needs": the plan's next click, or what the goal asks to reach
    // ("message Sohan", "reply to Sohan", "open the chat with Mum").
    {
      const low = compact;
      const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
      const next = planActive() ? plan![planPos] : undefined;
      const wanted = next?.action === "click" && next.target ? [next.target] : !planActive() ? goalValues(task.goal).targets : [];
      // on screen = a control whose label STARTS with it (a mention inside some message text doesn't count)
      // (a text field counts by its LABEL only: a search box that contains the name doesn't mean the name is shown)
      // ...or exactly one of the agent's own items: an item can be named by the agent itself ("text field (no label)"),
      // a name no window control carries, and searching the app for it TYPED that name into the search box
      const shown = (w: string) => p.items.some((i) => low(i.text) === low(w)) || obs.elements.some((e) => e.token && low(TEXT_INPUT.has(e.role) ? firstLabel.get(fieldKey(e)) ?? e.label ?? "" : `${e.label || e.value || ""}`).startsWith(low(w)));
      const missing = wanted.find((w) => low(w).length >= 2 && (!shown(w) || notReached.has(low(w))) && !searchedFor.has(low(w)));
      // (not a browser's address bar, whose label says "search" too: "Address and search bar". Live, a missing name would
      // have been typed into it)
      const isFind = (els: AxElement[]) => (e: AxElement) => !!e.token && !addressBarOf(e.token, els) && (e.role === "AXSearchField" || (TEXT_INPUT.has(e.role) && FIND_FIELD.test(e.label ?? "")));
      let search = missing ? obs.elements.find(isFind(obs.elements)) : undefined;
      // many apps show no search FIELD until a Search control is pressed (or a New chat / New message sheet opens).
      // Try each way in until one gives a field the agent can type into (WhatsApp's "Search" focuses a field that
      // isn't exposed to accessibility at all; its New Chat sheet has a real one)
      if (missing && !search) {
        let o2 = obs;
        for (const re of [/^(search|find)\b/, /^(new (chat|message|conversation)|compose|start a (chat|conversation))\b/]) {
          const open = o2.elements.find((e) => e.token && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && (e.frame?.w ?? 0) > 0 && re.test(words(e.label || e.value || "")));
          if (!open?.token) continue;
          update(`opening search to find ${missing}`);
          const r = await guardedClick(open.token, open.label || open.value || "", open.role, o2.elements);
          if (blockedBy(r)) { prev.push(`did not press '${open.label}' (blocked: ${blockedBy(r)})`); continue; }
          task.counts.actions++;
          await sleep(600);
          o2 = await driver.observe(agent, win);
          search = o2.elements.find(isFind(o2.elements)) ?? o2.elements.find((e) => !!e.token && TEXT_INPUT.has(e.role) && !MESSAGE_FIELD.test(e.label ?? "") && !addressBarOf(e.token, o2.elements));
          prev.push(`pressed '${open.label}' to get a search field${search ? "" : " (no field appeared)"}`);
          if (search) break;
        }
      }
      // what the goal asks to reach IS on screen: click it (the biggest element starting with its name: the list row
      // or search result, not the search box that contains the name, nor a small header title with the same name)
      const reachable = !missing && !planActive() ? wanted.find((w) => low(w).length >= 2 && shown(w) && !reached.has(low(w))) : undefined;
      if (reachable) {
        const hit = obs.elements
          .filter((e) => e.token && e.frame && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && low(e.label || e.value || "").startsWith(low(reachable)))
          .sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0];
        if (hit?.token) {
          reached.add(low(reachable));
          update(`opening ${reachable}`);
          const t1 = performance.now();
          const label = (hit.label || hit.value || "").slice(0, 60);
          const r = await guardedClick(hit.token, hit.label || hit.value || "", hit.role, obs.elements);
          let acted: string;
          if (blockedBy(r)) acted = `blocked: did not click '${label}': ${blockedBy(r)}`;
          else {
            task.counts.actions++;
            await sleep(700);
            // did it become the open content? if not, it counts as not found (the agent searches for it next)
            const ok = headed(await driver.observe(agent, win), reachable);
            if (!ok) notReached.add(low(reachable));
            acted = ok ? `opened '${label}' (what the goal asks to reach)` : `clicked '${label}' but ${reachable} did not open`;
          }
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("reach"), acted, results: [r], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
          prev.push(acted);
          await sleep(800);
          continue;
        }
      }
      if (missing && search?.token) {
        searchedFor.add(low(missing));
        update(`searching for ${missing}`);
        const t1 = performance.now();
        await guardedClick(search.token, search.label ?? "", search.role, obs.elements);
        // a search field may be emptied: what it held was something to look for, not the user's writing
        if ((search.value ?? "").trim() && !/^search$/i.test((search.value ?? "").trim())) await driver.setValue(agent, win, search.token, "").catch(() => undefined);
        await typeInto(search.token, missing, false, search.role);
        task.counts.actions += 2;
        let acted = `searched for "${missing}" (it was not on screen) in '${search.label ?? "search"}'`;
        // a search isn't done until a result is opened: the biggest element that starts with the name (results are often
        // plain text rows that aren't in the agent's list of buttons)
        for (let i = 0; i < 6 && !signal.aborted; i++) {
          await sleep(500);
          const o3 = await driver.observe(agent, win);
          const hit = o3.elements
            .filter((e) => e.token && e.frame && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && low(e.label || e.value || "").startsWith(low(missing)))
            .sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0];
          if (hit?.token) {
            // the result's label comes from the window (a page can name a "result" anything): guarded like any click
            const r = await guardedClick(hit.token, hit.label || hit.value || "", hit.role, o3.elements);
            if (blockedBy(r)) { acted += `, did not open '${(hit.label || hit.value || "").slice(0, 60)}' (blocked: ${blockedBy(r)})`; break; }
            task.counts.actions++;
            acted += `, opened '${(hit.label || hit.value || "").slice(0, 60)}'`;
            reached.add(low(missing));
            break;
          }
        }
        if (signal.aborted) return finish("stopped", "stopped by the user");
        log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("search", "type_text"), acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
        prev.push(acted);
        await sleep(800);
        continue;
      }
    }

    // A compiled plan's run of clicks needs no classify call per step: the compiler already verified every target's
    // label against THIS window, each press goes through the same in-code guard as a classified click, and the first
    // surprise (a control that isn't there, a press that fails) stops the replay and returns to deciding step by step.
    // Stale-window risk, grounded in the cua-driver contract: element_token is an AX action path scoped to
    // (pid, window_id), carries its snapshot generation (trycua/cua PR #2608), and Cua REFUSES a stale or
    // unresolvable token (cua.ai/docs/cua-driver click reference; a live refusal is recorded in STEPS.md 14214,
    // driver.ts maps it to stale_element_token). Presses are element-addressed, never coordinates, and a whole
    // batch stays inside the one snapshot generation taken this iteration, so a control press 1 destroyed makes
    // press 2 fail safe (refused -> replayOff above), not land somewhere new. A press that lands on the right
    // element but under changed meaning is the same residual the existing single-step `coded` path accepts, and
    // the task's verify pass is the backstop before anything is reported done.
    if (!replayOff && planActive() && helper.lastSource === "compiled" && plan![planPos]?.action === "click") {
      const batch: Item[] = [];
      for (let i = planPos; i < plan!.length && plan![i]!.action === "click"; i++) {
        const target = plan![i]!.target ?? "";
        const hits = p.items.filter((it) => it.text === target && it.token && !TEXT_INPUT.has(it.role));
        if (hits.length !== 1) { batch.length = 0; break; } // missing or ambiguous: the normal loop handles it
        if (clickBlocked({ role: hits[0]!.role, label: hits[0]!.text, token: hits[0]!.token }, task.goal, obs.elements)) { batch.length = 0; break; }
        batch.push(hits[0]!);
      }
      if (batch.length >= 2) {
        update(`pressing ${batch.length} planned controls`);
        const t1 = performance.now();
        const results: ActionResult[] = [];
        const pressed: string[] = [];
        for (const it of batch) {
          if (signal.aborted) return finish("stopped", "stopped by the user");
          // Let the UI settle between presses: the normal loop gets this for free from observe
          // latency; replayed presses run back to back and can outrun a menu or sheet animating in.
          if (pressed.length > 0) await sleep(250);
          const r = await driver.click(agent, win, it.token!);
          results.push(r);
          task.counts.actions++;
          if (!r.ok) {
            replayOff = true; // the window surprised us once: decide step by step from here
            break;
          }
          pressed.push(it.text);
        }
        planPos += pressed.length;
        const acted = `compiled replay: pressed ${pressed.join(" → ")}${pressed.length < batch.length ? ` (${batch.length - pressed.length} planned press(es) did not land: back to deciding step by step)` : ""}`;
        log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDecision("compiled_replay"), acted, results, ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
        prev.push(acted);
        continue;
      }
    }

    update("deciding");
    const facts: Facts = { goal: task.goal, app: task.app, screenText: p.screen, previousActions: prev, alreadyTriedHere: [...tried], notDoneReason, plan, planPos };
    let dec: Decision;
    // TIME: a step of a plan compiled IN CODE whose target is exactly one control on screen needs no classifier (saves
    // ~0.6 s and a call per step). Only code-compiled plans: an LLM plan was made from window text. The click below
    // still goes through every guard.
    const coded = planActive() && planSource === "compiled" && plan![planPos]?.action === "click" ? plan![planPos]!.target : undefined;
    const exact = coded ? p.items.filter((i) => i.text === coded) : [];
    // ...and a compiled TYPE step with its text but no named field goes into the one new, unlabeled, empty field a coded
    // click just brought up (Reminders' new row). Live, jev called it "done" there instead (the title was already in the
    // list from earlier), so nothing was typed. The typing still goes through every guard below.
    const codedType = planActive() && planSource === "compiled" && plan![planPos]?.action === "type" && !plan![planPos]!.target && plan![planPos]!.text !== undefined;
    const blank = codedType ? p.items.filter((i) => isTextInput(i) && i.state === "empty" && /\(no label\)$/.test(i.text)) : [];
    if (exact.length === 1 && exact[0]!.token && !isTextInput(exact[0])) dec = codeDecision("plan", "click", exact[0]!.i);
    else if (blank.length === 1 && blank[0]!.token) dec = codeDecision("plan", "type_text", blank[0]!.i);
    else {
      try {
        dec = await brain.classify(facts, p.items);
      } catch (e: any) {
        return finish("error", `${brain.kind} brain failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      task.counts.decisions++;
      task.cost.decisionsUsd += dec.costUsd;
      task.decideMs.push(dec.ms);
    }
    // Stop must stop the NEXT action too: a classifier call takes a while
    if (signal.aborted) return finish("stopped", "stopped by the user");
    // A goal that sends a message is not done until THIS task has sent one. The chat can already show an earlier, identical
    // message ("hi" sent a minute ago) and jev calls that done: nothing was typed or sent (live, 6 Oct: a second "hi" to
    // Rishabh, three "done?" checks, nothing sent). The message goes into the open chat's message box instead.
    if (dec.kind === "done" && sendText && !messageSent) {
      const box = p.items.find((i) => isTextInput(i) && i.token && MESSAGE_FIELD.test(i.text) && !FIND_FIELD.test(i.text));
      if (box) dec = { ...codeDecision("not-sent-yet", "type_text", box.i), text: sendText };
    }
    const chosen: Item | undefined = dec.item === undefined ? undefined : p.items.find((i) => i.i === dec.item);

    const logStep = (acted: string, results: ActionResult[], actMs: number) =>
      log.write({
        type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: dec, acted, results,
        ms: { observe: obs.ms, decide: dec.ms, act: Math.round(actMs) }, truncated: obs.truncated,
      });
    // background input refused (Electron text fields, apps with several windows): one counted foreground retry (refusedInBackground, top of file)

    // ---- the gate: only for the calibrated brain (jev). An LLM's self-reported confidence is not calibrated. ----
    if (dec.backend === "jev" && !["done", "wait", "none"].includes(dec.kind) && dec.gate < GATE) {
      task.counts.gated++;
      logStep(`gated: confidence ${dec.gate.toFixed(2)} < ${GATE} (${topOf(dec.kindP)}; ${topOf(dec.itemP)})`, [], 0);
      if (await escalate(p, `unsure what to do next (confidence ${dec.gate.toFixed(2)})`)) continue;
      return finish("low_confidence", `not sure what to do next (confidence ${dec.gate.toFixed(2)}). It stopped instead of guessing.`);
    }
    if (dec.kind === "none") {
      if (dec.backend === "jev" && dec.kindConf < 0.5) {
        // unsure "nothing helps" usually means "it's already done": let the verifier read the screen
        logStep(`unsure (none ${dec.kindConf.toFixed(2)}): checking the screen`, [], 0);
        const r = await checkDone(p, "classifier unsure");
        if (r) return r;
        continue;
      }
      logStep("nothing on screen helps", [], 0);
      if (await escalate(p, "jev sees nothing on screen that helps")) continue;
      return finish("stalled", "nothing on this screen can make progress toward the goal");
    }

    const key = `${dec.kind}:${chosen?.id ?? ""}`;
    if (tried.includes(key) && dec.kind !== "wait" && dec.kind !== "done") {
      sameChoice++;
      if (sameChoice >= 2) {
        logStep(`repeat: ${key}`, [], 0);
        if (await escalate(p, `kept choosing ${dec.kind} ${chosen?.text ?? ""} on an unchanged screen`)) continue;
        return finish("stalled", `kept choosing the same action on an unchanged screen (${dec.kind} ${chosen?.text ?? ""})`);
      }
    }
    tried.push(key);

    // ---- done? the verifier reads the screen; a premature "done" is caught here ----
    if (dec.kind === "done") {
      logStep("done? checking the screen", [], 0);
      const r = await checkDone(p, "classifier says done");
      if (r) return r;
      continue;
    }

    update(`${dec.kind}${chosen ? " " + chosen.text : ""}`);
    /**
     * Cua drops a window's snapshot after a while (seen: a long itinerary took the writer several seconds, then typing
     * failed with "element_token is stale"): read the window again, find the SAME control (role + label), retry once.
     */
    const retryStale = async (r: ActionResult, again: (token: string) => Promise<ActionResult>): Promise<ActionResult> => {
      if (r.ok || r.error?.code !== "stale_element_token" || !chosen) return r;
      const fresh = perceive(await driver.observe(agent, win, slowOpts), task.goal);
      const same = fresh.items.find((i) => i.role === chosen.role && i.text === chosen.text && i.token) ?? fresh.items.find((i) => i.role === chosen.role && i.token && chosen.role === "AXTextArea");
      return same?.token ? again(same.token) : r;
    };
    let results: ActionResult[] = [];
    let desc = "";
    let holdPlan = false;
    const t1 = performance.now();
    switch (dec.kind) {
      case "click": {
        if (!chosen?.token) { desc = "blocked: no such control"; break; }
        // already the open content (the chat with X is open, X is clicked again): that step is already done
        if (planActive() && plan![planPos]?.action === "click" && goalValues(task.goal).targets.some((t) => compact(t) === compact(chosen.text) || compact(chosen.text).startsWith(compact(t))) && goalValues(task.goal).targets.some((t) => headed(obs, t))) {
          desc = `skipped: '${chosen.text}' is already open`;
          planPos = Math.min(planPos + 1, plan!.length);
          holdPlan = true;
          focusOnly = true;
          break;
        }
        if (isTextInput(chosen)) focusOnly = true; // a click into a text field only focuses it
        // several clickable elements with the same label, of ANY role (WhatsApp: the chat-list row is a 460-pt text
        // element "Sohan", the chat header a 51-pt button "Sohan" that opens the contact's info): the biggest one is
        // the item itself; a title or a badge with the same text is small (a local choice: the Item is shared)
        const twins = obs.elements.filter((e) => e.token && !TEXT_INPUT.has(e.role) && e.frame && compact(e.label ?? "") === compact(chosen.text));
        const big = twins.length > 1 ? twins.sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0]! : undefined;
        const token = big?.token ?? chosen.token;
        // SAFETY (guardedClick): no Send unless the goal sends, nothing that spends money or can't be undone unless the
        // goal asks for exactly that
        const r = await guardedClick(token, chosen.text, big?.role ?? chosen.role, obs.elements);
        if (blockedBy(r)) { desc = `blocked: ${blockedBy(r)}`; break; }
        results = [await retryStale(r, (t) => guardedClick(t, chosen.text, chosen.role, []))];
        desc = `click '${chosen.text}'`;
        if (/^search\b/i.test(chosen.text.trim())) searchOpenedAt = step; // the field it brings up is a search box
        // a "Search" / "Go" button with the goal's term already in a search box: the term still has to be submitted (live,
        // App Store kept the term from an earlier run, and pressing its Search button only showed the search page)
        if (/^(search|go|find)$/i.test(chosen.text.trim()) && !signal.aborted) {
          // (never a browser's address bar, which holds the page's address and so often the goal's own words; and never a
          // field that only shows its prompt)
          const box = obs.elements.find((e) => e.token && SINGLE_LINE.has(e.role) && (e.value ?? "").trim().length >= 2 &&
            !PLACEHOLDER.test(e.value!.trim()) && !showsPrompt(obs.elements, e) && !addressBarOf(e.token, obs.elements) && norm(task.goal).includes(norm(e.value!)));
          const key = `${box?.role}|${norm(box?.value ?? "")}`;
          if (box?.token && !submittedSearch.has(key) && !enterForbidden(obs.elements, box.token, task.goal)) {
            submittedSearch.add(key);
            // typed again first: a term SET into the box (or left from before) fires no filtering (live: Font Book)
            const term = box.value!.trim();
            await driver.setValue(agent, win, box.token, "").catch(() => undefined);
            results.push(await typeInto(box.token, term, false, box.role, box));
            results.push(await submitField(box.token, box.actions));
            desc += `, then Enter in the search box ("${box.value!.trim().slice(0, 40)}")`;
          }
        }
        break;
      }
      case "type_text": {
        if (!isTextInput(chosen) || !chosen?.token) { desc = `blocked: '${chosen?.text ?? "?"}' is not a text field`; break; }
        // SAFETY: never a password, card number or ID: the user does that part
        const secret = typingForbidden(chosen.text);
        if (secret) return finish("not_achieved", secret);
        const chosenEl = obs.elements.find((e) => e.token === chosen.token);
        // SAFETY: never the browser's own address bar (sites open with open_url): what is typed there is navigated to or Googled
        const bar = addressBarOf(chosen.token, obs.elements);
        if (bar) { desc = `blocked: ${bar}`; break; }
        const id = fieldId(obs, chosen.token, chosen.role);
        const purpose = firstLabel.get(fieldKey(chosenEl)) || chosen.text; // what the field is for, from its first label
        // a field that shows only its own prompt holds nothing: perceive says so (`placeholder`: Instagram's message box is
        // an AXTextArea "Message..." that holds "Message..."), and so does an older rule for a single-line field whose "value"
        // is its placeholder words under its FIRST label (Weather's box holds "Search"). Narrow on purpose: an app may report
        // a note's TEXT as its label too (Notes), so a text area counts only when perceive found it prompt-shaped (in a web
        // page, or ending in "...") and a filled-in name could equal its label (the engine safety test caught the wide version)
        const placeholder = chosen.placeholder === true || (chosen.role !== "AXTextArea" && (chosen.value ?? "").trim().length <= 40 &&
          PLACEHOLDER.test((chosen.value ?? "").trim()) && [chosen.text, purpose].some((l) => norm(l) === norm(chosen.value ?? "")));
        const before = placeholder ? "" : chosen.value ?? "";
        // SAFETY: never add to text the agent did not write (e.g. the body of one of the user's existing notes): its own
        // text is a field still holding exactly what the agent left there; the goal may name the text to edit
        const own = owns(id, before);
        // the name field of a Save panel holds a SUGGESTED name ("MATH2014 ASSIGNMENT2 (1)"); a goal that saves a file may rename it
        const mayEdit = editAllowed(task.goal, `${purpose}\n${before}`) || (/\b(save|download|export)\b/i.test(task.goal) && isSaveNameField(obs.elements, chosen.token));
        if (chosen.role === "AXTextArea" && chosen.state === "filled" && !placeholder && !own && !mayEdit) {
          desc = `blocked: '${chosen.text.slice(0, 30)}' already contains someone else's text (create a new item first)`;
          if (usePlan && safetyReplans < 1) {
            safetyReplans++;
            logStep(desc, [], 0);
            await makePlan(p.screen, p.items, "the text area shows EXISTING content that must not be edited: first create a new item (for example click New Note or New Document), then type").catch(() => {});
            desc = "re-planned: create a new item first";
            holdPlan = true;
          }
          break;
        }
        let text = dec.text;
        const planned = plan?.[planPos];
        if (text === undefined && planned?.action === "type" && planned.text !== undefined) text = planned.text; // from the plan, no extra LLM call
        // the field already holds what this agent wrote (from the writer): writing again would only duplicate it
        if (text === undefined && own && before.trim()) {
          desc = `skipped: '${chosen.text.slice(0, 30)}' already holds the text this agent wrote`;
          holdPlan = true;
          break;
        }
        const messageField = MESSAGE_FIELD.test(purpose) && !FIND_FIELD.test(purpose);
        if (messageField && !sendAsked) { desc = `blocked: '${chosen.text}' is a message field and the goal does not ask to send anything`; break; }
        { const whoTo = goalValues(task.goal).targets;
          if (messageField && whoTo.length && !whoTo.some((t) => headed(obs, t))) { desc = `blocked: the conversation on screen is not with ${whoTo.join(" / ")}`; break; } }
        if (text === undefined) {
          const w = await helper.writeText(task.goal, { ...chosen, text: purpose }, p.screen, prev);
          task.counts.helperCalls++;
          task.cost.helperUsd += w.costUsd;
          if (w.llm || llmHelper) noteLlm("write free text");
          log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "write", detail: `"${w.text.slice(0, 120)}" for '${chosen.text}'`, costUsd: w.costUsd, ms: w.ms });
          text = w.text;
          if (signal.aborted) return finish("stopped", "stopped by the user"); // writing takes seconds
        }
        if (!text) { desc = "blocked: nothing to type"; break; }
        const typed = text;
        // never type the same text twice: if the field already holds it, that step is done
        // a search box: Enter runs the search (see below, after typing)
        // (also: a single-line field the agent brought up by pressing "Search" a moment ago — SwiftUI fields show their
        // placeholder as their label AND value, live: Podcasts' "Apple Podcasts")
        const openedBySearch = step - searchOpenedAt <= 2 && chosen.role !== "AXTextArea";
        const searchBox = openedBySearch || chosen.role === "AXSearchField" || SEARCH_BOX.test(purpose) || SEARCH_BOX.test(chosen.text) ||
          (SEARCH_GOAL.test(task.goal) && /\(no label\)$/.test(purpose) && chosen.role !== "AXTextArea");
        const submitSearch = async (): Promise<string> => {
          if (!searchBox || messageField || plan?.[planPos + 1]?.action === "press_enter" || signal.aborted || submittedSearch.has(`${id}|${typed}`)) return "";
          if (enterForbidden(obs.elements, chosen.token, task.goal)) return "";
          submittedSearch.add(`${id}|${typed}`);
          results.push(await submitField(chosen.token!, chosen.actions));
          return ", then Enter to search";
        };
        // a search box holding the term from BEFORE this task is typed again once (below): a leftover term may never have
        // been searched or filtered on (live: Font Book's box held "Helvetica" over an unfiltered list)
        const leftoverSearch = searchBox && !typedInto.has(id) && chosen.role !== "AXTextArea";
        // what the field holds (nothing, when it only shows its prompt: typing "me" is not already in "Message...")
        const holds = placeholder ? "" : chosen.value ?? (chosen.role === "AXTextArea" ? chosen.text : "");
        if (!leftoverSearch && norm(holds).includes(norm(typed))) {
          // ...but a search box that already holds the term may never have been searched (live: App Store kept the term
          // from an earlier run and the agent called it done without searching): submit it once
          desc = `skipped: '${chosen.text.slice(0, 30)}' already contains "${typed.slice(0, 40)}"${await submitSearch()}`;
          if (plan) planPos = Math.min(planPos + 1, plan.length);
          holdPlan = true;
          break;
        }
        if (messageField && goalValues(task.goal).targets.some((t) => norm(t) === norm(typed))) {
          desc = `blocked: "${typed}" is who to reach, not what to say (it does not go into '${chosen.text}')`;
          break;
        }
        // the same text into the same field once per task: apps that hide a field's contents (WhatsApp) otherwise get
        // it typed again and again. After an UNCERTAIN insert, one retry, only where the field's contents can be read
        // (and, just above, don't hold the text)
        const retryKey = `${id}|${typed}`;
        if (typedInto.get(id) === typed && !(uncertainTyped.has(retryKey) && chosen.value !== undefined && !retriedTyping.has(retryKey))) {
          desc = `skipped: "${typed.slice(0, 40)}" was already typed into '${chosen.text}'`;
          if (plan) planPos = Math.min(planPos + 1, plan.length);
          holdPlan = true;
          break;
        }
        if (uncertainTyped.has(retryKey)) retriedTyping.add(retryKey);
        // single-line fields (search boxes, address bars) are REPLACED, not appended to; text areas are appended to.
        // Only old contents that may go: a search field's, the agent's own, or a field the goal says to change (never
        // a form's name or email the user filled in)
        const searchLike = searchBox || SEARCH_FIELD.test(purpose) || SEARCH_FIELD.test(chosen.text);
        if (chosen.state === "filled" && !placeholder && chosen.role !== "AXTextArea") {
          if (!searchLike && !own && !mayEdit) { desc = `blocked: '${chosen.text.slice(0, 30)}' already holds "${before.slice(0, 30)}", which this agent did not write (not clearing it)`; break; }
          results.push(await driver.setValue(agent, win, chosen.token, ""));
        } else if (searchLike && chosen.role !== "AXTextArea") {
          // a search box that doesn't report what it holds (Weather's): empty it anyway, or the new term lands next to an
          // old one (live: "Tokyo" was typed in front of a whole leftover sentence, and that became the "answer")
          results.push(await driver.setValue(agent, win, chosen.token, ""));
        }
        // focus the field first: when an app doesn't take text through accessibility, it arrives as key presses, which
        // go to whatever has the keyboard focus (measured: a message landed in the chat list's search box)
        await guardedClick(chosen.token, chosen.text, chosen.role, obs.elements).catch(() => undefined);
        await sleep(150);
        if (signal.aborted) return finish("stopped", "stopped by the user");
        const asSearch = searchBox ? chosenEl : undefined;
        let r = await retryStale(await typeInto(chosen.token, typed, false, chosen.role, asSearch), (t) => typeInto(t, typed, false, chosen.role, asSearch));
        if (refusedInBackground(r) && allowForeground) {
          results.push(r);
          r = await typeInto(chosen.token, typed, true);
          task.counts.foreground++;
        }
        results.push(r);
        let landed: string | undefined; // the field's value read back after typing (when the app shows it)
        // where did it land? if ANOTHER field now holds it (and didn't before), it went to the wrong place: put back what
        // that field held, and don't count it (only when fields have positions to tell them apart by)
        if (r.ok && fieldKey(chosenEl)) {
          const after = await driver.observe(agent, win);
          const head = norm(typed).slice(0, 16);
          learnFields(after);
          const held = (e: AxElement) => obs.elements.find((x) => fieldKey(x) === fieldKey(e));
          const shows = (e?: AxElement) => norm(`${e?.value ?? ""} ${e?.label ?? ""}`).includes(head);
          const elsewhere = head.length >= 4
            ? after.elements.find((e) => e.token && TEXT_INPUT.has(e.role) && fieldKey(e) && fieldKey(e) !== fieldKey(chosenEl) && shows(e) && !shows(held(e)))
            : undefined;
          if (elsewhere?.token) {
            const was = held(elsewhere);
            const prior = was && !showsPrompt(obs.elements, was) ? was.value ?? "" : ""; // one that only showed its prompt held nothing
            await driver.setValue(agent, win, elsewhere.token, prior).catch(() => undefined);
            // a search box that ignores the value: its OWN clear button, never a form's "Clear"
            const clear = prior ? undefined : clearButtonOf(after.elements, elsewhere);
            if (clear?.token) await guardedClick(clear.token, clear.label ?? "", clear.role, after.elements).catch(() => undefined);
            desc = `typing landed in '${elsewhere.label ?? "another field"}' instead of '${chosen.text}': put back what it held`;
            break;
          }
          // and did it land in the field itself? (when the app shows the field's contents) If not, paste it once
          const mine = after.elements.find((e) => fieldKey(e) === fieldKey(chosenEl) && e.token);
          landed = mine?.value;
          if (mine?.token && mine.value !== undefined && !norm(mine.value).includes(head)) {
            const pr = driver.paste && !signal.aborted ? await driver.paste(agent, win, mine.token, typed) : undefined;
            if (pr) results.push(pr);
            const again = (await driver.observe(agent, win)).elements.find((e) => fieldKey(e) === fieldKey(chosenEl));
            if (!again || again.value === undefined || !norm(again.value).includes(head)) {
              desc = `typing did not land in '${chosen.text}' (it still holds "${norm(again?.value ?? "").slice(0, 30)}")`;
              break;
            }
            landed = again.value;
          }
          // a message box that still reads empty after typing, in an app that ignores background keys: the text again as
          // real foreground keystrokes (WhatsApp reports no value at all while its box is empty)
          if (messageField && mine?.token && (mine.value === undefined || !mine.value.trim()) && r.channel !== "foreground" &&
              ignoresBackgroundKeys(task.app) && allowForeground && !signal.aborted) {
            const fr = await typeInto(mine.token, typed, true, chosen.role);
            results.push(fr);
            task.counts.foreground++;
            const again = (await driver.observe(agent, win)).elements.find((e) => fieldKey(e) === fieldKey(chosenEl));
            landed = again?.value;
            if (!fr.ok || !again?.value || !norm(again.value).includes(head)) {
              desc = `typing did not land in '${chosen.text}', even as foreground keystrokes`;
              break;
            }
            r = fr;
          }
        }
        if (r.ok || uncertain(r)) {
          // ownership: the exact value the agent left (read back, or what it must be); blank text owns nothing
          if (typed.trim()) wrote.set(id, landed ?? (chosen.role === "AXTextArea" ? before + typed : typed));
          typedInto.set(id, typed);
          if (uncertain(r)) uncertainTyped.add(retryKey);
          lastTyped = { id: chosen.id, label: chosen.text, text: typed, foreground: r.channel === "foreground" };
        }
        desc = `type "${typed.length > 60 ? typed.slice(0, 57) + "..." : typed}" into '${chosen.text}'${r.channel === "foreground" ? " (foreground)" : ""}`;
        // a search box runs its search on Enter, not by pressing some "Search" control (live, App Store kept clicking its
        // Search TAB with the term typed and never searched). A search box: a search field, one labelled as one, or an
        // unlabeled single-line field when the goal is a search. Not when the plan's next step is Enter anyway; the
        // Enter safety rule still applies (submitSearch)
        if (r.ok || uncertain(r)) desc += await submitSearch();
        // a message the goal asks to send, now confirmed in its box: the app's own Send button, pressed through accessibility.
        // That works in the background where a Return does not (WhatsApp), and needs no key at all
        if ((r.ok || uncertain(r)) && messageField && sendAsked && landed !== undefined && norm(landed).includes(norm(typed).slice(0, 16)) && !signal.aborted) {
          const nowObs = await driver.observe(agent, win);
          const sendBtn = nowObs.elements.find((e) => e.role === "AXButton" && e.token && compact(e.label ?? "") === "send");
          if (sendBtn?.token) {
            const sr = await guardedClick(sendBtn.token, sendBtn.label ?? "Send", sendBtn.role, nowObs.elements);
            results.push(sr);
            if (sr.ok || uncertain(sr)) { desc += ", then pressed Send"; justSentAt = step; lastTyped = undefined; messageSent = true; }
          }
        }
        break;
      }
      case "press_enter":
      case "press_escape": {
        const k = dec.kind === "press_enter" ? "return" : "escape";
        if (k === "return" && step - justSentAt <= 3) {
          desc = "skipped: the message was already sent with the Send button";
          if (plan) planPos = Math.min(planPos + 1, plan.length);
          holdPlan = true;
          break;
        }
        // SAFETY: never Enter in a browser's address bar (sites open with open_url): what it holds is navigated to or
        // Googled (live: it held a private message the agent had typed there by mistake)
        const barEnter = k === "return" && isTextInput(chosen) ? addressBarOf(chosen!.token, obs.elements) : null;
        if (barEnter) { desc = `blocked: ${barEnter}`; break; }
        // read-back before sending: the field must hold exactly what was typed (a lost first keystroke must not be sent)
        if (k === "return" && lastTyped) {
          const f = p.items.find((i) => isTextInput(i) && (i.id === lastTyped!.id || i.text === lastTyped!.label));
          if (f?.token && f.value !== undefined && !norm(f.value).includes(norm(lastTyped.text))) {
            const retypeKey = `${lastTyped.id}|${lastTyped.text}`;
            if (retyped.has(retypeKey)) {
              desc = `blocked: the field still does not contain the typed text ("${norm(f.value).slice(0, 40)}"), not sending`;
              logStep(desc, [], 0);
              return finish("driver_refused", `typing did not land correctly in '${f.text}', so it was not sent`);
            }
            retyped.add(retypeKey);
            results.push(await driver.setValue(agent, win, f.token, ""));
            results.push(await typeInto(f.token, lastTyped.text, lastTyped.foreground));
            if (lastTyped.foreground) task.counts.foreground++;
            holdPlan = true; // Enter is still to come
            desc = `re-typed into '${f.text}': it held "${norm(f.value).slice(0, 30)}" instead of the full text`;
            break;
          }
        }
        // SAFETY: Enter in a message field sends it: only when the goal asks to send something, and only to the one the
        // goal names (the open content's title must be them: measured, a message aimed at "You" sat in another chat)
        const enterIn = isTextInput(chosen) ? chosen : p.items.find((i) => isTextInput(i) && i.state === "filled" && !addressBarOf(i.token, obs.elements));
        const whoTo = goalValues(task.goal).targets;
        if (k === "return" && enterIn && MESSAGE_FIELD.test(firstLabel.get(fieldKey(obs.elements.find((e) => e.token === enterIn.token))) || enterIn.text) && whoTo.length && !whoTo.some((t) => headed(obs, t))) {
          desc = `blocked: the conversation on screen is not with ${whoTo.join(" / ")}, not sending`;
          notReached.add(compact(whoTo[0]!));
          break;
        }
        if (k === "return" && enterIn && MESSAGE_FIELD.test(enterIn.text) && !FIND_FIELD.test(enterIn.text) && !sendAsked) {
          desc = `blocked: Enter in '${enterIn.text}' would send it, and the goal does not ask to send anything`;
          break;
        }
        // Enter on a field that supports AXConfirm needs no keyboard at all (keys are refused when an app has 2 windows)
        const field = isTextInput(chosen) ? chosen : p.items.find((i) => isTextInput(i) && i.state === "filled" && i.actions?.includes("AXConfirm") && !addressBarOf(i.token, obs.elements));
        // SAFETY: Return / AXConfirm press the default button: a dialog's "Delete" / "Replace", a web form's "Pay"
        const noEnter = k === "return" ? enterForbidden(obs.elements, field?.token ?? enterIn?.token, task.goal) : null;
        if (noEnter) { desc = `blocked: ${noEnter}`; break; }
        if (signal.aborted) return finish("stopped", "stopped by the user");
        if (k === "return" && field?.token && field.actions?.includes("AXConfirm")) {
          results = [await driver.confirm(agent, win, field.token)];
          desc = `confirm '${field.text}' (Enter via accessibility)`;
        } else {
          let r = await driver.pressKey(agent, win, k, isTextInput(chosen) ? chosen!.token : undefined);
          results = [r];
          if (refusedInBackground(r) && allowForeground) {
            r = await driver.pressKey(agent, win, k, isTextInput(chosen) ? chosen!.token : undefined, true);
            results.push(r);
            task.counts.foreground++;
          }
          desc = `press ${k}${isTextInput(chosen) ? ` in '${chosen!.text}'` : ""}${r.channel === "foreground" ? " (foreground)" : ""}`;
          if (k === "return" && lastTyped && (r.ok || uncertain(r))) messageSent = true;
        }
        if (k === "return" && lastTyped && results.some((x) => x.ok || uncertain(x))) messageSent = true;
        break;
      }
      case "scroll_down":
      case "scroll_up": {
        results = [await driver.scroll(agent, win, dec.kind === "scroll_down" ? "down" : "up", chosen?.token)];
        desc = dec.kind.replace("_", " ");
        break;
      }
      case "wait": {
        await sleep(600);
        desc = "wait";
        break;
      }
    }
    const actMs = performance.now() - t1;
    task.counts.actions += results.filter((r) => !blockedBy(r)).length;
    logStep(desc, results, actMs);
    prev.push(desc);
    if (desc.startsWith("blocked")) {
      blockedHere++;
      if (blockedHere >= 2 && !(await escalate(p, desc))) return finish("stalled", desc);
      continue;
    }
    const last = results[results.length - 1];
    if (uncertain(last)) {
      // the press or insert may or may not have happened (it is deliberately not retried by the driver): the window
      // decides. Changed -> the step is done; unchanged -> one retry. Never counted as a failure or as "idle": some
      // presses show nothing ("All Clear" on 0), so after the retry the plan moves on and the verifier has the last word
      const o = await driver.observe(agent, win, slowOpts);
      const changed = o.elements.length > 0 && signature(perceive(o, task.goal, undefined, nextStep?.target ?? "")) !== sig;
      focusOnly = true;
      tried.pop(); // a retry is not "the same choice again"
      if (!changed && !uncertainRetried) {
        uncertainRetried = true;
        prev.push(`(${desc}: its effect was uncertain and nothing changed: trying once more)`);
        continue;
      }
      uncertainRetried = false;
      if (plan && !holdPlan) planPos = Math.min(planPos + 1, plan.length);
      prev.push(`(${desc}: its effect was uncertain; ${changed ? "the window changed: counted as done" : "still nothing visible changed: moving on"})`);
      continue;
    }
    if (plan && last?.ok && !holdPlan) planPos = Math.min(planPos + 1, plan.length);
    const bad = last && !last.ok ? last : undefined;
    if (bad) {
      const fatal = bad.error?.code === "permissions_pending" || (bad.error?.code === "minimized_or_hidden" && !allowForeground);
      if (fatal) return finish("driver_refused", `${bad.error?.code}: ${bad.error?.detail ?? ""}`);
      if (signal.aborted) return finish("stopped", "stopped by the user");
      // e.g. AXPress unsupported on a text area, or keys refused because the app has two windows: note it, try another way
      prev.push(`(${desc} FAILED: ${bad.error?.code}${bad.error?.code === "keyboard_ambiguity" ? ": the app has more than one window, keys are refused" : ""})`);
      if (plan && dec.kind === "click" && isTextInput(chosen)) planPos = Math.min(planPos + 1, plan.length); // clicking a field first is unnecessary
      failedHere++;
      if (failedHere >= 3) return finish("driver_refused", `actions keep failing: ${bad.error?.code}: ${bad.error?.detail ?? ""}`);
      continue;
    }
  }
  return finish("step_limit", `more than ${max} steps`);
}
