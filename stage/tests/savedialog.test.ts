// Save / Open panels in code (src/savedialog.ts), offline. The fake panel behaves like the live one measured in Brave
// (STEPS.md 198.1): a sidebar and a column view over a REAL temp folder tree, real clicks (clickAtFrame) that select
// rows, a triple-click that selects the name, Cmd+V that replaces it, a Return that works only when it is sent to the
// panel's own window, and a Save that writes a file. Switches reproduce the ways it misbehaved.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import type { ActionResult, AxElement, Brain, Driver, Helper, Observation, PlanStep, Rect, Task, WindowRaw, WindowRef } from "../src/contracts.ts";
import { RunLogger } from "../src/logger.ts";
import { runTask } from "../src/loop.ts";
import { classifyError, type RawCall } from "../src/driver.ts";
import { savePanelPlan } from "../src/compile.ts";
import { cellNames, findSavePanel, isSaveNameField, parseChord, routeTo, runSaveDialog, splitDestination, type Front } from "../src/savedialog.ts";

const WIN: WindowRef = { pid: 1, windowId: 160, app: "Brave Browser", title: "Untitled" };
const PANEL_WIN = 2991;
const ok = (channel: ActionResult["channel"] = "ax", effect?: string): ActionResult => ({ ok: true, channel, ms: 1, cli: "fake", effect });
const refusedOutside = (): ActionResult => ({ ok: false, channel: "ax", ms: 1, cli: "fake", effect: "refused", error: { code: "outside_window", detail: "could not be proven to belong to window 160" } });
const failed = (detail: string): ActionResult => ({ ok: false, channel: "ax", ms: 1, cli: "fake", error: { code: "other", detail } });

interface Opts {
  /** background clicks / value writes / typing on the main window are refused as outside_window (the live panel) */
  outsideBackground?: boolean;
  /** Return does nothing (focus is elsewhere): only the Save button saves */
  returnDoesNothing?: boolean;
  /** the panel closes but writes nothing */
  silentSave?: boolean;
  /** the pasted text does not land */
  pasteLost?: boolean;
  /** an Open panel (a site's Choose file): no name field, an Open button, Return opens the selected file */
  open?: boolean;
  /** the panel is in List view (one folder at a time, a folder is entered with a double-click), as the live Open panel was */
  list?: boolean;
}

/** a Save panel as Cua would list it, and the real-click / key behaviour measured live */
class FakePanel implements Driver {
  base: string;
  cwd: string;
  displayName = "MATH2014 ASSIGNMENT2 (1)";
  ext = ".pdf";
  nameSelected = false;
  closed = false;
  replacePrompt = false;
  selected: string | undefined;
  chosen: string | undefined;
  scrollOffset = 0;
  log: string[] = [];
  /** the live sidebar's cells have no label of their own: the name is only in the text tree */
  cellName = new Map<string, string>();
  foregroundCalls = 0;
  constructor(public home: string, private o: Opts = {}) {
    this.base = this.cwd = join(home, "Downloads");
  }

