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

export async function windowsOf(driver: Driver, appName: string): Promise<WindowRef[]> {
  const { windows } = await driver.listWindows();
  return windows
    // only windows the agent can actually read: not minimised, not on another desktop (Space)
    .filter((w) => w.app_name === appName && w.title && w.title.trim() !== "" && w.bounds.height > 100 && w.is_on_screen !== false && w.on_current_space !== false)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
    .map((w) => ({ pid: w.pid, windowId: w.window_id, app: appName, title: w.title }));
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
