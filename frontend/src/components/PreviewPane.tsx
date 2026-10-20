import { Children, isValidElement, useCallback, useDeferredValue, useMemo, type ChangeEvent, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleAlert, Info, Lightbulb, ShieldAlert, TriangleAlert } from "lucide-react";
import { useUiText } from "../LocaleContext";
import { remarkAlerts } from "../remarkAlerts";
import { remarkHeadingIds } from "../remarkHeadingIds";
import { prepareMarkdown } from "../markdown";
import type { PreviewCheckboxMode } from "../previewCheckboxes";
import { rehypeTaskCheckboxes } from "../rehypeTaskCheckboxes";
import type { Note } from "../types";
import { MermaidDiagram } from "./MermaidDiagram";

type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const alertIcons = {
  note: Info,
  tip: Lightbulb,
  important: CircleAlert,
  warning: TriangleAlert,
  caution: ShieldAlert,
} satisfies Record<AlertKind, typeof Info>;

function MarkdownBlockquote({ node: _node, children, className, ...props }: ComponentPropsWithoutRef<"blockquote"> & ExtraProps) {
  const uiText = useUiText();
  const kind = Object.keys(alertIcons).find((key) => className?.split(" ").includes(`markdown-alert-${key}`)) as AlertKind | undefined;
  if (!kind) return <blockquote className={className} {...props}>{children}</blockquote>;
  const Icon = alertIcons[kind];
  return <blockquote className={className} {...props}>
    <div className="markdown-alert-title"><Icon size={16} />{uiText.preview.alerts[kind]}</div>
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

function MarkdownLink({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  return <a href={href} className={href?.startsWith("#wikilink-") ? "wikilink" : undefined} {...props}>{children}</a>;
}

function ignoreCheckboxChange() { /* The article handles changes using the source offset. */ }

function MarkdownInput({ node: _node, ...props }: ComponentPropsWithoutRef<"input"> & ExtraProps) {
  return <input {...props} onChange={ignoreCheckboxChange} />;
}

const markdownComponents = {
  a: MarkdownLink,
  blockquote: MarkdownBlockquote,
  pre: MarkdownPre,
  input: MarkdownInput,
} satisfies Components;

type Props = {
  content: string;
  links: Note["links"];
  onWikilink: (id: string) => void;
  checkboxMode?: PreviewCheckboxMode;
  readOnly?: boolean;
  onToggleTask?: (source: string, offset: number, checked: boolean) => void;
};

export function PreviewPane({ content, links, onWikilink, checkboxMode = "readonly", readOnly = false, onToggleTask }: Props) {
  const uiText = useUiText();
  const deferred = useDeferredValue(content);
  const markdown = useMemo(() => prepareMarkdown(deferred), [deferred]);
  const editable = checkboxMode !== "readonly" && !readOnly && Boolean(onToggleTask) && deferred === content;
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
  const toggleTask = (event: ChangeEvent<HTMLElement>) => {
    const input = event.target;
    if (!editable || !(input instanceof HTMLInputElement) || input.type !== "checkbox" || !input.hasAttribute("data-task-offset")) return;
    onToggleTask?.(deferred, Number(input.dataset.taskOffset), input.checked);
  };
  return (
    <article className={`preview-pane markdown-body${checkboxMode === "toggle-strikethrough" ? " tasks-strike-checked" : ""}`} aria-label={uiText.preview.regionLabel} onClick={followWikilink} onChange={toggleTask}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlerts, remarkHeadingIds]}
        rehypePlugins={[[rehypeTaskCheckboxes, { source: deferred, sourceOffset: markdown.sourceOffset, editable, checkboxLabel: uiText.preview.taskCheckbox }]]}
        components={markdownComponents}
      >{markdown.content}</ReactMarkdown>
    </article>
  );
}