  private levels(): string[] {
    const out = [this.base];
    for (const part of relative(this.base, this.cwd).split("/").filter(Boolean)) out.push(join(out[out.length - 1]!, part));
    return out;
  }
  private el(i: number, role: string, label: string | undefined, depth: number, extra: Partial<AxElement> = {}): AxElement {
    return { index: i, depth, role, label, token: `t${i}`, actions: ["AXPress"], ...extra };
  }
  /** the real panel shows three columns and scrolls sideways to keep the newest in view */
  private shift() { return Math.max(0, this.levels().length - 3); }
  private sidebarLabels() { return ["Desktop", "Documents", "Downloads", basename(this.home)]; }
  elements(): AxElement[] {
    const els: AxElement[] = [this.el(0, "AXWindow", "Untitled", 0, { actions: [] })];
    let n = 1;
    const add = (role: string, label: string | undefined, depth: number, extra: Partial<AxElement> = {}) => { const e = this.el(n++, role, label, depth, extra); els.push(e); return e; };
    if (this.closed) return els;
    add("AXSheet", "save", 1, { actions: ["AXRaise"] });
    this.sidebarLabels().forEach((l, i) => { const e = add("AXCell", undefined, 5, { actions: ["AXOpen"], frame: { x: 375, y: 355 + i * 30, w: 98, h: 19 } }); this.cellName.set(e.token!, l); });
    if (this.o.list) {
      add("AXOutline", "list view", 4, { actions: ["AXShowMenu"], frame: { x: 374, y: 518, w: 882, h: 211 } });
      readdirSync(this.cwd).sort().forEach((name, k) => {
        add("AXTextField", name, 7, { value: name, actions: ["AXOpen", "AXShowMenu", "AXConfirm"], frame: { x: 529, y: 526 + (k - this.scrollOffset) * 22, w: 180, h: 18 } });
      });
    } else add("AXBrowser", "column view", 4, { actions: ["AXShowMenu"], frame: { x: 374, y: 518, w: 882, h: 211 } });
    const shift = this.shift();
    if (!this.o.list) this.levels().forEach((dir, i) => {
      readdirSync(dir).sort().forEach((name, k) => {
        add("AXTextField", name, 6, { value: name, actions: ["AXOpen", "AXShowMenu", "AXConfirm"], frame: { x: 529 + (i - shift) * 245, y: 526 + (k - this.scrollOffset) * 22, w: 180, h: 18 } });
      });
    });
    add("AXPopUpButton", "Where:", 3, { value: basename(this.cwd), frame: { x: 758, y: 473, w: 200, h: 26 } });
    add("AXTextField", "Search", 3, { actions: ["AXConfirm"] });
    if (!this.o.open) {
      add("AXTextField", this.displayName, 3, { value: this.displayName, actions: ["AXShowMenu", "AXConfirm"], frame: { x: 758, y: 392, w: 232, h: 26 } });
      add("AXTextField", "tag editor", 3, { actions: ["AXConfirm"] });
    }
    add("AXButton", "New Folder", 3, { frame: { x: 512, y: 748, w: 95, h: 26 } });
    add("AXButton", "Cancel", 3, { frame: { x: 1068, y: 748, w: 81, h: 26 } });
    // the live Open panel's button was disabled (so missing from Cua's element list) until a file was selected
    if (!this.o.open || this.selected) add("AXButton", this.o.open ? "Open" : "Save", 3, { frame: { x: 1155, y: 748, w: 81, h: 26 } });
    if (this.replacePrompt) {
      add("AXSheet", "alert", 2);
      add("AXButton", "Replace", 3);
      add("AXButton", "Cancel", 3);
    }
    // Cua lists parent_index: the loop reads the window through it (windowElements)
    els.forEach((e, k) => { for (let j = k - 1; j >= 0; j--) if (els[j]!.depth < e.depth) { e.parent = els[j]!.index; break; } });
    return els;
  }
  async ensureSession() {}
  async listWindows(): Promise<{ windows: WindowRaw[] }> {
    return { windows: [
      { app_name: "Brave Browser", title: "Untitled", pid: 1, window_id: 160, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, is_on_screen: true },
      ...(this.closed ? [] : [{ app_name: "Brave Browser", title: "Save", pid: 1, window_id: PANEL_WIN, bounds: { x: 375, y: 345, width: 880, height: 448 }, is_on_screen: true }]),
    ] };
  }
  async listApps() { return []; }
  async launchApp() { return { pid: 1 }; }
  async observe(agent: string, w: WindowRef): Promise<Observation> {
    const elements = this.elements();
    const markdown = elements.filter((e) => this.cellName.has(e.token!)).map((e) => `  - [${e.index}] AXCell [actions=[open]]\n      - AXStaticText = "${this.cellName.get(e.token!)}"\n      - AXImage (icon)`).join("\n");
    return { agent, window: w, elements, truncated: false, ms: 1, markdown };
  }

