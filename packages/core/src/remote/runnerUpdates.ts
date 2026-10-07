/**
 * Keeping runners on this computer's Godmode (the controller's side of remote/selfUpdate.ts), and their tools current.
 *
 * Which Godmode a runner gets is always this computer's: the same program when both are the same kind of computer
 * (sent over the link in pieces, compared by SHA-256), else the same release from usegodmode.com (compared by version).
 * Runners from before the updater know neither, so they fetch this computer's program once from a short-lived
 * listener through `runner_exec` (the bridge); after that they update like any other.
 *
 * With auto-update on (per runner, the default) a runner that connects with another Godmode gets this one; it waits
 * for its runs to finish before it restarts. A failed attempt isn't repeated by itself for the same build for a while.
 * The Update button does the same at once and installs the runner's tool updates (Claude Code, uv, Chromium…) too.
 */
import type { RemoteRunner, RunnerInfo, RunnerUpdate, RunnerUpdateSource, RunnerUpdateState, ToolUpdateResult, ToolUpdateStatus, UpdateReport } from "@godmode/shared";
import { BUILD, COMPILED, VERSION } from "../config";
import { licenseBaseUrl, licenseKey } from "../license/license";
import { logger } from "../log";
import { tailscaleStatus } from "../mobile/tailscale";
import { audit } from "../services/audit";
import { compareVersions } from "../services/claudeUpdate";
import { notify } from "../services/notifications";
import { HttpError, randomToken } from "../util";
import type { RemoteLink } from "./linkClient";
import { offerAddresses } from "./pairing";
import { executableDigest, knownExecutableDigest, releaseAsset, type UpdateTarget } from "./selfUpdate";
import { SERVICE_LABEL } from "./launchd";

const log = logger("runner-updates");

const CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 2 * 60_000;
const APPLY_TIMEOUT_MS = 3 * 60_000;
const TOOLS_TIMEOUT_MS = 30 * 60_000;
const BRIDGE_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 10_000;
/** A runner that restarted and doesn't come back within this long: the update counts as failed. */
const RESTART_TIMEOUT_MS = 5 * 60_000;
/** An automatic update that failed isn't tried again by itself for the same build for this long. */
const RETRY_AUTO_MS = 6 * 60 * 60_000;

/** What runners.ts lends: the runner's row, link, last info and a way to tell the UI. */
export interface UpdateHost {
  row(id: string): { id: string; name: string; platform: string | null; arch: string | null; version: string | null; auto_update: number } | null;
  link(id: string): RemoteLink | null;
  info(id: string): RunnerInfo | undefined;
  setInfo(id: string, info: RunnerInfo): void;
  activeRuns(id: string): number;
  emit(id: string): void;
}

interface Attempt {
  state: Exclude<RunnerUpdateState, "current" | "available" | "unsupported">;
  source: RunnerUpdateSource | null;
  progress: number | null;
  detail: string | null;
  /** Install the tool updates once the new Godmode is up. */
  tools: boolean;
  at: number;
  target: string;
}

let host: UpdateHost | null = null;
const attempts = new Map<string, Attempt>();
const toolReports = new Map<string, ToolUpdateStatus[]>();
/** `${runner}:${target}` → when an automatic update of it failed. */
const autoFailed = new Map<string, number>();
const polls = new Map<string, ReturnType<typeof setInterval>>();

export function setUpdateHost(h: UpdateHost | null): void {
  host = h;
}

const target = (): UpdateTarget => ({ version: VERSION, build: BUILD });

/** Tests: this computer as a compiled program with this digest (null = as it really is). */
let controllerOverride: { digest: string } | null = null;

export function __setControllerForTests(value: { digest: string } | null): void {
  controllerOverride = value;
}

const compiled = () => !!controllerOverride || COMPILED;

function ownDigest(): string | null {
  if (controllerOverride) return controllerOverride.digest;
  return COMPILED ? knownExecutableDigest() : null;
}

/** Start hashing this program (the runners' digests are compared with it); resolves once known. */
export async function prepareRunnerUpdates(): Promise<void> {
  if (COMPILED) await executableDigest()?.catch((err) => log.warn("couldn't hash this program", err));
}

const samePlatform = (r: { platform: string | null; arch: string | null }) => r.platform === process.platform && r.arch === process.arch;

/** The command that installs this Godmode's release on the runner by hand. The key stays out: phones read the runner list too. */
function manualCommand(): string {
  return `curl -fsSL https://usegodmode.com/runner.sh | GODMODE_LICENSE=GM-XXXXX-XXXXX-XXXXX-XXXXX GODMODE_VERSION=v${VERSION} sh`;
}

