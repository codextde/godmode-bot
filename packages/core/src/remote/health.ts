/**
 * Is this runner fit for work? Software, macOS permissions, access to the setup (vault key, copied config) and the
 * machine itself — one check each, with the fix Godmode can start from the other computer where there is one.
 *
 * Every look at the machine goes through `deps`, so tests decide what it finds.
 */
import { closeSync, openSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComputerStatus, DependencyId, DependencyStatus, DoctorReport, RunnerCheck, RunnerCheckGroup, RunnerCheckStatus, RunnerHealth } from "@godmode/shared";
import { computerStatus, requestComputerPermissions } from "../computer/service";
import { config } from "../config";
import { getMeta } from "../db";
import { logger } from "../log";
import { installDependency, resolveGh, runCommand, runDoctor, toolPath } from "../services/doctor";
import { childEnv } from "../util";
import * as vault from "../vault/vault";
import { keepAwakeStatus, restartKeepAwake, type KeepAwakeStatus } from "./keepAwake";
import { serviceStatus, type ServiceStatus } from "./launchd";

const log = logger("runner-health");

/** A report younger than this answers the next question (the health view asks every few seconds while something fails). */
const HEALTH_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;
const GB = 1024 ** 3;
const DISK_WARN_BYTES = 10 * GB;
const DISK_FAIL_BYTES = 2 * GB;
const FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** What a fresh runner needs before it can work, in the order it has to be installed (uv brings browser-use and Chrome). */
const BOOTSTRAP: DependencyId[] = ["claude", "uv", "browser-use", "chrome"];

type Fix = NonNullable<RunnerCheck["fix"]>;
type FixResult = { ok: boolean; output: string };
type Probe = { code: number | null; stdout: string; stderr: string };

export interface HealthDeps {
  platform: NodeJS.Platform;
  dataDir(): string;
  doctor(refresh: boolean): Promise<DoctorReport>;
  install(id: DependencyId): Promise<FixResult>;
  resolveGh(): string | null;
  /** Run a command without a shell; a command that can't be started comes back with code null. */
  exec(argv: string[]): Promise<Probe>;
  computer(): Promise<ComputerStatus>;
  requestPermissions(): Promise<ComputerStatus>;
  /** Can this process read files macOS keeps behind Full Disk Access? */
  fullDiskAccess(): boolean;
  vault(): { initialized: boolean; unlocked: boolean };
  /** Digest of the setup last copied here; null = nothing was copied yet. */
  configDigest(): string | null;
  service(): Promise<ServiceStatus>;
  keepAwake(): KeepAwakeStatus;
  restartKeepAwake(): void;
  /** Free space on the volume of `dir`, or null when it can't be read. */
  freeBytes(dir: string): number | null;
}

