/**
 * Model catalog (owner: runner): the models the installed Claude Code offers in `/model`, read through the stream-json
 * `initialize` control request (no prompt, no API call). Cached in memory and on disk, refreshed in the background.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { ClaudeModel, Effort, ModelCatalog } from "@godmode/shared";
import { BUILTIN_MODELS, EFFORT_OPTIONS, effortForModel, findModel, isModelId } from "@godmode/shared";
import { config, ensureDir } from "../config";
import { bus } from "../events/bus";
import { logger } from "../log";
import { now } from "../util";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";

const log = logger("models");

const EXIT_GRACE_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const FRESH_MS = 15 * 60_000;
const RETRY_MS = 60_000;

interface RawModel {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
}

let cached: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;
let probeTimeoutMs = 20_000;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const posix = process.platform !== "win32";

function cacheFile(): string {
  return join(config().dataDir, "claude-models.json");
}

function efforts(levels: unknown): Effort[] {
  const reported = Array.isArray(levels) ? levels : EFFORT_OPTIONS;
  return EFFORT_OPTIONS.filter((e) => reported.includes(e));
}

/** Normalize the CLI's model list. "default" is dropped: in Godmode the default is the agent's model. */
export function parseModels(raw: unknown): ClaudeModel[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.filter((m): m is RawModel => !!m && typeof m === "object");
  // CLIs that predate per-model effort info accept every level.
  const reportsEffort = entries.some((m) => "supportsEffort" in m);
  const seen = new Set<string>();
  // The CLI lists the newest model of each family first; variants of it (e.g. "[1m]") count as newest too.
  const newest = new Map<string, string>();
  const models: ClaudeModel[] = [];
  for (const m of entries) {
    const id = text(m.value);
    if (id === "default" || !isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const resolvedModel = text(m.resolvedModel) || id;
    const base = resolvedModel.replace(/\[[^\]]*\]$/, "");
    const family = /claude-([a-z]+)/i.exec(base)?.[1]?.toLowerCase() ?? base;
    if (!newest.has(family)) newest.set(family, base);
    models.push({
      id,
      resolvedModel,
      label: text(m.displayName) || id,
      description: text(m.description),
      efforts: !reportsEffort || m.supportsEffort === true ? efforts(m.supportedEffortLevels) : [],
      latest: newest.get(family) === base,
    });
  }
  return models;
}

function builtinCatalog(error: string): ModelCatalog {
  return { models: BUILTIN_MODELS, source: "builtin", claudeVersion: null, fetchedAt: now(), error };
}

function isCatalog(data: unknown): data is ModelCatalog {
  const c = data as ModelCatalog | null;
  return (
    c?.source === "claude" &&
    Array.isArray(c.models) &&
    c.models.length > 0 &&
    c.models.every((m) => typeof m?.id === "string" && typeof m.resolvedModel === "string" && typeof m.label === "string" && Array.isArray(m.efforts))
  );
}

/** Keep the last `max` chars of a stream without blocking on it. */
function drain(stream: ReadableStream<Uint8Array>, max = 4096): () => string {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        out = (out + decoder.decode(value, { stream: true })).slice(-max);
      }
    } catch {
      /* closed */
    }
  })();
  return () => out;
}

async function readControlResponse(stream: ReadableStream<Uint8Array>, requestId: string): Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let event: { type?: string; response?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const res = event.response;
        if (event.type !== "control_response" || res?.request_id !== requestId) continue;
        if (res.subtype === "error") throw new Error(text(res.error) || "Claude Code rejected the request");
        return (res.response as Record<string, unknown> | undefined) ?? {};
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("Claude Code exited without answering");
}

