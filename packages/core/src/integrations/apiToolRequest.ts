/**
 * Requests to an API tool on an agent's behalf (`api_tool_request`) and the key check behind "Test".
 *
 * Godmode adds the key itself, only to URLs under the tool's address (redirects elsewhere aren't followed), and masks
 * it in everything returned. Files go both ways: `{ "$file": path }` sends a file (base64 in JSON, an upload in a form,
 * or the raw body), and files in the response (binary bodies, base64 or data URLs in JSON) are saved to disk so the
 * agent gets paths instead of megabytes of base64. Both only reach the folders the run itself may use.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ApiTool, ApiToolTestResult } from "@godmode/shared";
import { badRequest, HttpError, slugify } from "../util";
import { redact } from "../vault/vault";
import { resolveApiUrl } from "./apiTools";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type Method = (typeof METHODS)[number];

export interface FileRef {
  $file: string;
  /** How a file inside `json` is written: plain base64 (default) or a `data:` URL. */
  as?: "base64" | "dataUrl";
  filename?: string;
  type?: string;
}

export interface ApiCall {
  method?: Method;
  path?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string | FileRef;
  form?: Record<string, string | FileRef>;
  saveAs?: string;
  timeoutSeconds?: number;
}

export interface CallPlaces {
  /** Folders `$file` may read from and `saveAs` may write to. */
  roots: string[];
  /** Relative `$file` / `saveAs` paths start here. */
  cwd: string;
  /** Where response files go when `saveAs` doesn't say. */
  outputDir: string;
}

export interface SavedFile {
  path: string;
  type: string;
  bytes: number;
}

export interface ApiCallResult {
  ok: boolean;
  status: number | null;
  text: string;
  files: SavedFile[];
}

const MAX_INPUT_FILE = 50 * 1024 * 1024;
const MAX_INPUT_TOTAL = 100 * 1024 * 1024;
const MAX_RESPONSE = 200 * 1024 * 1024;
const MAX_INLINE = 60_000;
const MAX_ERROR_INLINE = 8_000;
/** Base64 strings this long in JSON are decoded and saved when they are a recognizable file (or huge). */
const MIN_BLOB_CHARS = 700;
const OPAQUE_BLOB_CHARS = 64 * 1024;
const MAX_REDIRECTS = 5;
const DROP_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization"]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MASK = "••••••••";

/* ------------------------------------------------------------------ */
/* File types                                                           */
/* ------------------------------------------------------------------ */

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/l16": "pcm",
  "audio/pcm": "pcm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/html": "html",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
};

const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE)
    .filter(([type]) => !["image/jpg", "audio/mp3", "audio/wave", "audio/x-wav", "audio/l16", "text/xml"].includes(type))
    .map(([type, ext]) => [ext, type]),
);
TYPE_BY_EXT.jpeg = "image/jpeg";

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** File type from the first bytes, or null. */
export function sniffType(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
    const kind = ascii(b, 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (ascii(b, 0, 4) === "%PDF") return "application/pdf";
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand.startsWith("avif")) return "image/avif";
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return "image/heic";
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(b, 0, 4) === "PK\x03\x04") return "application/zip";
  if ((ascii(b, 0, 4) === "II*\0") || ascii(b, 0, 4) === "MM\0*") return "image/tiff";
  if (ascii(b, 0, 2) === "BM" && b.length > 26) return "image/bmp";
  return null;
}

function mimeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    /^application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|graphql|yaml|x-yaml)$/.test(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function isJsonType(mime: string): boolean {
  return mime === "application/json" || mime.endsWith("+json");
}

function looksLikeText(b: Uint8Array): boolean {
  const head = b.subarray(0, 4096);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length < b.length ? head.subarray(0, Math.max(0, head.length - 4)) : head);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Paths                                                                */
/* ------------------------------------------------------------------ */

function realRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(realpathSync(root));
    } catch {
      /* missing folder */
    }
  }
  return out;
}

function within(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
}

