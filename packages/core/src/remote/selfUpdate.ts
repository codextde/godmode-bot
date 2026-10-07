/**
 * A runner replacing its own Godmode with the one its controller runs.
 *
 * The new program arrives in pieces over the link (`receiveChunk`) or is downloaded from usegodmode.com
 * (`downloadUpdate`, for a runner on another platform than its controller). It is staged next to the running
 * executable, checked against its SHA-256, started once with `version`, and only then renamed over the executable — a
 * rename, so the running process keeps its old file and a broken download never replaces a working program. The swap
 * waits until no run works; then the runner restarts: under launchd it exits with EX_TEMPFAIL and KeepAlive starts the
 * new program, otherwise a small shell waits for this process to end and starts the new one with the same arguments.
 *
 * The build it installed is noted (meta `update.pending`); the restarted runner compares it with its own and reports
 * a mismatch as a failed update.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { LICENSE_SITE, type RunnerSelfUpdate } from "@godmode/shared";
import { BUILD, COMPILED, VERSION, config } from "../config";
import { deleteMeta, getMeta, setMeta } from "../db";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { audit } from "../services/audit";
import { runCommand } from "../services/doctor";
import { HttpError, parseJson } from "../util";
import { SERVICE_LABEL } from "./launchd";

const log = logger("self-update");

/** launchd's KeepAlive starts a runner again that exits with anything but 0. */
export const RESTART_EXIT_CODE = 75;
const PENDING_META = "update.pending";
const IDLE_POLL_MS = 10_000;
const VERIFY_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const MAX_UPDATE_BYTES = 1024 ** 3;

export interface UpdateTarget {
  version: string;
  build: string;
}

interface State {
  state: RunnerSelfUpdate["state"];
  target: UpdateTarget | null;
  error: string | null;
}

let state: State = { state: "idle", target: null, error: null };
let received = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let restartHandler: (() => void) | null = null;
let digest: Promise<string> | null = null;
let knownDigest: string | null = null;

/** index.ts: how this process stops so it can come back as the new program. */
export function setRestartHandler(fn: (() => void) | null): void {
  restartHandler = fn;
}

let executableOverride: string | null = null;

/** The program a runner would replace: the compiled executable, or null when Godmode runs from source. */
export function ownExecutable(): string | null {
  return executableOverride ?? (COMPILED ? process.execPath : null);
}

/** SHA-256 of this program; computed once, in the background. */
export function executableDigest(): Promise<string> | null {
  const path = ownExecutable();
  if (!path) return null;
  digest ??= (async () => {
    const hash = createHash("sha256");
    const reader = Bun.file(path).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    knownDigest = hash.digest("hex");
    return knownDigest;
  })().catch((err) => {
    digest = null;
    throw err;
  });
  return digest;
}

/** The digest once it is known (RunnerInfo is answered without waiting for it). */
export function knownExecutableDigest(): string | null {
  if (!knownDigest) void executableDigest()?.catch(() => undefined);
  return knownDigest;
}

function stagePath(): string {
  const exe = ownExecutable();
  if (!exe) throw new HttpError(409, "This runner runs Godmode from its sources — update it with git there.", "runner_from_source");
  return join(dirname(exe), ".godmode-update");
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
}

export function selfUpdateStatus(): RunnerSelfUpdate {
  return { ...state, waitingFor: state.state === "waiting" ? listActiveRuns().length : 0 };
}

function fail(message: string, code = "update_failed"): never {
  set({ state: "failed", error: message });
  log.warn(`update failed: ${message}`);
  throw new HttpError(422, message, code);
}

/** Forget a half-received update (another one starts, or the controller gave up). */
function resetStage() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  received = 0;
  try {
    rmSync(stagePath(), { force: true });
  } catch {
    /* from source: nothing staged */
  }
}

/** One piece of the new program, in order. `offset` 0 starts a new update. */
export function receiveChunk(offset: number, total: number, bytes: Uint8Array): { received: number } {
  if (!Number.isInteger(total) || total <= 0 || total > MAX_UPDATE_BYTES) throw new HttpError(400, "That isn't a size Godmode can be.", "bad_request");
  if (state.state === "installing") throw new HttpError(409, "An update is being installed right now.", "update_busy");
  const path = stagePath();
  if (offset === 0) {
    resetStage();
    set({ state: "receiving", target: null, error: null });
  } else if (offset !== received || state.state !== "receiving") {
    throw new HttpError(409, `Expected the piece at ${received}, got ${offset}.`, "update_out_of_order");
  }
  if (offset + bytes.byteLength > total) throw new HttpError(400, "More than announced.", "bad_request");
  const fd = openSync(path, offset === 0 ? "w" : "a", 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  received = offset + bytes.byteLength;
  return { received };
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

/** The staged program is the one announced and starts on this computer. */
async function verifyStage(sha256: string, size: number, target: UpdateTarget): Promise<void> {
  const path = stagePath();
  if (!existsSync(path)) fail("The new Godmode didn't arrive. Try again.");
  if (statSync(path).size !== size) fail("The new Godmode arrived incomplete. Try again.");
  if ((await fileDigest(path)) !== sha256.toLowerCase()) {
    rmSync(path, { force: true });
    fail("The new Godmode arrived damaged (its checksum doesn't match). Try again.");
  }
  chmodSync(path, 0o755);
  if (platform() === "darwin") await runCommand(["/usr/bin/xattr", "-d", "com.apple.quarantine", path], { timeoutMs: 10_000 });
  const res = await runCommand([path, "version"], { timeoutMs: VERIFY_TIMEOUT_MS });
  const said = res.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (res.code !== 0 || said !== target.version) {
    rmSync(path, { force: true });
    fail(`The new Godmode doesn't start on this computer${res.stderr.trim() ? `: ${res.stderr.trim().split("\n").pop()}` : "."}`);
  }
}

/**
 * Install what was staged once nothing works: the controller sent all of it (`receiveChunk`) or it was downloaded.
 * Resolves with what the runner does now ("waiting" for its runs, or "installing" — it restarts right after answering).
 */
export async function applyUpdate(input: { sha256: string; size: number; target: UpdateTarget }): Promise<RunnerSelfUpdate> {
  if (state.state === "installing") throw new HttpError(409, "An update is being installed right now.", "update_busy");
  set({ state: "installing", target: input.target, error: null });
  await verifyStage(input.sha256, input.size, input.target);
  if (listActiveRuns().length) {
    set({ state: "waiting" });
    log.info(`update to ${input.target.version} (${input.target.build}) waits for ${listActiveRuns().length} run(s)`);
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (listActiveRuns().length || state.state !== "waiting") return;
      clearInterval(idleTimer!);
      idleTimer = null;
      swap(input.target);
    }, IDLE_POLL_MS);
    idleTimer.unref?.();
    return selfUpdateStatus();
  }
  setTimeout(() => swap(input.target), 300);
  return selfUpdateStatus();
}

