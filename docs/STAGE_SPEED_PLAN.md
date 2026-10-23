# Stage speed: investigation and plan

Written 2026-10-23. Goal: make Stage (`stage/`, `assistant/stage.py`) faster with no change to
intelligence and no change to LLM cost. Nothing here called Anthropic, TypeSafe or Oni. Every
number is either **measured** (a real call on this Mac, or the real run logs) or **projected**
(arithmetic on measured parts) and is labelled that way.

Sources: 84 completed tasks in `stage/runs/run-*/steps.jsonl` (975 s of wall time, Oct 4-22) and
direct `cua-driver call` benchmarks against Calculator (scripts were throwaway, not committed).

## Where the time goes (measured, 84 completed tasks)

| Part of a task | Share of wall time |
|---|---|
| act (clicks, typing, scrolling, key presses) | 45% |
| helper LLM calls (verify 104 calls, avg 1.6 s; plan 106 calls; write 23) | 21.5% |
| observe (accessibility snapshot) | 11% |
| decide (LLM planning step) | 10% |
| other (fixed sleeps, app start-up, gaps) | 13% |

Median completed task: 9.3 s. Inside `act`, the biggest items are Cua typing (126 s over 40 steps)
and Cua accessibility clicks (190 s over 166 clicks in all tasks, 75 s of it in completed ones).

## Findings

**F1. Cua accessibility clicks cost 1.2-1.6 s each; Stage's own fast lane costs 10-20 ms.**
- Real logs: 166 Cua AX clicks, median 1243 ms (WhatsApp 1283, Brave 1230). The fast lane's 221
  presses: median 5 ms.
- Direct, on Calculator: Cua AX click 1.57 s median; the fast-lane helper (`native/build/fastlane`)
  11-19 ms for the same buttons. About 100x.
- The delay is inside the action, not a read-back after it: polling a second snapshot while a
  click was in flight showed the effect appear only after ~1.3 s. Overlapping the observe with the
  click therefore cannot help.

**F2. The fast lane was off for whole runs, silently.** 53 of 92 runs that clicked anything used
Cua only, including plain Calculator buttons ("All Clear", "4", "7" on Oct 16 and Oct 20), which
the lane handles. By day, the lane did no presses from Oct 16 to the morning of Oct 22, then came
back. It is on right now (`/api/state`: `fastLane.on: true`; the helper reports `trusted: true`).
- Likely cause (**not proven**, the old process logs were overwritten): the helper needs the
  Accessibility permission of the app that launched Stage. Oni.app launches Stage
  (`dashboard/src-tauri/src/lib.rs` `spawn_stage`), and a rebuilt ad-hoc-signed Oni.app is a new
  identity to macOS (the same effect CLAUDE.md records for the Documents prompt).
- Nothing records that the lane was off: the reason is only printed to `stage.log`, which Tauri
  truncates on each launch, and `steps.jsonl` has no field for it.
- Projected: in completed tasks, 74 Cua AX clicks = 75 s; at ~0.2 s each (the fast lane plus the
  150 ms cursor glide) that is 15 s, so about 60 s of 975 s (6%). Larger when the whole mix is
  clicks (Calculator-style tasks: most of the time).

**F3. Typing is the largest single act cost.** Cua `type_text`: foreground median 2.5 s (22 calls),
synthetic 2.1 s (15), and 20 background AX attempts that failed after a median 1.07 s before the
fallback. Measured on Calculator digits: `delay_ms` 30 (default) -> 0 saves about 250 ms per 10
characters (a 10-character string: ~900 ms -> ~650 ms); the fixed part is ~640 ms.
- **Not measured: whether dropping characters becomes more likely at low delay** in Chromium and
  Catalyst fields. That is the risk, and it needs a real page test before any change.

**F4. One daemon knob exists and Stage already sets it.** The only timing variables in the driver
binary are `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS` and `..._POLL_MS` (`strings` on the binary).
`scripts/daemon.sh` sets the timeout to 300. On a second, throwaway daemon (killed afterwards,
Stage's daemon untouched): timeout 0 and poll 10 ms -> click median 1575 -> 1235 ms (**-340 ms per
Cua action**, measured). The cost is on the unproven side: with 0, an action that opens a dialog or
popup may return before the window exists. Only matters on the Cua path, so it is worth less once
F1/F2 are fixed.