function outsideMessage(path: string): string {
  return `${path} is outside the folders you can use in this run (your repository, the chat's folder, the workspace's folders and the VM's shared folder).`;
}

/** The most specific root `real` lies in, or null. */
function rootOf(real: string, roots: string[]): string | null {
  return roots.filter((root) => within(real, [root])).sort((a, b) => b.length - a.length)[0] ?? null;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function readInputFile(ref: string, places: CallPlaces, budget: { left: number }): { bytes: Uint8Array<ArrayBuffer>; name: string; type: string } {
  if (typeof ref !== "string" || !ref.trim()) throw badRequest("$file needs a path");
  const path = resolve(places.cwd, ref.trim());
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw badRequest(`File not found: ${path}`);
  }
  if (!within(real, realRoots(places.roots))) throw new HttpError(403, outsideMessage(path), "forbidden");
  const fd = openSync(real, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw badRequest(`${path} is not a file`);
    if (stat.size > MAX_INPUT_FILE) throw badRequest(`${path} is larger than ${formatBytes(MAX_INPUT_FILE)}`);
    if (stat.size > budget.left) throw badRequest(`The files of one request may add up to ${formatBytes(MAX_INPUT_TOTAL)}`);
    budget.left -= stat.size;
    const bytes = new Uint8Array(readFileSync(fd));
    const ext = extname(real).slice(1).toLowerCase();
    return { bytes, name: basename(real), type: TYPE_BY_EXT[ext] ?? sniffType(bytes) ?? "application/octet-stream" };
  } finally {
    closeSync(fd);
  }
}

function isFileRef(v: unknown): v is FileRef {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as FileRef).$file === "string";
}

function substituteFiles(value: unknown, places: CallPlaces, budget: { left: number }, depth = 0): unknown {
  if (depth > 64) throw badRequest("json is nested too deeply");
  if (isFileRef(value)) {
    const file = readInputFile(value.$file, places, budget);
    const b64 = Buffer.from(file.bytes).toString("base64");
    return value.as === "dataUrl" ? `data:${value.type ?? file.type};base64,${b64}` : b64;
  }
  if (Array.isArray(value)) return value.map((v) => substituteFiles(v, places, budget, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteFiles(v, places, budget, depth + 1)]));
  }
  return value;
}

function saveAsTarget(places: CallPlaces, saveAs: string): { target: string; folder: boolean } {
  const target = resolve(places.cwd, saveAs.trim());
  return { target, folder: /[\\/]$/.test(saveAs) || (existsSync(target) && statSync(target).isDirectory()) };
}

/** Where a response file is written: `saveAs` (a file, or a folder ending in / or existing), else the output folder. */
function targetPath(places: CallPlaces, saveAs: string | undefined, tool: ApiTool, type: string, index: number, suggested: string | null): { path: string; overwrite: boolean } {
  const ext = EXT_BY_TYPE[type] ?? (suggested ? extname(suggested).slice(1) : "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const generated = suggested ? suggested : `${slugify(tool.name) || "api"}-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext || "bin"}`;
  if (!saveAs?.trim()) return { path: uniquePath(join(places.outputDir, generated)), overwrite: false };
  const { target, folder } = saveAsTarget(places, saveAs);
  if (folder) return { path: uniquePath(join(target, generated)), overwrite: false };
  const own = extname(target) ? target : `${target}.${ext || "bin"}`;
  return index === 0 ? { path: own, overwrite: true } : { path: uniquePath(own.replace(/(\.[^./\\]+)?$/, (m) => `-${index + 1}${m}`)), overwrite: false };
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!existsSync(next)) return next;
  }
}

/**
 * The real path a response file may be written to: inside one of the run's folders (symlinks resolved) and not in a
 * hidden file or folder — .git, .claude and the like hold settings and hooks that run programs on this computer.
 */
