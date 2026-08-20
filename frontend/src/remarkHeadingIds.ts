import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";

export const headingId = (index: number) => `note-heading-${index}`;

export function extractOutlineHeadings(markdown: string) {
  const headings: Array<{ level: number; label: string }> = [];
  let fence: "`" | "~" | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (fence === marker) fence = null;
      else if (!fence) fence = marker;
      continue;
    }
    if (fence) continue;
    const match = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, label: match[2] });
  }
  return headings;
}

export const remarkHeadingIds: Plugin<[], Root> = () => (tree) => {
  let headingIndex = 0;

  const walk = (node: Root | RootContent) => {
    if (node.type === "heading" && node.depth <= 3) {
      const data = node.data ?? (node.data = {});
      (data as unknown as { hProperties: { id: string } }).hProperties = {
        id: headingId(headingIndex),
      };
      headingIndex += 1;
    }
    if ("children" in node) {
      node.children.forEach((child) => walk(child as RootContent));
    }
  };

  walk(tree);
};
