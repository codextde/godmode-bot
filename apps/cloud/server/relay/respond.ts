/** Answers the custom server writes itself: JSON errors, refused upgrades, and the headers every relayed answer gets. */
import { STATUS_CODES, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Set (overwriting) on everything relayed from a computer and on the relay's own answers: the computer answers on
 * the cloud's origin, so nothing it sends may be sniffed, rendered as a document or embedded elsewhere.
 */
export const RELAY_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

/** Why the relay refuses a request, in the `{ error, code }` shape the core uses. */
export interface Denial {
  status: number;
  code: string;
  error: string;
  retryAfterMs?: number;
}

export function denial(status: number, code: string, error: string, retryAfterMs?: number): Denial {
  return { status, code, error, retryAfterMs };
}

function retryAfter(ms: number | undefined): Record<string, string> {
  return ms ? { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) } : {};
}

/** Writes a complete JSON answer but leaves ending it to the caller; false (and destroyed) when too late for that. */
export function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): boolean {
  if (res.headersSent) {
    res.destroy();
    return false;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...RELAY_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(data)),
    "cache-control": "no-store",
    ...headers,
  });
  if (res.req.method !== "HEAD") res.write(data);
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (writeJson(res, status, body, headers)) res.end();
}

export function writeDenial(res: ServerResponse, d: Denial, headers: Record<string, string> = {}): boolean {
  return writeJson(res, d.status, { error: d.error, code: d.code }, { ...retryAfter(d.retryAfterMs), ...headers });
}

export function sendDenial(res: ServerResponse, d: Denial, headers: Record<string, string> = {}): void {
  if (writeDenial(res, d, headers)) res.end();
}

/** Answers an upgrade request that will not become a WebSocket, then drops the connection. */
export function rejectUpgrade(socket: Duplex, d: Denial): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: d.error, code: d.code });
  const lines = [
    `HTTP/1.1 ${d.status} ${STATUS_CODES[d.status] ?? "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Cache-Control: no-store",
    "Connection: close",
    ...Object.entries(retryAfter(d.retryAfterMs)).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.once("finish", () => socket.destroy());
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

/** Cuts a WebSocket close reason to `max` UTF-8 bytes without splitting a character (ws throws above 123). */
export function truncateUtf8(text: string, max = 123): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}
