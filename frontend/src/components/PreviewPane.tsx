import { Children, isValidElement, useDeferredValue, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleAlert, Info, Lightbulb, ShieldAlert, TriangleAlert } from "lucide-react";
import { remarkAlerts } from "../remarkAlerts";
import { MermaidDiagram } from "./MermaidDiagram";

type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const alertTypes = {
  note: { label: "Note", Icon: Info },
  tip: { label: "Tip", Icon: Lightbulb },
  important: { label: "Important", Icon: CircleAlert },
  warning: { label: "Warning", Icon: TriangleAlert },
  caution: { label: "Caution", Icon: ShieldAlert },
} satisfies Record<AlertKind, { label: string; Icon: typeof Info }>;

function MarkdownBlockquote({ node: _node, children, className, ...props }: ComponentPropsWithoutRef<"blockquote"> & ExtraProps) {
  const kind = Object.keys(alertTypes).find((key) => className?.split(" ").includes(`markdown-alert-${key}`)) as AlertKind | undefined;
  if (!kind) return <blockquote className={className} {...props}>{children}</blockquote>;
  const { label, Icon } = alertTypes[kind];
  return <blockquote className={className} {...props}>
    <div className="markdown-alert-title"><Icon size={16} />{label}</div>
    {children}
  </blockquote>;
}

function MarkdownPre({ node: _node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(" ").includes("language-mermaid")) {
    return <MermaidDiagram chart={String(child.props.children ?? "").replace(/\n$/, "")} />;
  }
  return <pre {...props}>{children}</pre>;
}

function normalizeWikilinks(markdown: string) {
  return markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => {
    const label = alias || target;
    return `[${label}](#wikilink-${encodeURIComponent(target)})`;
  });
}

export function PreviewPane({ content }: { content: string }) {
  const deferred = useDeferredValue(content);
  const markdown = useMemo(() => normalizeWikilinks(deferred), [deferred]);
  return (
    <article className="preview-pane markdown-body" aria-label="Markdownプレビュー">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlerts]}
        components={{
          a: ({ href, children }) => <a href={href} className={href?.startsWith("#wikilink-") ? "wikilink" : undefined}>{children}</a>,
          blockquote: MarkdownBlockquote,
          pre: MarkdownPre,
        }}
      >{markdown}</ReactMarkdown>
    </article>
  );
}