  /** Save writes the file; Open takes the selected file and closes (nothing selected: nothing happens) */
  private confirmButton() {
    if (!this.o.open) return this.save();
    if (!this.selected) { this.log.push("open -> nothing selected"); return; }
    this.chosen = this.selected;
    this.closed = true;
    this.log.push(`open ${this.selected}`);
  }
  private save() {
    const path = join(this.cwd, this.displayName + this.ext);
    if (existsSync(path)) { this.replacePrompt = true; this.log.push("save -> replace prompt"); return; }
    if (!this.o.silentSave) writeFileSync(path, "pdf");
    this.closed = true;
    this.log.push(`save ${path}`);
  }
  async click(_a: string, _w: WindowRef, token: string, foreground = false): Promise<ActionResult> {
    if (foreground) this.foregroundCalls++;
    if (this.o.outsideBackground && !foreground) return refusedOutside();
    const label = this.elements().find((e) => e.token === token)?.label;
    this.log.push(`press ${label}${foreground ? " fg" : ""}`);
    if (label === "Save" || label === "Open") this.confirmButton();
    return ok(foreground ? "foreground" : "ax");
  }
  async hotkey(_a: string, _w: WindowRef, keys: string[], _t?: string, foreground = false): Promise<ActionResult> {
    this.log.push(`hotkey ${keys.join("+")}${foreground ? " fg" : ""}`);
    if (foreground) this.foregroundCalls++;
    return ok(foreground ? "foreground" : "synthetic", "unverifiable");
  }
  /** a physical click: whatever sits at that screen position, if it is on screen */
  async clickAtFrame(_a: string, f: Rect, count = 1): Promise<ActionResult> {
    this.foregroundCalls++;
    const els = this.elements();
    const browser = els.find((e) => e.role === "AXBrowser" || e.role === "AXOutline")!.frame!;
    const hit = els.find((e) => e.frame && e.frame.x === f.x && e.frame.y === f.y && e.frame.w === f.w);
    // a list: a click in a row's empty part (right of the name) selects the row
    const rowHit = !hit && this.o.list ? els.find((e) => e.role === "AXTextField" && e.actions.includes("AXOpen") && e.frame && e.frame.y === f.y && f.x > e.frame.x + e.frame.w) : undefined;
    if (rowHit) {
      this.log.push(`real click row ${rowHit.label}`);
      try { if (!statSync(join(this.cwd, rowHit.label!)).isDirectory()) this.selected = join(this.cwd, rowHit.label!); } catch { /* gone */ }
      return ok("pixel", "unverifiable");
    }
    if (!hit) { this.log.push("click miss"); return ok("pixel", "unverifiable"); }
    this.log.push(`real click${count > 1 ? ` x${count}` : ""} ${hit.label ?? this.cellName.get(hit.token!)}`);
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    if (hit.role === "AXCell") {
      const name = this.cellName.get(hit.token!)!;
      const home = name === basename(this.home) ? this.home : join(this.home, name);
      this.base = this.cwd = home;
      this.scrollOffset = 0;
    } else if (hit.actions.includes("AXOpen")) {
      const onScreen = cx >= browser.x && cx <= browser.x + browser.w && cy >= browser.y && cy <= browser.y + browser.h;
      if (!onScreen) { this.log.push("click landed outside the columns"); return ok("pixel", "unverifiable"); }
      const level = this.o.list ? this.levels().length - 1 : Math.round((hit.frame!.x - 529) / 245) + this.shift();
      const dir = this.levels()[level]!;
      const path = join(dir, hit.label!);
      try {
        if (statSync(path).isDirectory()) {
          // columns: one click shows the folder; a list: only a double-click enters it
          if (!this.o.list || count >= 2) { this.cwd = path; this.scrollOffset = 0; }
        } else if (!this.o.list) this.selected = path; // in a list, a click on the name only starts renaming it
      } catch { /* gone */ }
    } else if (hit.label === this.displayName) {
      this.nameSelected = count === 3;
    } else if (hit.label === "Save" || hit.label === "Open") {
      this.confirmButton();
    }
    return ok("pixel", "unverifiable");
  }
  async typeText(_a: string, _w: WindowRef, token: string, text: string, foreground = false): Promise<ActionResult> {
    if (this.o.outsideBackground && !foreground) return refusedOutside();
    if (foreground) this.foregroundCalls++;
    const e = this.elements().find((x) => x.token === token);
    if (e?.label === this.displayName) this.displayName = text;
    this.log.push(`type ${text}${foreground ? " fg" : ""}`);
    return ok(foreground ? "foreground" : "ax");
  }
  /** Cmd+V into the name field: only when the triple-click selected it and the chord went to the panel's window */
  async paste(_a: string, w: WindowRef, _t: string | undefined, text: string, foreground = false): Promise<ActionResult> {
    this.log.push(`paste ${text} win=${w.windowId}${foreground ? " fg" : ""}`);
    if (w.windowId !== PANEL_WIN || this.o.pasteLost || !this.nameSelected) return ok("foreground", "unverifiable");
    this.ext = extname(text) || ".pdf";
    this.displayName = text.slice(0, text.length - extname(text).length) || text; // the panel hides the extension
    this.nameSelected = false;
    return ok("foreground", "unverifiable");
  }
  async pressKey(_a: string, w: WindowRef, key: string, _t?: string, foreground = false): Promise<ActionResult> {
    this.log.push(`key ${key} win=${w.windowId}${foreground ? " fg" : ""}`);
    if (w.windowId !== PANEL_WIN) return failed("exact target window did not become focused for foreground HID delivery");
    if (this.o.outsideBackground && !foreground) return refusedOutside();
    if (key === "return" && !this.o.returnDoesNothing && !this.replacePrompt) this.confirmButton();
    return ok("foreground", "unverifiable");
  }
  async scroll(): Promise<ActionResult> { this.scrollOffset += 4; this.log.push("scroll"); return ok(); }
  async confirm() { return ok(); }
  async setValue(_a: string, _w: WindowRef, token: string, value: string): Promise<ActionResult> {
    if (this.o.outsideBackground) return refusedOutside();
    const e = this.elements().find((x) => x.token === token);
    if (e?.label === this.displayName) this.displayName = value;
    this.log.push(`set ${value}`);
    return ok();
  }
  async endSession() {}
}

const fastSleep = async () => {};
/** a front-app fake that records what it was asked, so no test ever touches the real screen */
const fakeFront = () => {
  const calls: string[] = [];
  const front: Front = {
    async current() { calls.push("current"); return "Claude"; },
    async bring(app) { calls.push(`bring ${app}`); },
    async restore(app) { calls.push(`restore ${app}`); },
  };
  return { front, calls };
};
/** a home folder with Downloads, Documents/{proj/MATH2014, long/d00..d29} */
const tmpHome = () => {
  const home = mkdtempSync(join(tmpdir(), "savedlg-home-"));
  for (const d of ["Downloads/Old", "Desktop", "Documents/proj/MATH2014", "Documents/Courses/sem_3/MATH2014"]) mkdirSync(join(home, d), { recursive: true });
  for (let i = 0; i < 30; i++) mkdirSync(join(home, "Documents/long", `d${String(i).padStart(2, "0")}`), { recursive: true });
  return home;
};
const run = (dest: string, p: FakePanel, extra: Partial<Parameters<typeof runSaveDialog>[1]> = {}) => {
  const { front, calls } = fakeFront();
  return runSaveDialog(dest, { driver: p, agent: "Mint-3", win: WIN, sleep: fastSleep, front, home: p.home, waitMs: 4000, ...extra }).then((r) => ({ r, calls }));
};