const ONCE_BY_HAND = "Its Godmode is older than the updater. Install the new one there once with this command, with your licence key from Settings → License.";

interface Plan {
  needed: boolean;
  source: RunnerUpdateSource | null;
  /** Why it can't be updated from here. */
  reason: string | null;
  command: string | null;
  /** Identifies what it would get, for remembering failed automatic attempts. */
  key: string;
}

/** Does the runner need this computer's Godmode, and how would it get there? */
export function planUpdate(r: { platform: string | null; arch: string | null; version: string | null }, info: RunnerInfo | undefined): Plan {
  const mine = ownDigest();
  const key = mine ?? `${VERSION} ${BUILD}`;
  const none = { needed: false, source: null, reason: null, command: null, key };
  const version = info?.version ?? r.version;
  if (!version) return none;
  // Never back to an older one: this computer needs the update then.
  if (compareVersions(version, VERSION) > 0) return none;
  const legacy = !!info && info.build === undefined;
  const sameProgram = compiled() && samePlatform(r) && info?.compiled !== false;
  let needed: boolean;
  if (sameProgram && legacy) needed = true;
  else if (sameProgram && mine && info?.digest) needed = info.digest !== mine;
  else needed = compareVersions(version, VERSION) < 0;
  if (!needed) return none;

  if (info?.compiled === false) return { needed, source: null, reason: "It runs Godmode from its sources. Update it there with git.", command: null, key };
  if (sameProgram && !legacy) return { needed, source: "controller", reason: null, command: null, key };
  if (sameProgram && legacy) {
    return r.platform === "darwin"
      ? { needed, source: "bridge", reason: null, command: null, key }
      : { needed, source: null, reason: ONCE_BY_HAND, command: manualCommand(), key };
  }
  if (legacy) return { needed, source: null, reason: ONCE_BY_HAND, command: manualCommand(), key };
  if (!releaseAsset(r.platform ?? "", r.arch ?? "")) return { needed, source: null, reason: `There is no Godmode download for ${r.platform ?? "its system"} ${r.arch ?? ""}.`.trim(), command: null, key };
  if (!licenseKey()) return { needed, source: null, reason: "Add your licence key (Settings → License): the runner downloads Godmode from usegodmode.com with it.", command: manualCommand(), key };
  return { needed, source: "website", reason: null, command: null, key };
}

function dueTools(id: string): RunnerUpdate["tools"] {
  return (toolReports.get(id) ?? []).filter((t) => t.installed && t.updatable && t.updateAvailable).map(({ id, name, current, latest }) => ({ id, name, current, latest }));
}

/** The update part of a runner as the UI sees it. */
export function runnerUpdate(r: { id: string; platform: string | null; arch: string | null; version: string | null; auto_update: number }, linkState: RemoteRunner["state"]): RunnerUpdate {
  const base = { target: target(), autoUpdate: r.auto_update === 1, tools: dueTools(r.id), command: null, source: null, progress: null, detail: null };
  if (linkState === "update_required") {
    return { ...base, state: "unsupported", detail: "It runs a Godmode that can't talk to this one. Install the new one there with this command, with your licence key from Settings → License.", command: manualCommand() };
  }
  const attempt = attempts.get(r.id);
  const info = host?.info(r.id);
  const plan = planUpdate(r, info);
  if (attempt) return { ...base, state: attempt.state, source: attempt.source, progress: attempt.progress, detail: attempt.detail };
  const own = info?.update;
  if (own?.state === "waiting") return { ...base, state: "waiting", source: plan.source, detail: waitingText(own.waitingFor) };
  if (own?.state === "installing") return { ...base, state: "installing", source: plan.source };
  if (!plan.needed) return { ...base, state: "current" };
  if (!plan.source) return { ...base, state: "unsupported", detail: plan.reason, command: plan.command };
  if (own?.state === "failed") return { ...base, state: "failed", source: plan.source, detail: own.error };
  return { ...base, state: "available", source: plan.source };
}

function waitingText(runs: number): string {
  return runs > 0 ? `Installs once its ${runs === 1 ? "run is" : `${runs} runs are`} done.` : "Installs in a moment.";
}

function set(id: string, attempt: Attempt | null) {
  if (attempt) attempts.set(id, attempt);
  else attempts.delete(id);
  host?.emit(id);
}

function patch(id: string, p: Partial<Attempt>) {
  const a = attempts.get(id);
  if (a) set(id, { ...a, ...p });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error:\s*/, "") : String(err);
}

