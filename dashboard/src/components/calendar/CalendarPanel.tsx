import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  addCalendarEvent,
  deleteCalendarEvent,
  fetchCalendar,
  updateCalendarEvent,
  type CalendarData,
  type CalendarEvent,
} from "@/lib/api";
import {
  diffAgainst,
  emptyForm,
  EventFormDialog,
  formFromEvent,
  toInput,
  type EventFormValue,
} from "./EventFormDialog";
import {
  addMonths,
  byImportance,
  byTime,
  courseHue,
  coversDay,
  daysBetween,
  formatDayLong,
  formatDayShort,
  formatMonth,
  formatTimeRange,
  indexByDay,
  monthGrid,
  monthKey,
  parseIso,
  toIso,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

// What the three toggles switch. Exams and deadlines share one toggle: the
// question the view answers is "what's due", not which of the two it is.
type Group = "class" | "tutorial" | "due";

const GROUPS: { value: Group; label: string }[] = [
  { value: "class", label: "Classes" },
  { value: "tutorial", label: "Tutorials" },
  { value: "due", label: "Deadlines & exams" },
];

function groupOf(event: CalendarEvent): Group {
  return event.kind === "exam" || event.kind === "deadline" ? "due" : event.kind;
}

// The vault note every add/edit/delete is stored in (calendar_store.ADDED_TITLE).
const ADDED_SOURCE = "Calendar — Added Events";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS_PER_DAY = 3;

function courseColor(code: string, codes: string[]): string {
  return `oklch(0.72 0.14 ${courseHue(code, codes)})`;
}

function relativeDay(from: string, to: string): string {
  const n = daysBetween(from, to);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

// One line of a month cell. The colour is the course's; the shape carries the
// kind (a bar for a session, a diamond for a deadline, a ringed dot for an
// exam) so nothing depends on colour alone, and the course code is always
// printed. A session whose slot is not in the vault is dashed.
function EventChip({ event, color }: { event: CalendarEvent; color: string }) {
  const marker = event.kind === "deadline" ? "◆ " : event.kind === "exam" ? "● " : "";
  const time = event.kind === "class" || event.kind === "tutorial" ? event.start_time : null;
  return (
    <span
      data-testid="calendar-chip"
      data-kind={event.kind}
      title={`${event.course} · ${event.title}`}
      className={cn(
        "block truncate rounded-sm border-l-2 px-1 py-px text-left text-[0.65rem] leading-4",
        event.kind === "exam" && "ring-1 ring-alarm/70",
        event.tbc && "border-dashed",
      )}
      style={{
        borderLeftColor: color,
        backgroundColor: `color-mix(in oklab, ${color} ${event.kind === "class" ? 12 : 22}%, transparent)`,
      }}
    >
      {marker}
      {time && <span className="font-mono text-muted-foreground">{time} </span>}
      <span className="font-medium">{event.course}</span>
      {event.kind !== "class" && <span className="text-muted-foreground"> {event.title}</span>}
    </span>
  );
}

function AgendaItem({
  event,
  color,
  day,
  onEdit,
  onDelete,
}: {
  event: CalendarEvent;
  color: string;
  day: string;
  onEdit: (event: CalendarEvent) => void;
  onDelete: (event: CalendarEvent) => void;
}) {
  const time = formatTimeRange(event);
  const ongoing = event.end_date != null && event.date !== day;
  return (
    <li
      data-testid="agenda-item"
      data-kind={event.kind}
      className={cn(
        "flex gap-3 rounded-md border-l-2 bg-card/50 py-2 pr-2 pl-3",
        event.kind === "exam" && "ring-1 ring-alarm/60",
        event.tbc && "border-dashed",
      )}
      style={{ borderLeftColor: color }}
    >
      <div className="w-[5.5rem] shrink-0 font-mono text-[0.7rem] leading-5 text-muted-foreground">
        {time ?? (event.tbc ? "time TBC" : "all day")}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">
            {event.kind === "deadline" ? "◆ " : event.kind === "exam" ? "● " : ""}
            {event.title}
          </span>
          <Chip>{event.course}</Chip>
          <Chip>{event.kind === "deadline" ? "due" : event.kind}</Chip>
          {event.weight && <Chip>{event.weight}</Chip>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {[
            event.location,
            ongoing
              ? `window ${formatDayShort(event.date)} – ${formatDayShort(event.end_date!)}`
              : null,
            event.note,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {event.detail && <p className="mt-1 text-xs text-muted-foreground/80">{event.detail}</p>}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${event.title}`}
          onClick={() => onEdit(event)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${event.title}`}
          onClick={() => onDelete(event)}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

// Calendar view, built at the user's own direct request ("make a calendar
// space in oni, fill it with all my classes/ttrs and deadlines"). Everything
// shown is parsed by the backend from the vault's timetable / deadlines /
// tutorials notes on each fetch (assistant/calendar_store.py) — this panel
// holds no schedule data of its own, so a date corrected in the vault is
// corrected here the next time the tab is opened or refreshed. Entries can be
// added, edited and deleted here (or by asking Oni): every change goes to one
// vault note, "Calendar — Added Events", and the timetable / deadlines notes
// are never rewritten — an edit or delete of an event that comes from one of
// them is stored there as an override.
export function CalendarPanel() {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = toIso(new Date());
  const [month, setMonth] = useState(monthKey(today));
  const [selected, setSelected] = useState(today);
  const [shown, setShown] = useState<Record<Group, boolean>>({
    class: true,
    tutorial: true,
    due: true,
  });
  const [hiddenCourses, setHiddenCourses] = useState<Set<string>>(new Set());
  // null = closed; otherwise the event being edited, or "new".
  const [editing, setEditing] = useState<CalendarEvent | "new" | null>(null);
  const [deleting, setDeleting] = useState<CalendarEvent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCalendar()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const codes = useMemo(() => (data?.courses ?? []).map((c) => c.code), [data]);
  const visible = useMemo(
    () => (data?.events ?? []).filter((e) => shown[groupOf(e)] && !hiddenCourses.has(e.course)),
    [data, shown, hiddenCourses],
  );
  const byDay = useMemo(() => indexByDay(visible), [visible]);
  const grid = useMemo(() => monthGrid(month), [month]);
  const dayEvents = useMemo(
    () => visible.filter((e) => coversDay(e, selected)).sort(byTime),
    [visible, selected],
  );
  const upcoming = useMemo(
    () =>
      visible.filter((e) => groupOf(e) === "due" && (e.end_date ?? e.date) >= today).slice(0, 6),
    [visible, today],
  );

  function goToDay(iso: string) {
    setSelected(iso);
    setMonth(monthKey(iso));
  }

  async function saveEvent(value: EventFormValue) {
    if (editing === null) return;
    if (editing === "new") {
      const created = await addCalendarEvent(toInput(value));
      goToDay(created.date);
    } else {
      const changes = diffAgainst(formFromEvent(editing), value);
      if (Object.keys(changes).length > 0) {
        const updated = await updateCalendarEvent(editing.id, changes);
        goToDay(updated.date);
      }
    }
    load();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await deleteCalendarEvent(deleting.id);
      setDeleting(null);
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleCourse(code: string) {
    setHiddenCourses((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto"
      data-testid="calendar-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 min-w-[11rem] text-lg font-medium" data-testid="calendar-month">
          {formatMonth(month)}
        </h2>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => setMonth((m) => addMonths(m, -1))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next month"
          onClick={() => setMonth((m) => addMonths(m, 1))}
        >
          <ChevronRight />
        </Button>
        <Button variant="outline" size="sm" onClick={() => goToDay(today)}>
          Today
        </Button>
        <Button size="sm" onClick={() => setEditing("new")} data-testid="add-event">
          <Plus /> Add event
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
          {GROUPS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={shown[value]}
              onClick={() => setShown((prev) => ({ ...prev, [value]: !prev[value] }))}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[0.7rem] transition-colors",
                shown[value]
                  ? "border-accent-signal/50 bg-accent-signal/15 text-accent-signal"
                  : "border-graphite/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the calendar: {error}
        </p>
      )}

      {data && codes.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Courses">
          {codes.map((code) => {
            const on = !hiddenCourses.has(code);
            return (
              <button
                key={code}
                type="button"
                aria-pressed={on}
                title={data.courses.find((c) => c.code === code)?.title || code}
                onClick={() => toggleCourse(code)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border border-graphite/40 px-2 py-0.5 font-mono text-[0.65rem] transition-opacity",
                  !on && "opacity-40",
                )}
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: courseColor(code, codes) }}
                />
                {code}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-7 gap-px text-center font-mono text-[0.65rem] text-muted-foreground">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div
            className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-graphite/30 bg-graphite/30"
            data-testid="calendar-grid"
          >
            {grid.map(({ iso, inMonth }) => {
              const events = (byDay.get(iso) ?? []).slice().sort(byImportance);
              const extra = events.length - MAX_CHIPS_PER_DAY;
              const isToday = iso === today;
              const isSelected = iso === selected;
              return (
                <button
                  key={iso}
                  type="button"
                  data-testid={`calendar-day-${iso}`}
                  aria-label={`${formatDayLong(iso)}, ${events.length} ${events.length === 1 ? "item" : "items"}`}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => setSelected(iso)}
                  className={cn(
                    "flex min-h-[5.75rem] flex-col items-stretch gap-0.5 bg-background p-1 text-left align-top transition-colors hover:bg-muted/60",
                    !inMonth && "bg-background/60 opacity-50",
                    isSelected && "ring-2 ring-accent-signal ring-inset",
                  )}
                >
                  <span
                    className={cn(
                      "ml-auto flex size-5 items-center justify-center rounded-full font-mono text-[0.7rem]",
                      isToday ? "bg-accent-signal text-background" : "text-muted-foreground",
                    )}
                  >
                    {parseIso(iso).getDate()}
                  </span>
                  {events.slice(0, MAX_CHIPS_PER_DAY).map((e) => (
                    <EventChip
                      key={`${e.id}@${iso}`}
                      event={e}
                      color={courseColor(e.course, codes)}
                    />
                  ))}
                  {extra > 0 && (
                    <span className="px-1 font-mono text-[0.6rem] text-muted-foreground">
                      +{extra} more
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80" aria-label="Day details">
          <section className="rounded-md border border-graphite/30 bg-card/40 p-3">
            <h3 className="text-sm font-medium" data-testid="agenda-heading">
              {formatDayLong(selected)}
            </h3>
            <p className="mb-2 font-mono text-[0.65rem] text-muted-foreground">
              {relativeDay(today, selected)}
            </p>
            {loading && !data ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : dayEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {dayEvents.map((e) => (
                  <AgendaItem
                    key={`${e.id}@${selected}`}
                    event={e}
                    color={courseColor(e.course, codes)}
                    day={selected}
                    onEdit={setEditing}
                    onDelete={(ev) => {
                      setDeleteError(null);
                      setDeleting(ev);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          {upcoming.length > 0 && (
            <section className="rounded-md border border-graphite/30 bg-card/40 p-3">
              <h3 className="mb-2 text-sm font-medium">Coming up</h3>
              <ul className="flex flex-col gap-1">
                {upcoming.map((e) => {
                  const start = e.date < today ? today : e.date;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => goToDay(start)}
                        data-testid="upcoming-item"
                        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted/60"
                      >
                        <span className="w-[5.2rem] shrink-0 font-mono text-[0.65rem] text-muted-foreground">
                          {formatDayShort(start)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{e.course}</span> {e.title}
                        </span>
                        <span className="shrink-0 font-mono text-[0.6rem] text-muted-foreground">
                          {relativeDay(today, start)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {data && data.undated.length > 0 && (
            <section className="rounded-md border border-graphite/30 bg-card/40 p-3">
              <h3 className="mb-1 text-sm font-medium">No date yet</h3>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {data.undated.map((u) => (
                  <li key={u.text}>{u.text}</li>
                ))}
              </ul>
            </section>
          )}

          {data && data.warnings.length > 0 && (
            <details className="rounded-md border border-alarm/40 bg-card/40 p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                {data.warnings.length} problem{data.warnings.length === 1 ? "" : "s"} in the vault
                notes
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {data && (
            <p className="px-1 font-mono text-[0.6rem] text-muted-foreground/70">
              Read from {data.sources.join(" · ") || "no notes found"}. Changes made here are saved
              in “Calendar — Added Events”; the other notes are left as they are.
            </p>
          )}
        </aside>
      </div>

      <EventFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? "Add event" : "Edit event"}
        note={
          editing !== null && editing !== "new" && editing.source !== ADDED_SOURCE
            ? `From “${editing.source}”. That note is left alone; your change is saved in “${ADDED_SOURCE}”.`
            : undefined
        }
        initial={
          editing === null || editing === "new" ? emptyForm(selected) : formFromEvent(editing)
        }
        courseCodes={codes}
        onSubmit={saveEvent}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this event?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `“${deleting.title}” on ${formatDayShort(deleting.date)} will be removed from the calendar.` +
                (deleting.source !== ADDED_SOURCE
                  ? ` It comes from “${deleting.source}”, which is left as it is; the event is hidden instead.`
                  : "")
              : ""}
          </AlertDialogDescription>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
