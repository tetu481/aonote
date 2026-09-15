import type { Root, RootContent } from "mdast";
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { normalizeWikilinks } from "./markdown";
import { remarkAlerts } from "./remarkAlerts";

export const headingId = (index: number) => `note-heading-${index}`;

function walkHeadings(node: Root | RootContent, visit: (heading: Extract<RootContent, { type: "heading" }>) => void) {
  if (node.type === "heading" && node.depth <= 3) visit(node);
  if ("children" in node) node.children.forEach((child) => walkHeadings(child as RootContent, visit));
}

function headingText(node: RootContent): string {
  if ("children" in node) return node.children.map((child) => headingText(child as RootContent)).join("");
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("value" in node) return node.value;
  return "";
}

const outlineParser = unified().use(remarkParse).use(remarkGfm).use(remarkAlerts);

export function extractOutlineHeadings(markdown: string) {
  const tree = outlineParser.runSync(outlineParser.parse(normalizeWikilinks(markdown))) as Root;
  const headings: Array<{ level: number; label: string }> = [];
  walkHeadings(tree, (heading) => {
    headings.push({ level: heading.depth, label: headingText(heading) });
  });
  return headings;
}

export const remarkHeadingIds: Plugin<[], Root> = () => (tree) => {
  let headingIndex = 0;
  walkHeadings(tree, (heading) => {
    const data = heading.data ?? (heading.data = {});
    const htmlData = data as { hProperties?: Record<string, unknown> };
    htmlData.hProperties = { ...htmlData.hProperties, id: headingId(headingIndex++) };
  });
};