function failed(id: string, detail: string, auto: boolean) {
  const a = attempts.get(id);
  stopPoll(id);
  set(id, { state: "failed", source: a?.source ?? null, progress: null, detail, tools: false, at: Date.now(), target: a?.target ?? "" });
  if (auto && a) autoFailed.set(`${id}:${a.target}`, Date.now());
  const name = host?.row(id)?.name ?? "The runner";
  log.warn(`${name}: update failed: ${detail}`);
  if (auto) notify("warning", `${name} couldn't be updated`, detail, "/runners");
}

/* ------------------------------------------------------------------ */
/* Tool reports                                                         */
/* ------------------------------------------------------------------ */

/** Ask the runner which of its tools have updates (runners before the updater have no answer: none). */
export async function refreshToolReport(id: string, refresh = false): Promise<void> {
  const l = host?.link(id);
  if (!l || l.state.state !== "online") return;
  try {
    const report = await l.json<UpdateReport>("GET", `/api/link/updates${refresh ? "?refresh=1" : ""}`, undefined, { timeoutMs: 5 * 60_000 });
    toolReports.set(id, report.tools ?? []);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) log.debug(`couldn't ask runner ${id} for its tool updates`, err);
    toolReports.set(id, []);
  }
  host?.emit(id);
}

async function installTools(id: string, l: RemoteLink): Promise<ToolUpdateResult[]> {
  const due = dueTools(id);
  if (!due.length) return [];
  set(id, { state: "installing", source: null, progress: null, detail: `Updating ${due.map((t) => t.name).join(", ")}`, tools: false, at: Date.now(), target: attempts.get(id)?.target ?? "" });
  const results = await l.json<ToolUpdateResult[]>("POST", "/api/link/updates/install", undefined, { timeoutMs: TOOLS_TIMEOUT_MS });
  await refreshToolReport(id);
  return results;
}

/* ------------------------------------------------------------------ */
/* Updating                                                             */
/* ------------------------------------------------------------------ */

function stopPoll(id: string) {
  const t = polls.get(id);
  if (t) clearInterval(t);
  polls.delete(id);
}

/** While the runner waits for its runs, look at it now and then: it restarts by itself once they are done. */
function poll(id: string) {
  stopPoll(id);
  const timer = setInterval(() => {
    const a = attempts.get(id);
    const l = host?.link(id);
    if (!a) return stopPoll(id);
    if (a.state === "restarting") {
      if (Date.now() - a.at > RESTART_TIMEOUT_MS) failed(id, `${host?.row(id)?.name ?? "The runner"} didn't come back after installing the new Godmode. Check its screen or log.`, false);
      return;
    }
    if (!l || l.state.state !== "online") return;
    void l
      .json<RunnerInfo>("GET", "/api/link/info")
      .then((info) => {
        host?.setInfo(id, info);
        const own = info.update;
        if (own?.state === "failed") failed(id, own.error ?? "The update didn't work.", false);
        else if (own?.state === "installing") patch(id, { state: "restarting", detail: null, at: Date.now() });
        else if (own?.state === "waiting") patch(id, { detail: waitingText(own.waitingFor) });
      })
      .catch(() => undefined);
  }, POLL_MS);
  timer.unref?.();
  polls.set(id, timer);
}

/** Send this computer's program in pieces, with progress, and ask the runner to install it. */
async function sendProgram(id: string, l: RemoteLink): Promise<RunnerInfo["update"]> {
  const sha256 = await executableDigest();
  if (!sha256) throw new Error("This computer runs Godmode from its sources and has no program to send.");
  const file = Bun.file(process.execPath);
  const size = file.size;
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + CHUNK_BYTES, size)).arrayBuffer());
    const res = await l.request("PUT", `/api/link/update/chunk?offset=${offset}&total=${size}`, { body: bytes, headers: { "content-type": "application/octet-stream" }, timeoutMs: CHUNK_TIMEOUT_MS });
    if (res.status < 200 || res.status >= 300) {
      const answer = JSON.parse(Buffer.from(res.body).toString("utf8") || "{}") as { error?: string };
      throw new Error(answer.error ?? `The runner answered ${res.status}.`);
    }
    patch(id, { progress: Math.min((offset + bytes.byteLength) / size, 1) });
  }
  patch(id, { state: "installing", progress: null, detail: "Checking and installing the new Godmode" });
  return l.json<RunnerInfo["update"]>("POST", "/api/link/update/apply", { sha256, size, target: target() }, { timeoutMs: APPLY_TIMEOUT_MS });
}