test("parseChord: modifiers then one key; aliases normalised; a lone key is not a chord", () => {
  expect(parseChord("cmd+shift+g")).toEqual(["cmd", "shift", "g"]);
  expect(parseChord("Command + Option + K")).toEqual(["cmd", "option", "k"]);
  expect(parseChord("ctrl+enter")).toEqual(["ctrl", "return"]);
  expect(parseChord("g")).toBeUndefined();
  expect(parseChord("cmd+shift")).toBeUndefined();
  expect(parseChord("hyper+g")).toBeUndefined();
  expect(parseChord(undefined)).toBeUndefined();
});

test("routeTo: from a Favourite when the folder sits under one, else from the home folder; outside home is not reachable", () => {
  expect(routeTo("/Users/me/Documents/Courses/sem_3", "/Users/me")).toEqual({ start: "Documents", steps: ["Courses", "sem_3"] });
  expect(routeTo("/Users/me/Downloads", "/Users/me")).toEqual({ start: "Downloads", steps: [] });
  expect(routeTo("/Users/me/Projects/x", "/Users/me")).toEqual({ start: "me", steps: ["Projects", "x"] });
  expect(routeTo("/Users/me", "/Users/me")).toEqual({ start: "me", steps: [] });
  expect(routeTo("/private/tmp/x", "/Users/me")).toBeUndefined();
  expect(routeTo("/Users/meow/x", "/Users/me")).toBeUndefined(); // a sibling whose name starts the same
});

test("findSavePanel: the innermost sheet with Save and Cancel; the name field is not a search box, a tag box or a file row", () => {
  const p = new FakePanel(tmpHome());
  const sp = findSavePanel(p.elements())!;
  expect(sp.kind).toBe("save");
  expect(sp.name?.value).toBe("MATH2014 ASSIGNMENT2 (1)");
  expect(sp.where?.value).toBe("Downloads");
  expect(sp.confirm?.label).toBe("Save");
  expect(findSavePanel([{ index: 0, depth: 0, role: "AXWindow", label: "Notes", actions: [] }])).toBeUndefined();
  const nameTok = sp.name!.token!;
  expect(isSaveNameField(p.elements(), nameTok)).toBe(true);
  expect(isSaveNameField(p.elements(), p.elements().find((e) => e.actions.includes("AXOpen"))!.token)).toBe(false); // a file row
});

test("findSavePanel: a web page with its own Save and Cancel buttons is not a panel", () => {
  const page: AxElement[] = [
    { index: 0, depth: 0, role: "AXWindow", label: "Settings | Site", actions: [] },
    { index: 1, depth: 1, role: "AXTextField", label: "Display name", value: "Mohit", token: "a", actions: [], frame: { x: 0, y: 0, w: 1, h: 1 } },
    { index: 2, depth: 1, role: "AXButton", label: "Save", token: "b", actions: ["AXPress"] },
    { index: 3, depth: 1, role: "AXButton", label: "Cancel", token: "c", actions: ["AXPress"] },
  ];
  expect(findSavePanel(page)).toBeUndefined();
  expect(isSaveNameField(page, "a")).toBe(false);
  expect(findSavePanel(page.map((e) => (e.index === 0 ? { ...e, label: "Save" } : e)))?.kind).toBe("save");
});

test("splitDestination: a folder keeps the name, a file path sets it, a missing folder is refused", () => {
  const home = tmpHome();
  const dir = join(home, "Documents/proj/MATH2014");
  expect(splitDestination(dir)).toEqual({ folder: dir });
  expect(splitDestination(join(dir, "a b (1).pdf"))).toEqual({ folder: dir, name: "a b (1).pdf" });
  expect("error" in (splitDestination(join(dir, "nope", "x.pdf")) as object)).toBe(true);
});

