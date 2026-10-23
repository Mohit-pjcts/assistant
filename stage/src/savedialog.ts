// Save / Open panels (NSSavePanel): done in code, not by the click-by-click loop.
//
// Why: a browser's Save panel is its own window that accessibility cannot attribute to the app's main window, so Cua refuses
// every background action on it; its file rows are text fields with no Press action; Backstage had no key chords; and the
// name field already holds a suggested name the loop will not overwrite. Live (2026-10-22) an agent stalled four times on a
// "This page wants to save" panel in Brave.
//
// What works on the real panel (each checked on screen, STEPS.md 198.1):
//   * a REAL click at a control's position (the tree gives fresh screen frames): selects a sidebar item or a folder row,
//     and a triple-click selects the name field's text
//   * a key sent to the PANEL's own window (not the app's main one): Return saves
//   * Cmd+V (clipboard) into the name field; typing does not reach it
// What does not: Cmd+Shift+G (a browser's own menu owns it: Brave's Find Previous), typed text, and a path pasted into the
// name field (the panel keeps only the file name and saves into the folder it is showing).
// So: navigate by clicking down from a sidebar item, paste the name, press Return, and look on disk for the file.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ActionResult, AgentName, AxElement, Driver, Observation, Rect, WindowRef } from "./contracts.ts";

const MODIFIERS: Record<string, string> = { cmd: "cmd", command: "cmd", shift: "shift", option: "option", alt: "option", opt: "option", ctrl: "ctrl", control: "ctrl", fn: "fn" };

/** "cmd+shift+g" -> ["cmd","shift","g"]; undefined when it is not a chord (modifiers first, exactly one other key last) */
export function parseChord(text: string | undefined): string[] | undefined {
  const parts = (text ?? "").toLowerCase().split(/[+\s]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1]!;
  if (MODIFIERS[last]) return undefined;
  const mods = parts.slice(0, -1).map((m) => MODIFIERS[m]);
  if (mods.some((m) => !m)) return undefined;
  return [...(mods as string[]), last === "enter" ? "return" : last === "esc" ? "escape" : last];
}

/** the elements below `els[i]` (the tree is a depth-first list, so they follow it until the depth comes back) */
function subtree(els: AxElement[], i: number): AxElement[] {
  const root = els[i]!;
  const out: AxElement[] = [];
  for (let k = i + 1; k < els.length && els[k]!.depth > root.depth; k++) out.push(els[k]!);
  return out;
}

export interface SaveSheet {
  sheet: AxElement;
  /** Save / Open / Export / Choose / Select */
  /** the Save / Open button; absent when the panel's own button is disabled and so missing from Cua's element list (an Open panel with nothing selected) */
  confirm?: AxElement;
  cancel: AxElement;
  /** the file name field of a Save panel (none in an Open panel) */
  name?: AxElement;
  /** the "Where:" popup: shows the folder the panel is in */
  where?: AxElement;
  /** everything inside the panel */
  inside: AxElement[];
  kind: "save" | "open";
}

const CONFIRM_LABEL = /^(save|open|export|choose|select)$/i;
const CONTAINERS = new Set(["AXSheet", "AXDialog", "AXSystemDialog", "AXWindow"]);

/**
 * the Save / Open panel in a window's tree: the innermost sheet, dialog or window that holds both a Cancel button and
 * a Save / Open button. undefined when there is none.
 */
export function findSavePanel(els: AxElement[]): SaveSheet | undefined {
  let best: SaveSheet | undefined;
  let bestDepth = -1;
  els.forEach((c, i) => {
    if (!CONTAINERS.has(c.role) || c.depth < bestDepth) return;
    // a plain window only when it is itself a panel by its title: a web page with its own Save and Cancel buttons is not one
    if (c.role === "AXWindow" && !/^(save|open|export|choose|select|this page wants|.* wants to (save|open))/i.test((c.label ?? "").trim())) return;
    const sub = subtree(els, i);
    const buttons = sub.filter((e) => e.role === "AXButton" && e.token && e.label);
    const confirm = buttons.find((b) => CONFIRM_LABEL.test(b.label!.trim()));
    const cancel = buttons.find((b) => /^cancel$/i.test(b.label!.trim()));
    if (!cancel) return;
    // an Open panel with nothing selected has its Open button disabled, and a disabled button is missing from the element list:
    // the "Where:" popup (and the view) is what marks the sheet as a file panel then
    const where = sub.find((e) => e.role === "AXPopUpButton" && /^where/i.test(e.label ?? ""));
    if (!confirm && !where) return;
    // a column-view row is a text field with AXOpen; the name field is the top-most editable one that is not a search or tag box
    const fields = sub.filter((e) => (e.role === "AXTextField" || e.role === "AXComboBox") && e.token && !e.actions.includes("AXOpen") && !/search|tag/i.test(e.label ?? "") && e.frame)
      .sort((a, b) => a.frame!.y - b.frame!.y);
    const isSave = (!!confirm && /^(save|export)$/i.test(confirm.label!.trim())) || fields.length > 0;
    best = {
      sheet: c, confirm, cancel, kind: isSave ? "save" : "open", inside: sub,
      name: isSave ? fields[0] : undefined,
      where,
    };
    bestDepth = c.depth;
  });
  return best;
}

