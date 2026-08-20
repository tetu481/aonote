import { Children, isValidElement, useCallback, useDeferredValue, useMemo, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleAlert, Info, Lightbulb, ShieldAlert, TriangleAlert } from "lucide-react";
import { remarkAlerts } from "../remarkAlerts";
import { remarkHeadingIds } from "../remarkHeadingIds";
import type { Note } from "../types";
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

function MarkdownLink({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  return <a href={href} className={href?.startsWith("#wikilink-") ? "wikilink" : undefined} {...props}>{children}</a>;
}

const markdownComponents = {
  a: MarkdownLink,
  blockquote: MarkdownBlockquote,
  pre: MarkdownPre,
} satisfies Components;

type Props = {
  content: string;
  links: Note["links"];
  onWikilink: (id: string) => void;
};

export function PreviewPane({ content, links, onWikilink }: Props) {
  const deferred = useDeferredValue(content);
  const markdown = useMemo(() => normalizeWikilinks(deferred), [deferred]);
  const linkTargets = useMemo(
    () => new Map(links.flatMap((link) => link.id ? [[link.target, link.id] as const] : [])),
    [links],
  );
  const followWikilink = useCallback((event: MouseEvent<HTMLElement>) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    const anchor = element.closest<HTMLAnchorElement>("a.wikilink");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("#wikilink-")) return;
    event.preventDefault();
    const target = decodeURIComponent(href.slice("#wikilink-".length));
    const noteId = linkTargets.get(target);
    if (noteId) onWikilink(noteId);
  }, [linkTargets, onWikilink]);
  return (
    <article className="preview-pane markdown-body" aria-label="Markdownプレビュー" onClick={followWikilink}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlerts, remarkHeadingIds]}
        components={markdownComponents}
      >{markdown}</ReactMarkdown>
    </article>
  );
}