function deadline<T>(ms: number, onTimeout: () => T): { promise: Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

async function probe(cmd: string[]): Promise<unknown> {
  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn({
    cmd: [...cmd, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--strict-mcp-config"],
    cwd: ensureDir(join(config().dataDir, "claude-probe")),
    env: claudeEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so a wrapper (cmd.exe, version-manager shims) cannot leave the CLI behind.
    detached: posix,
  });
  const stderr = drain(proc.stderr);
  const requestId = `models_${randomUUID()}`;
  const timeout = deadline(probeTimeoutMs, () => {
    throw new Error(`Claude Code did not answer within ${Math.round(probeTimeoutMs / 1000)}s`);
  });
  try {
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
    await proc.stdin.flush();
    const read = readControlResponse(proc.stdout, requestId);
    read.catch(() => {});
    const response = await Promise.race([read, timeout.promise]);
    return response.models;
  } catch (err) {
    killTree(proc, true);
    const reason = err instanceof Error ? err.message : String(err);
    const tail = stderr().trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new Error(tail ? `${reason}: ${tail}` : reason);
  } finally {
    timeout.clear();
    try {
      await proc.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => killTree(proc, true), EXIT_GRACE_MS).unref?.();
  }
}

async function claudeVersion(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd: [...cmd, "--version"], env: claudeEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: posix });
    const timeout = deadline(VERSION_TIMEOUT_MS, () => "");
    const out = await Promise.race([new Response(proc.stdout).text(), timeout.promise]);
    timeout.clear();
    killTree(proc, true);
    return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchCatalog(): Promise<ModelCatalog> {
  try {
    const cmd = resolveClaudeCommand();
    if (!cmd) return builtinCatalog("Claude Code CLI not found");
    const [raw, version] = await Promise.all([probe(cmd), claudeVersion(cmd)]);
    const models = parseModels(raw);
    if (!models.length) throw new Error("Claude Code reported no models");
    return { models, source: "claude", claudeVersion: version, fetchedAt: now(), error: null };
  } catch (err) {
    log.warn("could not read the model list from Claude Code", err);
    return builtinCatalog(err instanceof Error ? err.message : String(err));
  }
}

function loadCached(): ModelCatalog | null {
  if (cached) return cached;
  try {
    const file = cacheFile();
    if (!existsSync(file)) return null;
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isCatalog(data)) cached = data;
  } catch (err) {
    log.debug("ignoring unreadable model cache", err);
  }
  return cached;
}

function refresh(): Promise<ModelCatalog> {
  inflight ??= fetchCatalog()
    .then((next) => {
      const prev = loadCached();
      // A failed probe keeps the last list Claude Code reported.
      if (next.source === "builtin" && prev?.source === "claude") {
        cached = { ...prev, fetchedAt: next.fetchedAt, error: next.error };
        return cached;
      }
      cached = next;
      if (next.source === "claude") {
        try {
          writeFileSync(cacheFile(), JSON.stringify(next), { mode: 0o600 });
        } catch (err) {
          log.warn("could not write the model cache", err);
        }
      }
      if (JSON.stringify(prev?.models) !== JSON.stringify(next.models)) bus.changed("models");
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Models offered by the installed Claude Code. Serves the cache and refreshes it in the background when stale. */
export async function getModelCatalog(opts: { refresh?: boolean } = {}): Promise<ModelCatalog> {
  const current = loadCached();
  if (opts.refresh || !current) return refresh();
  const ttl = current.source === "claude" && !current.error ? FRESH_MS : RETRY_MS;
  if (Date.now() - Date.parse(current.fetchedAt) > ttl) refresh().catch((err) => log.warn("model refresh failed", err));
  return current;
}

/** Effort to pass with `--model <model>`, per the cached catalog. Never spawns the CLI. */
export function effortFor(model: string, effort: Effort | null): Effort | null {
  if (!effort) return null;
  const known = findModel(loadCached()?.models ?? [], model);
  return known ? effortForModel(known.efforts, effort) : effort;
}

/** Tests: forget the in-memory catalog; optionally shorten the probe timeout. */
export function __resetModelCatalogForTests(opts: { probeTimeoutMs?: number } = {}) {
  cached = null;
  inflight = null;
  probeTimeoutMs = opts.probeTimeoutMs ?? 20_000;
}