function writablePath(path: string, places: CallPlaces): string {
  let probe = dirname(path);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, path));
  const root = rootOf(real, realRoots(places.roots));
  if (!root || real === root) throw new HttpError(403, outsideMessage(path), "forbidden");
  const hidden = relative(root, real).split(sep).find((part) => part.startsWith("."));
  if (hidden) throw new HttpError(403, `Files from responses can't go into hidden files or folders (${hidden}); pick another path.`, "forbidden");
  return real;
}

function writeOutput(path: string, bytes: Uint8Array, places: CallPlaces, overwrite: boolean): void {
  const target = writablePath(path, places);
  mkdirSync(dirname(target), { recursive: true });
  if (realpathSync(dirname(target)) !== dirname(target)) throw new HttpError(403, outsideMessage(path), "forbidden");
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new HttpError(403, `${path} is a link; pick another path.`, "forbidden");
  const flags = constants.O_WRONLY | constants.O_CREAT | (overwrite ? constants.O_TRUNC : constants.O_EXCL) | NOFOLLOW;
  const fd = openSync(target, flags, 0o644);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Refuse a `saveAs` that can't be used before anything is sent (and paid for). */
function checkSaveAs(places: CallPlaces, saveAs: string | undefined): void {
  if (!saveAs?.trim()) return;
  const { target, folder } = saveAsTarget(places, saveAs);
  writablePath(folder ? join(target, "file") : target, places);
}

/* ------------------------------------------------------------------ */
/* Request                                                              */
/* ------------------------------------------------------------------ */

function buildBody(call: ApiCall, places: CallPlaces, headers: Headers): BodyInit | undefined {
  const budget = { left: MAX_INPUT_TOTAL };
  const given = [call.json !== undefined, call.body !== undefined, call.form !== undefined].filter(Boolean).length;
  if (given > 1) throw badRequest("Send only one of json, body or form");
  if (!given) return undefined;
  const method = call.method ?? "GET";
  if (method === "GET" || method === "HEAD") throw badRequest(`A ${method} request has no body; use query for parameters`);
  if (call.json !== undefined) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return JSON.stringify(substituteFiles(call.json, places, budget));
  }
  if (call.form !== undefined) {
    headers.delete("content-type");
    const form = new FormData();
    for (const [name, value] of Object.entries(call.form)) {
      if (isFileRef(value)) {
        const file = readInputFile(value.$file, places, budget);
        form.append(name, new Blob([file.bytes], { type: value.type ?? file.type }), value.filename ?? file.name);
      } else form.append(name, String(value));
    }
    return form;
  }
  if (isFileRef(call.body)) {
    const file = readInputFile(call.body.$file, places, budget);
    if (!headers.has("content-type")) headers.set("content-type", call.body.type ?? file.type);
    return file.bytes;
  }
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return call.body as string;
}

function requestHeaders(tool: ApiTool, given: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(given ?? {})) {
    if (!HEADER_NAME_RE.test(name)) throw badRequest(`Invalid header name: ${name}`);
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw badRequest(`Invalid value for header ${name}`);
    const lower = name.toLowerCase();
    if (DROP_HEADERS.has(lower) || (tool.auth.in === "header" && lower === tool.auth.name.toLowerCase())) continue;
    headers.set(name, value);
  }
  return headers;
}

function addKey(tool: ApiTool, key: string | null, url: URL, headers: Headers): void {
  if (!key) return;
  if (tool.auth.in === "query") url.searchParams.set(tool.auth.name, key);
  else headers.set(tool.auth.name, `${tool.auth.prefix}${key}`);
}

