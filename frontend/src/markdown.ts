import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function protectedCodeRanges(markdown: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  function walk(node: Root | RootContent) {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      return;
    }
    if ("children" in node) node.children.forEach((child) => walk(child as RootContent));
  }
  walk(markdownParser.parse(markdown));
  return ranges;
}

// Keep preview rendering and outline parsing on the same Markdown input.
export function prepareMarkdown(markdown: string) {
  if (!markdown.includes("[[")) return { content: markdown, sourceOffset: (offset: number) => offset };
  const protectedRanges = protectedCodeRanges(markdown);
  let protectedIndex = 0;
  const replacements: Array<{ start: number; end: number; sourceEnd: number }> = [];
  let delta = 0;
  const content = markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (match: string, target: string, alias: string | undefined, offset: number) => {
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex].end <= offset) protectedIndex++;
    const protectedRange = protectedRanges[protectedIndex];
    // Code (including Mermaid's A[[subroutine]] syntax) is literal Markdown.
    if (protectedRange && protectedRange.start < offset + match.length) return match;
    const label = alias || target.trim();
    const replacement = `[${label}](#wikilink-${encodeURIComponent(target.trim())})`;
    replacements.push({ start: offset + delta, end: offset + delta + replacement.length, sourceEnd: offset + match.length });
    delta += replacement.length - match.length;
    return replacement;
  });
  return {
    content,
    sourceOffset(offset: number): number | null {
      let shift = 0;
      for (const replacement of replacements) {
        if (offset < replacement.start) break;
        // Generated Wiki-link markup must never become an editable task.
        if (offset < replacement.end) return null;
        shift = replacement.end - replacement.sourceEnd;
      }
      return offset - shift;
    },
  };
}

export function normalizeWikilinks(markdown: string) {
  return prepareMarkdown(markdown).content;
}
