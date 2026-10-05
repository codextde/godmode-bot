/**
 * Cleanup (Settings → Cleanup): a self check of Godmode's data folder and what piles up in it over time — leftovers of
 * interrupted runs, browser caches, worktrees of finished tasks, clones nothing uses, free database pages, old logs,
 * unfinished VM downloads and the trash.
 *
 * Only Godmode's own files are removed. Whatever may hold work stays: checkouts with uncommitted changes or commits no
 * branch holds, clones with commits that were never pushed, and anything an agent or a browser uses right now. What is
 * removed is looked at twice: for the report, and again right before it goes.
 */
import { existsSync, readlinkSync, statfsSync, statSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CleanupEntry, CleanupId, CleanupItem, CleanupReport, CleanupResult, CleanupRun, HealthCheck, StorageArea, StorageUsage } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { backupInProgress } from "../backup/backup";
import { getRegistered } from "../browser/state";
import { config } from "../config";
import { all, get, getDb, getMeta, setMeta } from "../db";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { removeCheckoutUnless, repoCacheDir, whileCloneIdle } from "../tasks/git";
import { imageDownloadInProgress, removeImage, vmStatus } from "../vm/service";
import { vmRoot, vmSupport } from "../vm/tart";
import { now, parseJson } from "../util";
import { resolveGit } from "./doctor";
import { reposDir, runGit } from "./workspaceSources";

const log = logger("cleanup");

const NAMES = {
  "temp-files": "Leftovers of interrupted work",
  "browser-cache": "Browser caches",
  "task-worktrees": "Worktrees of finished tasks",
  "task-clones": "Clones no task uses",
  database: "Database",
  "old-logs": "Old logs",
  "vm-downloads": "Unfinished VM downloads",
  trash: "Trash",
  "vm-images": "Downloaded macOS images",
} as const satisfies Record<CleanupId, string>;

export const CLEANUP_IDS = Object.keys(NAMES) as [CleanupId, ...CleanupId[]];

/** Safe without a look: what "Free …" preselects, and what the automatic cleanup and `godmode cleanup --fix` take. */
export const RECOMMENDED: CleanupId[] = ["temp-files", "browser-cache", "task-worktrees", "task-clones", "database", "old-logs"];

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** A finished task keeps its worktree this long: time for a last look or a follow-up (longer when nobody asked). */
const GRACE = { asked: DAY, automatic: 7 * DAY };
const ENTRY_LIMIT = 50;
/** Less free room in the database isn't worth rewriting it. */
const WORTH_IT = 1024 * 1024;
const BUSY = "Agents are working — this is cleaned once they are done.";
const LAST_RUN = "cleanup.lastRun";
const LAST_AUTOMATIC = "cleanup.lastAutomatic";

let tempDir = tmpdir;

/** Tests: look for leftovers in this folder instead of the system's temp folder (null = the system's). */
export function __setTempDirForTests(dir: string | null) {
  tempDir = dir ? () => dir : tmpdir;
}

/* ------------------------------------------------------------------ */
/* Disk use                                                             */
/* ------------------------------------------------------------------ */

interface Size {
  bytes: number;
  modified: number;
}

const ZERO: Size = { bytes: 0, modified: 0 };

function sum(sizes: Size[], base: Size = ZERO): Size {
  return sizes.reduce((a, b) => ({ bytes: a.bytes + b.bytes, modified: Math.max(a.modified, b.modified) }), base);
}

/** What a file takes on disk: sparse files (VM disks) only count their written blocks. */
function onDisk(st: { size: number; blocks?: number }): number {
  return process.platform !== "win32" && typeof st.blocks === "number" ? st.blocks * 512 : st.size;
}

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Sizes of files and folders during one scan; every folder is walked once, however many questions touch it. */
class Sizes {
  private dirs = new Map<string, Promise<Size>>();
  private io = limiter(64);

  of(path: string): Promise<Size> {
    return this.dirs.get(path) ?? this.walk(path);
  }

