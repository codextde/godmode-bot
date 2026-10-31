import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { HEX_LANGUAGES, HEX_MODELS, type HexLanguage, type HexStatus } from "@godmode/shared";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { badRequest, HttpError } from "../util";

const log = logger("hex");

const STARTUP_TIMEOUT_MS = 15_000;
const IDLE_STOP_MS = 15 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const MAX_WAV_BYTES = 64 * 1024 * 1024;

interface Endpoint {
  url: string;
  token: string;
}

interface Service {
  path: string;
  child: ChildProcessWithoutNullStreams;
  endpoint: Promise<Endpoint>;
  version: string | null;
}

let service: Service | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let preparing: { key: string; promise: Promise<void> } | null = null;
let progress: HexStatus["progress"] = null;
let lastError: string | null = null;
const warm = new Set<string>();

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bundleBinary(app: string): string | null {
  try {
    return readdirSync(join(app, "Contents", "MacOS")).includes("hex") ? join(app, "Contents", "MacOS", "hex") : null;
  } catch {
    return null;
  }
}

export function findHex(configured = getSettings().voice.hexPath): string | null {
  const custom = configured.trim();
  if (custom) {
    const inBundle = custom.endsWith(".app") ? bundleBinary(custom) : null;
    const path = inBundle ?? custom;
    return executable(path) ? path : null;
  }
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    for (const app of ["/Applications/Hex.app", join(homedir(), "Applications", "Hex.app")]) {
      const binary = bundleBinary(app);
      if (binary) candidates.push(binary);
    }
  }
  const name = process.platform === "win32" ? "hex.exe" : "hex";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, name));
  return candidates.find(executable) ?? null;
}

export function hexLanguage(tag: string | null | undefined): HexLanguage {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (HEX_LANGUAGES as readonly string[]).includes(primary ?? "") ? (primary as HexLanguage) : "en";
}

function hexModel(): string {
  const model = getSettings().voice.hexModel;
  return HEX_MODELS.some((m) => m.id === model) ? model : HEX_MODELS[0]!.id;
}

function readHandshake(child: ChildProcessWithoutNullStreams): Promise<Endpoint> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const finish = (result: Endpoint | Error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout.resume();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const newline = out.indexOf("\n");
      if (newline < 0) {
        if (out.length > 16_384) finish(new Error("Hex sent an invalid startup message"));
        return;
      }
      try {
        const ready = JSON.parse(out.slice(0, newline)) as { type?: unknown; url?: unknown; token?: unknown; apiVersion?: unknown };
        if (ready.apiVersion !== "2") return finish(new Error("This Hex version is not supported. Update Hex to version 3 or newer."));
        if (ready.type !== "ready" || typeof ready.url !== "string" || typeof ready.token !== "string") return finish(new Error("Hex sent an invalid startup message"));
        const url = new URL(ready.url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return finish(new Error("Hex reported an address outside this computer"));
        finish({ url: ready.url.replace(/\/+$/, ""), token: ready.token });
      } catch {
        finish(new Error("Hex sent an invalid startup message. Update Hex to version 3 or newer."));
      }
    };
    const onStderr = (chunk: Buffer) => {
      err = `${err}${chunk.toString("utf8")}`.slice(-4_000);
    };
    const onExit = (code: number | null) => {
      const detail = err.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop();
      finish(new Error(`Hex stopped while starting (${code ?? "signal"})${detail ? `: ${detail}` : ""}`));
    };
    const onError = (e: Error) => finish(new Error(`Could not start Hex: ${e.message}`));
    const timer = setTimeout(() => finish(new Error(`Hex did not start within ${STARTUP_TIMEOUT_MS / 1000} seconds`)), STARTUP_TIMEOUT_MS);
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function start(path: string): Service {
  const child = spawn(path, ["service", "--embedded"], { stdio: ["pipe", "pipe", "pipe"] });
  const started: Service = { path, child, endpoint: readHandshake(child), version: null };
  started.endpoint.catch(() => undefined);
  child.once("exit", (code) => {
    if (service === started) {
      service = null;
      warm.clear();
      log.info("hex service stopped", { code });
    }
  });
  log.info("hex service started", { path, pid: child.pid });
  return started;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stopHex(), IDLE_STOP_MS);
  idleTimer.unref?.();
}

async function connection(): Promise<Endpoint> {
  const path = findHex();
  if (!path) throw badRequest("Hex isn't installed. Install Hex from anoma.ly/hex or set its location in Settings → Voice.", { reason: "hex_missing" });
  if (service && service.path !== path) await stopHex();
  service ??= start(path);
  touch();
  try {
    return await service.endpoint;
  } catch (err) {
    await stopHex();
    throw new HttpError(502, err instanceof Error ? err.message : String(err), "hex_unavailable");
  }
}

export async function stopHex(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = service;
  service = null;
  warm.clear();
  if (!current || current.child.exitCode !== null) return;
  current.child.stdin.end();
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    current.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) current.child.kill("SIGKILL");
}

