/**
 * `/ui/*`: static files of the Godmode dashboard build (config().uiDir). Only assets are public; the page itself is
 * served per computer by ui.ts with the cloud context and its CSP, so `/ui/` and `/ui/index.html` are 404.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "@/server/config";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end("Not found.");
}

/** The file inside the build for `/ui/<rest>`, or null for anything that is not a plain path below it. */
async function resolveFile(rest: string): Promise<{ file: string; size: number; mtime: Date } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded === "index.html" || decoded.includes("\0") || decoded.includes("\\")) return null;
  // No empty, "." or ".." segments and no dotfiles: only what a build puts there.
  if (decoded.split("/").some((segment) => segment === "" || segment.startsWith("."))) return null;
  const root = path.resolve(config().uiDir);
  const file = path.resolve(root, decoded);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const [info, realRoot, realFile] = await Promise.all([stat(file), realpath(root), realpath(file)]);
    if (!info.isFile() || !realFile.startsWith(realRoot + path.sep)) return null;
    return { file: realFile, size: info.size, mtime: info.mtime };
  } catch {
    return null;
  }
}

export async function serveUiFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end("Method not allowed.");
    return;
  }
  const found = pathname.startsWith("/ui/") ? await resolveFile(pathname.slice(4)) : null;
  if (!found) return notFound(res);

  const lastModified = new Date(Math.floor(found.mtime.getTime() / 1000) * 1000);
  const headers: Record<string, string> = {
    "content-type": TYPES[path.extname(found.file).toLowerCase()] ?? "application/octet-stream",
    // Vite puts a content hash into every name under assets/; everything else may change with a new build.
    "cache-control": pathname.startsWith("/ui/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "last-modified": lastModified.toUTCString(),
    "x-content-type-options": "nosniff",
  };
  const since = Date.parse(req.headers["if-modified-since"] ?? "");
  if (!Number.isNaN(since) && since >= lastModified.getTime()) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-length": String(found.size) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(found.file), res);
  } catch {
    res.destroy();
  }
}
