import { describe, expect, test } from "bun:test";
import { artifactDocument, policyFirstDocument, standaloneDocument, webViewDocument } from "@godmode/shared";

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

describe("every artifact document", () => {
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

  test("the download and the desktop's frame put the page behind their policy and bridge too", () => {
    const html = `<title><head></title><script>pageCode()</script><html class="h-full"><body>hi</body></html>`;
    for (const doc of [standaloneDocument(html, null, "dark"), artifactDocument(html, "<script>bridge()</script>")]) {
      const page = doc.indexOf("<title><head>");
      expect(doc.startsWith(`<!doctype html><html><head><meta charset="utf-8">`)).toBe(true);
      expect(doc.indexOf(`classList.add(...["h-full"])`)).toBeLessThan(page);
      expect(doc.slice(0, page)).not.toContain("pageCode()");
    }
    const download = standaloneDocument(html, null, "dark");
    expect(download.indexOf(`http-equiv="Content-Security-Policy"`)).toBeLessThan(download.indexOf("window.godmode=g"));
    expect(download).toContain(`name="viewport"`);
  });

  test("a page full of openings that never close is looked at in one pass", () => {
    for (const html of ["<!--".repeat(50_000), "<script ".repeat(30_000), "<html ".repeat(40_000), "<!--x-->".repeat(30_000) + "<script></script>".repeat(10_000)]) {
      const started = performance.now();
      policyFirstDocument(html, POLICY);
      webViewDocument(html, "tok", null, "dark");
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("what is in a comment or a script, closed or not, makes no page of a fragment", () => {
    for (const html of ["<!-- <body> --><p>hi</p>", "<!-- <body> <p>hi</p>", "<script>'<html>'</script><p>hi</p>", "<SCRIPT>'<head>'</SCRIPT ><p>hi</p>", "<script>'<html>'"]) {
      expect(policyFirstDocument(html, POLICY)).toContain(`</head><body>${html}`);
    }
    for (const html of ["<!-- x --><HEAD></HEAD>", "<scripty><body>", "<script>a</script>\n<body class=\"x\">"]) {
      expect(policyFirstDocument(html, POLICY)).toBe(`${OPEN}</head>${html}`);
    }
  });

  test("only plain classes are carried over: nothing a page can break out of", () => {
    const doc = webViewDocument(`<html class="a');alert(1)//"><body>hi</body></html>`, "tok", null, "light");
    expect(doc).not.toContain("classList.add(...");
    expect(webViewDocument(`<title><html class="x"></title>`, "tok", null, "light")).toContain(`classList.add(...["x"])`);
  });
});
