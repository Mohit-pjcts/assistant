import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  deleteDiaryEntry,
  fetchDiaryEntries,
  saveDiaryEntry,
  transcribeVoice,
  type DiaryEntry,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA"); // en-CA formats as YYYY-MM-DD
}

function formatDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Daily diary (PLAN.md, built at the user's own direct request: "I want to
// diary everyday and give Oni access to every diary entry so she can know
// more about me"). Two decisions locked before building: entries live as
// plain Notes in the existing Obsidian vault (assistant/diary_store.py),
// not a new store; authored here via a dedicated journal box (type or
// dictate, no back-and-forth with Oni needed) — the same in-app mic
// pipeline ChatPanel's own recorder uses (transcribeVoice), just inserted
// into this textarea instead of sent as a chat turn. Oni already has full
// read/search access to the vault (Phase 27), Diary/ included, with no
// code change needed there; it can never write or delete an entry (see
// diary_store.py's own module docstring) — this panel is the only writer.
export function JournalPanel() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [deletingDate, setDeletingDate] = useState<string | null>(null);
  const [openDialogDate, setOpenDialogDate] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchDiaryEntries()
      .then((next) => {
        setEntries(next);
        const today = next.find((e) => e.date === todayIso());
        if (today) setContent(today.content);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function selectEntry(date: string) {
    setSelectedDate(date);
    setSavedAt(null);
    const existing = entries.find((e) => e.date === date);
    setContent(existing?.content ?? "");
  }

  function startNewToday() {
    selectEntry(todayIso());
  }

  async function handleSave() {
    const trimmed = content.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDiaryEntry(trimmed, selectedDate);
      setEntries((prev) => {
        const rest = prev.filter((e) => e.date !== saved.date);
        return [saved, ...rest].sort((a, b) => (a.date < b.date ? 1 : -1));
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete(date: string) {
    setDeletingDate(date);
    setError(null);
    try {
      await deleteDiaryEntry(date);
      setEntries((prev) => prev.filter((e) => e.date !== date));
      if (selectedDate === date) startNewToday();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingDate(null);
      setOpenDialogDate(null);
    }
  }

  // Same tap-to-start/tap-to-stop mic pipeline as ChatPanel.tsx's own
  // recorder (transcribeVoice → server.py's /voice/transcribe), except the
  // transcript is inserted into this entry's textarea instead of sent as a
  // chat turn — dictating a diary entry shouldn't involve Oni at all.
  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (saving || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
        if (blob.size === 0) return;
        setTranscribing(true);
        transcribeVoice(blob)
          .then((text) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            setContent((prev) => (prev.trim() ? `${prev.trim()}\n\n${trimmed}` : trimmed));
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setTranscribing(false));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Microphone access failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const isToday = selectedDate === todayIso();
  const hasUnsavedChanges =
    content !== (entries.find((e) => e.date === selectedDate)?.content ?? "");

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          A daily diary Oni can read and search, but never edit or delete.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <p
            className="panel-label text-[0.7rem] text-muted-foreground"
            data-testid="journal-editor-date"
          >
            {formatDay(selectedDate)}
            {!isToday && " (past entry)"}
          </p>
          {!isToday && (
            <Button variant="ghost" size="sm" onClick={startNewToday}>
              Back to today
            </Button>
          )}
        </div>
        <Textarea
          placeholder="What happened today?"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={saving}
          rows={8}
          data-testid="journal-entry-input"
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant={recording ? "destructive" : "outline"}
            size="sm"
            onClick={() => void toggleRecording()}
            disabled={saving || transcribing}
            data-testid="journal-mic-button"
          >
            {recording ? (
              <>
                <Square className="size-3.5" /> Stop
              </>
            ) : (
              <>
                <Mic className="size-3.5" /> {transcribing ? "Transcribing…" : "Dictate"}
              </>
            )}
          </Button>
          <div className="flex items-center gap-2">
            {savedAt && !hasUnsavedChanges && (
              <span className="text-xs text-muted-foreground">Saved</span>
            )}
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !content.trim() || !hasUnsavedChanges}
              data-testid="journal-save-button"
            >
              {saving ? "Saving…" : "Save entry"}
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          {entries.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No diary entries yet.</p>
          )}
          {entries.map((entry) => (
            <InstrumentCard
              key={entry.date}
              className={cn(
                "cursor-pointer p-3",
                selectedDate === entry.date && "ring-1 ring-inset ring-accent-signal",
              )}
              onClick={() => selectEntry(entry.date)}
              data-testid="journal-entry-row"
            >
              <div className="flex flex-col gap-2">
                <div>
                  <p className="text-sm font-medium">{formatDay(entry.date)}</p>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {entry.content}
                  </p>
                </div>
                <div className="flex justify-end border-t border-graphite/20 pt-2">
                  <AlertDialog
                    open={openDialogDate === entry.date}
                    onOpenChange={(open) => setOpenDialogDate(open ? entry.date : null)}
                  >
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={deletingDate === entry.date}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        >
                          {deletingDate === entry.date ? "Deleting…" : "Delete"}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Permanently removes your {formatDay(entry.date)} diary entry from the
                          vault.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleConfirmDelete(entry.date)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </InstrumentCard>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
