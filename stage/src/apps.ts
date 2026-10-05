// Finding the app a task names, and the one window an agent will work in.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppInfo, Driver, AgentName, WindowRef } from "./contracts.ts";

const SCRATCH = join(import.meta.dir, "..", "scratch");

/** "calculator", "Calc", "safari browser" -> the installed app */
export function matchApp(apps: AppInfo[], name: string): AppInfo | null {
  const n = name.trim().toLowerCase().replace(/\.app$/, "");
  return (
    apps.find((a) => a.name.toLowerCase() === n) ??
    apps.find((a) => a.name.toLowerCase().startsWith(n)) ??
    apps.find((a) => n.includes(a.name.toLowerCase()) && a.name.length >= 4) ??
    apps.find((a) => a.name.toLowerCase().includes(n) && n.length >= 4) ??
    null
  );
}

const GENERIC_WORD = /^(the|app|apps|my|new|and|for|of)$/; // these say nothing about which app is meant
const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const nameWords = (s: string) => wordsOf(s).filter((w) => w.length >= 2 && !GENERIC_WORD.test(w));
/** an app name compared by its letters only: case, spacing and a trailing ".app" don't count */
const appKey = (s: string) => s.trim().toLowerCase().replace(/\.app$/, "").replace(/\s+/g, " ");

/**
 * How people name an app whose installed name is longer ("Brave", "Chrome", "Excel"): the planner's own short names
 * (manager.ts, appAlias), plus "Word": as the name of an app it can only mean Microsoft Word, where in a sentence it
 * may be "a word doc" (which is why the planner leaves it out).
 */
function shortNamesOf(installed: string): string[] {
  if (installed === "Brave Browser") return ["brave"];
  if (installed === "Google Chrome") return ["chrome"];
  const ms = installed.match(/^Microsoft (Word|Excel|PowerPoint|Outlook|Teams|OneNote)$/);
  return ms ? [ms[1]!.toLowerCase()] : [];
}

/**
 * The one installed app a name stands for, or null. Stricter than matchApp, for names that arrive in a field of their
 * own (Oni's tasks, /api/look), where a sloppy name must never land silently in a different app. In order: the exact
 * name (any case); a short name people use for it ("Brave", "Chrome", "Word"); the whole words of ONE installed name
 * ("Settings" is System Settings, but "System" is two apps, so unknown). Never the reverse: a name that CONTAINS an
 * installed name ("Photoshop" is not Photos, "Safari browser" is not Safari) and a mere prefix ("Calc") are unknown.
 * The unknown-app reply then offers suggestApps' closest names, so the caller fixes the name instead.
 */
export function resolveAppStrict(apps: AppInfo[], name: string): AppInfo | null {
  const key = appKey(name);
  if (!key) return null;
  const named = apps.find((a) => appKey(a.name) === key) ?? apps.find((a) => shortNamesOf(a.name).includes(key));
  if (named) return named;
  const given = wordsOf(key);
  if (!given.some((w) => w.length >= 2 && !GENERIC_WORD.test(w))) return null; // "app", "the": no app is named
  const holders = new Map<string, AppInfo>(); // each installed name once, whatever its case
  for (const a of apps) {
    const words = wordsOf(a.name);
    const holds = words.some((_, i) => given.every((w, j) => words[i + j] === w)); // the given words, in a row
    if (holds && !holders.has(appKey(a.name))) holders.set(appKey(a.name), a);
  }
  return holders.size === 1 ? [...holders.values()][0]! : null;
}

/**
 * Installed apps that look like the one a caller named when nothing matched: a word in common ("Google Docs" ->
 * Google Chrome), one name inside the other, the same first three letters ("Spotfy" -> Spotify). Best first (more words
 * in common, then one name inside the other, then the same start, then running apps), at most `max`: an unknown app's
 * reply offers these so the caller can fix the name instead of guessing again.
 */
