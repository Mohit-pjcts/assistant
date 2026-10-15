import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CalendarPanel } from "./CalendarPanel";
import * as api from "@/lib/api";
import type { CalendarData, CalendarEvent } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchCalendar: vi.fn() };
});

const mockedFetchCalendar = vi.mocked(api.fetchCalendar);

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
    source: "Semester 3 — Class Timetable",
    ...overrides,
  };
}

const lecture = event({
  id: "lec",
  title: "Introduction to data structures and algorithms",
  start_time: "13:00",
  end_time: "14:50",
  location: "CYPP2",
});
const quiz = event({
  id: "quiz",
  title: "In-class quiz",
  kind: "exam",
  start_time: "13:00",
  end_time: "14:50",
  weight: "20%",
});
const wa2 = event({
  id: "wa2",
  date: "2026-10-21",
  title: "WA2 — Data Structures and Hashing",
  kind: "deadline",
  start_time: "19:00",
  weight: "part of 10% (3 WAs)",
});
const mathLecture = event({
  id: "math",
  course: "MATH2014",
  date: "2026-10-28",
  title: "Multivariable calculus and linear algebra",
  start_time: "11:00",
  end_time: "12:50",
});
const mathTutorial = event({
  id: "mt",
  course: "MATH2014",
  kind: "tutorial",
  date: "2026-10-28",
  title: "Tutorial 6",
  tbc: true,
});
const portfolio = event({
  id: "port",
  course: "AILT9009",
  kind: "deadline",
  date: "2026-11-02",
  end_date: "2026-11-06",
  title: "Individual AI Portfolio",
  note: "probably Fri 6 Nov; time not stated",
});

const sample: CalendarData = {
  events: [wa2, lecture, quiz, mathLecture, mathTutorial, portfolio],
  undated: [
    { text: "COMP2119 final exam (60%): date not stated.", source: "Semester 3 — Deadlines" },
  ],
  courses: [
    { code: "AILT9009", title: "AI Literary 2: Humanities" },
    { code: "COMP2119", title: "Introduction to data structures and algorithms" },
    { code: "MATH2014", title: "Multivariable calculus and linear algebra" },
  ],
  sources: ["Semester 3 — Class Timetable", "Semester 3 — Deadlines"],
  warnings: [],
};