test("savePanelPlan: a goal that finishes an open Save panel at an absolute path becomes one save_dialog step", () => {
  const dir = "/Users/me/Documents/Courses/sem_3/MATH2014";
  expect(savePanelPlan(`Complete the Save As dialog so the file saves into ${dir}`, [])).toEqual([{ action: "save_dialog", text: dir }]);
  expect(savePanelPlan(`In the open Save dialog, save the file as "${dir}/Assignment 2.pdf" and tell me it closed`, [])).toEqual([{ action: "save_dialog", text: `${dir}/Assignment 2.pdf` }]);
  expect(savePanelPlan("save the file in ~/Documents/x", [{ i: 0, id: "a", text: "Save", role: "AXButton", state: "n/a" }, { i: 1, id: "b", text: "Cancel", role: "AXButton", state: "n/a" }])).toEqual([{ action: "save_dialog", text: "~/Documents/x" }]);
  // the delegated goal Oni actually produced: the real path comes first, "sidebar/list)" is not a path
  expect(savePanelPlan("In the open Save As dialog, choose the folder /Users/me/Documents/Courses/_oni_savetest (you can press Cmd+Shift+G, or open Documents > Courses in the sidebar/list), then click Save", [])).toEqual([{ action: "save_dialog", text: "/Users/me/Documents/Courses/_oni_savetest" }]);
  expect(savePanelPlan("save the file in ~/Documents/x.", [{ i: 0, id: "a", text: "Save", role: "AXButton", state: "n/a" }, { i: 1, id: "b", text: "Cancel", role: "AXButton", state: "n/a" }])).toEqual([{ action: "save_dialog", text: "~/Documents/x" }]);
  expect(savePanelPlan("save the file in ~/Documents/x", [])).toBeNull(); // no panel on screen, none named
  expect(savePanelPlan("Complete the Save As dialog into the MATH2014 folder", [])).toBeNull(); // no path: not guessed
  expect(savePanelPlan(`open ${dir} in Finder`, [])).toBeNull();
});

test("savePanelPlan: an unquoted path with spaces and brackets is read whole, and the sentence after a folder is not part of it (the disk decides)", () => {
  const home = tmpHome();
  const dir = join(home, "Documents/proj/MATH2014");
  // the goal Oni produced for "save a second copy": no quotes, spaces and brackets in the name
  expect(savePanelPlan(`complete the open Save As dialog so the file saves into ${dir}/Lec01-Course overview (Moodle).pdf`, [])).toEqual([{ action: "save_dialog", text: `${dir}/Lec01-Course overview (Moodle).pdf` }]);
  expect(savePanelPlan(`complete the open Save As dialog so the file saves into ${dir}/a b.pdf and tell me the name`, [])).toEqual([{ action: "save_dialog", text: `${dir}/a b.pdf` }]);
  expect(savePanelPlan(`In the open Save dialog choose the folder ${dir} (you can press Cmd+Shift+G), then click Save`, [])).toEqual([{ action: "save_dialog", text: dir }]);
  expect(savePanelPlan(`In the open Save dialog save into ${dir} and then close the tab`, [])).toEqual([{ action: "save_dialog", text: dir }]);
  expect(savePanelPlan(`In the open Save dialog save into ${dir}.`, [])).toEqual([{ action: "save_dialog", text: dir }]);
});

test("classifyError: Cua's 'could not be proven to belong to window' is outside_window, not a stale token", () => {
  const rc = (json: any): RawCall => ({ json, raw: JSON.stringify(json), exit: 0, ms: 5, cli: "x" });
  expect(classifyError(rc({ effect: "refused", code: "element_outside_target_window", escalation: { reason: "the addressed element could not be proven to belong to window 160" } }))?.code).toBe("outside_window");
  expect(classifyError(rc({ effect: "refused", escalation: { reason: "the element could not be proven to belong to window 5" } }))?.code).toBe("outside_window");
  expect(classifyError(rc({ effect: "refused", escalation: { reason: "token is stale" } }))?.code).toBe("stale_element_token");
});

// ---------- runSaveDialog ----------

test("runSaveDialog: real clicks down from the sidebar, triple-click + paste for the name, Return to the PANEL window, file on disk", async () => {
  const home = tmpHome();
  const dir = join(home, "Documents/Courses/sem_3/MATH2014");
  const p = new FakePanel(home);
  const { r, calls } = await run(join(dir, "MATH2014 ASSIGNMENT2.pdf"), p);
  expect(r.ok).toBe(true);
  expect(r.file).toBe(join(dir, "MATH2014 ASSIGNMENT2.pdf"));
  expect(existsSync(r.file!)).toBe(true);
  expect(p.closed).toBe(true);
  // the order of what was done, read off the panel's own log
  expect(p.log.filter((l) => l.startsWith("real click") || l.startsWith("paste") || l.startsWith("key") || l.startsWith("save"))).toEqual([
    "real click Documents", "real click Courses", "real click sem_3", "real click MATH2014",
    "real click x3 MATH2014 ASSIGNMENT2 (1)",
    "paste MATH2014 ASSIGNMENT2.pdf win=2991 fg",
    "key return win=2991 fg",
    `save ${dir}/MATH2014 ASSIGNMENT2.pdf`,
  ]);
  // the app was brought forward first and the user's app put back last
  expect(calls).toEqual(["current", "bring Brave Browser", "restore Claude"]);
  expect(r.foreground).toBeGreaterThan(0);
});

test("runSaveDialog: a folder alone keeps the suggested name, and the file that appears is the one reported", async () => {
  const home = tmpHome();
  const p = new FakePanel(home);
  const { r } = await run(join(home, "Documents/proj/MATH2014"), p);
  expect(r.ok).toBe(true);
  expect(basename(r.file!)).toBe("MATH2014 ASSIGNMENT2 (1).pdf");
  expect(p.log.some((l) => l.startsWith("paste"))).toBe(false); // nothing to rename
});

