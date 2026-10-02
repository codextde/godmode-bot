/**
 * The files and folders a message names, put into its rendered Markdown (a hast tree): links to the file manager, and
 * the pictures themselves. No React here, so the core's tests can run it.
 */
import type { ChatFile } from "@godmode/shared";
import { barePaths, linkedPath } from "@godmode/shared";

export type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  data?: { gmFile?: ChatFile; gmChip?: boolean };
};

export const content = (n: HastNode) => (n.children ?? []).filter((c) => !(c.type === "text" && !c.value?.trim()));

const textOf = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));
const text = (value: string): HastNode => ({ type: "text", value });

function fileLink(file: ChatFile, children: HastNode[], chip: boolean): HastNode {
  return { type: "element", tagName: "a", properties: {}, children, data: { gmFile: file, gmChip: chip } };
}

function picture(file: ChatFile): HastNode {
  return { type: "element", tagName: "img", properties: { src: file.image, alt: file.name }, children: [], data: { gmFile: file } };
}

function linkBarePaths(node: HastNode, files: ReadonlyMap<string, ChatFile>): HastNode[] {
  const value = node.value ?? "";
  const out: HastNode[] = [];
  let at = 0;
  for (const { path, index } of barePaths(value)) {
    const file = files.get(path);
    if (!file) continue;
    if (index > at) out.push(text(value.slice(at, index)));
    out.push(fileLink(file, [text(path)], true));
    at = index + path.length;
  }
  if (!out.length) return [node];
  if (at < value.length) out.push(text(value.slice(at)));
  return out;
}

/** Code, links, images and bare paths that name an existing file become links to it. Code blocks stay as they are. */
function linkFiles(parent: HastNode, files: ReadonlyMap<string, ChatFile>): void {
  parent.children = (parent.children ?? []).flatMap((child): HastNode[] => {
    if (child.type === "text") return linkBarePaths(child, files);
    if (child.type !== "element" || child.tagName === "pre") return [child];
    if (child.tagName === "code") {
      const file = files.get(textOf(child).trim());
      return [file ? fileLink(file, [text(textOf(child))], true) : child];
    }
    if (child.tagName === "a" || child.tagName === "img") {
      const target = child.properties?.[child.tagName === "a" ? "href" : "src"];
      const file = typeof target === "string" ? files.get(linkedPath(target)) : undefined;
      if (!file) return [child];
      if (child.tagName === "a") return [fileLink(file, child.children ?? [], false)];
      const alt = child.properties?.alt;
      return [file.image ? picture(file) : fileLink(file, [text((typeof alt === "string" && alt) || file.name)], false)];
    }
    linkFiles(child, files);
    return [child];
  });
}

const pictureLink = (n: HastNode) => (n.tagName === "a" && n.data?.gmFile?.image ? n.data.gmFile : null);

/** The picture a paragraph or list item names with nothing said around it. */
function solePicture(n: HastNode): ChatFile | null {
  const [child, ...rest] = content(n);
  if (!child || rest.length) return null;
  return pictureLink(child) ?? (["p", "strong", "em"].includes(child.tagName ?? "") ? solePicture(child) : null);
}

function showSolePictures(parent: HastNode, shown: Set<string>): void {
  for (const child of parent.children ?? []) {
    if (child.tagName === "ul" || child.tagName === "ol") {
      const items = content(child);
      const pictures = items.map(solePicture);
      const paths = new Set(pictures.map((f) => f?.path));
      // A list of nothing but pictures becomes a gallery. In any other list they stay links and are shown below it.
      const gallery = child.tagName === "ul" && pictures.every(Boolean) && paths.size === items.length && !pictures.some((f) => shown.has(f!.path));
      items.forEach((item, i) => {
        const file = pictures[i];
        if (!file) return showSolePictures(item, shown);
        if (!gallery) return;
        shown.add(file.path);
        item.children = [picture(file)];
      });
      continue;
    }
    const file = child.tagName === "p" ? solePicture(child) : null;
    if (file && !shown.has(file.path)) {
      shown.add(file.path);
      child.children = [picture(file)];
    } else showSolePictures(child, shown);
  }
}

function shownPictures(n: HastNode): string[] {
  return n.tagName === "img" && n.data?.gmFile ? [n.data.gmFile.path] : (n.children ?? []).flatMap(shownPictures);
}

function pictureLinks(n: HastNode): ChatFile[] {
  const file = pictureLink(n);
  return file ? [file] : (n.children ?? []).flatMap(pictureLinks);
}

/**
 * Rehype plugin: links the files and folders a message names, and shows its pictures — each once. One that stands
 * alone in a paragraph takes its place, a list of nothing but pictures becomes a gallery; one named within a sentence
 * or a mixed list stays a link there and is shown right below.
 */
export function rehypeLocalFiles(files: ReadonlyMap<string, ChatFile>) {
  return (tree: HastNode) => {
    linkFiles(tree, files);
    // Pictures the message shows itself (`![…](path)`) are not shown again.
    const shown = new Set(shownPictures(tree));
    showSolePictures(tree, shown);
    tree.children = (tree.children ?? []).flatMap((block): HastNode[] => {
      const below = pictureLinks(block).filter((f) => !shown.has(f.path) && !!shown.add(f.path));
      if (!below.length) return [block];
      const items = below.map((f): HastNode => ({ type: "element", tagName: "li", properties: {}, children: [picture(f)] }));
      return [block, { type: "element", tagName: "ul", properties: {}, children: items }];
    });
  };
}