async function call(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const endpoint = await connection();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${endpoint.token}`);
  let res: Response;
  try {
    res = await fetch(`${endpoint.url}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new HttpError(502, aborted ? `Hex did not answer within ${timeoutMs / 1000} seconds` : "Could not reach Hex", "hex_unavailable");
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 300) || `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
    message = data.error?.message ?? message;
    code = data.error?.code;
  } catch {}
  if (code === "model-not-ready") throw badRequest("The Hex speech model isn't downloaded yet. Download it in Settings → Voice.", { reason: "hex_model_missing" });
  if (res.status === 429 || code === "busy") throw new HttpError(429, `Hex is busy: ${message}`, "hex_busy");
  throw new HttpError(res.status >= 500 ? 502 : 400, `Hex: ${message}`, "hex_error");
}

interface CatalogEntry {
  id: string;
  installed: boolean;
  downloadBytes: number | null;
}

async function catalog(language: HexLanguage): Promise<CatalogEntry[]> {
  const res = await call(`/models?${new URLSearchParams({ language })}`);
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) throw new HttpError(502, "Hex returned an invalid model list", "hex_error");
  return data.filter((m): m is CatalogEntry => !!m && typeof m === "object" && typeof (m as CatalogEntry).id === "string");
}

export async function hexStatus(): Promise<HexStatus> {
  const path = findHex();
  const model = hexModel();
  const base: HexStatus = { path, version: null, model, installed: false, downloadBytes: null, progress, error: lastError };
  if (!path) return base;
  try {
    const entry = (await catalog(hexLanguage(getSettings().voice.language))).find((m) => m.id === model);
    if (service && service.version === null) {
      const health = (await (await call("/health")).json().catch(() => null)) as { version?: unknown } | null;
      service.version = typeof health?.version === "string" ? health.version : null;
    }
    return { ...base, version: service?.version ?? null, installed: entry?.installed === true, downloadBytes: entry?.downloadBytes ?? null, error: lastError };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runPrepare(model: string, language: HexLanguage): Promise<void> {
  const res = await call(`/models/${encodeURIComponent(model)}/prepare?${new URLSearchParams({ language })}`, { method: "POST", signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.body) throw new HttpError(502, "Hex returned no progress", "hex_error");
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    touch();
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const step = JSON.parse(data) as { type?: string; downloadedBytes?: number; totalBytes?: number; error?: { message?: string } };
      if (step.type === "downloading") progress = { phase: "downloading", downloadedBytes: step.downloadedBytes ?? 0, totalBytes: step.totalBytes ?? 0 };
      else if (step.type === "verifying" || step.type === "loading") progress = { phase: step.type, downloadedBytes: 0, totalBytes: 0 };
      else if (step.type === "ok") done = true;
      else if (step.type === "error") throw new HttpError(502, `Hex could not prepare the model: ${step.error?.message ?? "unknown error"}`, "hex_error");
    }
  }
  if (!done) throw new HttpError(502, "Hex stopped preparing the model before it was ready", "hex_error");
  warm.add(`${model}:${language}`);
}

export function prepareHex(language: HexLanguage = hexLanguage(getSettings().voice.language), model = hexModel()): Promise<void> {
  const key = `${model}:${language}`;
  if (preparing?.key === key) return preparing.promise;
  lastError = null;
  progress = { phase: "starting", downloadedBytes: 0, totalBytes: 0 };
  const promise = runPrepare(model, language)
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("hex model preparation failed", { model, language, error: lastError });
      throw err;
    })
    .finally(() => {
      if (preparing?.promise === promise) preparing = null;
      progress = null;
    });
  preparing = { key, promise };
  return promise;
}

export async function transcribeWithHex(audio: Blob, opts: { language?: string | null } = {}): Promise<string> {
  if (audio.size > MAX_WAV_BYTES) throw new HttpError(413, "Recordings for Hex are limited to 64 MB", "too_large");
  const head = new Uint8Array(await audio.slice(0, 12).arrayBuffer());
  const riff = String.fromCharCode(...head.slice(0, 4)) === "RIFF" && String.fromCharCode(...head.slice(8, 12)) === "WAVE";
  if (!riff) throw badRequest("Hex needs the recording as WAV audio. Update Godmode and try again.");
  const language = hexLanguage(opts.language || getSettings().voice.language);
  const model = hexModel();
  if (!warm.has(`${model}:${language}`)) {
    const entry = (await catalog(language)).find((m) => m.id === model);
    if (!entry?.installed) throw badRequest("The Hex speech model isn't downloaded yet. Download it in Settings → Voice.", { reason: "hex_model_missing" });
    await prepareHex(language, model);
  }
  const body = await audio.arrayBuffer();
  const res = await call(
    `/transcriptions?${new URLSearchParams({ model, language })}`,
    { method: "POST", headers: { "content-type": "audio/wav", "content-length": String(body.byteLength) }, body },
    TRANSCRIBE_TIMEOUT_MS,
  );
  const data = (await res.json().catch(() => null)) as { transcript?: unknown } | null;
  if (!data || typeof data.transcript !== "string") throw new HttpError(502, "Hex returned an unexpected transcription", "hex_error");
  return data.transcript.trim();
}