test("runSaveDialog: a folder one click below a Favourite needs no folder rows", async () => {
  const home = tmpHome();
  const p = new FakePanel(home);
  const { r } = await run(join(home, "Desktop", "x.pdf"), p);
  expect(r.ok).toBe(true);
  expect(existsSync(join(home, "Desktop", "x.pdf"))).toBe(true);
});

test("runSaveDialog: a folder further down a long list is scrolled into view before it is clicked (a click off the columns would hit nothing)", async () => {
  const home = tmpHome();
  mkdirSync(join(home, "Documents/long/d29/deep"), { recursive: true });
  const p = new FakePanel(home);
  const { r } = await run(join(home, "Documents/long/d29/deep", "z.pdf"), p);
  expect(r.ok).toBe(true);
  expect(p.log.filter((l) => l === "scroll").length).toBeGreaterThan(0);
  expect(p.log).not.toContain("click landed outside the columns");
  expect(existsSync(join(home, "Documents/long/d29/deep", "z.pdf"))).toBe(true);
});

test("runSaveDialog: Return does nothing (focus elsewhere): the Save button is clicked for real, and the file is still checked on disk", async () => {
  const home = tmpHome();
  const p = new FakePanel(home, { returnDoesNothing: true });
  const { r } = await run(join(home, "Documents/proj", "a.pdf"), p);
  expect(r.ok).toBe(true);
  expect(p.log).toContain("real click Save");
  expect(existsSync(join(home, "Documents/proj", "a.pdf"))).toBe(true);
});

test("runSaveDialog: Return sent to the app's MAIN window is what failed live; the panel's window is found and used instead", async () => {
  const home = tmpHome();
  const p = new FakePanel(home);
  await run(join(home, "Documents/proj"), p);
  expect(p.log.filter((l) => l.startsWith("key")).every((l) => l.includes("win=2991"))).toBe(true);
});

test("runSaveDialog: a panel that closes without writing a file is a failure that says so, not a success", async () => {
  const home = tmpHome();
  const p = new FakePanel(home, { silentSave: true });
  const { r } = await run(join(home, "Documents/proj", "a.pdf"), p);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("no new file appeared");
});

test("runSaveDialog: a pasted name that does not land stops before Save, with what the field shows", async () => {
  const home = tmpHome();
  const p = new FakePanel(home, { pasteLost: true });
  const { r } = await run(join(home, "Documents/proj", "a.pdf"), p);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("name field shows");
  expect(p.log.some((l) => l.startsWith("key"))).toBe(false);
  expect(p.closed).toBe(false);
});

test("runSaveDialog: an existing file raises Replace: reported, never confirmed, the old file untouched", async () => {
  const home = tmpHome();
  const dir = join(home, "Documents/proj");
  writeFileSync(join(dir, "same.pdf"), "ORIGINAL");
  const p = new FakePanel(home);
  const { r } = await run(join(dir, "same.pdf"), p);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("Replace");
  expect(readFileSync(join(dir, "same.pdf"), "utf8")).toBe("ORIGINAL");
  expect(p.closed).toBe(false);
});

test("runSaveDialog: an Open panel (a site's Choose file): real clicks down to the folder, the file's row, Return; the proof is the panel closing on that file", async () => {
  const home = tmpHome();
  const dir = join(home, "Documents/Courses/sem_3/MATH2014");
  writeFileSync(join(dir, "A2_claude.pdf"), "x");
  writeFileSync(join(dir, "A2.pdf"), "the one");
  const p = new FakePanel(home, { open: true });
  const { r, calls } = await run(join(dir, "A2.pdf"), p);
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("Chose");
  expect(p.chosen).toBe(join(dir, "A2.pdf")); // not the similarly named other file
  expect(p.log.filter((l) => l.startsWith("real click") || l.startsWith("key") || l.startsWith("open "))).toEqual([
    "real click Documents", "real click Courses", "real click sem_3", "real click MATH2014", "real click A2.pdf",
    "key return win=2991 fg", `open ${join(dir, "A2.pdf")}`,
  ]);
  expect(p.log.some((l) => l.startsWith("paste"))).toBe(false); // no name field to type in
  expect(readdirSync(dir).sort()).toEqual(["A2.pdf", "A2_claude.pdf"]); // nothing written or removed
  expect(calls[calls.length - 1]).toBe("restore Claude");
});

test("runSaveDialog: an Open panel in List view with a disabled Open button: folders are double-clicked, the file selected, Return opens it", async () => {
  const home = tmpHome();
  const dir = join(home, "Documents/Courses/sem_3/MATH2014");
  writeFileSync(join(dir, "A2.pdf"), "the one");
  const p = new FakePanel(home, { open: true, list: true });
  expect(findSavePanel(p.elements())?.confirm).toBeUndefined(); // the live panel's state: no Open button in the element list
  expect(findSavePanel(p.elements())?.kind).toBe("open");
  const { r } = await run(join(dir, "A2.pdf"), p);
  expect(r.ok).toBe(true);
  expect(p.log.filter((l) => l.startsWith("real click"))).toEqual(["real click Documents", "real click x2 Courses", "real click x2 sem_3", "real click x2 MATH2014", "real click row A2.pdf"]);
  expect(p.chosen).toBe(join(dir, "A2.pdf"));
});

