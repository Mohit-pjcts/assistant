import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversationTab } from "./ConversationTab";
import { OnstageList } from "./OnstageList";
import { RenderBoundary } from "./RenderBoundary";
import { StageRunsList } from "./StageRunsList";

// STEPS.md 158 — the full-fidelity counterpart to the chat panel, rebuilt.
// ChatPanel deliberately shows only the dialogue; this panel shows
// everything the system did: every tool call with its arguments and output,
// every delegation and what the specialist did and said inside it, and — since
// Stage runs the computer-use agents — every Stage run and Onstage answer,
// including the ones Oni never started.
//
// Three tabs. Conversation follows the active thread the way the old panel
// did: App.tsx remounts this component (`key={activeThreadId}`) whenever the
// sidebar switches threads, and the backend answers for the active thread
// when no thread id is given. Stage and Onstage aren't per-thread at all —
// they are Stage's own logs.
//
// Each tab is mounted the first time it's opened and kept mounted after
// that (Base UI's `keepMounted`), so the filter text, loaded pages and
// expanded rows survive a trip to another tab — but opening the panel
// doesn't pull Stage's logs for someone who only came for the conversation.

type HistoryTab = "conversation" | "stage" | "onstage";

const TAB_LABEL_CLASS = "panel-label text-[0.7rem]";

function isHistoryTab(value: unknown): value is HistoryTab {
  return value === "conversation" || value === "stage" || value === "onstage";
}

export function HistoryPanel({ threadId }: { threadId?: string }) {
  const [tab, setTab] = useState<HistoryTab>("conversation");
  const [visited, setVisited] = useState<ReadonlySet<HistoryTab>>(new Set(["conversation"]));

  function handleTabChange(value: unknown) {
    if (!isHistoryTab(value)) return;
    setTab(value);
    setVisited((prev) => (prev.has(value) ? prev : new Set(prev).add(value)));
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="h-full min-h-0 gap-3">
      <TabsList variant="line">
        <TabsTrigger value="conversation" className={TAB_LABEL_CLASS}>
          Conversation
        </TabsTrigger>
        <TabsTrigger value="stage" className={TAB_LABEL_CLASS}>
          Stage
        </TabsTrigger>
        <TabsTrigger value="onstage" className={TAB_LABEL_CLASS}>
          Onstage
        </TabsTrigger>
      </TabsList>
      <TabsContent value="conversation" keepMounted className="flex min-h-0 flex-col">
        <RenderBoundary what="the conversation">
          <ConversationTab threadId={threadId} />
        </RenderBoundary>
      </TabsContent>
      <TabsContent value="stage" keepMounted className="flex min-h-0 flex-col">
        {visited.has("stage") && (
          <RenderBoundary what="the Stage runs">
            <StageRunsList />
          </RenderBoundary>
        )}
      </TabsContent>
      <TabsContent value="onstage" keepMounted className="flex min-h-0 flex-col">
        {visited.has("onstage") && (
          <RenderBoundary what="the Onstage journal">
            <OnstageList />
          </RenderBoundary>
        )}
      </TabsContent>
    </Tabs>
  );
}