function swap(target: UpdateTarget) {
  const exe = ownExecutable();
  if (!exe) return;
  try {
    set({ state: "installing" });
    renameSync(stagePath(), exe);
  } catch (err) {
    set({ state: "failed", error: `Couldn't replace ${exe}: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  setMeta(PENDING_META, JSON.stringify({ ...target, from: { version: VERSION, build: BUILD } }));
  audit("controller", "runner.upgrade", null, { from: `${VERSION} ${BUILD}`, to: `${target.version} ${target.build}` });
  log.info(`installed Godmode ${target.version} (${target.build}), restarting`);
  restart();
}

/** Under launchd: exit so KeepAlive starts the new program. Otherwise: a shell starts it once this process is gone. */
function restart() {
  const underLaunchd = process.env.XPC_SERVICE_NAME === SERVICE_LABEL;
  if (!underLaunchd) {
    const exe = ownExecutable()!;
    const logs = join(config().dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    const out = openSync(join(logs, "service.log"), "a");
    const child = spawn("/bin/sh", ["-c", 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"', String(process.pid), exe, ...process.argv.slice(2)], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
  }
  if (restartHandler) restartHandler();
  else process.exit(RESTART_EXIT_CODE);
}

/** The server binary of this computer on usegodmode.com (`godmode-darwin-arm64`), or null when there is none. */
export function releaseAsset(os: string = platform(), cpu: string = arch()): string | null {
  const name = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const bits = cpu === "arm64" ? "arm64" : cpu === "x64" ? "x64" : null;
  return name && bits ? `godmode-${name}-${bits}` : null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  return res.text();
}

/**
 * Download the release `version` for this computer from usegodmode.com (with the controller's licence key) and
 * install it like one that was sent.
 */
export async function downloadUpdate(input: { key: string; target: UpdateTarget; site?: string }): Promise<RunnerSelfUpdate> {
  const asset = releaseAsset();
  if (!asset) fail(`usegodmode.com has no Godmode for ${platform()} ${arch()}.`, "update_unsupported");
  if (state.state === "installing" || state.state === "receiving") throw new HttpError(409, "An update is being installed right now.", "update_busy");
  resetStage();
  set({ state: "receiving", target: input.target, error: null });
  const query = `key=${encodeURIComponent(input.key)}&version=${encodeURIComponent(`v${input.target.version.replace(/^v/, "")}`)}`;
  const base = `${(input.site ?? LICENSE_SITE).replace(/\/+$/, "")}/download/file/${asset}`;
  let sha256: string;
  try {
    sha256 = (await fetchText(`${base}.sha256?${query}`)).trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("no checksum");
  } catch (err) {
    fail(`usegodmode.com has no checksum for Godmode ${input.target.version} (${err instanceof Error ? err.message : String(err)}).`);
  }
  const path = stagePath();
  let size = 0;
  try {
    const res = await fetch(`${base}?${query}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
    const fd = openSync(path, "w", 0o600);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPDATE_BYTES) throw new Error("too large");
        writeSync(fd, value);
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    rmSync(path, { force: true });
    fail(`Couldn't download Godmode ${input.target.version}: ${err instanceof Error ? err.message : String(err)}`);
  }
  set({ state: "idle" });
  return applyUpdate({ sha256, size, target: input.target });
}

/** At start: did the update this runner restarted for take? A mismatch is reported like any failed update. */
export function settleUpdate(): void {
  const raw = getMeta(PENDING_META);
  if (!raw) return;
  deleteMeta(PENDING_META);
  const pending = parseJson<(UpdateTarget & { from?: UpdateTarget }) | null>(raw, null);
  if (!pending) return;
  // A release from usegodmode.com is named by its version only (build "").
  if (pending.version === VERSION && (!pending.build || pending.build === BUILD)) {
    log.info(`now running Godmode ${VERSION} (${BUILD})`);
    return;
  }
  state = { state: "failed", target: { version: pending.version, build: pending.build }, error: `Restarted as Godmode ${VERSION} (${BUILD}) instead of ${pending.version} (${pending.build}).` };
  log.warn(state.error!);
}

/** Tests: start from nothing; `executable` stands in for the compiled program. */
export function __resetSelfUpdateForTests(executable: string | null = null): void {
  executableOverride = executable;
  digest = null;
  knownDigest = null;
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  received = 0;
  state = { state: "idle", target: null, error: null };
}
