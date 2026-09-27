import { existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import type { Context } from "hono";
import { config } from "../config";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; connect-src 'self' ws: wss: https://api.openai.com https://api.elevenlabs.io; media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'self'";

/** Map of embedded UI files (compiled binary), keyed by relative path. */
let embedded: Map<string, Blob> | null = null;

async function loadEmbedded(): Promise<Map<string, Blob>> {
  if (embedded) return embedded;
  embedded = new Map();
  try {
    const { embeddedFiles } = await import("bun");
    for (const file of embeddedFiles as Blob[]) {
      const name = (file as Blob & { name?: string }).name;
      if (!name) continue;
      // assets are embedded as ui/<path>
      const idx = name.indexOf("ui/");
      if (idx >= 0) embedded.set(name.slice(idx + 3), file);
    }
  } catch {
    /* not compiled */
  }
  return embedded;
}

function withHeaders(res: Response, path: string): Response {
  const headers = new Headers(res.headers);
  headers.set("content-type", MIME[extname(path)] ?? "application/octet-stream");
  if (path.endsWith(".html")) {
    headers.set("content-security-policy", CSP);
    headers.set("cache-control", "no-cache");
  } else if (path.includes("/assets/")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(res.body, { status: res.status, headers });
}

export async function serveStatic(c: Context) {
  const cfg = config();
  const reqPath = decodeURIComponent(new URL(c.req.url).pathname);
  const rel = normalize(reqPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "") || "index.html";

  if (cfg.uiDir && existsSync(cfg.uiDir)) {
    let file = join(cfg.uiDir, rel);
    if (!file.startsWith(cfg.uiDir)) return c.text("Forbidden", 403);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(cfg.uiDir, "index.html");
    if (!existsSync(file)) return c.text("UI not built", 404);
    return withHeaders(new Response(Bun.file(file)), file);
  }

  const files = await loadEmbedded();
  if (files.size > 0) {
    const blob = files.get(rel) ?? files.get("index.html");
    const name = files.has(rel) ? rel : "index.html";
    if (blob) return withHeaders(new Response(blob), "/" + name);
  }

  return c.html(
    `<!doctype html><html><head><title>Godmode Bot</title></head><body style="font-family:system-ui;background:#0a0a0f;color:#eee;display:grid;place-items:center;height:100vh"><div><h1>⚡ Godmode Bot core is running</h1><p>The web dashboard is not bundled in this build. Run <code>pnpm build</code> or start the desktop app.</p></div></body></html>`,
  );
}