/** Let the runner download this Godmode's release from usegodmode.com. */
function downloadRelease(l: RemoteLink): Promise<RunnerInfo["update"]> {
  const site = licenseBaseUrl();
  return l.json<RunnerInfo["update"]>(
    "POST",
    "/api/link/update/download",
    { key: licenseKey(), target: { version: VERSION, build: "" }, ...(site !== "https://usegodmode.com" ? { site } : {}) },
    { timeoutMs: 20 * 60_000 },
  );
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The script a runner from before the updater runs (through runner_exec) to fetch this program and restart with it. */
export function bridgeScript(urls: string[], sha256: string): string {
  return [
    "set -e",
    `plist="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"`,
    `[ -f "$plist" ] || { echo "The runner isn't installed as a service here: run the install command on it once." >&2; exit 5; }`,
    `bin=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")`,
    'tmp="$(dirname "$bin")/.godmode-update"',
    "ok=",
    `for u in ${urls.map(shellQuote).join(" ")}; do curl -fsS --connect-timeout 3 --max-time 600 "$u" -o "$tmp" && ok=1 && break; done`,
    `[ -n "$ok" ] || { echo "The runner can't reach this computer to download the new Godmode." >&2; exit 3; }`,
    `[ "$(shasum -a 256 "$tmp" | cut -d' ' -f1)" = "${sha256}" ] || { rm -f "$tmp"; echo "The download arrived damaged." >&2; exit 4; }`,
    'chmod 755 "$tmp"',
    `"$tmp" version >/dev/null || { rm -f "$tmp"; echo "The new Godmode doesn't start there." >&2; exit 6; }`,
    'mv -f "$tmp" "$bin"',
    `nohup /bin/sh -c 'sleep 2; launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}' >/dev/null 2>&1 &`,
    "echo installed",
  ].join("\n");
}

/** Runners from before the updater: serve this program for a moment and let the runner fetch it with a shell command. */
async function bridge(id: string, l: RemoteLink): Promise<void> {
  const sha256 = await executableDigest();
  if (!sha256) throw new Error("This computer runs Godmode from its sources and has no program to send.");
  const token = randomToken(24);
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    idleTimeout: 255,
    fetch: (req) =>
      req.method === "GET" && new URL(req.url).pathname === `/${token}/godmode`
        ? new Response(Bun.file(process.execPath), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } })
        : new Response("Not found", { status: 404 }),
  });
  try {
    const urls = offerAddresses(await tailscaleStatus(true)).map((a) => `http://${a.address}:${server.port}/${token}/godmode`);
    if (!urls.length) throw new Error("This computer has no network address the runner could download from.");
    const res = await l.json<{ code: number | null; stdout: string; stderr: string }>(
      "POST",
      "/api/link/exec",
      { command: bridgeScript(urls, sha256), timeoutMs: BRIDGE_TIMEOUT_MS },
      { timeoutMs: BRIDGE_TIMEOUT_MS + 60_000 },
    );
    if (res.code !== 0) throw new Error(res.stderr.trim().split("\n").pop() || `The install stopped (exit ${res.code}).`);
  } finally {
    server.stop(true);
  }
}

/**
 * Bring a runner to this computer's Godmode (when it runs another) and, with `tools`, its tools to their newest
 * versions. Resolves once it is sent and installing, or waiting for its runs; the rest is reported as it happens.
 */
