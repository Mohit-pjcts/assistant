import { isValidElement, memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// Renders an assistant reply as formatted prose, the way the Claude app does
// (headings, lists, tables, quotes, fenced code with a copy button) instead of
// dumping the raw markdown source into a `whitespace-pre-wrap` div.
//
// Security posture, deliberate: model output can carry text pulled from web
// pages and emails, so this renderer is strictly display-only.
//  - react-markdown never parses raw HTML (no rehype-raw), so `<script>`/
//    `<iframe>` in a reply is shown as literal text.
//  - `![alt](url)` is NOT turned into an <img>: a remote image fetch is a
//    zero-click request to an attacker-chosen host (the exact "phone home"
//    channel a2ui.py already closes by accepting only `data:` URIs). The alt
//    text is shown instead.
//  - Links keep react-markdown's default protocol allowlist (no `javascript:`)
//    and open in a new tab with `noopener noreferrer`.

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); the
      // button simply does nothing rather than surfacing an error for a
      // convenience feature.
    }
  }
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-graphite/25 bg-muted/60">
      <div className="flex items-center justify-between border-b border-graphite/20 px-3.5 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{language || "text"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-[13px] leading-[1.6]">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-3 mt-6 font-sans text-[1.35rem] font-semibold leading-snug first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2.5 mt-6 font-sans text-[1.15rem] font-semibold leading-snug first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 font-sans text-[1rem] font-semibold leading-snug first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 font-sans text-[0.95rem] font-semibold first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground/70">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  hr: () => <hr className="my-6 border-graphite/25" />,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-accent-signal/60 pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-signal underline decoration-accent-signal/40 underline-offset-2 transition-colors hover:decoration-accent-signal"
    >
      {children}
    </a>
  ),
  // See the security note above: never fetch a remote image from model output.
  img: ({ alt }) => (alt ? <span className="text-muted-foreground">[{alt}]</span> : null),
  pre: ({ children }) => {
    // react-markdown hands us <pre><code class="language-x">…</code></pre>;
    // swap the whole thing for the copy-button block.
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement<ComponentProps<"code">>(child)) {
      const match = /language-([\w-]+)/.exec(child.props.className ?? "");
      return (
        <CodeBlock
          language={match?.[1] ?? ""}
          code={nodeText(child.props.children).replace(/\n$/, "")}
        />
      );
    }
    return <pre>{children}</pre>;
  },
  code: ({ className, children }) => (
    // Fenced blocks are replaced wholesale by `pre` above; this branch only
    // ever styles inline `code`.
    <code
      className={cn(
        "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.86em] text-foreground",
        className,
      )}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-graphite/25">
      <table className="w-full border-collapse text-[13.5px] [&_tbody_tr:last-child_td]:border-b-0">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-graphite/25 px-3.5 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-graphite/15 px-3.5 py-2 align-top">{children}</td>
  ),
};

interface MarkdownProps {
  children: string;
  className?: string;
}

/** Formatted-prose rendering of a markdown string. Memoized: a streaming reply
 * re-renders on every token, but earlier messages' text never changes. */
export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