function displayUrl(tool: ApiTool, url: URL): string {
  const shown = new URL(url);
  if (tool.auth.in === "query") shown.searchParams.delete(tool.auth.name);
  return shown.toString();
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (declared > MAX_RESPONSE) throw badRequest(`The response is larger than ${formatBytes(MAX_RESPONSE)}`);
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE) throw badRequest(`The response is larger than ${formatBytes(MAX_RESPONSE)}`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

interface Fetched {
  res: Response;
  url: URL;
  /** A redirect that wasn't followed because it leaves the tool's address. */
  leftAt: string | null;
  tooMany?: boolean;
}

/** fetch() that follows redirects only while they stay under the tool's address (the key never leaves it). */
async function fetchInside(tool: ApiTool, key: string | null, url: URL, init: { method: Method; headers: Headers; body?: BodyInit }, signal: AbortSignal): Promise<Fetched> {
  let current = url;
  let { method, body } = init;
  const headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const target = new URL(current);
    const sent = new Headers(headers);
    addKey(tool, key, target, sent);
    const res = await fetch(target, { method, headers: sent, body, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return { res, url: current, leftAt: null };
    let next: URL;
    try {
      next = resolveApiUrl(tool.baseUrl, new URL(location, current).toString());
    } catch {
      return { res, url: current, leftAt: new URL(location, current).toString() };
    }
    if (hop >= MAX_REDIRECTS) return { res, url: current, leftAt: null, tooMany: true };
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }
    current = next;
  }
}

function errorSummary(bytes: Uint8Array, mime: string): string {
  const text = new TextDecoder().decode(bytes.subarray(0, 64 * 1024)).trim();
  if (isJsonType(mime) || text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      const err = v.error as Record<string, unknown> | string | undefined;
      const msg =
        (typeof err === "string" ? err : typeof err?.message === "string" ? err.message : null) ??
        (typeof v.message === "string" ? v.message : null) ??
        (typeof v.detail === "string" ? v.detail : null);
      if (msg) return msg;
    } catch {
      /* not JSON */
    }
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/** Replace base64 files and data URLs in a JSON value by the paths they were saved to. */
function extractBlobs(value: unknown, save: (bytes: Uint8Array, type: string) => string, hint: string | null = null, depth = 0): unknown {
  if (depth > 64) return value;
  if (typeof value === "string") {
    if (value.length < MIN_BLOB_CHARS) return value;
    const dataUrl = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,/i.exec(value);
    const b64 = (dataUrl ? value.slice(dataUrl[0].length) : value).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return value;
    const bytes = new Uint8Array(Buffer.from(b64, /[-_]/.test(b64) ? "base64url" : "base64"));
    const type = mimeOf(dataUrl?.[1]) || sniffType(bytes) || (hint && !isTextual(hint) ? hint : null);
    if (!type && b64.length < OPAQUE_BLOB_CHARS) return value;
    return save(bytes, type ?? "application/octet-stream");
  }
  if (Array.isArray(value)) return value.map((v) => extractBlobs(v, save, null, depth + 1));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sibling = [obj.mimeType, obj.mime_type, obj.contentType, obj.content_type, obj.media_type, obj.mediaType].find((v) => typeof v === "string") as string | undefined;
    // A type field only describes the strings right next to it (e.g. inlineData.data), not nested ids or cursors.
    const own = sibling ? mimeOf(sibling) : null;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, extractBlobs(v, save, typeof v === "string" ? own : null, depth + 1)]));
  }
  return value;
}

