/**
 * Model catalog (owner: runner): the models the installed Claude Code offers in `/model`, read through the stream-json
 * `initialize` control request, and whether it has Ultracode (`get_settings`) — no prompt, no API call. Cached in memory
 * and on disk, refreshed in the background.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { ClaudeModel, Effort, ModelCatalog } from "@godmode/shared";
import { BUILTIN_MODELS, EFFORT_OPTIONS, ULTRACODE_EFFORT, effortForModel, findModel, isModelId } from "@godmode/shared";
import { config, ensureDir } from "../config";
import { bus } from "../events/bus";
import { logger } from "../log";
import { now } from "../util";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";

const log = logger("models");

const EXIT_GRACE_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const SETTINGS_TIMEOUT_MS = 3_000;
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
/** The last probe got no answer about Ultracode: its models have none for now, and Claude Code is asked again soon. */
let ultracodeUnknown = false;
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

/**
 * Normalize the CLI's model list. "default" is dropped: in Godmode the default is the agent's model.
 * `workflows`: this Claude Code has dynamic workflows — Ultracode then works with every model that has its effort level.
 */
export function parseModels(raw: unknown, workflows = false): ClaudeModel[] {
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
    const levels = !reportsEffort || m.supportsEffort === true ? efforts(m.supportedEffortLevels) : [];
    models.push({
      id,
      resolvedModel,
      label: text(m.displayName) || id,
      description: text(m.description),
      efforts: levels,
      ultracode: workflows && levels.includes(ULTRACODE_EFFORT),
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

/** Claude Code answered a control request with an error. */
class Rejected extends Error {}

/** Reads the answers to control requests off one stream, one request after the other: what a read leaves over is kept for the next. */
function controlResponses(stream: ReadableStream<Uint8Array>): (requestId: string) => Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return async (requestId) => {
    for (;;) {
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
        if (res.subtype === "error") throw new Rejected(text(res.error) || "Claude Code rejected the request");
        return (res.response as Record<string, unknown> | undefined) ?? {};
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    throw new Error("Claude Code exited without answering");
  };
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

/** A question after the model list. null: Claude Code rejected it; undefined: no answer (in time). */
type Ask = (subtype: string, fields?: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined>;

/**
 * Whether this Claude Code has dynamic workflows, per `get_settings`; null = not known, a question went unanswered. One
 * from before Ultracode rejects the request or leaves the field out: "no". Its "no" may also be about the session's
 * model: when that one lacks the Ultracode effort level, the session gets a model that has it and is asked once more.
 */
async function hasWorkflows(ask: Ask, models: ClaudeModel[]): Promise<boolean | null> {
  const first = await ask("get_settings");
  if (first === undefined) return null;
  const applied = first?.applied as { model?: unknown; ultracodeAvailable?: unknown } | undefined;
  if (applied?.ultracodeAvailable !== false) return applied?.ultracodeAvailable === true;
  const capable = (m: ClaudeModel | undefined) => !!m?.efforts.includes(ULTRACODE_EFFORT);
  const other = models.find(capable);
  // With a model that has the level, "no" is about the workflows.
  if (!other || capable(findModel(models, text(applied.model)))) return false;
  // A request without an answer leaves its read on the stream: nothing more is asked then.
  const switched = await ask("set_model", { model: other.id });
  if (!switched) return switched === null ? false : null;
  const second = await ask("get_settings");
  return second === undefined ? null : (second?.applied as { ultracodeAvailable?: unknown } | undefined)?.ultracodeAvailable === true;
}

/** The CLI's model list, and whether it has dynamic workflows (what Ultracode runs on; null = it didn't say). */
async function probe(cmd: string[]): Promise<{ models: unknown; workflows: boolean | null }> {
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
  const read = controlResponses(proc.stdout);
  const ask = async (subtype: string, fields: Record<string, unknown> = {}) => {
    const requestId = `models_${randomUUID()}`;
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype, ...fields } })}\n`);
    await proc.stdin.flush();
    return read(requestId);
  };
  const timeout = deadline(probeTimeoutMs, () => {
    throw new Error(`Claude Code did not answer within ${Math.round(probeTimeoutMs / 1000)}s`);
  });
  try {
    const initialize = ask("initialize");
    initialize.catch(() => {});
    const response = await Promise.race([initialize, timeout.promise]);
    // What is asked after the list gets a moment each, and never fails the probe.
    const brief: Ask = async (subtype, fields) => {
      const wait = deadline(Math.min(SETTINGS_TIMEOUT_MS, probeTimeoutMs), () => undefined);
      const answer = await Promise.race([ask(subtype, fields).catch((err: unknown) => (err instanceof Rejected ? null : undefined)), wait.promise]);
      wait.clear();
      return answer;
    };
    return { models: response.models, workflows: await hasWorkflows(brief, parseModels(response.models)) };
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
    const [probed, version] = await Promise.all([probe(cmd), claudeVersion(cmd)]);
    const models = parseModels(probed.models, probed.workflows === true);
    if (!models.length) throw new Error("Claude Code reported no models");
    ultracodeUnknown = probed.workflows === null;
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
    if (isCatalog(data)) {
      // A list from before Ultracode says nothing about it: it is served as it is, and asked for again right away.
      const complete = data.models.every((m) => typeof m.ultracode === "boolean");
      cached = complete ? data : { ...data, models: data.models.map((m) => ({ ...m, ultracode: false })), fetchedAt: new Date(0).toISOString() };
    }
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
  const ttl = current.source === "claude" && !current.error && !ultracodeUnknown ? FRESH_MS : RETRY_MS;
  if (Date.now() - Date.parse(current.fetchedAt) > ttl) refresh().catch((err) => log.warn("model refresh failed", err));
  return current;
}

/** Effort to pass with `--model <model>`, per the cached catalog. Never spawns the CLI. */
export function effortFor(model: string, effort: Effort | null): Effort | null {
  if (!effort) return null;
  const known = findModel(loadCached()?.models ?? [], model);
  return known ? effortForModel(known.efforts, effort) : effort;
}

/**
 * Whether a run with `--model <model>` gets Ultracode when it is switched on, per the cached catalog. Never spawns the
 * CLI. A model the catalog doesn't list (a custom or provider id) gets it when this Claude Code has it for any model.
 */
export function ultracodeFor(model: string, on: boolean): boolean {
  if (!on) return false;
  const models = loadCached()?.models ?? [];
  return findModel(models, model)?.ultracode ?? models.some((m) => m.ultracode);
}

/** Tests: forget the in-memory catalog; optionally shorten the probe timeout. */
export function __resetModelCatalogForTests(opts: { probeTimeoutMs?: number } = {}) {
  cached = null;
  inflight = null;
  ultracodeUnknown = false;
  probeTimeoutMs = opts.probeTimeoutMs ?? 20_000;
}
