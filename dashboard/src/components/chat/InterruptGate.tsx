import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { InterruptPayload } from "@/lib/api";

interface InterruptGateProps {
  payload: InterruptPayload;
  onApprove: () => void;
  onDecline: () => void;
  disabled?: boolean;
}

// Mirrors memory_extraction.py's gate exactly: voice_approvable === false is
// how that module marks a fact-write proposal (assistant/memory_extraction.py,
// STEPS.md 54). Structural check, not a guess at the action name, so it
// still works if the tool's `action` string ever changes.
function isMemoryWrite(payload: InterruptPayload): boolean {
  return payload.voice_approvable === false && typeof payload.fact === "string";
}

// The confirmation-gate UI affordance PLAN.md's Phase 9 step 3 requires.
// Renders whatever raw payload the gated tool constructed — never
// re-summarized. For memory writes specifically, the `fact` string is shown
// verbatim (no LLM paraphrase) and there is deliberately no voice/speak
// affordance offered here at all: the red-teamed Phase 7 gate requires
// text-only confirmation for fact writes specifically, and since voice
// hasn't moved into this app yet (STEPS.md 54's sequencing decision) that's
// automatically true today — but if voice ever does move in, this
// component must keep excluding memory-write payloads from any
// speak-it-aloud affordance, same as voice_daemon.py already does.
export function InterruptGate({ payload, onApprove, onDecline, disabled }: InterruptGateProps) {
  const memoryWrite = isMemoryWrite(payload);
  const spokenPrompt = typeof payload.spoken_prompt === "string" ? payload.spoken_prompt : null;

  return (
    <Card className="border-amber-500/60" data-testid="interrupt-gate">
      <CardHeader>
        <CardTitle>Confirmation needed</CardTitle>
        <CardDescription>
          {memoryWrite
            ? "The assistant wants to save this as a long-term fact about you."
            : (spokenPrompt ?? `Action: ${String(payload.action ?? "unknown")}`)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {memoryWrite ? (
          <>
            <blockquote
              data-testid="interrupt-fact-verbatim"
              className="whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-sm"
            >
              {payload.fact as string}
            </blockquote>
            {typeof payload.provenance === "string" && payload.provenance && (
              <p className="mt-2 text-xs text-muted-foreground">Source: {payload.provenance}</p>
            )}
          </>
        ) : (
          !spokenPrompt && (
            <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={onApprove} disabled={disabled}>
          Approve
        </Button>
        <Button variant="outline" onClick={onDecline} disabled={disabled}>
          Decline
        </Button>
      </CardFooter>
    </Card>
  );
}
