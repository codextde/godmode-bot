import type { HastNode } from "./local-file-tree";

type Node = HastNode & { value?: string; position?: { start?: { offset?: number }; end?: { offset?: number } } };

function fade(at: number, value: string): Node {
  return { type: "element", tagName: `gm-fade-${at}`, properties: { className: ["gm-fade"] }, children: [{ type: "text", value } as Node] } as Node;
}

function split(node: Node, marks: number[]): Node[] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  const value = node.value ?? "";
  if (start == null || end == null || !value || end <= marks[0]!) return null;
  if (end - start !== value.length) {
    const owner = [...marks].reverse().find((m) => m <= start) ?? marks.find((m) => m < end)!;
    return [fade(owner, value)];
  }
  const out: Node[] = [];
  const cuts = marks.filter((m) => m > start && m < end);
  const owner = [...marks].reverse().find((m) => m <= start);
  let pos = start;
  let current = owner;
  for (const cut of [...cuts, end]) {
    const piece = value.slice(pos - start, cut - start);
    if (piece) out.push(current == null ? ({ type: "text", value: piece } as Node) : fade(current, piece));
    current = cut;
    pos = cut;
  }
  return out;
}

function walk(node: Node, marks: number[]) {
  const children = node.children as Node[] | undefined;
  if (!children) return;
  const next: Node[] = [];
  for (const child of children) {
    if (child.type === "text") {
      const parts = split(child, marks);
      if (parts) next.push(...parts);
      else next.push(child);
    } else {
      if (child.type === "element" && !child.tagName?.startsWith("gm-fade-")) walk(child, marks);
      next.push(child);
    }
  }
  node.children = next as HastNode[];
}

export function rehypeStreamFade(options: { marks: number[] }) {
  return (tree: Node) => {
    if (options.marks.length) walk(tree, options.marks);
  };
}
