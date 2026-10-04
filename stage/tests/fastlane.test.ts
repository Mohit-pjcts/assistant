// The fast lane's request shape and outcomes, and the Cua driver's time limits (offline: no helper, no cua-driver).
import { expect, test } from "bun:test";
import { classifyError, fastToAction, runLimited, type RawCall } from "../src/driver.ts";
import { ACT_DEADLINE_MS, ANSWER_TIMEOUT_MS, requestLine, unusableLabel } from "../src/fastlane.ts";

const target = { pid: 42, frame: { x: 10, y: 20, w: 30, h: 40 }, role: "AXButton", label: "Reload", windowId: 777, winFrame: { x: 0, y: 0, w: 1440, h: 900 }, winTitle: "Agent tab" };

test("every fast-lane request names the agent's window and carries a deadline before the caller gives up", () => {
  const r = requestLine(1, "press", target, undefined, 1_000_000);
  expect(r).toMatchObject({ id: 1, op: "press", pid: 42, x: 10, y: 20, w: 30, h: 40, role: "AXButton", label: "Reload", windowId: 777, winTitle: "Agent tab", wx: 0, wy: 0, ww: 1440, wh: 900 });
  expect(r.deadline).toBe(1_000_000 + ACT_DEADLINE_MS);
  // the helper's last moment to act (+ its 0.5 s AX timeout) comes before the caller stops waiting
  expect(ACT_DEADLINE_MS + 500).toBeLessThan(ANSWER_TIMEOUT_MS);
});

test("labels that can't identify one element are refused (Cua acts by token instead)", () => {
  for (const bad of ["", "   ", undefined, "ICMNoteListCell", "NSTableRowView", "_NS:123", "_SC_x"]) expect(unusableLabel(bad)).toBe(true);
  for (const good of ["7", "Reload", "New Note", "Multiply", "Cell 3", "OK"]) expect(unusableLabel(good)).toBe(false);
});

test("an uncertain fast-lane answer is reported, never handed to Cua to do again", () => {
  expect(fastToAction({ ok: true, ms: 3.2, how: "hit-test" }, "c")).toMatchObject({ ok: true, route: "fast_lane", channel: "ax", ms: 3 });
  // nothing was done (element not found, deadline passed): undefined = use Cua
  expect(fastToAction({ ok: false, ms: 1, error: "element not found" }, "c")).toBeUndefined();
  expect(fastToAction({ ok: false, ms: 1, error: "deadline passed: skipped" }, "c")).toBeUndefined();
  const timedOut = fastToAction({ ok: false, uncertain: true, ms: 2500, error: "no answer in 2.5 s: it may still have happened" }, "c")!;
  expect(timedOut).toMatchObject({ ok: false, effect: "uncertain", error: { code: "timeout" } });
  const cannot = fastToAction({ ok: false, uncertain: true, ms: 5, error: "AXPress could not complete (-25205): it may have happened" }, "c")!;
  expect(cannot).toMatchObject({ ok: false, effect: "uncertain", error: { code: "other" } });
  expect(cannot.error!.detail).toContain("uncertain");
});

const raw = (over: Partial<RawCall>): RawCall => ({ json: undefined, raw: "", exit: 1, ms: 100, cli: "x", ...over });

test("a Cua call is a timeout by ITS OWN time limit, not a fixed 15 s", () => {
  expect(classifyError(raw({ ms: 4005, timeoutMs: 4000, timedOut: true }))?.code).toBe("timeout"); // list_windows: 4 s
  expect(classifyError(raw({ ms: 3990, timeoutMs: 4000 }))?.code).toBe("timeout");
  expect(classifyError(raw({ ms: 1200, timeoutMs: 4000, timedOut: false }))?.code).toBe("other");
  expect(classifyError(raw({ ms: 20000, timeoutMs: 30000, timedOut: false }))?.code).toBe("other"); // type_text: 30 s
  expect(classifyError(raw({ ms: 30010, timeoutMs: 30000, timedOut: true }))?.code).toBe("timeout");
  expect(classifyError(raw({ ms: 14950 }))?.code).toBe("timeout"); // an old RawCall without the fields: 15 s default
  expect(classifyError(raw({ raw: "session has ended" }))?.code).toBe("session_ended");
});

test("a hung subprocess that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const t0 = performance.now();
  const r = await runLimited(["sh", "-c", "trap '' TERM; exec sleep 30"], 200, 300);
  const ms = performance.now() - t0;
  expect(r.timedOut).toBe(true);
  expect(ms).toBeLessThan(5000);
  expect(ms).toBeGreaterThanOrEqual(450);
});

test("a normal subprocess's output is read in full", async () => {
  const r = await runLimited(["sh", "-c", "printf '{\"ok\":true}'"], 5000);
  expect(r).toMatchObject({ out: '{"ok":true}', exit: 0, timedOut: false });
});