function statusLine(res: Response): string {
  return `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

function suggestedName(res: Response): string | null {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  let raw = (m?.[1] ?? m?.[2] ?? "").trim();
  if (m?.[1]) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep it encoded */
    }
  }
  const name = basename(raw.replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").trim();
  return name && name !== "." && name !== ".." ? name.slice(0, 120) : null;
}

/**
 * Send one request for an agent. Never throws for HTTP errors (they come back with `ok: false`); throws HttpError for
 * requests that aren't allowed (outside the address, files outside the run's folders, bad arguments).
 */
export async function callApiTool(tool: ApiTool, key: string | null, call: ApiCall, places: CallPlaces): Promise<ApiCallResult> {
  if (!tool.baseUrl) {
    throw badRequest(
      tool.envVar
        ? `${tool.name} has no API address for requests through Godmode; use its key from $${tool.envVar} in a script instead.`
        : `${tool.name} has no API address; ask the human to add it under Integrations → Tools.`,
    );
  }
  const method = call.method ?? "GET";
  if (!METHODS.includes(method)) throw badRequest(`Unsupported method ${method}`);
  const url = resolveApiUrl(tool.baseUrl, call.path ?? "");
  for (const [name, value] of Object.entries(call.query ?? {})) {
    if (tool.auth.in === "query" && name === tool.auth.name) continue;
    url.searchParams.set(name, String(value));
  }
  const headers = requestHeaders(tool, call.headers);
  const body = buildBody(call, places, headers);
  checkSaveAs(places, call.saveAs);
  const timeout = Math.min(Math.max(call.timeoutSeconds ?? 180, 5), 600);
  const mask = masker(key);
  const shown = displayUrl(tool, url);
  const started = Date.now();

  let fetched: Fetched;
  let bytes: Uint8Array;
  try {
    fetched = await fetchInside(tool, key, url, { method, headers, body }, AbortSignal.timeout(timeout * 1000));
    bytes = await readCapped(fetched.res);
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? `no answer within ${timeout} s (pass timeoutSeconds for slow APIs)` : err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, files: [], text: mask(`${method} ${shown}\n→ failed: ${reason}`) };
  }
  const { res } = fetched;
  const mime = mimeOf(res.headers.get("content-type"));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const head = [`${method} ${displayUrl(tool, fetched.url)}`, `→ ${statusLine(res)} · ${seconds} s${mime ? ` · ${mime}` : ""} · ${formatBytes(bytes.byteLength)}`];
  if (fetched.leftAt) {
    head.push(`Redirected to ${mask(fetched.leftAt)} — not followed: it's outside this tool's API address and would get the key. If it's a download link, fetch it without the key (e.g. curl -L).`);
  }
  if (fetched.tooMany) head.push(`Stopped after ${MAX_REDIRECTS} redirects.`);

  const files: SavedFile[] = [];
  const notes: string[] = [];
  const keyBytes = key ? Buffer.from(key) : null;
  const save = (data: Uint8Array, type: string, opts: { suggested?: string | null; useSaveAs?: boolean } = {}): string => {
    if (keyBytes && Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(keyBytes)) {
      notes.push(`A ${type} file in the response contained the key, so it wasn't saved.`);
      return "[not saved: it contained the key]";
    }
    const { path, overwrite } = targetPath(places, opts.useSaveAs === false ? undefined : call.saveAs, tool, type, files.length, opts.suggested ?? null);
    writeOutput(path, data, places, overwrite);
    files.push({ path, type, bytes: data.byteLength });
    return path;
  };

  const ok = res.ok && !fetched.leftAt && !fetched.tooMany;
  let payload = "";
  if (!ok) {
    const detail = bytes.byteLength ? mask(new TextDecoder().decode(bytes.subarray(0, MAX_ERROR_INLINE + 2048))) : "";
    payload = detail.length > MAX_ERROR_INLINE ? `${detail.slice(0, MAX_ERROR_INLINE)}\n… (cut off)` : detail;
  } else if (method === "HEAD" || !bytes.byteLength) {
    payload = "";
  } else if (isJsonType(mime) || (isTextual(mime) && /^\s*[[{]/.test(new TextDecoder().decode(bytes.subarray(0, 64))))) {
    const text = new TextDecoder().decode(bytes);
    let pretty: string;
    try {
      const replaced = extractBlobs(JSON.parse(text), (data, type) => {
        const path = save(data, type);
        return path.startsWith("[") ? path : `[saved to ${path} — ${type}, ${formatBytes(data.byteLength)}]`;
      });
      pretty = JSON.stringify(replaced, null, 2);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      pretty = text;
    }
    payload = inline(mask(pretty), "application/json", save);
  } else if (isTextual(mime) || (!mime && looksLikeText(bytes))) {
    payload = inline(mask(new TextDecoder().decode(bytes)), mime || "text/plain", save);
  } else {
    const type = mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream" ? mime : (sniffType(bytes) ?? "application/octet-stream");
    save(bytes, type, { suggested: suggestedName(res) });
  }

  const out = [...head];
  if (files.length) out.push("", `Saved ${files.length === 1 ? "1 file" : `${files.length} files`}:`, ...files.map((f) => `- ${f.path} (${f.type}, ${formatBytes(f.bytes)})`));
  if (notes.length) out.push("", ...notes);
  if (payload) out.push("", payload);
  if (!ok && !fetched.leftAt && !fetched.tooMany) out.push("", hintFor(res.status, tool));
  return { ok, status: res.status, files, text: mask(out.join("\n").trimEnd()) };
}

/** Masks the key (also URL-encoded, as it appears in query strings) and every other known secret. */
function masker(key: string | null): (s: string) => string {
  const forms = key ? [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)])] : [];
  return (s: string) => redact(forms.reduce((text, form) => text.split(form).join(MASK), s));
}

