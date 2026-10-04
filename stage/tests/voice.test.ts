// The ElevenLabs limiter: never more than 2 requests at a time, even when a new caller arrives as a slot is freed.
import { expect, test } from "bun:test";
import { Semaphore } from "../src/voice.ts";

test("a released slot goes to the waiter, not to a caller who arrives at that moment", async () => {
  const s = new Semaphore(2);
  let now = 0, peak = 0;
  const gates: (() => void)[] = [];
  const job = () => s.run(async () => {
    now++; peak = Math.max(peak, now);
    await new Promise<void>((r) => gates.push(r));
    now--;
  });
  const a = job(), b = job(), c = job(); // c waits
  await Bun.sleep(0);
  expect(s.active).toBe(2);
  expect(s.queued).toBe(1);
  gates.shift()!(); // a finishes: its slot is handed to c ...
  await Bun.sleep(0);
  const d = job(); // ... so d, arriving right now, must wait (the old limiter let it in: a 3rd request, then a 429)
  await Bun.sleep(0);
  expect(s.active).toBe(2);
  expect(s.queued).toBe(1);
  expect(peak).toBe(2);
  while (gates.length || s.queued) { gates.shift()?.(); await Bun.sleep(0); }
  await Promise.all([a, b, c, d]);
  expect(peak).toBe(2);
  expect(s.active).toBe(0);
});

test("many callers, random lengths: at most 2 at once and every one runs", async () => {
  const s = new Semaphore(2);
  let now = 0, peak = 0, done = 0;
  await Promise.all(Array.from({ length: 25 }, (_, k) => s.run(async () => {
    now++; peak = Math.max(peak, now);
    await Bun.sleep(k % 3);
    now--; done++;
  })));
  expect(peak).toBe(2);
  expect(done).toBe(25);
  expect(s.active).toBe(0);
});

test("a failing job still frees its slot", async () => {
  const s = new Semaphore(1);
  await expect(s.run(async () => { throw new Error("network"); })).rejects.toThrow("network");
  expect(await s.run(async () => 7)).toBe(7);
  expect(s.active).toBe(0);
});
