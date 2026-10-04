/**
 * `GET /d/<id>/…`: the Godmode dashboard for one computer. The cloud serves its own trusted copy of the dashboard
 * build; the page learns which computer it shows from a meta tag, and only its API calls and its WebSocket travel
 * through the link.
 */
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { CLOUD_BROWSER_PREFIX, CLOUD_UI_META, type CloudUiContext } from "@godmode/shared";
import { sessionCookieName, sessionCookieOptions } from "@/server/auth/sessions";
import { config } from "@/server/config";
import { getDeviceForUser } from "@/server/devices";
import { sessionFromHeaders } from "./access";

let cached: { file: string; mtimeMs: number; html: string; uiVersion: string } | null = null;

async function readVersion(uiDir: string): Promise<string> {
  // The image copies apps/desktop's version next to the build; in development the build sits in apps/desktop.
  for (const file of [path.join(uiDir, "version.json"), path.join(uiDir, "..", "package.json")]) {
    try {
      const value = (JSON.parse(await readFile(file, "utf8")) as { version?: unknown }).version;
      if (typeof value === "string" && value) return value;
    } catch {
      // try the next one
    }
  }
  return "unknown";
}

/** index.html of the build, re-read when it changes; null when there is no usable build. */
async function loadIndex(): Promise<{ html: string; uiVersion: string } | null> {
  const uiDir = config().uiDir;
  const file = path.join(uiDir, "index.html");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached;
  const html = await readFile(file, "utf8");
  // Without the marker the meta tag would be missing and the UI would run in local mode on the cloud's origin.
  if (!html.includes("<head>")) return null;
  cached = { file, mtimeMs, html, uiVersion: await readVersion(uiDir) };
  return cached;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function dashboardCsp(publicUrl: string): string {
  const ui = `${publicUrl}/ui/`;
  const socket = publicUrl.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    `script-src ${ui} 'wasm-unsafe-eval'`,
    `style-src ${ui} 'unsafe-inline'`,
    `font-src ${ui} data:`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data:",
    `connect-src 'self' ${socket}`,
    `manifest-src ${ui}`,
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const MISSING_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard missing</title></head>
<body style="margin:0;min-height:100svh;display:grid;place-items:center;padding:16px;background:#faf9f5;color:#1c1c1c;font:15px/1.5 system-ui,sans-serif">
<main style="max-width:30rem">
<h1 style="font-size:20px;font-weight:500;margin:0 0 8px">The dashboard build is missing</h1>
<p>This cloud has no copy of the Godmode dashboard to show. Whoever runs it can build it with <code>pnpm --filter @godmode/desktop build:cloud</code> and restart the cloud.</p>
<p><a href="/devices" style="color:inherit">Back to your computers</a></p>
</main>
</body>
</html>
`;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end();
}

function cookieHeader(token: string, expires: Date): string {
  const options = sessionCookieOptions(expires);
  const parts = [`${sessionCookieName()}=${token}`, `Path=${options.path}`, `Expires=${options.expires.toUTCString()}`, "HttpOnly", "SameSite=Lax"];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export async function serveDashboard(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", ...PAGE_HEADERS });
    res.end("Method not allowed.");
    return;
  }
  const here = req.url ?? `${CLOUD_BROWSER_PREFIX}/${deviceId}/`;
  const session = await sessionFromHeaders(req.headers);
  if (!session) return redirect(res, `/login?next=${encodeURIComponent(here)}`);
  const access = await getDeviceForUser(deviceId, session.ctx.user.id);
  if (!access) return redirect(res, "/devices?denied=1");

  const cookies = session.ctx.renewed ? { "set-cookie": cookieHeader(session.token, session.ctx.session.expiresAt) } : {};
  const page = await loadIndex();
  if (!page) {
    res.writeHead(503, {
      ...PAGE_HEADERS,
      ...cookies,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : MISSING_PAGE);
    return;
  }

  const base = `${CLOUD_BROWSER_PREFIX}/${deviceId}`;
  const context: CloudUiContext = {
    deviceId,
    deviceName: access.device.name,
    base,
    home: "/devices",
    login: "/login",
    billing: "/billing",
    role: access.role,
    uiVersion: page.uiVersion,
  };
  const meta = `<meta name="${CLOUD_UI_META}" content="${escapeHtml(JSON.stringify(context))}">`;
  // A function, so "$&" and friends in a computer's name are not replacement patterns.
  const html = page.html.replace("<head>", () => `<head>${meta}`);
  res.writeHead(200, {
    ...PAGE_HEADERS,
    ...cookies,
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "content-security-policy": dashboardCsp(config().publicUrl),
  });
  res.end(req.method === "HEAD" ? undefined : html);
}
