import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CalendarEvent, CalendarEventInput, CalendarEventKind } from "@/lib/api";

// The Add / Edit event form. Plain strings all the way (an empty optional
// field means "none"); `toInput` turns it into what the backend validates, and
// `diffAgainst` keeps an edit down to the fields that really changed, so
// saving an untouched form can never alter anything.

export interface EventFormValue {
  title: string;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  kind: CalendarEventKind;
  course: string;
  location: string;
  weight: string;
}

const KIND_OPTIONS: { value: CalendarEventKind; label: string }[] = [
  { value: "exam", label: "Exam" },
  { value: "deadline", label: "Deadline" },
  { value: "class", label: "Class" },
  { value: "tutorial", label: "Tutorial" },
  { value: "study", label: "Study" },
];

export function emptyForm(date: string): EventFormValue {
  return {
    title: "",
    date,
    endDate: "",
    startTime: "",
    endTime: "",
    kind: "exam",
    course: "",
    location: "",
    weight: "",
  };
}

export function formFromEvent(event: CalendarEvent): EventFormValue {
  return {
    // `detail` is the full text when the view shows a shortened title.
    title: event.detail ?? event.title,
    date: event.date,
    endDate: event.end_date ?? "",
    startTime: event.start_time ?? "",
    endTime: event.end_time ?? "",
    kind: event.kind,
    course: event.course === "—" ? "" : event.course,
    location: event.location ?? "",
    weight: event.weight ?? "",
  };
}

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

export function toInput(v: EventFormValue): CalendarEventInput {
  return {
    title: v.title.trim(),
    date: v.date,
    kind: v.kind,
    course: v.course.trim().toUpperCase(),
    start_time: orNull(v.startTime),
    end_time: orNull(v.endTime),
    end_date: orNull(v.endDate),
    location: orNull(v.location),
    weight: orNull(v.weight),
  };
}

/** The fields of `next` that differ from `original` (what a PATCH should carry). */
export function diffAgainst(
  original: EventFormValue,
  next: EventFormValue,
): Partial<CalendarEventInput> {
  const a = toInput(original);
  const b = toInput(next);
  const changes: Partial<CalendarEventInput> = {};
  for (const key of Object.keys(b) as (keyof CalendarEventInput)[]) {
    if (a[key] !== b[key]) (changes as Record<string, unknown>)[key] = b[key];
  }
  return changes;
}

function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function EventFormDialog({
  open,
  onOpenChange,
  title,
  initial,
  courseCodes,
  onSubmit,
  note,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: EventFormValue;
  courseCodes: string[];
  /** Resolve on success; a rejection's message is shown in the form. */
  onSubmit: (value: EventFormValue) => Promise<void>;
  /** A line under the title, e.g. where the event came from. */
  note?: string;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), date: useId(), end: useId(), start: useId(), stop: useId() };
  const ids2 = { kind: useId(), course: useId(), where: useId(), weight: useId(), codes: useId() };

  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
    // Only re-seed when the dialog opens, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof EventFormValue>(key: K, v: EventFormValue[K]) =>
    setValue((s) => ({ ...s, [key]: v }));

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(value);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogTitle className="mb-1">{title}</DialogTitle>
        {note && <p className="mb-3 text-xs text-muted-foreground">{note}</p>}
        <form
          className="mt-2 grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.title.trim() && value.date && !saving) void submit();
          }}
        >
          <Field label="Title" htmlFor={ids.title} className="col-span-2">
            <Input
              id={ids.title}
              autoFocus
              required
              value={value.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </Field>
          <Field label="Date" htmlFor={ids.date}>
            <Input
              id={ids.date}
              type="date"
              required
              value={value.date}
              onChange={(e) => set("date", e.target.value)}
            />
          </Field>
          <Field label="Until (multi-day)" htmlFor={ids.end}>
            <Input
              id={ids.end}
              type="date"
              value={value.endDate}
              onChange={(e) => set("endDate", e.target.value)}
            />
          </Field>
          <Field label="Starts (HKT)" htmlFor={ids.start}>
            <Input
              id={ids.start}
              type="time"
              value={value.startTime}
              onChange={(e) => set("startTime", e.target.value)}
            />
          </Field>
          <Field label="Ends" htmlFor={ids.stop}>
            <Input
              id={ids.stop}
              type="time"
              value={value.endTime}
              onChange={(e) => set("endTime", e.target.value)}
            />
          </Field>
          <Field label="Kind" htmlFor={ids2.kind}>
            <select
              id={ids2.kind}
              value={value.kind}
              onChange={(e) => set("kind", e.target.value as CalendarEventKind)}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Course" htmlFor={ids2.course}>
            <Input
              id={ids2.course}
              list={ids2.codes}
              placeholder="COMP2119"
              value={value.course}
              onChange={(e) => set("course", e.target.value)}
            />
            <datalist id={ids2.codes}>
              {courseCodes.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Room (optional)" htmlFor={ids2.where}>
            <Input
              id={ids2.where}
              value={value.location}
              onChange={(e) => set("location", e.target.value)}
            />
          </Field>
          <Field label="Weight (optional)" htmlFor={ids2.weight}>
            <Input
              id={ids2.weight}
              placeholder="40%"
              value={value.weight}
              onChange={(e) => set("weight", e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="col-span-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="col-span-2 mt-1 flex justify-end gap-2 border-t border-graphite/20 pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !value.title.trim() || !value.date}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