**F5. Cua reads are cheap.** `list_windows` 31 ms; tree-only `get_window_state` ~260 ms (it walks
the menu bar too: 128 of 154 Calculator elements are menu items, which costs tokens, not time);
screenshot-only 90 ms; `max_elements=40` cuts the walk to ~100 ms. `list_apps` is 0.9 s and
`hotkey`/`press_key` take ~1.9 s in the daemon's background mode when nothing visibly changes
(measured on Calculator; real `press_key` logs are 0.6-0.9 s).

**F6. Fixed sleeps are small on the hot path.** The ones that run in nearly every task are 150 ms
(after the focus click before typing) and 400 ms (after a hotkey chord); in the 84 completed tasks
only 1 ended on a send-like step (the 3 s wait) and 11 opened a page (1.2 s). Total fixed-sleep
time is well under the 13% "other" bucket, which is mostly app start-up (one logged run spent 25.7 s
before its first plan step, cause never found, STEPS 159.4).

## What to do, in order

1. **Make a silent fast-lane failure loud (no risk, small).** Put `fastLane: {on, reason}` into the
   `run_start` log record and the `/api/state` snapshot, and have `assistant/stage.py` tell Oni
   when a run starts with the lane off (so it shows in the dashboard and the next debugging
   session). Add a fast-lane-vs-Cua count to the `task_end` record. Without this, F2 recurs
   unseen. *Measured need, zero effect on cost or intelligence.*
2. **Find why it went off and fix it at the source.** Candidate: grant Accessibility to the Oni.app
   that launches Stage, and avoid the rebuild-changes-identity trap (sign Oni.app with the
   stable identity, or let `start.sh` re-check). Step 1's `reason` field tells us which case it is
   the next time it happens. *Needs you at the Mac for the permission prompt.*
3. **Fast-lane fall-through audit.** Where the lane declines (label changed, e.g. Calculator's
   "All Clear" -> "Clear"; element not found), Stage pays 1.2-1.6 s. Count declines per run from
   the console line and consider matching by role + position when the label is the only mismatch.
   *Projected from the one decline seen in my probe; needs the lane on in real runs to measure.*
4. **Skip the failing background AX type attempt for known apps.** The driver already knows which
   apps ignore AX text (`IGNORES_BACKGROUND_KEYS`, WhatsApp). Remember per app which rung worked
   within a run, so the second type into the same app does not retry the one that failed.
   *Projected: ~1 s x 20 attempts ≈ 20 s of 975 (2%).*
5. **`delay_ms` for synthesized typing, only after a fidelity test.** Test 5 / 10 ms against a
   local page with a long string in Brave and in WhatsApp's compose box (drops would show as
   missing characters, which the existing landing check should also catch). Projected saving
   ~25 ms per character.
6. **Daemon timeout 300 -> 100 (not 0).** Measure first whether dialog-opening clicks still see
   their new window. Skip entirely if step 2 keeps clicks on the fast lane.

## What not to do

- **Do not change the verify helper or its model to save time.** Verify is 21.5% of wall time, but
  it is the guard against a false "done" (STEPS 159.4 had one); a faster verify is an
  intelligence trade, so it stays.
- **Do not overlap observe with an in-flight click** (F1: the effect lands after ~1.3 s, so the
  extra snapshot would read the old screen).
- **Do not upgrade Cua Driver for speed.** 0.32.0 -> 0.38.0 is available. The release notes name
  "faster batched steps and window reads" (0.37) but also add focus checks and read-backs; there is
  no stated click-latency fix, and Stage is pinned on purpose. Not tested.
- **Do not drop the cursor glide** (~0.15-0.2 s per fast action): it is your explicit visual choice
  (STEPS 159.3).

## Not verified

- Anything on real apps beyond Calculator: the F1 click timings in WhatsApp/Brave come from the logs,
  not from my probes (I did not drive your Brave or WhatsApp).
- The cause of the lane being off (F2).
- Typing fidelity at lower `delay_ms` (F3) and dialog detection at lower window-change timeout (F4).
- No Stage code was changed by this investigation; nothing is built yet.