test("runSaveDialog: an Open panel is refused before any click when the file does not exist or only a folder was named", async () => {
  const home = tmpHome();
  const p = new FakePanel(home, { open: true });
  const missing = await run(join(home, "Documents/proj", "nope.pdf"), p);
  expect(missing.r.ok).toBe(false);
  expect(missing.r.detail).toContain("no file");
  const folder = await run(join(home, "Documents/proj"), p);
  expect(folder.r.detail).toContain("needs the path of the file");
  expect(p.log.length).toBe(0);
});

test("runSaveDialog: an Open panel whose Return does nothing is finished with a real click on Open", async () => {
  const home = tmpHome();
  writeFileSync(join(home, "Documents/proj", "a.pdf"), "x");
  const p = new FakePanel(home, { open: true, returnDoesNothing: true });
  const { r } = await run(join(home, "Documents/proj", "a.pdf"), p);
  expect(r.ok).toBe(true);
  expect(p.log).toContain("real click Open");
  expect(p.chosen).toBe(join(home, "Documents/proj", "a.pdf"));
});

test("savePanelPlan: choosing a file in an upload dialog compiles to the same step", () => {
  const f = "/Users/me/Documents/Courses/sem_3/MATH2014/3036517750_MATH2014_A2.pdf";
  expect(savePanelPlan(`In the open file chooser dialog, choose the file ${f}`, [])).toEqual([{ action: "save_dialog", text: f }]);
  expect(savePanelPlan(`select ${f} in the open Open panel`, [])).toEqual([{ action: "save_dialog", text: f }]);
  expect(savePanelPlan(`choose the file ${f}`, [{ i: 0, id: "a", text: "Open", role: "AXButton", state: "n/a" }, { i: 1, id: "b", text: "Cancel", role: "AXButton", state: "n/a" }])).toEqual([{ action: "save_dialog", text: f }]);
  expect(savePanelPlan(`open ${f} in Preview`, [])).toBeNull(); // no panel named, none on screen
});

test("runSaveDialog: refused before any click: no panel, a missing folder, a folder outside home, foreground off", async () => {
  const home = tmpHome();
  const closed = new FakePanel(home);
  closed.closed = true;
  expect((await run(join(home, "Documents"), closed)).r.detail).toContain("no Save or Open panel");

  const p = new FakePanel(home);
  const missing = await run(join(home, "Documents", "missing", "x.pdf"), p);
  expect(missing.r.detail).toContain("does not exist");

  const outside = tmpdir();
  const out = await run(outside, p);
  expect(out.r.ok).toBe(false);
  expect(out.r.detail).toContain("not under your home folder");

  const off = await run(join(home, "Documents"), p, { allowForeground: false });
  expect(off.r.ok).toBe(false);
  expect(off.r.detail).toContain("foreground actions are off");

  expect(p.log.length).toBe(0); // nothing was touched by any of them
});

test("runSaveDialog: a folder that is not in the columns fails with where it looked, and never presses Save", async () => {
  const home = tmpHome();
  const dir = join(home, "Documents/proj");
  const p = new FakePanel(home);
  // the folder exists on disk but the panel's view does not list it (renamed meanwhile)
  const real = p.elements.bind(p);
  p.elements = () => real().filter((e) => e.label !== "proj");
  const { r, calls } = await run(join(dir, "MATH2014"), p);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain('no folder "proj"');
  expect(p.log.some((l) => l.startsWith("key") || l.startsWith("save"))).toBe(false);
  expect(calls[calls.length - 1]).toBe("restore Claude"); // the user's app comes back even on failure
});

// ---------- through the loop: the plan steps and the foreground click retry ----------

