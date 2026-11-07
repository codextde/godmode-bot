import { describe, expect, test } from "bun:test";
import { pdfViewerPage } from "./pdf-viewer-page";

const page = pdfViewerPage({ nonce: "n0nce", background: "#111111", surface: "#222222", bottom: 24 });
const policy = /Content-Security-Policy" content="([^"]+)"/.exec(page)![1]!;

describe("the Android PDF page", () => {
  test("reaches nothing outside itself", () => {
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/https?:|\*|'unsafe-inline'|'unsafe-eval'|connect-src/);
  });

  test("runs only its own script, with the nonce it was given", () => {
    expect(policy).toContain("script-src 'nonce-n0nce' blob: 'wasm-unsafe-eval'");
    expect(page.match(/<script /g)).toHaveLength(1);
    expect(page).toContain('<script nonce="n0nce">');
  });

  test("keeps room for the navigation bar and allows pinching", () => {
    expect(page).toContain("padding: 8px 8px 32px");
    expect(page).toContain("maximum-scale=6");
    expect(page).not.toContain("user-scalable=no");
  });
});
