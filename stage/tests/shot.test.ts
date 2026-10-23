// The picture of a task's working window (src/shot.ts): only that window, the Save / Open panel in front of it as a
// second one, never the screen; shrunk before it goes anywhere. Offline: a fake driver that "captures" a tiny PNG.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, WindowRaw, WindowRef } from "../src/contracts.ts";
import { windowShots } from "../src/shot.ts";

const PNG_1X1 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082", "hex");
const win = (app: string, title: string, id: number, over: Partial<WindowRaw> = {}): WindowRaw => ({ app_name: app, title, pid: 7, window_id: id, bounds: { x: 0, y: 0, width: 900, height: 700 }, is_on_screen: true, ...over });

function fakeDriver(windows: WindowRaw[], captured: number[] = [], fails: number[] = []): Driver {
  const dir = mkdtempSync(join(tmpdir(), "shot-test-"));
  return {
    listWindows: async () => ({ windows }),
    windowPicture: async (_a: string, w: WindowRef) => {
      captured.push(w.windowId);
      if (fails.includes(w.windowId)) return undefined;
      const f = join(dir, `w-${w.windowId}.png`);
      writeFileSync(f, PNG_1X1);
      return f;
    },
  } as unknown as Driver;
}

test("the window the task worked in is captured by id, not the screen and not another window of the app", async () => {
  const captured: number[] = [];
  const d = fakeDriver([win("Brave Browser", "Moodle", 160), win("Brave Browser", "Instagram", 215, { bounds: { x: 0, y: 0, width: 1400, height: 1000 } }), win("Notes", "Todo", 9)], captured);
  const shots = await windowShots(d, "Brave Browser", 160);
  expect(captured).toEqual([160]);
  expect(shots.map((s) => [s.kind, s.title])).toEqual([["window", "Moodle"]]);
  expect(shots[0]!.data.length).toBeGreaterThan(10);
});

test("without a window id, or when it has closed, the app's biggest window is used", async () => {
  const captured: number[] = [];
  const d = fakeDriver([win("Brave Browser", "small", 1, { bounds: { x: 0, y: 0, width: 500, height: 500 } }), win("Brave Browser", "big", 2, { bounds: { x: 0, y: 0, width: 1400, height: 1000 } })], captured);
  expect((await windowShots(d, "Brave Browser"))[0]!.title).toBe("big");
  expect((await windowShots(d, "Brave Browser", 999))[0]!.title).toBe("big");
});

test("an open Save panel is its own window and comes first, then the window behind it", async () => {
  const d = fakeDriver([win("Brave Browser", "Moodle", 160), win("Brave Browser", "Save", 3385, { bounds: { x: 0, y: 0, width: 880, height: 448 } })]);
  const shots = await windowShots(d, "Brave Browser", 160);
  expect(shots.map((s) => [s.kind, s.title])).toEqual([["panel", "Save"], ["window", "Moodle"]]);
  expect((await windowShots(d, "Brave Browser", 160, { max: 1 })).map((s) => s.kind)).toEqual(["panel"]);
});

test("a panel is never mistaken for the app's main window when no id is given", async () => {
  const d = fakeDriver([win("Brave Browser", "Save", 5, { bounds: { x: 0, y: 0, width: 1500, height: 1100 } }), win("Brave Browser", "Moodle", 160)]);
  const shots = await windowShots(d, "Brave Browser");
  expect(shots.map((s) => s.title)).toEqual(["Save", "Moodle"]);
});

test("minimised, off-desktop and thin windows are not captured; a failed capture is skipped, not fatal", async () => {
  const d = fakeDriver([win("Notes", "Gone", 1, { is_on_screen: false }), win("Notes", "strip", 2, { bounds: { x: 0, y: 0, width: 1800, height: 39 } }), win("Notes", "Todo", 3)], [], [3]);
  expect(await windowShots(d, "Notes")).toEqual([]);
  expect(await windowShots(fakeDriver([]), "Notes")).toEqual([]);
});

test("the picture is a shrunk JPEG where sips exists, and the temp files are removed", async () => {
  const d = fakeDriver([win("Notes", "Todo", 3)]);
  const [s] = await windowShots(d, "Notes", 3);
  expect(["image/jpeg", "image/png"]).toContain(s!.mime);
  if (s!.mime === "image/jpeg") expect(Buffer.from(s!.data, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
  expect(existsSync(join(tmpdir(), "stage-shots", "w-3.jpg"))).toBe(false);
});

test("a driver that cannot take a window picture gives nothing", async () => {
  expect(await windowShots({ listWindows: async () => ({ windows: [win("Notes", "Todo", 3)] }) } as unknown as Driver, "Notes")).toEqual([]);
});
