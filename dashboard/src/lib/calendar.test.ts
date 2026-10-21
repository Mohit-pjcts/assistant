import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/lib/api";
import {
  addDays,
  addMonths,
  byImportance,
  byTime,
  courseHue,
  coversDay,
  daysBetween,
  formatTimeRange,
  indexByDay,
  monthGrid,
  parseIso,
  toIso,
} from "./calendar";

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e",
    date: "2026-10-27",
    end_date: null,
    title: "Thing",
    course: "COMP2119",
    kind: "class",
    start_time: null,
    end_time: null,
    location: null,
    weight: null,
    detail: null,
    note: null,
    tbc: false,
    source: "",
    ...overrides,
  };
}

describe("ISO dates", () => {
  it("round-trips through a local-time Date, never shifting the day", () => {
    // `new Date("2026-10-27")` is UTC midnight: the previous evening west of UTC.
    for (const iso of ["2026-10-27", "2026-01-01", "2026-12-31", "2027-02-28"]) {
      expect(toIso(parseIso(iso))).toBe(iso);
    }
    expect(parseIso("2026-10-27").getDate()).toBe(27);
  });

  it("adds days and months across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("counts whole days between two dates", () => {
    expect(daysBetween("2026-10-16", "2026-10-27")).toBe(11);
    expect(daysBetween("2026-10-27", "2026-10-16")).toBe(-11);
    expect(daysBetween("2026-10-27", "2026-10-27")).toBe(0);
  });
});

describe("monthGrid", () => {
  it("is six Monday-first weeks that contain the whole month", () => {
    const grid = monthGrid("2026-10");
    expect(grid).toHaveLength(42);
    // 1 Oct 2026 is a Thursday, so the grid starts on Monday 28 Sep.
    expect(grid[0]).toEqual({ iso: "2026-09-28", inMonth: false });
    expect(grid[3]).toEqual({ iso: "2026-10-01", inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
    expect(grid.every((d, i) => i === 0 || parseIso(d.iso) > parseIso(grid[i - 1].iso))).toBe(true);
  });

  it("starts on the 1st when the month begins on a Monday", () => {
    // 1 Feb 2027 is a Monday.
    expect(monthGrid("2027-02")[0]).toEqual({ iso: "2027-02-01", inMonth: true });
  });

  it("puts every weekday column under the right date", () => {
    for (const { iso } of monthGrid("2026-10").filter((_, i) => i % 7 === 1)) {
      expect(parseIso(iso).getDay()).toBe(2); // every second column is a Tuesday
    }
  });
});

describe("event helpers", () => {
  it("a window covers every day it spans, a single event only its own", () => {
    const window = event({ date: "2026-11-02", end_date: "2026-11-06" });
    expect(coversDay(window, "2026-11-01")).toBe(false);
    expect(coversDay(window, "2026-11-04")).toBe(true);
    expect(coversDay(window, "2026-11-06")).toBe(true);
    expect(coversDay(window, "2026-11-07")).toBe(false);
    expect(coversDay(event({}), "2026-10-27")).toBe(true);
    expect(coversDay(event({}), "2026-10-28")).toBe(false);
  });

  it("lists a window on its first and last day only in the month index", () => {
    const window = event({ id: "w", date: "2026-11-02", end_date: "2026-11-06" });
    const single = event({ id: "s", date: "2026-11-04" });
    const index = indexByDay([window, single]);
    expect([...index.keys()].sort()).toEqual(["2026-11-02", "2026-11-04", "2026-11-06"]);
    expect(index.get("2026-11-06")).toEqual([window]);
  });

  it("orders a day by time with all-day entries first, and a cell by importance", () => {
    const quiz = event({ id: "q", kind: "exam", start_time: "13:00" });
    const lecture = event({ id: "l", kind: "class", start_time: "13:00" });
    const due = event({ id: "d", kind: "deadline", start_time: null });
    const early = event({ id: "t", kind: "tutorial", start_time: "09:00" });
    expect([lecture, early, due, quiz].sort(byTime).map((e) => e.id)).toEqual(["d", "t", "q", "l"]);
    // In a month cell the quiz must not be hidden behind lectures.
    expect([lecture, early, due, quiz].sort(byImportance).map((e) => e.id)).toEqual([
      "q",
      "d",
      "t",
      "l",
    ]);
  });

  it("formats a time range, a lone start, and none", () => {
    expect(formatTimeRange(event({ start_time: "13:00", end_time: "14:50" }))).toBe("13:00–14:50");
    expect(formatTimeRange(event({ start_time: "19:00" }))).toBe("19:00");
    expect(formatTimeRange(event({}))).toBeNull();
  });

  it("gives each course in a list its own hue", () => {
    const codes = ["AILT9009", "CCHU9053", "COMP2119", "COMP2501", "MATH2014"];
    const hues = codes.map((c) => courseHue(c, codes));
    expect(new Set(hues).size).toBe(codes.length);
    expect(courseHue("COMP2119", codes)).toBe(courseHue("COMP2119", codes));
    // Adjacent courses are far apart on the colour wheel, not neighbours.
    for (let i = 1; i < hues.length; i += 1) {
      const gap = Math.abs(hues[i] - hues[i - 1]);
      expect(Math.min(gap, 360 - gap)).toBeGreaterThan(30);
    }
  });
});
