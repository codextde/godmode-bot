/**
 * Permission checks (Settings → System): can Godmode read and write its data, keep it private, start its tools and —
 * on macOS — see and control the computer?
 *
 * Every problem says how it gets solved: Godmode repairs it itself ("auto": its own files and folders), the human
 * allows it in a system dialog ("request": macOS privacy), or only the human can ("manual": files of another user).
 */
import { accessSync, chmodSync, closeSync, constants, lstatSync, openSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { FixResult, PermissionId, PermissionReport, PermissionStatus } from "@godmode/shared";
import { blockedProfileRoots } from "../browser/importer";
import { getHelper, helperAvailability } from "../computer/helper";
import { config, ensureDir } from "../config";
import { bus } from "../events/bus";
import { logger } from "../log";
import { now } from "../util";
import { managedTartPath } from "../vm/tart";
import { claudeConfigDir } from "./claudeUpdate";
import { isWin, resetDoctorCache, resolveClaudeBinary, resolveUvx, runCommand } from "./doctor";
import { getSettings } from "./settings";

const log = logger("permissions");

export const PERMISSION_IDS = ["data-dir", "data-private", "tool-binaries", "claude-config", "accessibility", "screen-recording", "full-disk-access"] as const satisfies readonly PermissionId[];

const { R_OK, W_OK, X_OK } = constants;

/** One thing that is wrong. `repair` is null when Godmode can't put it right; `hint` then says what the human can do. */
interface Finding {
  path: string;
  problem: string;
  repair: (() => void) | null;
  hint: string;
}

interface Check {
  status: PermissionStatus;
  findings: Finding[];
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Does the path lead out of the data folder — itself a link, or inside a folder that is one? What is out there is
 * checked, but never changed: Godmode didn't create it.
 */
function leadsOutside(path: string): boolean {
  try {
    const root = realpathSync(config().dataDir);
    const real = realpathSync(path);
    return real !== root && !real.startsWith(root + sep);
  } catch {
    return isLink(path);
  }
}

function can(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Only the owner (or root) may change a file's mode. */
function mine(st: Stats): boolean {
  if (isWin() || typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  return uid === 0 || st.uid === uid;
}

function addMode(path: string, bits: number) {
  chmodSync(path, (statSync(path).mode & 0o7777) | bits);
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function ownHint(path: string): string {
  return isWin()
    ? `Give your user full control of ${path} (Explorer → Properties → Security).`
    : `It belongs to another user. Run in a terminal: \`sudo chown -R "$(id -un)" "${path}"\``;
}

const LINK_HINT = "It is reached through a link to another place — change the permissions there.";

/**
 * A problem with an entry Godmode may repair: unless it belongs to another user or lies outside the data folder.
 * `follow`: the entry is Godmode's (or Claude Code's) wherever a link leads.
 */
function finding(path: string, st: Stats, problem: string, repair: () => void, opts: { follow?: boolean } = {}): Finding {
  if (!opts.follow && leadsOutside(path)) return { path, problem, repair: null, hint: LINK_HINT };
  if (!mine(st)) return { path, problem, repair: null, hint: ownHint(path) };
  return { path, problem, repair, hint: "" };
}

/**
 * Entries a repair didn't change: a drive that keeps no permissions (exFAT, some network shares) or a locked file.
 * They are not offered for repair again, so neither the human nor the background upkeep tries forever.
 */
const stuck = new Set<string>();
const STUCK_HINT = "Godmode couldn't change this. The drive may not keep file permissions (exFAT, a network share) or the file is locked — move Godmode's data to a disk that does, or change it by hand.";

function fileCheck(base: Pick<PermissionStatus, "id" | "name" | "path" | "required">, okDetail: string, found: Finding[]): Check {
  const findings = found.map((f) => (stuck.has(f.path) ? { ...f, repair: null, hint: STUCK_HINT } : f));
  const first = findings[0];
  const manual = findings.find((f) => !f.repair);
  const repairable = findings.some((f) => f.repair);
  return {
    findings,
    status: {
      ...base,
      ok: !first,
      detail: first ? `${tilde(first.path)} ${first.problem}${findings.length > 1 ? ` (and ${findings.length - 1} more)` : ""}` : okDetail,
      // Repairable in part still gets the button; what is left then says what the human has to do.
      fix: !first || repairable ? "auto" : "manual",
      fixHint: !first ? "" : !manual ? "Godmode can repair this." : repairable ? `Godmode can repair part of this. ${tilde(manual.path)}: ${manual.hint}` : manual.hint,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Files                                                                */
/* ------------------------------------------------------------------ */

/** Godmode's folders: the ones it always needs, and the ones created when a feature is first used. */
function dataFolders(): { path: string; needed: boolean }[] {
  const cfg = config();
  const needed = [cfg.dataDir, cfg.agentsDir, cfg.browserDir, cfg.attachmentsDir, cfg.backupsDir, cfg.logsDir];
  const onDemand = [cfg.vmDir, cfg.tasksDir, join(cfg.dataDir, "bin"), join(cfg.dataDir, "plugins")];
  return [...needed.map((path) => ({ path, needed: true })), ...onDemand.map((path) => ({ path, needed: false }))];
}

function checkDataDir(): Check {
  const cfg = config();
  const findings: Finding[] = [];
  for (const { path, needed } of dataFolders()) {
    // The data folder itself may be a link (data moved to another disk): it is Godmode's wherever it lives.
    const follow = path === cfg.dataDir;
    const st = statOf(path);
    if (!st) {
      // Folders of features that may not be in use (VMs on a disk that is unplugged) are no problem while missing.
      if (!needed) continue;
      if (isLink(path)) findings.push({ path, problem: "is a link that leads nowhere", repair: null, hint: "Point it at a folder again, or remove it." });
      else findings.push({ path, problem: "is missing", repair: () => void ensureDir(path), hint: "" });
    } else if (!st.isDirectory()) {
      findings.push({ path, problem: "is not a folder", repair: null, hint: "Move it out of the way — Godmode keeps a folder there." });
    } else if (!can(path, R_OK | W_OK | X_OK)) {
      findings.push(finding(path, st, "can't be written", () => addMode(path, 0o700), { follow }));
    }
  }
  for (const path of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`, join(cfg.logsDir, "godmode.jsonl")]) {
    const st = statOf(path);
    if (st && !can(path, R_OK | W_OK)) findings.push(finding(path, st, "can't be written", () => addMode(path, 0o600)));
  }
  return fileCheck({ id: "data-dir", name: "Data folder", path: cfg.dataDir, required: true }, "Godmode can read and write its data", findings);
}

/**
 * Only the owner may open the data folder (POSIX mode bits). The folder guards everything inside it, so what is
 * checked is the folder itself, plus — as a second lock — the files that hold secrets.
 */
function checkDataPrivate(): Check {
  const cfg = config();
  const findings: Finding[] = [];
  const problem = "can be opened by other users of this computer";
  const dir = statOf(cfg.dataDir);
  if (dir && (dir.mode & 0o077) !== 0) findings.push(finding(cfg.dataDir, dir, problem, () => chmodSync(cfg.dataDir, 0o700), { follow: true }));
  for (const path of [cfg.dbPath, join(cfg.dataDir, ".vault-key"), join(cfg.dataDir, "access-token")]) {
    const st = statOf(path);
    if (st && (st.mode & 0o077) !== 0) findings.push(finding(path, st, problem, () => chmodSync(path, 0o600)));
  }
  return fileCheck({ id: "data-private", name: "Private data", path: cfg.dataDir, required: true }, "Only your user account can open the data folder", findings);
}

/** Godmode's own copies of programs, under the data folder. */
function ownBinaries(): string[] {
  const bin = join(config().dataDir, "bin");
  const own = [managedTartPath()];
  try {
    for (const name of readdirSync(bin)) if (!name.endsWith(".tmp")) own.push(join(bin, name));
  } catch {
    /* nothing extracted yet */
  }
  return own.filter((p) => !leadsOutside(p));
}

function checkToolBinaries(): Check {
  const findings: Finding[] = [];
  // The claude CLI and uvx are usually links into a versions folder: what counts is the program behind them.
  const installed = [resolveClaudeBinary(), resolveUvx()].filter((p): p is string => !!p).map((path) => ({ path, follow: true }));
  const tools = [...installed, ...ownBinaries().map((path) => ({ path, follow: false }))].filter((t) => statOf(t.path)?.isFile());
  for (const { path, follow } of tools) {
    if (can(path, X_OK)) continue;
    const f = finding(path, statSync(path), "may not be started", () => addMode(path, 0o100), { follow });
    findings.push(f.repair || f.hint === LINK_HINT ? f : { ...f, hint: `Run in a terminal: \`sudo chmod +x "${path}"\`` });
  }
  return fileCheck({ id: "tool-binaries", name: "Tool programs", path: findings[0]?.path ?? null, required: true }, tools.length ? "Godmode may start its tools" : "No tools installed yet", findings);
}

/** Claude Code keeps its sign-in, settings and sessions here; a folder left behind by `sudo` breaks every run. */
function checkClaudeConfig(): Check {
  const dir = claudeConfigDir();
  const findings: Finding[] = [];
  const st = statOf(dir);
  if (!st) {
    // Claude Code creates it on first use — as long as it may.
    const parent = dirname(dir);
    if (!can(parent, W_OK | X_OK)) findings.push({ path: parent, problem: "can't be written, so Claude Code can't create its folder", repair: null, hint: ownHint(parent) });
  } else if (!st.isDirectory()) {
    findings.push({ path: dir, problem: "is not a folder", repair: null, hint: "Move it out of the way — Claude Code keeps a folder there." });
  } else if (!can(dir, R_OK | W_OK | X_OK)) {
    findings.push(finding(dir, st, "can't be written", () => addMode(dir, 0o700), { follow: true }));
  }
  const state = process.env.CLAUDE_CONFIG_DIR ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
  const stateSt = statOf(state);
  if (stateSt && !can(state, R_OK | W_OK)) findings.push(finding(state, stateSt, "can't be written", () => addMode(state, 0o600), { follow: true }));
  return fileCheck({ id: "claude-config", name: "Claude Code folder", path: dir, required: true }, "Claude Code can save its sign-in and sessions", findings);
}

/* ------------------------------------------------------------------ */
/* macOS privacy                                                        */
/* ------------------------------------------------------------------ */

const PRIVACY_PANES = {
  accessibility: "Privacy_Accessibility",
  "screen-recording": "Privacy_ScreenCapture",
  "full-disk-access": "Privacy_AllFiles",
} as const;

type PrivacyId = keyof typeof PRIVACY_PANES;

const isPrivacyId = (id: PermissionId): id is PrivacyId => id in PRIVACY_PANES;

/** Full Disk Access can't be queried; macOS's own privacy database is only readable with it. */
function fullDiskAccess(): boolean | null {
  try {
    closeSync(openSync(join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"), "r"));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES" ? false : null;
  }
}

async function privacyChecks(): Promise<PermissionStatus[]> {
  if (process.platform !== "darwin") return [];
  const out: PermissionStatus[] = [];
  const computer = getSettings().computer.enabled && (await helperAvailability()).available;
  const perms = computer
    ? await getHelper()
        .then((h) => h.permissions())
        .catch(() => null)
    : null;
  if (perms) {
    out.push({
      id: "accessibility",
      name: "Accessibility",
      ok: perms.accessibility,
      detail: perms.accessibility ? "Agents can click and type in what you share" : "Not allowed yet — agents can't click or type",
      path: null,
      required: false,
      fix: "request",
      fixHint: perms.accessibility ? "" : "Allow Godmode in System Settings → Privacy & Security → Accessibility.",
    });
    out.push({
      id: "screen-recording",
      name: "Screen Recording",
      ok: perms.screenRecording,
      detail: perms.screenRecording ? "Agents can see the windows and screens you share" : "Not allowed yet — agents can't see windows or screens",
      path: null,
      required: false,
      fix: "request",
      fixHint: perms.screenRecording ? "" : "Allow Godmode in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Godmode.",
    });
  }
  // Only worth a row once it matters: it is on, or macOS has kept Godmode out of a browser's data folder.
  const fda = fullDiskAccess();
  const blocked = blockedProfileRoots();
  if (fda === true || (fda === false && blocked.length)) {
    out.push({
      id: "full-disk-access",
      name: "Full Disk Access",
      ok: fda,
      detail: fda ? "Godmode can import sign-ins from your browser profiles" : "macOS keeps Godmode out of your browser profiles, so sign-ins can't be imported",
      path: fda ? null : (blocked[0] ?? null),
      required: false,
      fix: "request",
      fixHint: fda ? "" : "Allow Godmode in System Settings → Privacy & Security → Full Disk Access, then restart Godmode.",
    });
  }
  return out;
}

/** Show the system's own dialog, and the settings pane when it stays unanswered (macOS asks only once). */
async function requestPrivacy(id: PrivacyId): Promise<void> {
  if (id !== "full-disk-access") {
    const helper = await getHelper();
    const granted = await helper.call<{ accessibility: boolean; screenRecording: boolean }>(
      "requestPermissions",
      { accessibility: id === "accessibility", screenRecording: id === "screen-recording" },
      30_000,
    );
    if (id === "accessibility" ? granted.accessibility : granted.screenRecording) return;
  }
  await runCommand(["/usr/bin/open", `x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[id]}`], { timeoutMs: 10_000 });
}

/* ------------------------------------------------------------------ */
/* Report & repair                                                      */
/* ------------------------------------------------------------------ */

function fileChecks(): Check[] {
  return [checkDataDir(), ...(isWin() ? [] : [checkDataPrivate(), checkToolBinaries()]), checkClaudeConfig()];
}

/**
 * `privacy: false` leaves out the macOS privacy permissions: they belong to the app that runs Godmode, so a one-off
 * command in a terminal would report the terminal's.
 */
export async function checkPermissions(opts: { privacy?: boolean } = {}): Promise<PermissionReport> {
  const permissions = [...fileChecks().map((c) => c.status), ...(opts.privacy === false ? [] : await privacyChecks())];
  return { ok: permissions.every((p) => p.ok || !p.required), checkedAt: now(), permissions };
}

/**
 * Solve one permission problem. `interactive: false` (the background upkeep) never opens a system dialog: those wait
 * for the human to ask.
 */
export async function fixPermission(id: PermissionId, opts: { interactive?: boolean } = {}): Promise<FixResult> {
  const result = (name: string, outcome: FixResult["outcome"], output: string): FixResult => ({ kind: "permission", id, name, outcome, output });

  if (isPrivacyId(id)) {
    const before = (await privacyChecks()).find((p) => p.id === id);
    if (!before) return result(id, "failed", "This permission doesn't apply on this computer.");
    if (before.ok) return result(before.name, "fixed", before.detail);
    if (opts.interactive === false) return result(before.name, "manual", before.fixHint);
    try {
      await requestPrivacy(id);
    } catch (err) {
      return result(before.name, "failed", err instanceof Error ? err.message : String(err));
    }
    const after = (await privacyChecks()).find((p) => p.id === id);
    bus.changed("computer");
    return after?.ok ? result(before.name, "fixed", after.detail) : result(before.name, "pending", before.fixHint);
  }

  const current = () => fileChecks().find((c) => c.status.id === id);
  let check = current();
  if (!check) return result(id, "failed", "This permission doesn't apply on this computer.");
  const name = check.status.name;
  const attempted = new Set<string>();
  const errors: string[] = [];
  // One repair can uncover the next (a folder that couldn't be entered hides what is inside): go on while it helps.
  for (let round = 0; round < 4 && !check.status.ok; round++) {
    const todo = check.findings.filter((f) => f.repair && !attempted.has(f.path));
    if (!todo.length) break;
    for (const f of todo) {
      attempted.add(f.path);
      try {
        f.repair!();
        log.info(`repaired ${f.path} (${f.problem})`);
      } catch (err) {
        errors.push(`${tilde(f.path)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    check = current()!;
  }
  // The system check found these tools broken; it has to look again.
  if (id === "tool-binaries" && attempted.size) resetDoctorCache();
  if (check.status.ok) return result(name, "fixed", check.status.detail);
  // Tried and still wrong: from now on this is the human's to solve.
  for (const f of check.findings) if (f.repair && attempted.has(f.path)) stuck.add(f.path);
  if (errors.length) return result(name, "failed", errors.join("\n"));
  const left = current()!.status;
  return result(name, "manual", `${left.detail}\n${left.fixHint}`);
}