beforeEach(() => {
  // Only Date is faked: timers stay real so findBy*/waitFor keep polling.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 16, 12, 0)); // Fri 16 Oct 2026, local time
  mockedFetchCalendar.mockReset();
  mockedFetchCalendar.mockResolvedValue(sample);
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderPanel() {
  const user = userEvent.setup();
  render(<CalendarPanel />);
  await screen.findByTestId("calendar-grid");
  await waitFor(() => expect(mockedFetchCalendar).toHaveBeenCalled());
  await screen.findByText(/Read from/);
  return user;
}

describe("CalendarPanel", () => {
  it("opens on today's month with today marked and selected", async () => {
    await renderPanel();
    expect(screen.getByTestId("calendar-month")).toHaveTextContent("October 2026");
    expect(screen.getByTestId("calendar-day-2026-10-16")).toHaveAttribute("aria-current", "date");
    expect(screen.getByTestId("agenda-heading")).toHaveTextContent("Friday 16 October 2026");
    expect(screen.getByTestId("agenda-heading").nextElementSibling).toHaveTextContent("today");
  });

  it("shows the COMP2119 quiz on Tue 27 Oct, ahead of the lecture in the same slot", async () => {
    await renderPanel();
    const cell = screen.getByTestId("calendar-day-2026-10-27");
    const chips = within(cell).getAllByTestId("calendar-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-kind", "exam");
    expect(chips[0]).toHaveTextContent("COMP2119 In-class quiz");
    expect(chips[1]).toHaveAttribute("data-kind", "class");
    expect(cell).toHaveAccessibleName("Tuesday 27 October 2026, 2 items");
  });

  it("lists the full day, with times, rooms and weight, when a day is selected", async () => {
    const user = await renderPanel();
    await user.click(screen.getByTestId("calendar-day-2026-10-27"));
    expect(screen.getByTestId("agenda-heading")).toHaveTextContent("Tuesday 27 October 2026");
    expect(screen.getByTestId("agenda-heading").nextElementSibling).toHaveTextContent("in 11 days");
    const items = screen.getAllByTestId("agenda-item");
    expect(items).toHaveLength(2);
    // Same start time: the exam sorts above the class.
    expect(items[0]).toHaveTextContent("In-class quiz");
    expect(items[0]).toHaveTextContent("13:00–14:50");
    expect(items[0]).toHaveTextContent("20%");
    expect(items[1]).toHaveTextContent("CYPP2");
  });

  it("marks a session with no known slot as time TBC", async () => {
    const user = await renderPanel();
    await user.click(screen.getByTestId("calendar-day-2026-10-28"));
    const tutorial = screen
      .getAllByTestId("agenda-item")
      .find((i) => i.dataset.kind === "tutorial");
    expect(tutorial).toHaveTextContent("Tutorial 6");
    expect(tutorial).toHaveTextContent("time TBC");
  });

  it("lists the next deadlines and exams, and jumps to one when clicked", async () => {
    const user = await renderPanel();
    const upcoming = screen.getAllByTestId("upcoming-item");
    expect(upcoming.map((u) => u.textContent)).toEqual([
      expect.stringContaining("WA2"),
      expect.stringContaining("In-class quiz"),
      expect.stringContaining("Individual AI Portfolio"),
    ]);
    expect(upcoming[1]).toHaveTextContent("in 11 days");
    await user.click(upcoming[1]);
    expect(screen.getByTestId("agenda-heading")).toHaveTextContent("Tuesday 27 October 2026");
  });

  it("pages months and returns to today", async () => {
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByTestId("calendar-month")).toHaveTextContent("November 2026");
    // A multi-day window shows on its first and last day, and in the panel on every day between.
    const first = within(screen.getByTestId("calendar-day-2026-11-02")).getAllByTestId(
      "calendar-chip",
    );
    expect(first[0]).toHaveTextContent("AILT9009");
    expect(
      within(screen.getByTestId("calendar-day-2026-11-04")).queryAllByTestId("calendar-chip"),
    ).toHaveLength(0);
    await user.click(screen.getByTestId("calendar-day-2026-11-04"));
    expect(screen.getByTestId("agenda-item")).toHaveTextContent("window Mon 2 Nov – Fri 6 Nov");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("calendar-month")).toHaveTextContent("October 2026");
    expect(screen.getByTestId("agenda-heading")).toHaveTextContent("Friday 16 October 2026");
  });

  it("filters by kind and by course", async () => {
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Deadlines & exams" }));
    const cell = screen.getByTestId("calendar-day-2026-10-27");
    expect(within(cell).getAllByTestId("calendar-chip")).toHaveLength(1);
    expect(within(cell).getByTestId("calendar-chip")).toHaveAttribute("data-kind", "class");
    expect(screen.queryAllByTestId("upcoming-item")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Deadlines & exams" }));
    await user.click(screen.getByRole("button", { name: "COMP2119" }));
    expect(within(cell).queryAllByTestId("calendar-chip")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "COMP2119" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the dates the notes do not give, and where the data came from", async () => {
    await renderPanel();
    expect(screen.getByText("No date yet")).toBeInTheDocument();
    expect(screen.getByText("COMP2119 final exam (60%): date not stated.")).toBeInTheDocument();
    expect(
      screen.getByText(/Read from Semester 3 — Class Timetable · Semester 3 — Deadlines/),
    ).toBeInTheDocument();
  });

  it("surfaces problems found in the vault notes instead of hiding them", async () => {
    mockedFetchCalendar.mockResolvedValue({
      ...sample,
      warnings: ["Semester 3 — Deadlines: 'Mon 27 Oct 2026' is a Tue, not a Mon"],
    });
    await renderPanel();
    expect(screen.getByText("1 problem in the vault notes")).toBeInTheDocument();
    expect(screen.getByText(/is a Tue, not a Mon/)).toBeInTheDocument();
  });

  it("reports a failed load and refreshes on request", async () => {
    mockedFetchCalendar.mockRejectedValueOnce(new Error("/calendar failed (403): forbidden"));
    const user = userEvent.setup();
    render(<CalendarPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByText("No date yet")).toBeInTheDocument();
    expect(mockedFetchCalendar).toHaveBeenCalledTimes(2);
  });

  it("says so when a day has nothing on it", async () => {
    await renderPanel();
    expect(screen.getByText("Nothing scheduled.")).toBeInTheDocument();
  });
});
