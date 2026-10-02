/**
 * How the files a message names get into its rendered Markdown. The transform is the desktop UI's, tested here because
 * the UI has no test runner of its own: it is plain tree code without React.
 */
import { describe, expect, test } from "bun:test";
import type { ChatFile } from "@godmode/shared";
import { rehypeLocalFiles, type HastNode } from "../../../apps/desktop/src/components/chat/local-file-tree";

const el = (tagName: string, children: (HastNode | string)[] = [], properties: Record<string, unknown> = {}): HastNode => ({
  type: "element",
  tagName,
  properties,
  children: children.map((c) => (typeof c === "string" ? { type: "text", value: c } : c)),
});
const code = (value: string) => el("code", [value]);
const root = (...children: HastNode[]): HastNode => ({ type: "root", children });

const file = (ref: string, path: string, kind: ChatFile["kind"] = "file"): ChatFile => ({
  ref,
  path,
  kind,
  name: path.split("/").pop()!,
  image: /\.png$/.test(path) ? `/api/files/image?path=${encodeURIComponent(path)}&v=1` : null,
});

function render(tree: HastNode, ...files: ChatFile[]): string {
  rehypeLocalFiles(new Map(files.map((f) => [f.ref, f])))(tree);
  return show(tree);
}

/** The tree as text: `{link:path|label}` for a file link, `{picture:path}` for a picture. */
function show(n: HastNode): string {
  if (n.type === "text") return n.value ?? "";
  const inner = (n.children ?? []).map(show).join("");
  const local = n.data?.gmFile;
  if (local) return n.tagName === "img" ? `{picture:${local.path}}` : `{${n.data?.gmChip ? "chip" : "link"}:${local.path}|${inner}}`;
  return n.type === "root" ? inner : `<${n.tagName}>${inner}</${n.tagName}>`;
}

const A = file("a.png", "/w/shots/a.png");
const B = file("b.png", "/w/shots/b.png");
const FOLDER = file("workspace/shots/", "/w/shots", "folder");
const PDF = file("report.pdf", "/w/report.pdf");

describe("files in a rendered message", () => {
  test("a list of nothing but pictures becomes a gallery, the folder a link", () => {
    const tree = root(el("p", ["The screenshots are in ", code("workspace/shots/"), ":"]), el("ul", ["\n", el("li", [code("a.png")]), "\n", el("li", [el("p", [el("strong", [code("b.png")])])]), "\n"]));
    expect(render(tree, FOLDER, A, B)).toBe("<p>The screenshots are in {chip:/w/shots|workspace/shots/}:</p><ul>\n<li>{picture:/w/shots/a.png}</li>\n<li>{picture:/w/shots/b.png}</li>\n</ul>");
  });

  test("a picture named in a sentence stays a link and is shown below, once", () => {
    const tree = root(el("p", ["Saved ", code("a.png"), " and ", code("report.pdf"), ". Again: ", code("a.png")]), el("p", ["Also ", code("a.png"), "."]));
    expect(render(tree, A, PDF)).toBe(
      "<p>Saved {chip:/w/shots/a.png|a.png} and {chip:/w/report.pdf|report.pdf}. Again: {chip:/w/shots/a.png|a.png}</p><ul><li>{picture:/w/shots/a.png}</li></ul><p>Also {chip:/w/shots/a.png|a.png}.</p>",
    );
  });

  test("in a mixed or numbered list pictures stay links, shown below the list", () => {
    const mixed = root(el("ul", [el("li", [code("a.png")]), el("li", [code("b.png"), " — the total"])]));
    expect(render(mixed, A, B)).toBe("<ul><li>{chip:/w/shots/a.png|a.png}</li><li>{chip:/w/shots/b.png|b.png} — the total</li></ul><ul><li>{picture:/w/shots/a.png}</li><li>{picture:/w/shots/b.png}</li></ul>");
    const numbered = root(el("ol", [el("li", [code("a.png")]), el("li", [code("b.png")])]));
    expect(render(numbered, A, B)).toBe("<ol><li>{chip:/w/shots/a.png|a.png}</li><li>{chip:/w/shots/b.png|b.png}</li></ol><ul><li>{picture:/w/shots/a.png}</li><li>{picture:/w/shots/b.png}</li></ul>");
    // The same picture twice is no gallery either.
    const twice = root(el("ul", [el("li", [code("a.png")]), el("li", [code("a.png")])]));
    expect(render(twice, A)).toBe("<ul><li>{chip:/w/shots/a.png|a.png}</li><li>{chip:/w/shots/a.png|a.png}</li></ul><ul><li>{picture:/w/shots/a.png}</li></ul>");
  });

  test("a picture alone in a paragraph takes its place; one the message shows itself isn't shown again", () => {
    expect(render(root(el("p", [code("a.png")]), el("p", ["See ", code("a.png")])), A)).toBe("<p>{picture:/w/shots/a.png}</p><p>See {chip:/w/shots/a.png|a.png}</p>");
    const image = root(el("p", [el("img", [], { src: "workspace/shots/a%20b.png", alt: "shot" })]), el("p", ["Saved as ", code("a b.png"), "."]));
    const spaced = [file("workspace/shots/a b.png", "/w/shots/a b.png"), file("a b.png", "/w/shots/a b.png")];
    expect(render(image, ...spaced)).toBe("<p>{picture:/w/shots/a b.png}</p><p>Saved as {chip:/w/shots/a b.png|a b.png}.</p>");
  });

  test("links, images of other files and bare paths", () => {
    const tree = root(
      el("p", [el("a", ["the ", el("em", ["report"])], { href: "report.pdf" }), " ", el("img", [], { src: "report.pdf", alt: "as image" }), " at /w/report.pdf, not /w/gone.pdf."]),
      el("table", [el("tr", [el("td", [code("a.png")])])]),
    );
    expect(render(tree, PDF, file("/w/report.pdf", "/w/report.pdf"), A)).toBe(
      "<p>{link:/w/report.pdf|the <em>report</em>} {link:/w/report.pdf|as image} at {chip:/w/report.pdf|/w/report.pdf}, not /w/gone.pdf.</p><table><tr><td>{chip:/w/shots/a.png|a.png}</td></tr></table><ul><li>{picture:/w/shots/a.png}</li></ul>",
    );
  });

  test("code blocks, other links and unknown names stay as they are", () => {
    const tree = root(el("pre", [code("a.png")]), el("p", [el("a", [code("a.png")], { href: "https://example.com/a.png" }), " ", code("missing.png"), " ", code(" a.png ")]));
    expect(render(tree, A)).toBe("<pre><code>a.png</code></pre><p><a><code>a.png</code></a> <code>missing.png</code> {chip:/w/shots/a.png| a.png }</p><ul><li>{picture:/w/shots/a.png}</li></ul>");
  });
});
