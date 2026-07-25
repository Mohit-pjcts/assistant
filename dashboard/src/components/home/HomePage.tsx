import { useState, type KeyboardEvent } from "react";
import { Layout, LayoutContent, VStack, HStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { ChatComposer, ChatSendButton } from "@astryxdesign/core/Chat";
import { TextArea } from "@astryxdesign/core/TextArea";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SparklesIcon,
  PencilSquareIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  LightBulbIcon,
} from "@heroicons/react/24/outline";

// Adapted from the Astryx Playground's "AI Chat Landing" template
// (astryx.atmeta.com/playground) into a real, wired-up entry point for this
// app. Trimmed from the template's mockup: the fake @mention roster,
// /command palette, "Sensitive"/"Deep Mode" tokens, and the decorative
// pre-seeded attachment chips were all non-functional demo content with no
// real counterpart in a single-user personal assistant — dropped rather
// than shipped as dead UI. What's kept (greeting, category filter,
// prompt-suggestion cards, composer) is fully live: submitting here hands
// the message to App.tsx, which switches to the Chat tab and sends it
// through ChatPanel's real, already-tested send pipeline.

type Category = "writing" | "coding" | "research" | "creative";

const CATEGORIES: Array<{ key: Category; label: string; icon: typeof SparklesIcon }> = [
  { key: "writing", label: "Writing", icon: PencilSquareIcon },
  { key: "coding", label: "Coding", icon: CodeBracketIcon },
  { key: "research", label: "Research", icon: MagnifyingGlassIcon },
  { key: "creative", label: "Creative", icon: LightBulbIcon },
];

const CATEGORY_SUGGESTIONS: Record<
  Category,
  Array<{ heading: string; body: string; prompt: string }>
> = {
  writing: [
    {
      heading: "Draft a professional email",
      body: "Compose a clear, polished email for any audience",
      prompt: "Help me draft a professional email",
    },
    {
      heading: "Improve my writing",
      body: "Enhance the clarity, tone, and flow of my text",
      prompt: "Review and improve the following text:",
    },
  ],
  coding: [
    {
      heading: "Debug my code",
      body: "Find and fix issues in a code snippet",
      prompt: "Help me debug the following code:",
    },
    {
      heading: "Explain this code",
      body: "Break down complex code into understandable pieces",
      prompt: "Explain what the following code does:",
    },
  ],
  research: [
    {
      heading: "Compare options",
      body: "Analyze pros and cons of different approaches",
      prompt: "Compare the pros and cons of",
    },
    {
      heading: "Find best practices",
      body: "Research standards and recommended approaches",
      prompt: "What are the best practices for",
    },
  ],
  creative: [
    {
      heading: "Brainstorm ideas",
      body: "Generate creative concepts for a project",
      prompt: "Brainstorm ideas for",
    },
    {
      heading: "Write a story",
      body: "Create an engaging narrative with characters",
      prompt: "Write a short story about",
    },
  ],
};

interface HomePageProps {
  greetingName: string;
  onStartChat: (message: string) => void;
}

export function HomePage({ greetingName, onStartChat }: HomePageProps) {
  const [category, setCategory] = useState<Category | null>(null);
  const [input, setInput] = useState("");

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    onStartChat(trimmed);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(input);
    }
  }

  const suggestions = category ? CATEGORY_SUGGESTIONS[category] : null;

  return (
    <Layout
      height="fill"
      contentWidth={720}
      padding={6}
      content={
        <LayoutContent>
          <VStack gap={8} vAlign="center" style={{ minHeight: "100%" }}>
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Icon icon={SparklesIcon} size="md" color="accent" />
                <Text type="large" as="h2">
                  Hi, {greetingName}
                </Text>
              </HStack>
              <Text type="display-2" as="h1">
                Where should we start?
              </Text>
            </VStack>

            <ChatComposer
              value={input}
              onChange={setInput}
              onSubmit={() => submit(input)}
              placeholder="Ask anything"
              input={
                <TextArea
                  label="Ask anything"
                  isLabelHidden
                  value={input}
                  onChange={setInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything"
                  rows={1}
                />
              }
              sendButton={<ChatSendButton isDisabled={!input.trim()} />}
            />

            <VStack gap={6} style={{ paddingInline: "var(--spacing-3)" }}>
              <ToggleButtonGroup
                label="Category"
                value={category}
                onChange={(value) => setCategory(value as Category | null)}
                size="lg"
              >
                {CATEGORIES.map((cat) => (
                  <ToggleButton
                    key={cat.key}
                    value={cat.key}
                    label={cat.label}
                    icon={<Icon icon={cat.icon} size="sm" />}
                  />
                ))}
              </ToggleButtonGroup>

              {suggestions && (
                <Grid columns={{ minWidth: 280 }} gap={3}>
                  {suggestions.map((suggestion) => (
                    <ClickableCard
                      key={suggestion.heading}
                      label={suggestion.heading}
                      variant="muted"
                      padding={3}
                      onClick={() => submit(suggestion.prompt)}
                    >
                      <VStack gap={0.5}>
                        <Heading level={4}>{suggestion.heading}</Heading>
                        <Text type="body" color="secondary" size="xsm">
                          {suggestion.body}
                        </Text>
                      </VStack>
                    </ClickableCard>
                  ))}
                </Grid>
              )}
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
