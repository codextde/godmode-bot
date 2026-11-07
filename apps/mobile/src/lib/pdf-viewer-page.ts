/** Where the viewer's page says it lives: never loaded, it gives the page a real origin for its blob: scripts. */
export const PDF_VIEWER_ORIGIN = "https://pdf.godmode.invalid/";

/**
 * The page that draws a PDF with pdf.js, for Android, whose web view has no PDF viewer. It starts empty: the app sends
 * pdf.js and the file through `window.__pdf.add`, and nothing reaches the network. Fingers zoom the page itself, so pinching
 * stays smooth; what is on screen is drawn again sharper when the fingers stop. Pages far from the screen give up their
 * canvas, so long files stay light.
 */
export function pdfViewerPage({ nonce, background, surface, bottom }: { nonce: string; background: string; surface: string; bottom: number }): string {
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob: 'wasm-unsafe-eval'`,
    "worker-src blob:",
    `style-src 'nonce-${nonce}'`,
    "img-src blob: data:",
    "font-src blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=6">
<style nonce="${nonce}">
html, body { margin: 0; background: ${background}; }
body { padding: 8px 8px ${8 + bottom}px; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; }
.page { width: 100%; margin-bottom: 8px; overflow: hidden; background: ${surface}; }
canvas { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="pages"></div>
<script nonce="${nonce}">${VIEWER}</script>
</body>
</html>`;
}

const VIEWER = String.raw`
(() => {
  const SHARP_PAGES = 1;
  const MAX_PIXELS = 9e6;
  const post = (message) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const root = document.getElementById("pages");
  const chunks = {};
  const pages = [];
  let doc = null;
  let current = 1;
  let drawing = false;
  let shown = false;

  const toBytes = (text) => {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  const unpack = (name) => new Response(new Blob(chunks[name]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const script = async (name) => URL.createObjectURL(new Blob([await unpack(name)], { type: "text/javascript" }));

  const dpr = () => window.devicePixelRatio || 1;
  const pinch = () => Math.max(1, window.visualViewport ? window.visualViewport.scale : 1);
  const sharpness = (p) => (Math.abs(p.n - current) <= SHARP_PAGES ? dpr() * pinch() : dpr());
  const target = (p) => {
    const size = p.size || pages[0].size;
    return Math.min((p.el.clientWidth / size.width) * sharpness(p), Math.sqrt(MAX_PIXELS / (size.width * size.height)));
  };

  const free = (p) => {
    const old = p.el.firstChild;
    if (old) {
      old.width = 0;
      old.remove();
    }
    p.scale = 0;
  };

  const draw = async (p) => {
    const page = await doc.getPage(p.n);
    const scale = target(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
    if (!p.near) {
      canvas.width = 0;
      return;
    }
    free(p);
    p.el.append(canvas);
    p.scale = scale;
    if (!shown) {
      shown = true;
      post({ type: "shown", pages: pages.length });
    }
  };

  const next = () => {
    let best = null;
    for (const p of pages) {
      if (!p.near || p.broken || p.scale >= target(p) * 0.9) continue;
      if (!best || Math.abs(p.n - current) < Math.abs(best.n - current)) best = p;
    }
    return best;
  };

  const pump = async () => {
    if (drawing || !doc) return;
    drawing = true;
    for (let p = next(); p; p = next()) {
      try {
        await draw(p);
      } catch {
        p.broken = true;
        if (p.n === 1) fail();
      }
    }
    drawing = false;
  };

  const track = () => {
    const view = window.visualViewport;
    const middle = view ? view.pageTop + view.height / 2 : window.scrollY + window.innerHeight / 2;
    let n = 1;
    for (const p of pages) {
      if (p.el.offsetTop > middle) break;
      n = p.n;
    }
    if (n === current) return;
    current = n;
    post({ type: "page", page: n, pages: pages.length });
    pump();
  };

  let tracking = false;
  const onScroll = () => {
    if (tracking) return;
    tracking = true;
    requestAnimationFrame(() => {
      tracking = false;
      track();
    });
  };
  let settling = null;
  const onResize = () => {
    clearTimeout(settling);
    settling = setTimeout(pump, 160);
  };

  const watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const p = pages[Number(entry.target.dataset.n) - 1];
        p.near = entry.isIntersecting;
        if (!p.near) free(p);
      }
      pump();
    },
    { rootMargin: "150% 0px" },
  );

  const measure = (p, page) => {
    const { width, height } = page.getViewport({ scale: 1 });
    p.size = { width, height };
    p.el.style.aspectRatio = width + " / " + height;
  };

  function fail(error) {
    post({ type: "failed", reason: error && error.name === "PasswordException" ? "password" : "broken" });
  }

  const open = async () => {
    const [lib, worker] = await Promise.all([script("lib"), script("worker")]);
    const wasm = {
      "jbig2.wasm": new Uint8Array(await unpack("jbig2.wasm")),
      "openjpeg.wasm": new Uint8Array(await unpack("openjpeg.wasm")),
    };
    const pdfjs = await import(lib);
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    class LocalData {
      async fetch({ filename }) {
        if (!wasm[filename]) throw new Error("Not bundled: " + filename);
        return wasm[filename];
      }
    }
    const data = new Uint8Array(await new Blob(chunks.pdf).arrayBuffer());
    for (const name of Object.keys(chunks)) delete chunks[name];
    doc = await pdfjs.getDocument({ data, BinaryDataFactory: LocalData }).promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.n = String(n);
      root.append(el);
      pages.push({ n, el, size: null, scale: 0, near: false, broken: false });
    }
    measure(pages[0], await doc.getPage(1));
    for (const p of pages) {
      if (!p.size) p.el.style.aspectRatio = pages[0].el.style.aspectRatio;
      watcher.observe(p.el);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("scroll", onScroll);
      window.visualViewport.addEventListener("resize", onResize);
    }
    for (const p of pages.slice(1)) measure(p, await doc.getPage(p.n));
  };

  window.__pdf = {
    add(name, text) {
      (chunks[name] = chunks[name] || []).push(toBytes(text));
      post({ type: "next" });
    },
    open() {
      open().catch(fail);
    },
  };
  post({ type: "hello" });
})();
`;
