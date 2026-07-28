import { ShieldAlert, Keyboard, Mic } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { VStack, HStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import type { InterruptPayload } from "@/lib/api";

interface InterruptGateProps {
  payload: InterruptPayload;
  onApprove: () => void;
  onDecline: () => void;
  disabled?: boolean;
}

// Fixed, content-independent description text per action — deliberately
// NEVER derived from the payload's own content (that would just be a
// summary, the exact thing this gate exists to avoid). Phase 12 checkpoint
// requirement, STEPS.md 63. Phase 14 added the three Mac-native actions
// (run_shortcut, calendar_create_event/calendar_update_event — Apple
// Calendar, distinct action names from Google's create_calendar_event/
// update_calendar_event above) that previously fell through to the raw
// JSON fallback.
const ACTION_DESCRIPTIONS: Record<string, string> = {
  send_email: "The assistant wants to send this email:",
  modify_gmail_labels: "The assistant wants to change labels on this email:",
  create_calendar_event: "The assistant wants to create this calendar event:",
  update_calendar_event: "The assistant wants to update this calendar event:",
  delete_calendar_event: "The assistant wants to delete this calendar event:",
  create_gmail_filter:
    "The assistant wants to create this Gmail filter — a STANDING rule that will keep acting on every future matching email:",
  delete_gmail_filter: "The assistant wants to delete this Gmail filter:",
  run_shortcut: "The assistant wants to run this Shortcut:",
  calendar_create_event: "The assistant wants to create this Apple Calendar event:",
  calendar_update_event: "The assistant wants to update this Apple Calendar event:",
  send_imessage: "The assistant wants to send this iMessage:",
  write_disk_file: "The assistant wants to write this file OUTSIDE the workspace:",
  delete_disk_file: "The assistant wants to DELETE this file OUTSIDE the workspace:",
  // PLAN.md Phase 25: one confirmation covering an entire multi-step,
  // cross-specialist plan, not a single action — see WorkflowPlanGateBody.
  propose_workflow: "The assistant wants to run this multi-step workflow:",
  // run_shortcut_on_phone is deliberately absent here — the user chose to
  // leave phone_tools.py's run_shortcut_on_phone ungated, so it never
  // gates and this entry would be dead/misleading code.
};

// Small source badge so it's visible at a glance which system a gate
// touches — matters most for the two calendar systems this project keeps
// deliberately disambiguated everywhere else (SUPERVISOR_SYSTEM_PROMPT,
// MAC_CONTROL_SYSTEM_PROMPT — see STEPS.md 69).
const ACTION_SOURCE: Record<string, string> = {
  send_email: "Gmail",
  modify_gmail_labels: "Gmail",
  create_calendar_event: "Google Calendar",
  update_calendar_event: "Google Calendar",
  delete_calendar_event: "Google Calendar",
  create_gmail_filter: "Gmail",
  delete_gmail_filter: "Gmail",
  run_shortcut: "Mac Control",
  calendar_create_event: "Apple Calendar",
  calendar_update_event: "Apple Calendar",
  send_imessage: "Messages",
  write_disk_file: "Full-disk access",
  delete_disk_file: "Full-disk access",
  // propose_workflow is deliberately absent here — it spans MULTIPLE
  // specialists (one per step), so no single source badge fits; each
  // step shows its own owning specialist inline instead (WorkflowPlanGateBody).
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Verbatim monospace block — the one primitive every renderer below reuses
// for actual content (body, description, criteria, etc.). No path through
// this component may paraphrase, truncate silently, or reformat content
// into prose.
function VerbatimBlock({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <pre
      data-testid={testId}
      className="whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-sm"
    >
      {children}
    </pre>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-sm">
      <span className="font-medium">{label}:</span> {value}
    </div>
  );
}

function AddressList({ label, addresses }: { label: string; addresses: string[] }) {
  return <Field label={label} value={addresses.length > 0 ? addresses.join(", ") : "(none)"} />;
}

function EmailGateBody({ payload }: { payload: InterruptPayload }) {
  return (
    <div className="space-y-2">
      <AddressList label="To" addresses={list(payload.to)} />
      <AddressList label="Cc" addresses={list(payload.cc)} />
      {/* Bcc rendered ALWAYS, even empty — smuggling a recipient into bcc
          must never hide it by being visually absent. STEPS.md 63. */}
      <AddressList label="Bcc" addresses={list(payload.bcc)} />
      <Field label="Subject" value={str(payload.subject)} />
      <div>
        <span className="text-sm font-medium">Body:</span>
        <VerbatimBlock testId="interrupt-email-body">{str(payload.body)}</VerbatimBlock>
      </div>
    </div>
  );
}

function LabelModifyGateBody({ payload }: { payload: InterruptPayload }) {
  const message = (payload.message as Record<string, unknown>) ?? {};
  return (
    <div className="space-y-2">
      <Field label="From" value={str(message.from, str(message.raw, "(unknown)"))} />
      <Field label="Subject" value={str(message.subject)} />
      <AddressList label="Add labels" addresses={list(payload.add_label_ids)} />
      <AddressList label="Remove labels" addresses={list(payload.remove_label_ids)} />
    </div>
  );
}

function eventFields(event: Record<string, unknown>) {
  return {
    title: str(event.title, "(no title)"),
    start: str(event.start, "(unknown)"),
    end: str(event.end, "(unknown)"),
    timezone: str(event.timezone, "(unspecified)"),
    location: str(event.location),
    description: str(event.description),
    attendees: Array.isArray(event.attendees) ? event.attendees : [],
  };
}

function EventFields({ event, testId }: { event: Record<string, unknown>; testId?: string }) {
  const f = eventFields(event);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Field label="Title" value={f.title} />
      <Field label="Start" value={f.start} />
      <Field label="End" value={f.end} />
      <Field label="Timezone" value={f.timezone} />
      {f.location && <Field label="Location" value={f.location} />}
      <Field
        label="Attendees"
        value={
          f.attendees.length > 0
            ? f.attendees
                .map((a) =>
                  a && typeof a === "object"
                    ? String((a as Record<string, unknown>).email ?? a)
                    : String(a),
                )
                .join(", ")
            : "(none)"
        }
      />
      {f.description && (
        <div>
          <span className="text-sm font-medium">Description:</span>
          <VerbatimBlock>{f.description}</VerbatimBlock>
        </div>
      )}
    </div>
  );
}

function CreateEventGateBody({ payload }: { payload: InterruptPayload }) {
  return <EventFields event={payload} testId="interrupt-event-fields" />;
}

function UpdateEventGateBody({ payload }: { payload: InterruptPayload }) {
  const current = (payload.current as Record<string, unknown>) ?? {};
  const changes = (payload.changes as Record<string, unknown>) ?? {};
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Current:</p>
        <EventFields event={current} testId="interrupt-event-current" />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Requested changes:</p>
        <VerbatimBlock testId="interrupt-event-changes">
          {JSON.stringify(changes, null, 2)}
        </VerbatimBlock>
      </div>
    </div>
  );
}

