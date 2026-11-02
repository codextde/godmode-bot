import { describe, expect, test } from "bun:test";
import { ARTIFACT_KIT_DOC, ARTIFACT_KIT_JS, checkSpec, specDocument, standaloneDocument } from "@godmode/shared";

describe("artifact kit", () => {
  test("the kit is valid script and small enough to go into every artifact", () => {
    expect(() => new Function(ARTIFACT_KIT_JS)).not.toThrow();
    expect(ARTIFACT_KIT_JS.length).toBeLessThan(40_000);
    expect(ARTIFACT_KIT_DOC).toContain("$.");
  });

  test("a spec page keeps its spec as indented JSON the agent can edit line by line", () => {
    const html = specDocument({ type: "page", title: "A </script> B", children: [{ type: "kpi", label: "Revenue", value: "$.total" }] }, "Sales");
    expect(html).toContain('<div id="gm-root"></div>');
    expect(html).toContain('\n   "label": "Revenue",');
    expect(html).not.toContain("A </script> B");
    expect(standaloneDocument(html, { total: 1 }, "light")).toContain("window.gm");
  });

  test("attached files get a base URL in the frame, travel inside a download, and the gallery is a known node", () => {
    const list = [{ name: "a b.png", mime: "image/png", kind: "image" as const, size: 1, updatedAt: "" }];
    const live = standaloneDocument("<p>x</p>", null, "light", { base: "http://127.0.0.1:4000/api/artifact-files/k/", list });
    expect(live).toContain('<base target="_blank" href="http://127.0.0.1:4000/api/artifact-files/k/">');
    expect(live).toContain("img-src https: data: blob: http://127.0.0.1:4000;");
    const gone = standaloneDocument("<p>x</p>", null, "light", { base: null, list, inline: { "a b.png": "data:image/png;base64,AA" } });
    expect(gone).not.toContain("<base target=\"_blank\" href");
    expect(gone).toContain("data:image/png;base64,AA");
    expect(checkSpec({ type: "page", children: [{ type: "gallery", review: true }, { type: "image", file: "a.png" }] })).toBeNull();
    expect(() => new Function(ARTIFACT_KIT_JS)).not.toThrow();
  });

  test("checkSpec names what is wrong", () => {
    expect(checkSpec({ type: "page", children: [] })).toBeNull();
    expect(checkSpec("page")).not.toBeNull();
    expect(checkSpec({ title: "x" })).not.toBeNull();
    expect(checkSpec({ type: "nope" })).not.toBeNull();
    expect(checkSpec({ type: "page", children: {} })).not.toBeNull();
  });
});
