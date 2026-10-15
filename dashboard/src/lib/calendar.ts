import type { CalendarEvent } from "@/lib/api";

// Pure date/grid logic behind the Calendar view (CalendarPanel.tsx). Dates
// travel as ISO "YYYY-MM-DD" strings end to end and are only turned into a
// `Date` here, built from their parts in LOCAL time. `new Date("2026-10-27")`
// parses as UTC midnight, which is the previous evening in any timezone west
// of UTC and would put a deadline on the wrong day.

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const date = parseIso(iso);
  date.setDate(date.getDate() + days);
  return toIso(date);
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Shift a "YYYY-MM" key by whole months. */
export function addMonths(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return monthKey(toIso(date));
}

export interface GridDay {
  iso: string;
  inMonth: boolean;
}

/**
 * Whole weeks covering a month, Monday first (HKU's timetable week). Always
 * 6 rows so the grid does not jump in height as you page between months.
 */
export function monthGrid(key: string): GridDay[] {
  const [y, m] = key.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const days: GridDay[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(y, m - 1, 1 - offset + i);
    days.push({ iso: toIso(date), inMonth: date.getMonth() === m - 1 });
  }
  return days;
}

/** An event covers `iso` if it starts there or a multi-day window spans it. */
export function coversDay(event: CalendarEvent, iso: string): boolean {
  return event.date <= iso && iso <= (event.end_date ?? event.date);
}

const KIND_ORDER: Record<CalendarEvent["kind"], number> = {
  exam: 0,
  deadline: 1,
  tutorial: 2,
  class: 3,
};

/** Chronological, all-day (no time) entries first. */
export function byTime(a: CalendarEvent, b: CalendarEvent): number {
  return (
    (a.start_time ?? "").localeCompare(b.start_time ?? "") ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.course.localeCompare(b.course)
  );
}

/** What a month cell shows first: the things that cost marks before the lectures. */
export function byImportance(a: CalendarEvent, b: CalendarEvent): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byTime(a, b);
}

/**
 * Events grouped by the days a month cell should list them on. A multi-day
 * window is listed on its first and last day only; the day panel (which uses
 * `coversDay`) lists it on every day it spans.
 */
export function indexByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  const add = (iso: string, event: CalendarEvent) => {
    const list = map.get(iso);
    if (list) list.push(event);
    else map.set(iso, [event]);
  };
  for (const event of events) {
    add(event.date, event);
    if (event.end_date && event.end_date !== event.date) add(event.end_date, event);
  }
  return map;
}

/** A stable, well-spread hue per course (golden-angle steps in the sorted list). */
export function courseHue(code: string, codes: string[]): number {
  const index = Math.max(0, codes.indexOf(code));
  return Math.round((index * 137.508 + 25) % 360);
}

export function formatTimeRange(event: CalendarEvent): string | null {
  if (!event.start_time) return null;
  return event.end_time ? `${event.start_time}–${event.end_time}` : event.start_time;
}

// Fixed English names rather than `toLocaleDateString`: the output of that
// depends on the ICU build of whatever WebView hosts the app ("Tuesday, 27
// October" vs "Tuesday 27 October"), and this view's labels should not.
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatDayLong(iso: string): string {
  const d = parseIso(iso);
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDayShort(iso: string): string {
  const d = parseIso(iso);
  return `${WEEKDAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}

export function formatMonth(key: string): string {
  const d = parseIso(`${key}-01`);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** Whole days from `fromIso` to `toIso` (negative if in the past). */
export function daysBetween(fromIso: string, endIso: string): number {
  const ms = parseIso(endIso).getTime() - parseIso(fromIso).getTime();
  return Math.round(ms / 86_400_000);
}
