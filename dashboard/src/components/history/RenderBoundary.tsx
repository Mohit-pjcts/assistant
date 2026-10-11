import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface RenderBoundaryProps {
  // What was being drawn ("turn 4", "Stage run"), for the message.
  what: string;
  children: ReactNode;
}

// Catches a render error in whatever it wraps and shows it in place, instead
// of letting React tear down the whole app. The History panel draws data the
// backend hands it wholesale — tool arguments of any shape, Stage's log
// lines, fields added by later versions — and nothing else in the dashboard
// has a boundary, so without this one malformed turn would blank the entire
// window (not just this panel) until a reload. Small on purpose: one boundary
// per tab, turn and Stage run, so a bad record costs that record, not the page.
//
// A class component because React has no hook for this.
export class RenderBoundary extends Component<RenderBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`History: couldn't display ${this.props.what}`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-1.5 rounded-md border border-rust/50 p-3"
      >
        <p className="text-sm text-destructive">
          {`Couldn't display ${this.props.what} — its data wasn't in the shape this panel expects.`}
        </p>
        <p className="break-words font-mono text-xs text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="xs" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