function DeleteEventGateBody({ payload }: { payload: InterruptPayload }) {
  const event = (payload.event as Record<string, unknown>) ?? {};
  return <EventFields event={event} testId="interrupt-event-fields" />;
}

function CreateFilterGateBody({ payload }: { payload: InterruptPayload }) {
  const criteria = (payload.criteria as Record<string, unknown>) ?? {};
  const action = (payload.resulting_action as Record<string, unknown>) ?? {};
  const forwardTo = typeof action.forward_to === "string" ? action.forward_to : null;
  return (
    <div className="space-y-3">
      <div>
        <span className="text-sm font-medium">Matches mail where:</span>
        <VerbatimBlock testId="interrupt-filter-criteria">
          {JSON.stringify(criteria, null, 2)}
        </VerbatimBlock>
      </div>
      <AddressList label="Add labels" addresses={list(action.add_labels)} />
      <AddressList label="Remove labels" addresses={list(action.remove_labels)} />
      {/* This is the exfiltration field — rendered loudly and unconditionally
          whenever set, never buried in a generic action dump. STEPS.md 64. */}
      {forwardTo && (
        <div
          data-testid="interrupt-filter-forward"
          className="rounded-md border border-destructive/60 bg-destructive/10 p-2 text-sm font-medium text-destructive"
        >
          ⚠ Forwards matching mail to: {forwardTo}
        </div>
      )}
    </div>
  );
}

function DeleteFilterGateBody({ payload }: { payload: InterruptPayload }) {
  return <VerbatimBlock testId="interrupt-filter-verbatim">{str(payload.filter)}</VerbatimBlock>;
}

// Apple Calendar (mac_tools.py, Phase 13) event fields — a DIFFERENT shape
// from Google's `eventFields` above (no attendees array; a `calendar_name`
// on create vs. a bare `calendar` key inside `current` on update, since that
// dict is `_calendar_get_event`'s read-back, not the create payload).
function appleEventFields(event: Record<string, unknown>) {
  return {
    calendarName: str(event.calendar_name ?? event.calendar, "(unspecified)"),
    title: str(event.title, "(no title)"),
    start: str(event.start, "(unknown)"),
    end: str(event.end, "(unknown)"),
    timezone: str(event.timezone, "(unspecified)"),
    location: str(event.location),
    description: str(event.description),
  };
}

