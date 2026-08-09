import type { Blockquote, Root, RootContent } from "mdast";
import type { Plugin } from "unified";

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

function markAlert(node: Blockquote) {
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return;
  const text = paragraph.children[0];
  if (text?.type !== "text") return;
  const marker = ALERT_MARKER.exec(text.value);
  if (!marker) return;

  const kind = marker[1].toLowerCase();
  const data = node.data ?? (node.data = {});
  (data as unknown as { hProperties: { className: string[] } }).hProperties = {
    className: ["markdown-alert", `markdown-alert-${kind}`],
  };
  const remainder = text.value.slice(marker[0].length);
  if (remainder) text.value = remainder;
  else paragraph.children.shift();
  if (!paragraph.children.length) node.children.shift();
}

function walk(node: Root | RootContent) {
  if (node.type === "blockquote") markAlert(node);
  if ("children" in node) node.children.forEach((child) => walk(child as RootContent));
}

export const remarkAlerts: Plugin<[], Root> = () => (tree) => { walk(tree); };