/** Long text is cut for the agent; the whole (masked) text goes to a file in the output folder. */
function inline(text: string, type: string, save: (data: Uint8Array, type: string, opts?: { useSaveAs?: boolean }) => string): string {
  if (text.length <= MAX_INLINE) return text;
  const path = save(new TextEncoder().encode(text), type, { useSaveAs: false });
  return `${text.slice(0, MAX_INLINE)}\n… (cut off after ${MAX_INLINE.toLocaleString("en-US")} characters — the full response is in ${path})`;
}

function hintFor(status: number, tool: ApiTool): string {
  if (status === 401 || status === 403) {
    return tool.hasKey
      ? "The API refused the request. If it says the key is invalid or lacks permission, tell the human to check the key under Integrations → Tools."
      : `${tool.name} has no key saved. If the API needs one, tell the human to add it under Integrations → Tools.`;
  }
  if (status === 404) return "Not found — check the path and the model or resource name against the tool's documentation (api_tool_docs).";
  if (status === 429) return "Rate limited or out of quota — wait a bit before retrying, and tell the human if it persists.";
  if (status >= 500) return "The API had a problem on its side — retry once, then report it.";
  return "Check the request against the tool's documentation (api_tool_docs).";
}

/** GET the tool's test path with the key: does the API accept it? */
export async function testApiToolKey(tool: ApiTool, key: string | null): Promise<ApiToolTestResult> {
  if (!tool.baseUrl || !tool.testPath) return { ok: false, status: null, ms: 0, message: "This tool has no test path." };
  const started = Date.now();
  const mask = masker(key);
  try {
    const url = resolveApiUrl(tool.baseUrl, tool.testPath);
    const { res, leftAt } = await fetchInside(tool, key, url, { method: "GET", headers: new Headers({ accept: "application/json" }) }, AbortSignal.timeout(15_000));
    const bytes = await readCapped(res);
    const ms = Date.now() - started;
    if (leftAt) return { ok: false, status: res.status, ms, message: mask(`The API redirected to ${new URL(leftAt).host}, outside its address.`) };
    if (res.ok) return { ok: true, status: res.status, ms, message: `${statusLine(res)} in ${ms} ms` };
    const detail = errorSummary(bytes, mimeOf(res.headers.get("content-type")));
    const refused = res.status === 401 || res.status === 403 || (res.status === 400 && /api[\s_-]?key|token|credential/i.test(detail));
    const lead = refused ? (key ? "The API rejected the key" : "The API needs a key") : `HTTP ${statusLine(res)}`;
    return { ok: false, status: res.status, ms, message: mask(`${lead}${detail ? `: ${detail}` : ""}`) };
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof HttpError) return { ok: false, status: null, ms, message: err.message };
    const reason = err instanceof Error && err.name === "TimeoutError" ? "no answer within 15 s" : err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, ms, message: mask(`Couldn't reach ${new URL(tool.baseUrl).host}: ${reason}`) };
  }
}