function AppleEventFields({ event, testId }: { event: Record<string, unknown>; testId?: string }) {
  const f = appleEventFields(event);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Field label="Calendar" value={f.calendarName} />
      <Field label="Title" value={f.title} />
      <Field label="Start" value={f.start} />
      <Field label="End" value={f.end} />
      <Field label="Timezone" value={f.timezone} />
      {f.location && <Field label="Location" value={f.location} />}
      {f.description && (
        <div>
          <span className="text-sm font-medium">Description:</span>
          <VerbatimBlock>{f.description}</VerbatimBlock>
        </div>
      )}
    </div>
  );
}

function AppleCalendarCreateEventGateBody({ payload }: { payload: InterruptPayload }) {
  return <AppleEventFields event={payload} testId="interrupt-apple-event-fields" />;
}

function AppleCalendarUpdateEventGateBody({ payload }: { payload: InterruptPayload }) {
  const current = (payload.current as Record<string, unknown>) ?? {};
  const changes = (payload.changes as Record<string, unknown>) ?? {};
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Current:</p>
        <AppleEventFields event={current} testId="interrupt-apple-event-current" />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Requested changes:</p>
        <VerbatimBlock testId="interrupt-apple-event-changes">
          {JSON.stringify(changes, null, 2)}
        </VerbatimBlock>
      </div>
    </div>
  );
}

// mac_tools.py's run_shortcut — every Shortcut name is gated the same way
// regardless of what it sounds like, since the tool can't see what a
// Shortcut actually does (its own docstring). Voice-approvable (no
// voice_approvable key means the default True — see the eyebrow badge
// below), unlike every other renderer on this page.
function RunShortcutGateBody({ payload }: { payload: InterruptPayload }) {
  return <Field label="Shortcut" value={str(payload.name, "(unnamed)")} />;
}

// mac_tools.py's send_imessage (Phase 22) — same verbatim-content
// requirement as EmailGateBody: the real recipient and message text, no
// paraphrase. voice_approvable: False (mac_tools.py), same tier as email.
function IMessageGateBody({ payload }: { payload: InterruptPayload }) {
  return (
    <div className="space-y-2">
      <Field label="To" value={str(payload.recipient, "(unknown)")} />
      <div>
        <span className="text-sm font-medium">Message:</span>
        <VerbatimBlock testId="interrupt-imessage-body">{str(payload.message)}</VerbatimBlock>
      </div>
    </div>
  );
}

// mac_tools.py's/disk_tools.py's write_disk_file/delete_disk_file (Phase
// 23) — the largest security-model change in this project's history
// (PLAN.md's own Phase 23 entry). Same verbatim-content requirement as
// every other gated tool: the real path, and the real previous/new
// content (or current content, for delete), never paraphrased.
function WriteDiskFileGateBody({ payload }: { payload: InterruptPayload }) {
  const existed = payload.existed === true;
  const previous = typeof payload.previous_content === "string" ? payload.previous_content : null;
  return (
    <div className="space-y-2">
      <Field label="Path" value={str(payload.path, "(unknown)")} />
      <Field
        label="Already exists"
        value={existed ? "Yes — will be OVERWRITTEN" : "No — new file"}
      />
      {existed && previous !== null && (
        <div>
          <span className="text-sm font-medium">Current content:</span>
          <VerbatimBlock testId="interrupt-disk-file-previous">{previous}</VerbatimBlock>
        </div>
      )}
      <div>
        <span className="text-sm font-medium">New content:</span>
        <VerbatimBlock testId="interrupt-disk-file-new">{str(payload.new_content)}</VerbatimBlock>
      </div>
    </div>
  );
}

function DeleteDiskFileGateBody({ payload }: { payload: InterruptPayload }) {
  return (
    <div className="space-y-2">
      <Field label="Path" value={str(payload.path, "(unknown)")} />
      <div>
        <span className="text-sm font-medium">Current content:</span>
        <VerbatimBlock testId="interrupt-disk-file-delete-content">
          {str(payload.content)}
        </VerbatimBlock>
      </div>
    </div>
  );
}