export function suggestApps(apps: AppInfo[], asked: string, max = 5): string[] {
  const q = asked.trim().toLowerCase().replace(/\.app$/, "");
  const qWords = new Set(nameWords(q));
  const seen = new Set<string>();
  const scored: { name: string; score: number }[] = [];
  for (const a of apps) {
    const n = a.name.toLowerCase();
    if (!q || seen.has(n)) continue;
    seen.add(n);
    const shared = nameWords(n).filter((w) => qWords.has(w)).length;
    // a name of 3 letters inside a longer word proves nothing (the app Arc inside "search"): same floor as matchApp's
    const inside = (q.length >= 3 && n.includes(q)) || (n.length >= 4 && q.includes(n));
    const sameStart = q.length >= 3 && n.length >= 3 && n.slice(0, 3) === q.slice(0, 3);
    if (!shared && !inside && !sameStart) continue;
    scored.push({ name: a.name, score: shared * 4 + (inside ? 2 : 0) + (sameStart ? 1 : 0) + (a.running ? 0.5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, max).map((s) => s.name);
}

export async function windowsOf(driver: Driver, appName: string): Promise<WindowRef[]> {
  const { windows } = await driver.listWindows();
  return windows
    // only windows the agent can actually read: not minimised, not on another desktop (Space). A window may have no
    // title (System Settings launched in the background has none until a pane loads: live, "opened no window"), so an
    // untitled one counts when it is a real, sizeable window, not one of the thin untitled "ghost" strips apps keep
    .filter((w) => w.app_name === appName && w.bounds.height > 100 && w.is_on_screen !== false && w.on_current_space !== false &&
      ((w.title ?? "").trim() !== "" || ((w as any).layer === 0 && w.bounds.width > 200 && w.bounds.height > 200)))
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
    .map((w) => ({ pid: w.pid, windowId: w.window_id, app: appName, title: (w.title ?? "").trim() || appName }));
}

async function waitForWindow(driver: Driver, appName: string, pred: (w: WindowRef) => boolean, ms = 8000): Promise<WindowRef | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ws = (await windowsOf(driver, appName)).filter(pred);
    if (ws.length) return ws[0]!;
    await Bun.sleep(400);
  }
  return null;
}

/** un-minimise an app's minimised windows WITHOUT bringing it to the front (measured: the front app stays the same) */
export async function restoreMinimized(appName: string): Promise<boolean> {
  const p = Bun.spawn(["osascript", "-e", `tell application "System Events" to tell process ${JSON.stringify(appName)}
    set ws to (every window whose value of attribute "AXMinimized" is true)
    repeat with w in ws
      set value of attribute "AXMinimized" of w to false
    end repeat
    return count of ws
  end tell`], { stdout: "pipe", stderr: "ignore" });
  const n = Number((await new Response(p.stdout).text()).trim()) || 0;
  if (n) await Bun.sleep(900); // the restore animation
  return n > 0;
}

/**
 * whether the Mac's screen is locked. Then macOS hides every window from accessibility and no agent can see or do
 * anything: say so plainly instead of a confusing "could not read the window" per app (live: every task failed with
 * ax_window_unresolved while the user had stepped away). Read from the login session (ioreg), ~20 ms, no permission.
 */
export const LOCKED_MESSAGE = "the Mac's screen is locked: Backstage and Onstage only work while you're logged in with the screen unlocked";
let lockCache: { at: number; locked: boolean } | undefined;
export async function screenLocked(): Promise<boolean> {
  if (lockCache && Date.now() - lockCache.at < 2000) return lockCache.locked;
  try {
    const p = Bun.spawn(["ioreg", "-n", "Root", "-d1", "-a"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    const locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
    lockCache = { at: Date.now(), locked };
    return locked;
  } catch {
    return false; // can't tell: never block on it
  }
}

export async function frontApp(): Promise<string> {
  const p = Bun.spawn(["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}
async function activate(name: string) {
  if (!name) return;
  await Bun.spawn(["osascript", "-e", `tell application ${JSON.stringify(name)} to activate`], { stdout: "ignore", stderr: "ignore" }).exited;
}
const CHROMIUM = /chrome|brave|edge|arc|chromium|vivaldi|opera/i;

/** the app links Stage's own compilers build (src/compile.ts: Maps directions, Stocks quotes); every other custom scheme is refused */
const APP_SCHEMES = new Set(["maps", "stocks"]);
/** sites the planners send the agents to: a long query is normal there (a search) */
const FAMILIAR_HOSTS = [
  "wikipedia.org", "youtube.com", "bing.com", "duckduckgo.com", "github.com", "apple.com", "claude.ai", "anthropic.com",
  "typesafe.ai", "whatsapp.com", "chatgpt.com", "hku.hk", "instructure.com",
];
const familiar = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host) || FAMILIAR_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
/** more than this much text (decoded) in an unfamiliar site's path and query looks like screen text being carried off */
export const MAX_UNFAMILIAR_URL_TEXT = 256;
const PACKAGE = /\.(app|pkg|mpkg|bundle|framework|plugin|appex|kext|prefpane|saver|workflow|action|command|tool|terminal|scpt|scptd|sh)\/?$/i;
const privateHost = (h: string) =>
  h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0" || h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe80") ||
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);

/**
 * May an agent open this address in this app? The address can come from an LLM plan, which may have read a hostile
 * page, so only: http(s) web addresses (not local or private-network hosts, no user:password@, and no long chunk of
 * text sent to an unfamiliar site), the app links the code itself builds (maps://, stocks://), and, for Finder only, a
 * folder path. file:, javascript:, data:, mailto:, other app schemes are refused.
 */
export function checkUrl(raw: string, appName: string): { ok: true; url: string } | { ok: false; why: string } {
  const u = raw.trim();
  if (!u) return { ok: false, why: "empty address" };
  // a folder (Finder)
  if (u.startsWith("~/") || u.startsWith("/")) {
    if (appName !== "Finder") return { ok: false, why: "a file path opens only in Finder" };
    if (u.split("/").includes("..")) return { ok: false, why: "a path with '..'" }; // before join(), which resolves it
    const path = u.startsWith("~/") ? join(homedir(), u.slice(2)) : u;
    if (PACKAGE.test(path)) return { ok: false, why: "an app, package or script, not a folder" };
    return { ok: true, url: path };
  }
  // "localhost:3000" is a host and a port, not a scheme
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):(?!\d)/i)?.[1]?.toLowerCase();
  if (scheme && APP_SCHEMES.has(scheme)) return { ok: true, url: u };
  if (scheme && scheme !== "http" && scheme !== "https") return { ok: false, why: `${scheme}: links are not opened` };
  let url: URL;
  try { url = new URL(scheme ? u : `https://${u}`); } catch { return { ok: false, why: "not a valid web address" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, why: `${url.protocol} links are not opened` };
  if (url.username || url.password) return { ok: false, why: "an address with a user name or password in it" };
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") && host !== "localhost" && !host.startsWith("[")) return { ok: false, why: "not a public web address" };
  if (privateHost(host)) return { ok: false, why: "a local or private-network address" };
  if (!familiar(host)) {
    let carried = url.pathname + url.search + url.hash;
    try { carried = decodeURIComponent(carried.replace(/\+/g, " ")); } catch { /* keep it encoded */ }
    if (carried.length > MAX_UNFAMILIAR_URL_TEXT) return { ok: false, why: `${carried.length} characters of text in an address on ${host}` };
  }
  return { ok: true, url: url.href };
}

/**
 * open one or more URLs (space-separated) in a browser WITHOUT the keyboard (keys are often refused in background
 * browsers). newWindow: Chromium browsers get a fresh window with all URLs as tabs. If the browser grabs the front,
 * the previous app is put back in front and the step is counted as a foreground step.
 */
export async function openUrl(driver: Driver, agent: AgentName, app: AppInfo, url: string, newWindow = false): Promise<{ win: WindowRef; note?: string; tookFront?: boolean }> {
  // a folder path (Finder) or a web address: each one checked (the address may come from an LLM plan), all or none
  const urls: string[] = [];
  for (const u of url.split(/\s+/).filter(Boolean)) {
    const c = checkUrl(u, app.name);
    if (!c.ok) throw new Error(`refused to open ${u.slice(0, 80)}${u.length > 80 ? "…" : ""}: ${c.why}`);
    urls.push(c.url);
  }
  if (!urls.length) throw new Error("no address to open");
  const full = urls[0]!;
  const before = new Map((await windowsOf(driver, app.name)).map((w) => [w.windowId, w.title] as const));
  const wasFront = await frontApp();
  if (newWindow && CHROMIUM.test(app.name)) await driver.launchApp(agent, app.bundle_id, [], { newInstance: true, args: ["--new-window", ...urls] });
  else await driver.launchApp(agent, app.bundle_id, urls);
  // a new window, or an existing one whose title changed (the URL opened in a tab there), or, for a folder, a window
  // already showing it (Finder just brings an existing window forward: no new window, no title change)
  const folder = full.startsWith("/") ? full.replace(/\/+$/, "").split("/").pop() : undefined;
  // an app's own link (maps://, stocks://) opens in its existing window, often without a title change: don't wait long
  const appLink = /^(maps|stocks):/i.test(full);
  const w = await waitForWindow(driver, app.name, (x) => !before.has(x.windowId) || before.get(x.windowId) !== x.title || (!!folder && x.title === folder), appLink ? 1500 : 6000);
  let all = await windowsOf(driver, app.name);
  if (!all.length && (await restoreMinimized(app.name))) all = await windowsOf(driver, app.name); // it opened in a minimised window
  const pick = w ?? (folder ? all.find((x) => x.title === folder) : undefined) ?? all[0];
  if (!pick) throw new Error(`${app.name} did not open ${full} in a window on this desktop (is it in full screen or on another desktop?)`);
  let tookFront = false;
  if (wasFront && wasFront !== app.name && (await frontApp()) === app.name) {
    tookFront = true;
    await activate(wasFront); // the browser stole the front: give it back
  }
  return { win: pick, tookFront, note: all.length > 1 ? `${app.name} has ${all.length} windows: background key presses may be refused` : undefined };
}

/**
 * The window an agent will work in. Apps are launched in the BACKGROUND (they do not come to the front).
 * Document apps (TextEdit) get a fresh scratch document so the agent never edits the user's own files.
 */
export async function prepareWindow(driver: Driver, agent: AgentName, app: AppInfo, url?: string): Promise<{ win: WindowRef; note?: string }> {
  if (app.name === "TextEdit") {
    mkdirSync(SCRATCH, { recursive: true });
    const file = join(SCRATCH, `${agent}-${Date.now()}.txt`);
    writeFileSync(file, "");
    const base = file.split("/").pop()!;
    await driver.launchApp(agent, app.bundle_id, [file]);
    const w = await waitForWindow(driver, app.name, (x) => x.title.includes(base.replace(/\.txt$/, "")));
    if (!w) throw new Error("TextEdit did not open the scratch document");
    return { win: w, note: `scratch document ${base}` };
  }
  if (url) return openUrl(driver, agent, app, url);
  let ws = await windowsOf(driver, app.name);
  let restored = false;
  if (ws.length === 0 && (await restoreMinimized(app.name))) { ws = await windowsOf(driver, app.name); restored = ws.length > 0; }
  if (ws.length === 0) {
    // no window on this desktop: launch it; an app that is already running (its windows closed, or all on another
    // desktop) needs a "reopen" (what clicking its Dock icon sends, here without bringing it to the front); a
    // Chromium browser with its windows on another desktop needs an explicit new window
    await driver.launchApp(agent, app.bundle_id);
    let w = await waitForWindow(driver, app.name, () => true, 3000);
    if (!w) {
      await Bun.spawn(["open", "-g", "-b", app.bundle_id], { stdout: "ignore", stderr: "ignore" }).exited;
      w = await waitForWindow(driver, app.name, () => true, 4000);
    }
    if (!w && CHROMIUM.test(app.name)) {
      await driver.launchApp(agent, app.bundle_id, [], { newInstance: true, args: ["--new-window"] });
      w = await waitForWindow(driver, app.name, () => true, 5000);
    }
    if (!w) throw new Error(`${app.name} opened no window on this desktop (is it in full screen or on another desktop?)`);
    ws = [w];
  }
  const note = [restored ? `restored a minimised ${app.name} window` : "", ws.length > 1 ? `${app.name} has ${ws.length} windows; using "${ws[0]!.title}"` : ""].filter(Boolean).join("; ");
  return { win: ws[0]!, note: note || undefined };
}