const defaults: HealthDeps = {
  platform: process.platform,
  dataDir: () => config().dataDir,
  doctor: runDoctor,
  install: installDependency,
  resolveGh,
  exec: (argv) => runCommand(argv, { timeoutMs: PROBE_TIMEOUT_MS, env: childEnv({ PATH: toolPath() }) }),
  computer: computerStatus,
  requestPermissions: requestComputerPermissions,
  fullDiskAccess: () => {
    // The privacy database itself is the one file that is only readable with Full Disk Access.
    try {
      closeSync(openSync(join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"), "r"));
      return true;
    } catch {
      return false;
    }
  },
  vault: () => vault.status(),
  configDigest: () => getMeta("link.config_digest"),
  service: () => serviceStatus(),
  keepAwake: () => keepAwakeStatus(),
  restartKeepAwake: () => restartKeepAwake(),
  freeBytes: (dir) => {
    try {
      const fs = statfsSync(dir);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return null;
    }
  },
};
let deps = defaults;

let cached: { at: number; health: RunnerHealth } | null = null;
let inflight: Promise<RunnerHealth> | null = null;
let bootstrap: Promise<void> | null = null;

/**
 * A fix or an install just changed what there is to find. Neither the last report nor one that is still being put
 * together (it looked before the change) may answer the next question: `runnerHealth` keeps only the report it is waiting for.
 */
function forget() {
  cached = null;
  inflight = null;
}

/** Replace how the machine is looked at (tests); null restores the real probes. Forgets what was found before. */
export function setHealthDeps(overrides: Partial<HealthDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
  cached = null;
  inflight = null;
  bootstrap = null;
}

/* ------------------------------------------------------------------ */
/* Fixes                                                                */
/* ------------------------------------------------------------------ */

const INSTALL: Fix = { kind: "install", label: "Install" };

/** How each check is fixed. `git` is not here: its hint is the doctor's, which depends on the platform. */
const FIXES: Record<string, Fix> = {
  claude: INSTALL,
  "claude-auth": {
    kind: "manual",
    label: "Sign in to Claude",
    hint: "Run `claude` in Terminal on the runner and sign in, or add an Anthropic API key in Godmode (Settings → AI) and sync.",
  },
  uv: INSTALL,
  "browser-use": INSTALL,
  chrome: INSTALL,
  gh: { kind: "manual", label: "Sign in to GitHub", hint: "Run `gh auth login` on the runner so coding tasks can open pull requests." },
  "cua-driver": INSTALL,
  accessibility: { kind: "request", label: "Ask for permission", hint: "System Settings → Privacy & Security → Accessibility → turn on Godmode" },
  "screen-recording": {
    kind: "request",
    label: "Ask for permission",
    hint: "System Settings → Privacy & Security → Screen & System Audio Recording → turn on Godmode",
  },
  "full-disk-access": { kind: "open-settings", label: "Open System Settings", hint: "System Settings → Privacy & Security → Full Disk Access → turn on Godmode" },
  vault: { kind: "sync", label: "Copy setup now", hint: "Unlock the vault in Godmode; the key is sent to the runner with the next sync." },
  config: { kind: "sync", label: "Copy setup now", hint: "Godmode copies your agents, logins and settings to the runner when it connects." },
  service: { kind: "manual", label: "Install the service", hint: "Run `godmode runner install` on the runner so it starts when you log in." },
  "keep-awake": { kind: "restart", label: "Restart" },
  "gui-session": {
    kind: "manual",
    label: "Log in on the runner",
    hint: "Log in on the runner's screen (or enable automatic login): the browser and screen control need a desktop session.",
  },
  disk: { kind: "manual", label: "Free up space", hint: "Free up disk space on the runner: chats, browser profiles and checkouts are stored there." },
  firewall: { kind: "manual", label: "Allow connections", hint: "The macOS firewall is on: allow incoming connections for godmode when macOS asks." },
};

/** Checks that only exist on macOS; elsewhere they are left out rather than reported as failing. */
const MAC_ONLY = new Set(["accessibility", "screen-recording", "full-disk-access", "service", "keep-awake", "gui-session", "firewall"]);

function gitFix(report: DoctorReport): Fix {
  return { kind: "manual", label: "Install git", hint: report.dependencies.find((d) => d.id === "git")?.installHint };
}

/* ------------------------------------------------------------------ */
/* Checks                                                               */
/* ------------------------------------------------------------------ */

function make(
  id: string,
  group: RunnerCheckGroup,
  name: string,
  status: RunnerCheckStatus,
  detail: string,
  required: boolean,
  fix: Fix | undefined = FIXES[id],
): RunnerCheck {
  return { id, group, name, status, detail, required, fix: status === "ok" ? null : (fix ?? null) };
}

/** A failing required check blocks work; a failing optional one is a warning. */
const failing = (required: boolean): RunnerCheckStatus => (required ? "fail" : "warn");

function dependencyCheck(dep: DependencyStatus, report: DoctorReport): RunnerCheck {
  const detail = dep.detail.split("\n")[0] || (dep.ok ? (dep.version ?? "Found") : "Not found");
  return make(dep.id, "software", dep.name, dep.ok ? "ok" : failing(dep.required), detail, dep.required, dep.id === "git" ? gitFix(report) : FIXES[dep.id]);
}

async function ghCheck(): Promise<RunnerCheck> {
  const name = "GitHub CLI";
  const path = deps.resolveGh();
  if (!path) return make("gh", "software", name, "warn", "gh is not installed", false);
  const res = await deps.exec([path, "auth", "status"]);
  if (res.code === null) return make("gh", "software", name, "unknown", "Couldn't check the GitHub login", false);
  if (res.code !== 0) return make("gh", "software", name, "warn", "Not signed in to GitHub", false);
  const account = `${res.stdout}\n${res.stderr}`.match(/Logged in to (\S+) (?:account|as) (\S+)/);
  return make("gh", "software", name, "ok", account ? `Signed in to ${account[1]} as ${account[2]}` : "Signed in to GitHub", false);
}

function permissionCheck(id: string, name: string, granted: boolean | null | undefined, required: boolean, missing: string): RunnerCheck {
  if (granted === true) return make(id, "permissions", name, "ok", "Allowed", required);
  if (granted === false) return make(id, "permissions", name, failing(required), missing, required);
  return make(id, "permissions", name, "unknown", "Couldn't check — the screen helper isn't available", required);
}

function vaultCheck(): RunnerCheck {
  const status = deps.vault();
  if (!status.initialized) return make("vault", "access", "Vault", "fail", "No vault key yet — logins can't be opened here", true);
  if (!status.unlocked) return make("vault", "access", "Vault", "fail", "Locked — the key hasn't reached this runner", true);
  return make("vault", "access", "Vault", "ok", "Unlocked", true);
}

function serviceCheck(status: ServiceStatus): RunnerCheck {
  const name = "Starts at login";
  if (status.loaded) return make("service", "system", name, "ok", "Installed as a service", false);
  if (status.installed) return make("service", "system", name, "warn", "Installed, but macOS hasn't loaded the service", false);
  return make("service", "system", name, "warn", "Not installed — the runner stops when its terminal closes", false);
}

function keepAwakeCheck(): RunnerCheck {
  const status = deps.keepAwake();
  if (!status.active) return make("keep-awake", "system", "Keep awake", "warn", "Not active — this Mac can fall asleep while agents work", false);
  return make("keep-awake", "system", "Keep awake", "ok", status.display ? "This Mac stays awake, the display stays on while agents work" : "This Mac stays awake", false);
}

async function sessionCheck(): Promise<RunnerCheck> {
  const name = "Desktop session";
  const res = await deps.exec(["/bin/launchctl", "managername"]);
  const session = res.stdout.trim();
  if (res.code !== 0 || !session) return make("gui-session", "system", name, "unknown", "Couldn't check the session", true);
  if (session === "Aqua") return make("gui-session", "system", name, "ok", "Logged in on the screen", true);
  return make("gui-session", "system", name, "fail", `No desktop session (${session})`, true);
}

function diskCheck(): RunnerCheck {
  const free = deps.freeBytes(deps.dataDir());
  if (free === null) return make("disk", "system", "Disk space", "unknown", "Couldn't read the free space", false);
  const detail = `${(free / GB).toFixed(free < DISK_WARN_BYTES ? 1 : 0)} GB free`;
  return make("disk", "system", "Disk space", free < DISK_FAIL_BYTES ? "fail" : free < DISK_WARN_BYTES ? "warn" : "ok", detail, false);
}

async function firewallCheck(): Promise<RunnerCheck> {
  const res = await deps.exec(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"]);
  const state = res.stdout.match(/State = (\d)/)?.[1];
  if (res.code !== 0 || !state) return make("firewall", "system", "Firewall", "unknown", "Couldn't check the firewall", false);
  if (state === "0") return make("firewall", "system", "Firewall", "ok", "Off", false);
  return make("firewall", "system", "Firewall", "warn", "On — macOS may block Godmode from reaching this runner", false);
}

async function inspect(refresh: boolean): Promise<RunnerHealth> {
  const mac = deps.platform === "darwin";
  const [report, gh, computer, service, session, firewall] = await Promise.all([
    deps.doctor(refresh),
    ghCheck(),
    mac ? deps.computer().catch(() => null) : null,
    mac ? deps.service() : null,
    mac ? sessionCheck() : null,
    mac ? firewallCheck() : null,
  ]);
  const software = (...ids: DependencyId[]) => report.dependencies.filter((d) => ids.includes(d.id)).map((d) => dependencyCheck(d, report));
  const configured = deps.configDigest() !== null;
  // Screen control is only needed when agents may use the computer.
  const screen = computer?.enabled ?? false;
  const checks: RunnerCheck[] = [
    ...software("claude", "claude-auth", "uv", "browser-use", "chrome", "git"),
    gh,
    ...software("cua-driver"),
    ...(mac
      ? [
          permissionCheck("accessibility", "Accessibility", computer?.permissions.accessibility, screen, "Not allowed — agents can't click or type"),
          permissionCheck("screen-recording", "Screen Recording", computer?.permissions.screenRecording, screen, "Not allowed — agents can't see the screen"),
          permissionCheck("full-disk-access", "Full Disk Access", deps.fullDiskAccess(), false, "Not allowed — some folders stay closed to agents"),
        ]
      : []),
    vaultCheck(),
    make("config", "access", "Setup", configured ? "ok" : "fail", configured ? "Copied from Godmode" : "Nothing copied yet", true),
    ...(service ? [serviceCheck(service), keepAwakeCheck()] : []),
    ...(session ? [session] : []),
    diskCheck(),
    ...(firewall ? [firewall] : []),
  ];
  return { ok: !checks.some((c) => c.required && c.status === "fail"), checkedAt: new Date().toISOString(), platform: deps.platform, checks };
}

/** Checks whose program is being installed right now: the health view shows them as on their way, not as broken. */
const installing = new Set<string>();

export async function runnerHealth(refresh = false): Promise<RunnerHealth> {
  const health = await checkedHealth(refresh);
  return installing.size ? { ...health, installing: [...installing] } : health;
}

async function checkedHealth(refresh: boolean): Promise<RunnerHealth> {
  if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.health;
  if (inflight) return inflight;
  const pending: Promise<RunnerHealth> = inspect(refresh)
    .then((health) => {
      if (inflight === pending) cached = { at: Date.now(), health };
      return health;
    })
    .finally(() => {
      if (inflight === pending) inflight = null;
    });
  inflight = pending;
  return pending;
}

/* ------------------------------------------------------------------ */
/* Fixing                                                               */
/* ------------------------------------------------------------------ */

/**
 * Do what a check's fix stands for. `sync` and `manual` have nothing to do on the runner (Godmode copies the setup
 * itself; the rest is the human's): they answer with the hint.
 */
export async function fixCheck(id: string): Promise<FixResult> {
  if (deps.platform !== "darwin" && MAC_ONLY.has(id)) return { ok: false, output: `Unknown check: ${id}` };
  // An own property only: the id comes from the controller, and "constructor" or "__proto__" are on every object.
  const fix = id === "git" ? gitFix(await deps.doctor(false)) : Object.hasOwn(FIXES, id) ? FIXES[id] : undefined;
  if (!fix) return { ok: false, output: `Unknown check: ${id}` };
  // Whatever happens next changes what the next report finds.
  cached = null;
  try {
    switch (fix.kind) {
      case "install":
        installing.add(id);
        try {
          return await deps.install(id as DependencyId);
        } finally {
          installing.delete(id);
        }
      case "request": {
        const { permissions } = await deps.requestPermissions();
        const granted = id === "accessibility" ? permissions.accessibility : permissions.screenRecording;
        return granted ? { ok: true, output: "Allowed." } : { ok: false, output: `macOS asks on the runner's own screen. ${fix.hint}` };
      }
      case "open-settings": {
        const res = await deps.exec(["/usr/bin/open", FULL_DISK_ACCESS_URL]);
        if (res.code !== 0) return { ok: false, output: res.stderr.trim() || "Couldn't open System Settings on the runner." };
        return { ok: true, output: `System Settings is open on the runner's screen. ${fix.hint}` };
      }
      case "restart": {
        deps.restartKeepAwake();
        const active = deps.keepAwake().active;
        return { ok: active, output: active ? "The runner keeps this Mac awake again." : "Couldn't start caffeinate on the runner." };
      }
      case "sync":
      case "manual":
        return { ok: false, output: fix.hint ?? fix.label };
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  } finally {
    // The health view kept asking while this ran: what it was told then is from before the fix was done.
    forget();
  }
}

/**
 * A fresh runner installs what it needs to work by itself: nobody sits in front of it to click "Install". Runs once
 * per process start; what can't be installed (or isn't required) is left to the health view.
 */
export function bootstrapDependencies(): Promise<void> {
  bootstrap ??= (async () => {
    // Everything this start will install is on its way from now on, also what waits for uv.
    const first = await deps.doctor(false);
    for (const id of BOOTSTRAP) if (first.dependencies.some((d) => d.id === id && !d.ok && d.required)) installing.add(id);
    try {
      for (const id of BOOTSTRAP) {
        // Asked again before every install: an installed uv is what makes browser-use and Chrome installable.
        const dep = (await deps.doctor(false)).dependencies.find((d) => d.id === id);
        if (!dep || dep.ok || !dep.required || !dep.installable) {
          installing.delete(id);
          continue;
        }
        log.info(`installing ${dep.name}`);
        const result = await deps.install(id).finally(() => installing.delete(id));
        forget();
        if (result.ok) log.info(`installed ${dep.name}`);
        else log.warn(`could not install ${dep.name}`, result.output.slice(-500));
      }
    } finally {
      for (const id of BOOTSTRAP) installing.delete(id);
    }
  })().catch((err) => log.warn("could not install the runner's dependencies", err));
  return bootstrap;
}