// supervisor.py's propose_workflow (PLAN.md Phase 25) — ONE confirmation
// bundling 2+ gated actions across specialists, decision D2's own
// tradeoff: this card shows the SUPERVISOR's own summary of each step,
// not necessarily byte-identical to what the specialist ends up actually
// constructing (same accepted gap as every single-action upfront
// confirmation already has — see supervisor.py's module docstring).
// Every step rendered verbatim, in order, with its owning specialist —
// no step may be summarized away or collapsed.
function WorkflowPlanGateBody({ payload }: { payload: InterruptPayload }) {
  const steps = Array.isArray(payload.steps) ? (payload.steps as Record<string, unknown>[]) : [];
  return (
    <div className="space-y-3" data-testid="interrupt-workflow-steps">
      <Field label="Goal" value={str(payload.goal, "(none)")} />
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={i}
            className="rounded-md border p-2"
            data-testid={`interrupt-workflow-step-${i}`}
          >
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="neutral" label={`Step ${i + 1}`} />
              <span className="text-sm font-medium">{str(step.action, "(unknown action)")}</span>
              {typeof step.specialist === "string" && step.specialist && (
                <span className="text-xs text-muted-foreground">via {step.specialist}</span>
              )}
            </div>
            <VerbatimBlock testId={`interrupt-workflow-step-${i}-summary`}>
              {str(step.summary)}
            </VerbatimBlock>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACTION_BODIES: Record<string, (props: { payload: InterruptPayload }) => React.ReactElement> =
  {
    send_email: EmailGateBody,
    modify_gmail_labels: LabelModifyGateBody,
    create_calendar_event: CreateEventGateBody,
    update_calendar_event: UpdateEventGateBody,
    delete_calendar_event: DeleteEventGateBody,
    create_gmail_filter: CreateFilterGateBody,
    delete_gmail_filter: DeleteFilterGateBody,
    run_shortcut: RunShortcutGateBody,
    calendar_create_event: AppleCalendarCreateEventGateBody,
    calendar_update_event: AppleCalendarUpdateEventGateBody,
    send_imessage: IMessageGateBody,
    write_disk_file: WriteDiskFileGateBody,
    delete_disk_file: DeleteDiskFileGateBody,
    propose_workflow: WorkflowPlanGateBody,
  };

// The confirmation-gate UI affordance PLAN.md's Phase 9 step 3 requires.
// Renders whatever raw payload the gated tool constructed — never
// re-summarized. For email/calendar/filter writes, the content is shown
// verbatim (no LLM paraphrase, no content-derived description text) with
// no voice/speak affordance in this component at all (voice approval is
// decided server-side by voice_daemon.py reading voice_approvable off the
// same payload, independent of this GUI). Only a genuinely unrecognized
// action falls back to a raw JSON dump — every known gated action gets a
// dedicated, human-readable renderer.
//
// Memory writes no longer reach this component at all (2026-07-28): the
// per-turn interrupt()-gated fact proposal was replaced by
// memory_review_agent.py's nightly batch pass, which queues candidates
// into MemoryPanel's own approve/decline review section instead — see
// memory_extraction.py's module docstring for the full reasoning.
export function InterruptGate({ payload, onApprove, onDecline, disabled }: InterruptGateProps) {
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const ActionBody = action ? ACTION_BODIES[action] : undefined;
  const spokenPrompt = typeof payload.spoken_prompt === "string" ? payload.spoken_prompt : null;

  const description =
    action && ACTION_DESCRIPTIONS[action]
      ? ACTION_DESCRIPTIONS[action]
      : (spokenPrompt ?? `Action: ${String(payload.action ?? "unknown")}`);

  const source = action ? ACTION_SOURCE[action] : undefined;
  // Structural, not a guess: voice_daemon.py treats an ABSENT voice_approvable
  // key as approvable-by-voice (True is the default) — mirror that exact
  // rule here rather than inventing a separate UI-side convention.
  const voiceApprovable = payload.voice_approvable !== false;

  return (
    <Card
      className="border-l-4 border-l-signal bg-signal/5"
      padding={4}
      data-testid="interrupt-gate"
    >
      <VStack gap={3}>
        <HStack justify="between" align="center">
          <HStack gap={2} align="center" className="panel-label text-[0.7rem] text-signal">
            <ShieldAlert className="size-3.5" aria-hidden />
            Approval required
          </HStack>
          <HStack gap={1.5} align="center">
            {source && <Badge variant="neutral" label={source} />}
            {/* No Tooltip wrapper here (unlike the original's `title` attr):
                Astryx's Tooltip renders its content into the DOM rather than
                a native title attribute, which put the word "voice" into the
                document even for memory-write gates — breaking the test that
                requires ZERO voice-related text on that specific gate. The
                badge's own visible label already conveys the state. */}
            <Badge
              variant="neutral"
              label={voiceApprovable ? "Voice OK" : "Text only"}
              icon={voiceApprovable ? <Mic className="size-3" /> : <Keyboard className="size-3" />}
            />
          </HStack>
        </HStack>
        <VStack gap={1}>
          <Heading level={4}>Confirmation needed</Heading>
          <Text color="secondary" size="sm">
            {description}
          </Text>
        </VStack>
        <div>
          {ActionBody ? (
            <ActionBody payload={payload} />
          ) : (
            !spokenPrompt && (
              <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
                {JSON.stringify(payload, null, 2)}
              </pre>
            )
          )}
        </div>
        <HStack gap={2}>
          <Button label="Approve" onClick={onApprove} isDisabled={disabled} />
          <Button label="Decline" variant="secondary" onClick={onDecline} isDisabled={disabled} />
        </HStack>
      </VStack>
    </Card>
  );
}
