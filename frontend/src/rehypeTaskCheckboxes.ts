import type { Element, Root, RootContent } from "hast";
import type { Plugin } from "unified";

type Options = {
  source: string;
  sourceOffset: (offset: number) => number | null;
  editable: boolean;
  checkboxLabel: (label: string) => string;
};

function textContent(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element" || ["ul", "ol", "input"].includes(node.tagName)) return "";
  return node.children.map(textContent).join("");
}

function markTask(node: Element, options: Options) {
  const container = node.children.find((child) => child.type === "element" && child.tagName === "p");
  const children = container?.type === "element" ? container.children : node.children;
  const input = children.find((child): child is Element => child.type === "element" && child.tagName === "input" && child.properties.type === "checkbox");
  if (!input) return;
  const normalizedStart = node.position?.start.offset;
  const start = normalizedStart === undefined ? null : options.sourceOffset(normalizedStart);
  const marker = start === null ? null : /^(?:[-+*]|\d+[.)])[\s>]+\[([ xX])\](?=\s|$)/.exec(options.source.slice(start));
  const offset = marker && start !== null ? start + marker[0].lastIndexOf("[") + 1 : null;
  const checked = Boolean(input.properties.checked);
  const valid = offset !== null && (options.source[offset].toLowerCase() === "x") === checked;
  input.properties.disabled = !options.editable || !valid;
  input.properties.ariaLabel = options.checkboxLabel(node.children.map(textContent).join("").replace(/\s+/g, " ").trim());
  if (valid) input.properties["data-task-offset"] = offset;
  node.properties["data-task-checked"] = String(checked);
  // Keep nested lists outside the text decoration of their parent task.
  node.children = node.children.map((child) => {
    if (child === input || (child.type === "element" && ["ul", "ol"].includes(child.tagName))) return child;
    return { type: "element", tagName: "div", properties: { className: ["task-item-text"] }, children: [child] };
  });
}

export const rehypeTaskCheckboxes: Plugin<[Options], Root> = (options) => (tree) => {
  function walk(node: Root | RootContent) {
    if (node.type === "element" && node.tagName === "li") markTask(node, options);
    if ("children" in node) node.children.forEach(walk);
  }
  walk(tree);
};
