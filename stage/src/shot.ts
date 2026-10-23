// A picture of the window an agent was working in, for Oni to look at when a task stalls or fails.
//
// Only that window, never the screen: Cua captures a window by its id, so what other apps cover (or what is behind it)
// is not in the picture, and the picture holds the app and nothing else. An open Save / Open panel is its own window, so
// it is a second picture. The images are shrunk to JPEG (a screenshot of a whole window is ~5 MB of PNG): they go
// into the model's context, where size is cost.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, WindowRef } from "./contracts.ts";

export interface WindowShot {
  /** "window" for the app's window, "panel" for a Save / Open panel in front of it */
  kind: "window" | "panel";
  title: string;
  mime: "image/jpeg" | "image/png";
  /** base64, no data: prefix */
  data: string;
}

/** a panel window: macOS draws a Save / Open panel as a window of its own, titled by what it does */
const PANEL_TITLE = /^(save|open|export|choose|select)\b/i;
const MAX_SIDE = 900;
const JPEG_QUALITY = 60;

/** shrink a PNG to a JPEG no taller or wider than MAX_SIDE with macOS's own `sips`; the PNG itself when that is not possible */
function shrink(png: string): { path: string; mime: WindowShot["mime"] } {
  const jpg = png.replace(/\.png$/i, "") + ".jpg";
  try {
    const r = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(JPEG_QUALITY), "-Z", String(MAX_SIDE), png, "--out", jpg]);
    if (r.exitCode === 0 && existsSync(jpg)) return { path: jpg, mime: "image/jpeg" };
  } catch { /* not macOS, or sips is missing */ }
  return { path: png, mime: "image/png" };
}

/**
 * The pictures of one app's working window: the panel in front of it when there is one, then the window itself.
 * `windowId` names the window the agent worked in (a task knows it); without it, or when it has closed since, the app's
 * biggest window is used. An empty list means there was nothing to capture.
 */
export async function windowShots(driver: Driver, app: string, windowId?: number, opts: { max?: number } = {}): Promise<WindowShot[]> {
  if (!driver.windowPicture) return [];
  const { windows } = await driver.listWindows();
  const mine = windows.filter((w) => w.app_name === app && (w.bounds?.height ?? 0) > 100 && w.is_on_screen !== false);
  const main = mine.find((w) => w.window_id === windowId)
    ?? [...mine].filter((w) => !PANEL_TITLE.test((w.title ?? "").trim())).sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
  const panel = mine.find((w) => w.pid === (main?.pid ?? w.pid) && w.window_id !== main?.window_id && PANEL_TITLE.test((w.title ?? "").trim()) && w.bounds.width > 200);
  const wanted: { w: (typeof mine)[number]; kind: WindowShot["kind"] }[] = [];
  if (panel) wanted.push({ w: panel, kind: "panel" });
  if (main) wanted.push({ w: main, kind: "window" });
  const out: WindowShot[] = [];
  const dir = join(tmpdir(), "stage-shots");
  mkdirSync(dir, { recursive: true });
  for (const { w, kind } of wanted.slice(0, opts.max ?? 2)) {
    const ref: WindowRef = { pid: w.pid, windowId: w.window_id, app, title: (w.title ?? "").trim() || app };
    let png: string | undefined;
    try { png = await driver.windowPicture("Shot", ref); } catch { /* skip this window */ }
    if (!png) continue;
    const small = shrink(png);
    try {
      out.push({ kind, title: ref.title, mime: small.mime, data: readFileSync(small.path).toString("base64") });
    } finally {
      for (const f of new Set([png, small.path])) { try { rmSync(f, { force: true }); } catch { /* already gone */ } }
    }
  }
  return out;
}
