import type { Context } from "hono";
import { ARTIFACT_FILES_PATH } from "@godmode/shared";

/**
 * The page artifacts run in (see services/artifacts.ts). It holds no data and needs no sign-in: the app posts the
 * document into it and it writes it into itself. Its own policy makes it a sandbox with an opaque origin (no cookies,
 * no access to Godmode's API: connect-src is https only), while scripts and styles may come from public CDNs. The
 * app's own policy can't host it as srcdoc: a srcdoc frame inherits the app's strict script-src.
 */
const framePolicy = (filesFrom: string) => [
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:",
  "style-src 'unsafe-inline' https:",
  `img-src https: data: blob: ${filesFrom}`,
  "font-src https: data:",
  "connect-src https: wss:",
  `media-src https: data: blob: ${filesFrom}`,
  "worker-src blob:",
  "frame-src https:",
  "form-action 'none'",
].join("; ");

export const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>
(function () {
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.type !== "gm:load" || typeof m.doc !== "string") return;
    document.open();
    document.write(m.doc);
    document.close();
  });
  window.parent.postMessage({ type: "gm:shell" }, "*");
})();
</script></head><body></body></html>`;

/** The one thing of the core's the frame may load: an artifact's attached files, as pictures and media, never by fetch. */
export function serveArtifactFrame(c: Context) {
  const filesFrom = `${new URL(c.req.url).origin}${ARTIFACT_FILES_PATH}/`;
  return c.body(FRAME_HTML, 200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": framePolicy(filesFrom),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}