/** is `el` the name field of a Save panel in these elements? (the loop may replace the suggested name there) */
export function isSaveNameField(els: AxElement[], tokenOrEl: string | AxElement | undefined): boolean {
  const panel = findSavePanel(els);
  if (!panel?.name || !tokenOrEl) return false;
  const token = typeof tokenOrEl === "string" ? tokenOrEl : tokenOrEl.token;
  return !!token && panel.name.token === token;
}

/** "~/Documents/x" and relative-to-home forms to an absolute path */
export function expandPath(p: string): string {
  const t = p.trim().replace(/^["']|["']$/g, "");
  return resolve(t.startsWith("~") ? t.replace(/^~/, homedir()) : t);
}

/**
 * a destination as the panel needs it: the folder to go to and the file name to use (none = keep the suggested one).
 * "/a/b" that is a folder -> go there, keep the name; "/a/b/c.pdf" -> go to /a/b, name c.pdf. A folder that does not
 * exist is refused (the panel's own "New Folder" is not touched).
 */
export function splitDestination(dest: string): { folder: string; name?: string } | { error: string } {
  const path = expandPath(dest);
  const isDir = (x: string) => { try { return statSync(x).isDirectory(); } catch { return false; } };
  if (isDir(path)) return { folder: path };
  const folder = dirname(path);
  if (!existsSync(folder) || !isDir(folder)) return { error: `the folder ${folder} does not exist` };
  return { folder, name: basename(path) };
}

/** the sidebar item to start from, and the folders to open one by one below it. undefined = not reachable by clicking from the sidebar */
export function routeTo(folder: string, home = homedir()): { start: string; steps: string[] } | undefined {
  const h = resolve(home);
  const f = resolve(folder);
  if (f !== h && !f.startsWith(h + "/")) return undefined;
  const rest = f === h ? [] : f.slice(h.length + 1).split("/");
  // the sidebar's Favourites: Desktop, Documents, Downloads are one click from their folder
  if (rest.length && ["Desktop", "Documents", "Downloads"].includes(rest[0]!)) return { start: rest[0]!, steps: rest.slice(1) };
  return { start: basename(h), steps: rest };
}

// ---------- the real panel, through Cua ----------

const norm = (s: string) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** a name without its extension: the panel hides it ("live-test" for live-test.pdf) */
const stem = (s: string) => norm(s).replace(/\.[a-z0-9]{1,5}$/, "");
const centre = (f: Rect) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

/**
 * Sidebar item names. Cua's structured element list leaves out static text, and the sidebar's cells carry no label of their
 * own, so the names are read from the text tree: `- [56] AXCell` followed by a deeper `- AXStaticText = "Desktop"`.
 * Returns element index -> name.
 */
export function cellNames(markdown: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  let cell: { index: number; indent: number } | undefined;
  for (const line of (markdown ?? "").split("\n")) {
    const indent = line.search(/\S/);
    const m = line.match(/^\s*- \[(\d+)\] (AXCell|AXRow)\b/);
    if (m) { cell = { index: Number(m[1]), indent }; continue; }
    if (cell && indent <= cell.indent) cell = undefined;
    const t = cell && line.match(/AXStaticText = "(.*)"\s*$/);
    if (cell && t && !out.has(cell.index)) out.set(cell.index, t[1]!);
  }
  return out;
}

const inside = (f: Rect | undefined, r: Rect | undefined) => !!f && (!r || (centre(f).x >= r.x && centre(f).x <= r.x + r.w && centre(f).y >= r.y && centre(f).y <= r.y + r.h));

/**
 * The window that owns the keyboard while a Save / Open panel is up. macOS draws the panel in a separate window of its own
 * ("Save"); the app's main window is modal behind it and cannot take focus, so keys sent to the main window never reach the
 * panel (live: Cua said "exact target window did not become focused"; the same key sent to the panel's window moved the
 * selection). The accessibility tree still lists the panel's controls under the main window, so frames and tokens stay with that one.
 */
export async function panelWindowOf(driver: Driver, win: WindowRef): Promise<WindowRef> {
  try {
    const ws = (await driver.listWindows()).windows;
    const hit = ws
      .filter((w) => w.pid === win.pid && w.window_id !== win.windowId && /^(save|open|export|choose|select)\b/i.test((w.title ?? "").trim()) && (w.bounds?.width ?? 0) > 200)
      .sort((a, b) => Number(!!b.is_on_screen) - Number(!!a.is_on_screen))[0];
    return hit ? { pid: hit.pid, windowId: hit.window_id, app: win.app, title: hit.title } : win;
  } catch {
    return win;
  }
}

/** which app is in front, and how to bring one forward and put the user's back: real clicks and keys land only on a visible, frontmost panel */
export interface Front {
  current(): Promise<string | undefined>;
  bring(app: string): Promise<void>;
  restore(app: string | undefined): Promise<void>;
}

export const macFront: Front = {
  async current() {
    try {
      const asn = Bun.spawnSync(["lsappinfo", "front"]).stdout.toString().trim();
      if (!asn) return undefined;
      const info = Bun.spawnSync(["lsappinfo", "info", "-only", "name", asn]).stdout.toString();
      return info.match(/"LSDisplayName"="([^"]+)"/)?.[1];
    } catch { return undefined; }
  },
  async bring(app) {
    Bun.spawnSync(["open", "-a", app]);
    await new Promise((r) => setTimeout(r, 900));
  },
  async restore(app) {
    if (!app) return;
    Bun.spawnSync(["open", "-a", app]);
  },
};

export interface SaveResult { ok: boolean; detail: string; results: ActionResult[]; foreground: number; steps: string[]; file?: string }

export interface SaveDeps {
  driver: Driver;
  agent: AgentName;
  win: WindowRef;
  /** false = never bring the app forward or click for real: the panel then cannot be driven, and it says so */
  allowForeground?: boolean;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  front?: Front;
  /** the home folder the sidebar's routes start from (tests) */
  home?: string;
  /** how long to wait for the file to appear after Save */
  waitMs?: number;
}

/**
 * Fill a Save panel that is open in `win` and save: navigate by real clicks, set the name by triple-click and paste, Return
 * to the panel's window, then look on disk for the file. `dest` is a folder or a full file path. Never replaces an existing
 * file: a Replace prompt is reported, not confirmed.
 */
export async function runSaveDialog(dest: string, deps: SaveDeps): Promise<SaveResult> {
  const { driver, agent, win } = deps;
  const allowFg = deps.allowForeground ?? true;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const front = deps.front ?? macFront;
  const results: ActionResult[] = [];
  const steps: string[] = [];
  let foreground = 0;
  const fail = (detail: string): SaveResult => ({ ok: false, detail, results, foreground, steps });
  const aborted = () => !!deps.signal?.aborted;
  const note = (r: ActionResult, what: string) => { results.push(r); steps.push(`${what}${r.ok || r.effect === "unverifiable" ? "" : ` [${r.error?.code ?? r.effect}]`}`); return r; };

  const target = splitDestination(dest);
  if ("error" in target) return fail(target.error);
  if (!allowFg) return fail("a Save panel can only be driven with real clicks and keys (the app comes forward), and foreground actions are off");
  if (!driver.clickAtFrame) return fail("this driver cannot click at a screen position");
  const route = routeTo(target.folder, deps.home);
  if (!route) return fail(`${target.folder} is not under your home folder: the panel can only be walked to by clicking down from its sidebar`);

  let obs: Observation = await driver.observe(agent, win);
  let panel = findSavePanel(obs.elements);
  if (!panel) return fail("there is no Save or Open panel open in this window");
  const word = panel.kind === "save" ? "Save" : "Open";
  const keys = await panelWindowOf(driver, win); // where key events must go
  const look = async () => { obs = await driver.observe(agent, win); panel = findSavePanel(obs.elements); return panel; };

  if (panel.kind === "open") {
    if (!target.name) return fail("an Open panel needs the path of the file to choose, not just a folder");
    if (!existsSync(join(target.folder, target.name))) return fail(`there is no file ${join(target.folder, target.name)} to choose`);
  }
  const before = new Set(readdirSync(target.folder));
  const wasFront = await front.current();
  await front.bring(win.app);
  foreground++;
  steps.push(`${win.app} brought forward`);
  try {
    // the column area: only rows inside it are on screen
    // column view (a browser) or list view (an outline): the area the rows are drawn in. A list shows one folder at a
    // time, and a folder is entered with a double-click; in columns one click shows the folder's contents
    const area = () => panel?.inside.find((e) => e.role === "AXBrowser" || (e.role === "AXOutline" && /list view/i.test(e.label ?? "")));
    const columns = () => area()?.frame;
    const inList = () => area()?.role === "AXOutline";
    const rows = () => (panel?.inside ?? []).filter((e) => e.frame && e.token && e.actions.includes("AXOpen") && e.role === "AXTextField");
    const firstColumnX = () => Math.min(...rows().map((r) => r.frame!.x), Infinity);

    /** click an element for real, then wait for the panel to react */
    const clickReal = async (el: AxElement, what: string, count = 1): Promise<boolean> => {
      const r = note(await driver.clickAtFrame!(agent, el.frame!, count), what);
      if (!r.ok) return false;
      await sleep(450);
      return !!(await look());
    };
    const whereIs = () => norm(panel?.where?.value ?? "");

    /** the row for a folder or file name, rightmost column first; a long list is scrolled until the row is on screen (checked again after the last scroll) */
    const rowNamed = async (name: string): Promise<AxElement | undefined> => {
      for (let n = 0; n <= 6; n++) {
        const cands = rows().filter((r) => norm(r.label ?? r.value ?? "") === norm(name) && inside(r.frame, columns()));
        const row = cands.sort((a, b) => b.frame!.x - a.frame!.x)[0];
        if (row) return row;
        const off = rows().some((r) => norm(r.label ?? r.value ?? "") === norm(name));
        const browser = area();
        if (!off || !browser?.token || n === 6) return undefined;
        note(await driver.scroll(agent, win, "down", browser.token), `scroll the list towards "${name}"`);
        await sleep(250);
        await look();
      }
      return undefined;
    };

    // 1. the start: a sidebar item (left of the first column), then each folder below it, one real click each
    const sidebar = () => {
      const names = cellNames(obs.markdown);
      return (panel?.inside ?? []).filter((e) => e.frame && (e.role === "AXCell" || e.role === "AXStaticText") && norm(names.get(e.index) ?? e.label ?? e.value ?? "") === norm(route.start) && e.frame.x + e.frame.w <= firstColumnX() + 12);
    };
    const start = sidebar()[0];
    if (!start) return fail(`the panel's sidebar has no "${route.start}" to start from`);
    if (!(await clickReal(start, `click sidebar "${route.start}"`))) return fail(`could not click the sidebar's "${route.start}"`);
    for (const dir of route.steps) {
      if (aborted()) return fail("stopped");
      const row = await rowNamed(dir);
      if (!row) return fail(`no folder "${dir}" is visible in the panel's columns (looked below ${route.start}${route.steps.indexOf(dir) > 0 ? ` > ${route.steps.slice(0, route.steps.indexOf(dir)).join(" > ")}` : ""})`);
      if (!(await clickReal(row, `${inList() ? "double-click" : "click"} folder "${dir}"`, inList() ? 2 : 1))) return fail(`could not click the folder "${dir}"`);
      if (whereIs() !== norm(dir)) return fail(`clicked "${dir}" but the panel shows "${panel?.where?.value ?? "?"}"`);
    }
    if (!panel) return fail(`the ${word} panel closed while going to the folder`);
    if (route.steps.length === 0 && whereIs() !== norm(route.start)) return fail(`clicked "${route.start}" but the panel shows "${panel.where?.value ?? "?"}"`);
    steps.push(`in ${target.folder}`);

    // an Open panel (a site's "Choose file"): select the file's row, Return opens it; the proof is that the panel closes
    if (panel.kind === "open") {
      const file = await rowNamed(target.name!);
      if (!file) return fail(`no file "${target.name}" is visible in the panel's columns (in ${target.folder})`);
      // in a list, a click on the name itself puts the row's name into edit mode (live: the row showed a text cursor and the
      // Open button stayed disabled); a click in the row's empty part, past the name, selects it
      const a = area()?.frame;
      const spot = inList() && a ? { ...file, frame: { x: a.x + a.w * 0.55, y: file.frame!.y, w: 20, h: file.frame!.h } } : file;
      if (!(await clickReal(spot, `click file "${target.name}"`))) return fail(`could not click the file "${target.name}"`);
      if (!panel) return fail("the Open panel closed after clicking the file (nothing confirms the right file was chosen)");
      const opened = note(await driver.pressKey(agent, keys, "return", undefined, true), "press Return in the Open panel");
      foreground++;
      if (!opened.ok) return fail(`could not press Return in the panel: ${opened.error?.detail ?? opened.effect}`);
      const limitOpen = deps.waitMs ?? 8000;
      let waitedOpen = 0;
      let clickedOpen = false;
      while (waitedOpen <= limitOpen) {
        await sleep(400);
        waitedOpen += 400;
        await look();
        if (!panel) return { ok: true, detail: `Chose ${join(target.folder, target.name!).replace(homedir(), "~")} in the Open panel (scripted: real clicks down from the sidebar, the file row, Return; the panel closed)`, results, foreground, steps, file: join(target.folder, target.name!) };
        if (!clickedOpen && waitedOpen >= 2000 && panel.confirm?.frame) {
          clickedOpen = true;
          note(await driver.clickAtFrame!(agent, panel.confirm!.frame!), "click Open");
        }
      }
      return fail("selected the file and pressed Open but the panel is still open");
    }

    // 2. the file name (Save panels): triple-click selects what is there, Cmd+V replaces it
    let expectName = panel.name?.value ?? "";
    if (panel.kind === "save" && target.name) {
      const field = panel.name;
      if (!field?.frame) return fail("the panel has no file name field to set");
      if (stem(field.value ?? "") !== stem(target.name)) {
        const clicked = note(await driver.clickAtFrame!(agent, field.frame, 3), "triple-click the file name");
        if (!clicked.ok) return fail("could not click the file name field");
        await sleep(300);
        if (!driver.paste) return fail("this driver cannot paste");
        const pasted = note(await driver.paste(agent, keys, undefined, target.name, true), `paste "${target.name}"`);
        foreground++;
        if (!pasted.ok) return fail(`could not paste the file name: ${pasted.error?.detail ?? pasted.effect}`);
        await sleep(400);
        await look();
        const now = panel?.name?.value ?? "";
        if (stem(now) !== stem(target.name)) return fail(`pasted "${target.name}" but the name field shows "${now}"`);
      }
      expectName = target.name;
    }

    // 3. Save: Return, to the panel's own window
    const saved = note(await driver.pressKey(agent, keys, "return", undefined, true), `press Return in the ${word} panel`);
    foreground++;
    if (!saved.ok) return fail(`could not press Return in the panel: ${saved.error?.detail ?? saved.effect}`);

    // 4. look: the panel closes and the file is on disk. A Replace prompt is reported, never answered
    const limit = deps.waitMs ?? 8000;
    let waited = 0;
    let clickedSave = false;
    while (waited <= limit) {
      await sleep(400);
      waited += 400;
      await look();
      if (panel) {
        if (obs.elements.some((e) => e.role === "AXButton" && /^(replace|overwrite)$/i.test((e.label ?? "").trim()))) {
          return fail(`a file with that name already exists in ${target.folder}: the panel asks to Replace it, and it was left unanswered (nothing was overwritten)`);
        }
        // Return did nothing (focus elsewhere): press the button itself once
        if (!clickedSave && waited >= 2000 && panel.confirm?.frame) {
          clickedSave = true;
          note(await driver.clickAtFrame!(agent, panel.confirm!.frame!), `click ${word}`);
        }
        continue;
      }
      const fresh = readdirSync(target.folder).filter((f) => !before.has(f));
      const want = stem(expectName);
      const hit = fresh.find((f) => stem(f) === want || stem(f).startsWith(want)) ?? (fresh.length === 1 ? fresh[0] : undefined);
      if (hit) {
        const file = join(target.folder, hit);
        return { ok: true, detail: `Saved ${file.replace(homedir(), "~")} (scripted: real clicks down from the sidebar${target.name ? ", pasted name" : ""}, Return; panel closed and the file is on disk)`, results, foreground, steps, file };
      }
    }
    return fail(panel ? `pressed ${word} but the panel is still open` : `the panel closed but no new file appeared in ${target.folder} (it may have saved somewhere else)`);
  } finally {
    await front.restore(wasFront);
  }
}