  private async walk(path: string): Promise<Size> {
    const st = await this.io(() => lstat(path)).catch(() => null);
    if (!st) return ZERO;
    const own = { bytes: onDisk(st), modified: st.mtimeMs };
    if (!st.isDirectory()) return own;
    const size = this.io(() => readdir(path)).then(
      async (children) => sum(await Promise.all(children.map((name) => this.of(join(path, name)))), own),
      () => own,
    );
    this.dirs.set(path, size);
    return size;
  }
}

function fileSize(path: string): number {
  try {
    return onDisk(statSync(path));
  } catch {
    return 0;
  }
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

async function isDir(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isDirectory() ?? false;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function diskSpace(): { freeBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(config().dataDir);
    return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Categories                                                           */
/* ------------------------------------------------------------------ */

/** A clean step found, on its last look, a reason to leave its target alone. */
class Kept extends Error {}

interface Target {
  entry: CleanupEntry;
  /** Removes it (null while it is kept); returns the bytes freed when they differ from the entry's. Throws `Kept`. */
  clean: (() => Promise<number | void>) | null;
}

interface Category {
  id: CleanupId;
  detail: string;
  blocked?: string | null;
  targets: Target[];
}

interface Scan {
  sizes: Sizes;
  activeRuns: Set<string>;
  busyAgents: Set<string>;
  /** Chats with a run that is working or paused. */
  busyChats: Set<string>;
  automatic: boolean;
  at: number;
}

function newScan(automatic = false): Scan {
  // The table too: `godmode cleanup` runs in a process of its own while the core may be working.
  const active = [
    ...listActiveRuns(),
    ...all<{ runId: string; agentId: string; conversationId: string }>(
      "SELECT id AS runId, agent_id AS agentId, conversation_id AS conversationId FROM runs WHERE status IN ('queued', 'running')",
    ),
  ];
  const paused = all<{ conversation_id: string }>("SELECT conversation_id FROM paused_runs").map((p) => p.conversation_id);
  return {
    sizes: new Sizes(),
    activeRuns: new Set(active.map((r) => r.runId)),
    busyAgents: new Set(active.map((r) => r.agentId)),
    busyChats: new Set([...active.map((r) => r.conversationId), ...paused]),
    automatic,
    at: Date.now(),
  };
}

function iso(ms: number): string | null {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

async function target(scan: Scan, path: string, name: string, opts: { kept?: string | null; clean?: () => Promise<number | void> } = {}): Promise<Target> {
  const size = await scan.sizes.of(path);
  const kept = opts.kept ?? null;
  return { entry: { name, path, bytes: size.bytes, modifiedAt: iso(size.modified), kept }, clean: kept ? null : (opts.clean ?? (() => remove(path))) };
}

const RUN_FILE = /^godmode-(?:mcp|prompt|agents|settings)-(run_[A-Za-z0-9]+)\.(?:json|md)$/;
const SCRATCH = /^godmode-(?:pr|claude-mem|ua|import)-/;
const CLONING = /\.cloning-[a-z0-9]+$/;

async function tempFiles(scan: Scan): Promise<Category> {
  const targets: Target[] = [];
  // The system's temp folder may be shared with another Godmode: only what nobody touched for a day.
  const tmp = tempDir();
  for (const name of await names(tmp)) {
    const run = RUN_FILE.exec(name)?.[1];
    if (!run && !SCRATCH.test(name)) continue;
    const path = join(tmp, name);
    if (process.getuid && (await lstat(path).catch(() => null))?.uid !== process.getuid()) continue;
    if ((run && scan.activeRuns.has(run)) || scan.at - (await scan.sizes.of(path)).modified < DAY) continue;
    targets.push(await target(scan, path, name));
  }

  // browser-use's folder per run; a run removes its own when it ends, unless Godmode was stopped meanwhile.
  const browserUse = join(config().dataDir, "browser-use");
  const profiles = new Set(all<{ id: string }>("SELECT id FROM browser_profiles").map((p) => p.id));
  const agents = new Set(all<{ id: string }>("SELECT id FROM agents").map((a) => a.id));
  for (const profile of await names(browserUse)) {
    if (!profiles.has(profile)) {
      targets.push(await target(scan, join(browserUse, profile), "Browser files of a deleted profile"));
      continue;
    }
    for (const agent of await names(join(browserUse, profile))) {
      if (!agents.has(agent)) {
        targets.push(await target(scan, join(browserUse, profile, agent), "Browser files of a deleted agent"));
        continue;
      }
      const runs = join(browserUse, profile, agent, "runs");
      for (const run of await names(runs)) {
        if (scan.activeRuns.has(run) || scan.at - (await scan.sizes.of(join(runs, run))).modified < HOUR) continue;
        targets.push(await target(scan, join(runs, run), `Browser files of run ${run}`));
      }
    }
  }

  // Clones only take their name once complete; what is left under the temporary one was interrupted.
  const repos = reposDir();
  for (const dir of [repos, ...(await names(repos)).filter((n) => n !== ".trash").map((n) => join(repos, n))]) {
    for (const name of await names(dir)) {
      if (!CLONING.test(name)) continue;
      const path = join(dir, name);
      if (scan.at - (await scan.sizes.of(path)).modified < DAY) continue;
      targets.push(await target(scan, path, `Interrupted clone ${name.replace(CLONING, "")}`));
    }
  }
  return { id: "temp-files", detail: "Temporary files of runs, clones and imports that were cut off — when Godmode quit in the middle of them.", targets };
}

/** Caches Chromium rebuilds by itself; cookies, logins and site data stay. */
const PROFILE_CACHES = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const BROWSER_CACHES = ["GrShaderCache", "GraphiteDawnCache", "ShaderCache"];

/**
 * Chromium holds `SingletonLock` (→ "<host>-<pid>") while it runs; one left by a crash names a process that is gone.
 * On Windows it holds `lockfile`, which a crash may leave behind — then the cache waits for the next clean exit.
 */
function chromiumRunning(userDataDir: string): boolean {
  if (process.platform === "win32") return existsSync(join(userDataDir, "lockfile"));
  let lock: string;
  try {
    lock = readlinkSync(join(userDataDir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function browserCaches(scan: Scan): Promise<Category> {
  const root = config().browserDir;
  const targets: Target[] = [];
  for (const profile of all<{ id: string; name: string; user_data_dir: string }>("SELECT id, name, user_data_dir FROM browser_profiles ORDER BY name")) {
    const dir = profile.user_data_dir;
    if (!inside(root, dir) || !(await isDir(dir))) continue;
    const profiles = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name)))
      .map((d) => d.name);
    const caches = [...BROWSER_CACHES.map((c) => join(dir, c)), ...profiles.flatMap((p) => PROFILE_CACHES.map((c) => join(dir, p, c)))];
    const size = sum(await Promise.all(caches.map((c) => scan.sizes.of(c))));
    if (!size.bytes) continue;
    const open = () => !!getRegistered(profile.id) || chromiumRunning(dir);
    const kept = open() ? "The browser is open — its cache is cleared once it is closed." : null;
    targets.push({
      entry: { name: profile.name, path: dir, bytes: size.bytes, modifiedAt: iso(size.modified), kept },
      clean: kept
        ? null
        : async () => {
            for (const cache of caches) {
              if (open()) throw new Kept("The browser was opened in the meantime.");
              await remove(cache);
            }
          },
    });
  }
  return { id: "browser-cache", detail: "Pictures, scripts and shaders Chromium keeps from visited pages. Sign-ins, cookies and site data stay.", targets };
}

const UNREADABLE = "Git can't read this folder — have a look at it before removing it.";
/** What git leaves in its folder while a rebase, merge, cherry-pick, revert or bisect is under way. */
const UNDER_WAY = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];

async function gitLines(args: string[], cwd: string): Promise<string[] | null> {
  const res = await runGit(args, { cwd, timeoutMs: 60_000 }).catch(() => null);
  return res?.ok ? res.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

/** Why a checkout can't go without losing work; null = everything in it is safe in its repository. */
async function unsavedWork(dir: string): Promise<string | null> {
  const gitPath = await lstat(join(dir, ".git")).catch(() => null);
  if (!gitPath) return "Not a git checkout — have a look at it before removing it.";
  // Said outright: the human's git settings may hide new files (status.showUntrackedFiles) or submodule changes.
  const changes = await gitLines(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], dir);
  if (!changes) return UNREADABLE;
  if (changes.length) return "Has uncommitted changes.";
  const marks = await gitLines(["rev-parse", ...UNDER_WAY.flatMap((f) => ["--git-path", f])], dir);
  if (!marks) return UNREADABLE;
  if (marks.some((path) => existsSync(resolve(dir, path)))) return "A rebase or merge is under way.";
  // Commits only this checkout's HEAD reaches (detached, or left by a rebase) would go with it.
  const adrift = await gitLines(["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--remotes"], dir);
  if (!adrift) return UNREADABLE;
  if (adrift.length) return "Has commits that are on no branch.";
  // A full clone (tasks from before worktrees) holds its own commits and stashes; a worktree's live in its repository.
  if (gitPath.isDirectory()) {
    const unpushed = await gitLines(["rev-list", "-n", "1", "--branches", "--not", "--remotes"], dir);
    if (!unpushed) return UNREADABLE;
    if (unpushed.length) return "Has commits that were never pushed.";
    if (await gitLines(["rev-parse", "--quiet", "--verify", "refs/stash"], dir)) return "Has stashed changes.";
  }
  return null;
}

interface TaskRow {
  id: string;
  number: number;
  title: string;
  status: string;
  conversation_id: string | null;
  completed_at: string | null;
  updated_at: string;
}

const TASK_COLUMNS = "id, number, title, status, conversation_id, completed_at, updated_at";

/** Done or cancelled for long enough, with nothing working in its chat. */
function finished(task: TaskRow, scan: Scan): boolean {
  if (task.status !== "done" && task.status !== "cancelled") return false;
  if (scan.at - Date.parse(task.completed_at ?? task.updated_at) < (scan.automatic ? GRACE.automatic : GRACE.asked)) return false;
  return !(task.conversation_id && scan.busyChats.has(task.conversation_id));
}

async function taskWorktrees(scan: Scan): Promise<Category> {
  const root = config().tasksDir;
  const tasks = new Map(all<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks`).map((t) => [t.id, t]));
  const targets: Target[] = [];
  for (const name of await names(root)) {
    const dir = join(root, name);
    if (!(await isDir(dir))) continue;
    const task = tasks.get(name);
    if (task && !finished(task, scan)) continue;
    // Folders without a task (it was deleted, or an older backup was restored): unasked, only once they stood still.
    if (!task && scan.automatic && scan.at - (await scan.sizes.of(dir)).modified < GRACE.automatic) continue;
    const clean = async () => {
      // Asked again inside the repository's lock: the task may have been reopened, the agent may be at work.
      const reason = await removeCheckoutUnless(dir, async () => {
        const current = get<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, name);
        if (current && !finished(current, newScan(scan.automatic))) return "Its task is being worked on again.";
        return unsavedWork(dir);
      });
      if (reason) throw new Kept(reason);
    };
    targets.push(await target(scan, dir, task ? `#${task.number} ${task.title}` : "Folder of a deleted task", { kept: await unsavedWork(dir), clean }));
  }
  return {
    id: "task-worktrees",
    detail: "Checkouts of tasks that are done or cancelled, and of deleted ones. Their branches stay — moving a task back to Todo checks it out again.",
    targets,
  };
}

function usedClones(): Set<string> {
  return new Set(all<{ repo_url: string }>("SELECT DISTINCT repo_url FROM tasks WHERE repo_url != ''").map((t) => basename(repoCacheDir(t.repo_url))));
}

async function cloneInUse(dir: string): Promise<string | null> {
  const worktrees = await gitLines(["worktree", "list", "--porcelain"], dir);
  if (!worktrees) return UNREADABLE;
  const checkouts = worktrees
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => !p.endsWith(".git"));
  for (const path of checkouts) if (await isDir(path)) return "A task folder still uses it.";
  const unpushed = await gitLines(["rev-list", "-n", "1", "--branches", "--not", "--remotes"], dir);
  if (!unpushed) return UNREADABLE;
  return unpushed.length ? "Holds commits that were never pushed." : null;
}

async function taskClones(scan: Scan): Promise<Category | null> {
  const root = join(reposDir(), ".tasks");
  const clones = (await names(root)).filter((n) => n.endsWith(".git"));
  if (!clones.length || !resolveGit()) return null;
  const used = usedClones();
  const targets: Target[] = [];
  for (const name of clones) {
    if (used.has(name)) continue;
    const dir = join(root, name);
    const clean = () =>
      whileCloneIdle(dir, async () => {
        const reason = usedClones().has(name) ? "A task uses it again." : await cloneInUse(dir);
        if (reason) throw new Kept(reason);
        await remove(dir);
      });
    targets.push(await target(scan, dir, name.replace(/-[0-9a-f]{12}\.git$/, ""), { kept: await cloneInUse(dir), clean }));
  }
  return { id: "task-clones", detail: "Godmode's copies of repositories whose tasks are all gone. One that holds commits never pushed stays.", targets };
}

function pragma(name: string): number {
  const row = getDb().query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return Number(row?.[name] ?? 0);
}

const freePages = () => pragma("freelist_count") * pragma("page_size");

function database(scan: Scan): Category {
  const path = config().dbPath;
  const free = freePages();
  const size = () => fileSize(path) + fileSize(`${path}-wal`);
  const targets: Target[] = [];
  if (free >= WORTH_IT) {
    targets.push({
      entry: { name: basename(path), path, bytes: free, modifiedAt: null, kept: null },
      clean: async () => {
        const before = size();
        const db = getDb();
        // In WAL mode VACUUM writes the compacted pages to the WAL; only the checkpoint after it shrinks the file.
        db.run("VACUUM");
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        db.run("PRAGMA optimize");
        return Math.max(0, before - size());
      },
    });
  }
  return {
    id: "database",
    detail: "Room left in Godmode's database by deleted chats, runs and notifications, given back to the disk.",
    blocked: targets.length ? databaseBlocked(scan, path) : null,
    targets,
  };
}

function databaseBlocked(scan: Scan, path: string): string | null {
  if (scan.busyAgents.size) return BUSY;
  if (backupInProgress()) return "A backup is being made or restored.";
  // VACUUM writes a compacted copy, through the WAL, before it replaces the original.
  if ((diskSpace()?.freeBytes ?? Infinity) < fileSize(path) * 2) return "Not enough free disk space to compact the database.";
  return null;
}

const PREVIOUS_LOGS: [string, string][] = [
  ["godmode.1.jsonl", "Previous diagnostic log"],
  ["desktop.log.1", "Previous desktop app log"],
  ["core.log", "Log of an older Godmode version"],
];

async function oldLogs(scan: Scan): Promise<Category> {
  const targets: Target[] = [];
  for (const [name, label] of PREVIOUS_LOGS) {
    const path = join(config().logsDir, name);
    if (fileSize(path) && scan.at - (await scan.sizes.of(path)).modified > 7 * DAY) targets.push(await target(scan, path, label));
  }
  const vmLogs = join(vmRoot(), "logs");
  const vms = new Set(all<{ id: string }>("SELECT id FROM vms").map((v) => v.id));
  for (const name of await names(vmLogs)) {
    if (!name.endsWith(".log") || vms.has(name.slice(0, -4))) continue;
    targets.push(await target(scan, join(vmLogs, name), `Log of a deleted VM (${name.slice(0, -4)})`));
  }
  return { id: "old-logs", detail: "Logs that were replaced by newer ones more than a week ago, and logs of deleted VMs.", targets };
}

const DOWNLOADING = "An image is downloading right now.";

async function vmDownloads(scan: Scan): Promise<Category | null> {
  if (!vmSupport().supported) return null;
  const dir = join(vmRoot(), "downloads");
  const layers = await names(dir);
  const clean = async () => {
    if (imageDownloadInProgress()) throw new Kept(DOWNLOADING);
    for (const layer of layers) await remove(join(dir, layer));
  };
  return {
    id: "vm-downloads",
    detail: "Parts of macOS images whose download stopped. Downloading the image again continues from them.",
    blocked: imageDownloadInProgress() ? DOWNLOADING : null,
    targets: layers.length ? [await target(scan, dir, `${layers.length} partly downloaded ${layers.length === 1 ? "layer" : "layers"}`, { clean })] : [],
  };
}

const TRASH_STAMP = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z(?:-\d+)?$/;

function trashedAt(name: string): number {
  const m = TRASH_STAMP.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] ?? "000"}Z`) : 0;
}

async function trash(scan: Scan): Promise<Category> {
  const targets: Target[] = [];
  const bins: { dir: string; restored: string; label: (name: string) => string }[] = [
    { dir: join(config().agentsDir, ".trash"), restored: "Agents", label: (n) => `Agent “${n}”` },
    {
      dir: join(reposDir(), ".trash"),
      restored: "Repositories",
      label: (n) => (/^tsk_/.test(n) ? "Leftover task folder" : `Repository “${n.replace(/^wsp?_[A-Za-z0-9]+-/, "")}”`),
    },
    { dir: join(config().browserDir, ".trash"), restored: "Browser profiles", label: () => "Browser profiles" },
  ];
  for (const bin of bins) {
    for (const name of await names(bin.dir)) {
      const label = name.startsWith("restore-") ? `${bin.restored} before a backup was restored` : bin.label(name.replace(TRASH_STAMP, ""));
      const t = await target(scan, join(bin.dir, name), label);
      t.entry.modifiedAt = iso(trashedAt(name)) ?? t.entry.modifiedAt;
      targets.push(t);
    }
  }
  return { id: "trash", detail: "Deleted agents, removed repositories and what a backup restore replaced — kept instead of deleted, in case they held work.", targets };
}

async function vmImages(): Promise<Category | null> {
  if (!vmSupport().supported) return null;
  const status = await vmStatus().catch(() => null);
  if (!status?.tart.installed) return null;
  const downloading = new Set(Object.keys(status.downloads));
  const targets: Target[] = status.images
    .filter((i) => i.downloaded)
    .map((i) => {
      const kept = downloading.has(i.image) ? "Downloading right now." : null;
      return { entry: { name: i.name, path: null, bytes: i.sizeBytes ?? 0, modifiedAt: null, kept }, clean: kept ? null : () => removeImage(i.image) };
    });
  return { id: "vm-images", detail: "What new VMs and resets start from. VMs made from an image keep working; it is downloaded again when needed.", targets };
}

const SCANNERS: Record<CleanupId, (scan: Scan) => Promise<Category | null> | Category> = {
  "temp-files": tempFiles,
  "browser-cache": browserCaches,
  "task-worktrees": taskWorktrees,
  "task-clones": taskClones,
  database,
  "old-logs": oldLogs,
  "vm-downloads": vmDownloads,
  trash,
  "vm-images": vmImages,
};

/* ------------------------------------------------------------------ */
/* Self check                                                           */
/* ------------------------------------------------------------------ */

/** `quick_check` reads the whole database while everything else waits, so its answer is kept for an hour. */
let integrity: { at: number; problems: string[] } | null = null;

function databaseCheck(fresh: boolean): HealthCheck {
  const base = { id: "database", name: "Database" } as const;
  try {
    if (fresh || !integrity || Date.now() - integrity.at > HOUR) {
      const rows = getDb().query("PRAGMA quick_check").all() as Record<string, string>[];
      integrity = { at: Date.now(), problems: rows.map((r) => String(Object.values(r)[0])).filter((p) => p !== "ok") };
    }
    if (!integrity.problems.length) return { ...base, status: "ok", detail: `Intact · ${formatBytes(fileSize(config().dbPath))}` };
    return { ...base, status: "error", detail: `Damaged (${integrity.problems[0]}). Restore a backup from Settings → Backup.` };
  } catch (err) {
    return { ...base, status: "error", detail: `Couldn't be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function diskCheck(disk: CleanupReport["disk"]): HealthCheck {
  const base = { id: "disk", name: "Disk space" } as const;
  if (!disk) return { ...base, status: "warn", detail: "Couldn't find out how much space is left." };
  const free = `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`;
  if (disk.freeBytes < 2e9) return { ...base, status: "error", detail: `${free} — runs, browsers and VMs may fail.` };
  if (disk.freeBytes < 10e9) return { ...base, status: "warn", detail: `${free} — getting tight.` };
  return { ...base, status: "ok", detail: free };
}

async function worktreeCheck(): Promise<HealthCheck> {
  const base = { id: "worktrees", name: "Task worktrees" } as const;
  const tasks = new Set(all<{ id: string }>("SELECT id FROM tasks").map((t) => t.id));
  const folders = (await readdir(config().tasksDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  const orphans = folders.filter((f) => !tasks.has(f)).length;
  if (!folders.length) return { ...base, status: "ok", detail: "No task has a worktree right now." };
  const owned = `${folders.length - orphans} ${folders.length - orphans === 1 ? "belongs" : "belong"} to tasks`;
  if (!orphans) return { ...base, status: "ok", detail: `${owned}, none left over.` };
  return { ...base, status: "warn", detail: `${owned}, ${orphans} left over from deleted tasks.` };
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

async function storage(scan: Scan): Promise<StorageUsage[]> {
  const cfg = config();
  const areas: [StorageArea, string, string[]][] = [
    ["agents", "Agents", [cfg.agentsDir]],
    ["browser", "Browser", [cfg.browserDir, join(cfg.dataDir, "browser-use")]],
    ["vms", "Virtual machines", [cfg.vmDir]],
    ["repos", "Worktrees & clones", [cfg.tasksDir, reposDir()]],
    ["database", "Database & logs", [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`, cfg.logsDir]],
  ];
  const known = new Set(areas.flatMap(([, , paths]) => paths));
  const rest = (await names(cfg.dataDir)).map((n) => join(cfg.dataDir, n)).filter((p) => !known.has(p));
  const usage = await Promise.all(
    [...areas, ["other", "Everything else", rest] as [StorageArea, string, string[]]].map(async ([area, name, paths]) => ({
      area,
      name,
      bytes: sum(await Promise.all(paths.map((p) => scan.sizes.of(p)))).bytes,
    })),
  );
  return usage.filter((u) => u.bytes > 0).sort((a, b) => Number(a.area === "other") - Number(b.area === "other") || b.bytes - a.bytes);
}

/* ------------------------------------------------------------------ */
/* Report and cleaning                                                  */
/* ------------------------------------------------------------------ */

export function lastCleanup(): CleanupRun | null {
  return parseJson<CleanupRun | null>(getMeta(LAST_RUN), null);
}

/** When the automatic cleanup last ran (0 = never). Cleaning by hand doesn't postpone it. */
export function lastAutomaticCleanup(): number {
  return Date.parse(getMeta(LAST_AUTOMATIC) ?? "") || 0;
}

function toItem(c: Category): CleanupItem {
  const cleanable = c.targets.filter((t) => !t.entry.kept);
  return {
    id: c.id,
    name: NAMES[c.id],
    detail: c.detail,
    bytes: cleanable.reduce((n, t) => n + t.entry.bytes, 0),
    count: cleanable.length,
    recommended: RECOMMENDED.includes(c.id),
    blocked: c.blocked ?? null,
    // What stays comes first: its reason is what the human needs to read.
    entries: c.targets
      .map((t) => t.entry)
      .sort((a, b) => Number(!!b.kept) - Number(!!a.kept) || b.bytes - a.bytes)
      .slice(0, ENTRY_LIMIT),
  };
}

async function report(fresh: boolean): Promise<CleanupReport> {
  const look = newScan();
  const disk = diskSpace();
  const categories = Promise.all(
    CLEANUP_IDS.map((id) =>
      Promise.resolve(look)
        .then(SCANNERS[id])
        .catch((err) => {
          log.warn(`could not look at ${id}`, err);
          return null;
        }),
    ),
  );
  const [usage, found, worktrees] = await Promise.all([storage(look), categories, worktreeCheck()]);
  return {
    checkedAt: now(),
    dataDir: config().dataDir,
    disk,
    storage: usage,
    checks: [databaseCheck(fresh), diskCheck(disk), worktrees],
    items: found.filter((c): c is Category => !!c).map(toItem),
    lastRun: lastCleanup(),
  };
}

let scanning: Promise<CleanupReport> | null = null;

/** What takes up space, what can go, and the self check. Looks at the same moment share one walk; `fresh` checks the database again too. */
export function scanCleanup(opts: { fresh?: boolean } = {}): Promise<CleanupReport> {
  if (opts.fresh) return report(true);
  scanning ??= report(false).finally(() => (scanning = null));
  return scanning;
}

/**
 * Clean the given items. Each is looked at again first — between the report and the click, a browser may have opened
 * or a task may have been reopened — and what must stay is left alone.
 */
export async function runCleanup(ids: readonly CleanupId[], opts: { automatic?: boolean } = {}): Promise<CleanupRun> {
  const startedAt = now();
  const results: CleanupResult[] = [];
  for (const id of CLEANUP_IDS.filter((i) => ids.includes(i))) {
    const result: CleanupResult = { id, name: NAMES[id], ok: true, freedBytes: 0, removed: 0, kept: 0, output: "" };
    let c: Category | null;
    try {
      c = await SCANNERS[id](newScan(!!opts.automatic));
    } catch (err) {
      log.warn(`could not look at ${id}`, err);
      results.push({ ...result, ok: false, output: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!c) continue;
    if (c.blocked) {
      results.push({ ...result, ok: false, kept: c.targets.length, output: c.blocked });
      continue;
    }
    const errors: string[] = [];
    for (const t of c.targets) {
      if (!t.clean) {
        result.kept++;
        continue;
      }
      try {
        const freed = await t.clean();
        result.freedBytes += typeof freed === "number" ? freed : t.entry.bytes;
        result.removed++;
      } catch (err) {
        if (err instanceof Kept) result.kept++;
        else errors.push(`${t.entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    result.ok = !errors.length;
    result.output = errors.join("\n");
    if (errors.length) log.warn(`cleanup of ${id} left ${errors.length} behind: ${result.output.slice(0, 500)}`);
    results.push(result);
  }
  const run: CleanupRun = { automatic: !!opts.automatic, startedAt, finishedAt: now(), freedBytes: results.reduce((n, r) => n + r.freedBytes, 0), results };
  if (run.freedBytes || results.some((r) => r.removed)) {
    log.info(`${run.automatic ? "automatic cleanup" : "cleanup"} freed ${formatBytes(run.freedBytes)} (${results.map((r) => `${r.id} ${r.removed}`).join(", ")})`);
  }
  setMeta(LAST_RUN, JSON.stringify(run));
  if (run.automatic) setMeta(LAST_AUTOMATIC, run.finishedAt);
  return run;
}