export async function updateRunnerSoftware(id: string, opts: { tools?: boolean; auto?: boolean } = {}): Promise<void> {
  const h = host;
  if (!h) throw new HttpError(503, "Runners aren't started.", "runners_stopped");
  const r = h.row(id);
  if (!r) throw new HttpError(404, "Runner not found", "not_found");
  const l = h.link(id);
  if (!l || l.state.state !== "online") throw new HttpError(409, `${r.name} is offline — it can be updated once it is back.`, "runner_offline");
  const busy = attempts.get(id);
  if (busy && busy.state !== "failed") throw new HttpError(409, `${r.name} is already being updated.`, "update_busy");
  const tools = opts.tools ?? true;
  const auto = !!opts.auto;
  const plan = planUpdate(r, h.info(id));

  if (!plan.needed) {
    if (!tools) return;
    set(id, null);
    try {
      await refreshToolReport(id, true);
      const results = await installTools(id, l);
      set(id, null);
      const bad = results.filter((x) => !x.ok);
      if (bad.length) failed(id, `${bad.map((x) => x.name).join(", ")}: ${bad[0]!.output.split("\n").pop()}`, auto);
      else audit("user", "runner.upgrade.tools", id, { tools: results.map((x) => `${x.id} ${x.version ?? ""}`.trim()) });
    } catch (err) {
      failed(id, message(err), auto);
    }
    return;
  }
  if (!plan.source) throw new HttpError(409, plan.reason ?? `${r.name} can't be updated from here.`, "update_unsupported");
  if (plan.source === "bridge" && h.activeRuns(id) > 0) {
    throw new HttpError(409, `Chats are working on ${r.name}. Update it once they are done.`, "runner_busy");
  }

  set(id, {
    state: plan.source === "website" ? "installing" : "sending",
    source: plan.source,
    progress: plan.source === "controller" ? 0 : null,
    detail: plan.source === "website" ? "Downloading Godmode from usegodmode.com" : plan.source === "bridge" ? "The runner downloads the new Godmode from this computer" : null,
    tools,
    at: Date.now(),
    target: plan.key,
  });
  audit(auto ? "system" : "user", "runner.upgrade", id, { to: `${VERSION} ${BUILD}`, source: plan.source });
  log.info(`updating ${r.name} to ${VERSION} (${BUILD}) via ${plan.source}`);
  try {
    if (plan.source === "bridge") {
      await bridge(id, l);
      patch(id, { state: "restarting", progress: null, detail: null, at: Date.now() });
    } else {
      const own = plan.source === "controller" ? await sendProgram(id, l) : await downloadRelease(l);
      if (own?.state === "waiting") patch(id, { state: "waiting", progress: null, detail: waitingText(own.waitingFor) });
      else patch(id, { state: "restarting", progress: null, detail: null, at: Date.now() });
    }
    poll(id);
  } catch (err) {
    failed(id, message(err), auto);
  }
}

/** The runner (re)connected: finish an update it restarted for, or start one by itself. */
export async function runnerConnected(id: string): Promise<void> {
  const h = host;
  if (!h) return;
  const r = h.row(id);
  if (!r) return;
  const a = attempts.get(id);
  const info = h.info(id);
  const plan = planUpdate(r, info);
  if (a && a.state !== "failed" && a.state !== "sending") {
    if (!plan.needed) {
      stopPoll(id);
      set(id, null);
      log.info(`${r.name} runs Godmode ${VERSION} (${BUILD}) now`);
      if (a.tools) {
        await refreshToolReport(id, true);
        const l = h.link(id);
        if (l) await installTools(id, l).catch((err) => log.warn(`${r.name}: tool updates failed`, message(err)));
        set(id, null);
      }
      return;
    }
    if (info?.update?.state === "failed") failed(id, info.update.error ?? "The update didn't work.", false);
    else if (info?.update?.state === "waiting") patch(id, { state: "waiting", detail: waitingText(info.update.waitingFor) });
    else if (a.state === "restarting") failed(id, `${r.name} came back with its old Godmode.`, false);
    return;
  }
  if (a?.state === "sending") failed(id, "The connection broke off while the new Godmode was sent.", false);
  else if (a?.state === "failed" && !plan.needed) set(id, null);
  await refreshToolReport(id);
  await maybeAutoUpdate(id);
}

/** An automatic update when the runner wants one, may have one and none failed lately for this build. */
export async function maybeAutoUpdate(id: string): Promise<void> {
  const h = host;
  const r = h?.row(id);
  if (!h || !r || r.auto_update !== 1) return;
  const l = h.link(id);
  if (!l || l.state.state !== "online") return;
  const a = attempts.get(id);
  if (a && a.state !== "failed") return;
  const plan = planUpdate(r, h.info(id));
  if (!plan.needed || !plan.source) return;
  if (plan.source === "bridge" && h.activeRuns(id) > 0) return;
  const lastFail = autoFailed.get(`${id}:${plan.key}`);
  if (lastFail && Date.now() - lastFail < RETRY_AUTO_MS) return;
  await updateRunnerSoftware(id, { auto: true, tools: false }).catch((err) => log.warn(`automatic update of ${r.name} didn't start`, message(err)));
}

export function forgetRunnerUpdates(id: string): void {
  stopPoll(id);
  attempts.delete(id);
  toolReports.delete(id);
  for (const key of autoFailed.keys()) if (key.startsWith(`${id}:`)) autoFailed.delete(key);
}

/** Tests and shutdown. */
export function resetRunnerUpdates(): void {
  for (const id of [...polls.keys()]) stopPoll(id);
  attempts.clear();
  toolReports.clear();
  autoFailed.clear();
}