const newTask = (goal: string): Task => ({
  id: "t1", agent: "Mint-3", app: "Brave Browser", goal, brain: "jev", status: "queued", steps: 0, seconds: 0,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [],
});
const noBrain: Brain = { kind: "jev", model: "x", async classify() { throw new Error("no classifier call expected"); } };
const helperWith = (steps: PlanStep[]): Helper => ({
  canEscalate: false,
  async plan() { return { steps, costUsd: 0, ms: 0, source: "compiled" } as any; },
  async writeText() { return { text: "", costUsd: 0, ms: 0 }; },
  async verify() { return { achieved: true, answer: "done", reason: "shown", costUsd: 0, ms: 0 }; },
});
const ctxFor = (driver: Driver, helper: Helper) => ({
  runId: "test", driver, brain: noBrain, helper, signal: new AbortController().signal, win: WIN, sleep: async () => {},
  log: new RunLogger("t-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
});

test("loop: a save_dialog step on a folder outside home ends the task as not achieved, with the reason, and presses nothing", async () => {
  const p = new FakePanel(tmpHome());
  const task = await runTask(ctxFor(p, helperWith([{ action: "save_dialog", text: tmpdir() }])), newTask("Complete the Save As dialog"));
  expect(task.status).toBe("failed");
  expect(task.exception?.code).toBe("not_achieved");
  expect(task.exception?.reason).toContain("not under your home folder");
  expect(p.log.length).toBe(0);
});

test("loop: a save_dialog step that saved the file ends the task as done: no screen check, no replanning against the closed panel", async () => {
  const home = tmpHome();
  const p = new FakePanel(home);
  let plans = 0, verifies = 0;
  const helper: Helper = {
    ...helperWith([{ action: "save_dialog", text: join(home, "Documents/proj", "a.pdf") }]),
    async plan() { plans++; return { steps: [{ action: "save_dialog", text: join(home, "Documents/proj", "a.pdf") }], costUsd: 0, ms: 0, source: "compiled" } as any; },
    // what the live run saw: nothing new on screen once the panel had closed
    async verify() { verifies++; return { achieved: false, answer: "", reason: "nothing new appeared on screen since the task started", costUsd: 0, ms: 0 }; },
  };
  const { front } = fakeFront();
  const task = await runTask({ ...ctxFor(p, helper), saveDeps: { front, home, waitMs: 4000 } }, newTask("complete the open Save As dialog so the file saves into x"));
  expect(task.status).toBe("done");
  expect(task.answer).toContain("is on disk");
  expect(plans).toBe(1);
  expect(verifies).toBe(0);
  expect(existsSync(join(home, "Documents/proj", "a.pdf"))).toBe(true);
});

test("loop: a hotkey step presses the chord once, in the foreground; a text that is not a chord is refused", async () => {
  const p = new FakePanel(tmpHome());
  const task = await runTask(ctxFor(p, helperWith([{ action: "hotkey", text: "cmd+shift+g" }])), newTask("press the chord"));
  expect(p.log.filter((l) => l.startsWith("hotkey"))).toEqual(["hotkey cmd+shift+g fg"]);
  expect(task.counts.foreground).toBe(1);
  expect(task.status).toBe("done");
  const q = new FakePanel(tmpHome());
  const bad = await runTask(ctxFor(q, helperWith([{ action: "hotkey", text: "g" }])), newTask("press g"));
  expect(bad.status).toBe("failed");
  expect(q.log.length).toBe(0);
});

test("loop: a click refused in the background (outside the window) is retried once in the foreground", async () => {
  const p = new FakePanel(tmpHome(), { outsideBackground: true });
  const task = await runTask(ctxFor(p, helperWith([{ action: "click", target: "Cancel" }])), newTask("cancel the dialog"));
  expect(p.log).toContain("press Cancel fg");
  expect(p.foregroundCalls).toBe(1);
  expect(task.counts.foreground).toBe(1);
});

test("loop: the Save panel's suggested name may be replaced when the goal saves a file (and only then)", async () => {
  const pickName = (items: any[]) => items.find((i) => i.role === "AXTextField" && i.text.startsWith("MATH2014 ASSIGNMENT2"))?.i;
  const runGoal = async (goal: string) => {
    const p = new FakePanel(tmpHome());
    let n = 0;
    const brain: Brain = { kind: "jev", model: "x", async classify(_f, items) { const k = n++; return { kind: k === 0 ? "type_text" : "done", item: k === 0 ? pickName(items) : undefined, kindConf: 1, itemConf: 1, gate: 1, backend: "jev", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 } as any; } };
    const helper: Helper = { ...helperWith([]), async writeText() { return { text: "Report.pdf", costUsd: 0, ms: 0 }; } };
    await runTask({ ...ctxFor(p, helper), brain }, newTask(goal));
    return p;
  };
  const saves = await runGoal('Save the file as "Report.pdf"');
  expect(saves.log.some((l) => l.startsWith("set ") || l.startsWith("type Report.pdf"))).toBe(true);
  const other = await runGoal('Write "Report.pdf" somewhere');
  expect(other.log.some((l) => l.startsWith("set ") || l.startsWith("type Report.pdf"))).toBe(false);
});

test("cellNames: a sidebar cell's name is the static text under it in Cua's text tree (the element list has none)", () => {
  const md = [
    "- [54] AXSheet (save) [id=save-panel actions=[raise]]",
    "    - AXOutline (sidebar)",
    "      - [55] AXRow [actions=[showdefaultui]]",
    "        - [56] AXCell [actions=[open]]",
    '          - AXStaticText = "Shared"',
    "          - AXImage (Two people)",
    "      - [57] AXRow [actions=[showdefaultui]]",
    '          - AXStaticText = "Favourites"',
    "      - [62] AXRow [actions=[showdefaultui]]",
    "        - [63] AXCell [actions=[open]]",
    '          - AXStaticText = "Documents"',
  ].join("\n");
  const names = cellNames(md);
  expect(names.get(56)).toBe("Shared");
  expect(names.get(63)).toBe("Documents");
  expect(names.get(57)).toBe("Favourites"); // a header row: harmless, it has no cell to click
  expect(cellNames(undefined).size).toBe(0);
});
