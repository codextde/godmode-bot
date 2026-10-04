/**
 * Cleanup (Settings → Cleanup): a self check of Godmode's data folder and what piles up in it over time — leftovers of
 * interrupted runs, browser caches, worktrees of finished tasks, clones nothing uses, loose git objects, free database
 * pages, unfinished VM downloads and the trash.
 *
 * Only Godmode's own files are removed (uv prunes its own cache). Whatever may hold work stays: checkouts with
 * uncommitted changes, clones with commits that were never pushed, and anything an agent or a browser uses right now.
 */
import { readlinkSync, statfsSync, statSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { CleanupEntry, CleanupId, CleanupReport, CleanupResult, CleanupRun, HealthCheck, StorageArea, StorageUsage } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { withRepoLock } from "../agents/repo";
import { backupInProgress } from "../backup/backup";
import { getRegistered } from "../browser/state";
import { config } from "../config";
import { all, getDb, getMeta, setMeta } from "../db";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { removeCheckout, repoCacheDir } from "../tasks/git";
import { imageDownloadInProgress, removeImage, vmStatus } from "../vm/service";
import { vmRoot, vmSupport } from "../vm/tart";
import { now, parseJson } from "../util";
import { resolveGit } from "./doctor";
import { reposDir, runGit } from "./workspaceSources";

const log = logger("cleanup");

export const CLEANUP_IDS = [
  "temp-files",
  "browser-cache",
  "task-worktrees",
  "task-clones",
  "agent-history",
  "database",
  "old-logs",
  "vm-downloads",
  "trash",
  "vm-images",
] as const satisfies readonly CleanupId[];

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** A finished task keeps its worktree this long: time for a last look or a follow-up (longer when nobody asked). */
const FINISHED_GRACE = { asked: DAY, automatic: 7 * DAY };
const ENTRY_LIMIT = 50;
/** Smaller savings aren't worth a VACUUM or a git gc. */
const WORTH_IT = 1024 * 1024;
const BUSY = "Agents are working — this is cleaned once they are done.";
const LAST_RUN = "cleanup.lastRun";

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
    const known = this.dirs.get(path);
    if (known) return known;
    const size = this.walk(path);
    this.dirs.set(path, size);
    return size;
  }

  private async walk(path: string): Promise<Size> {
    const st = await this.io(() => lstat(path)).catch(() => null);
    if (!st) return ZERO;
    const own = { bytes: onDisk(st), modified: st.mtimeMs };
    if (!st.isDirectory()) return own;
    const children = await this.io(() => readdir(path, { withFileTypes: true })).catch(() => []);
    return sum(await Promise.all(children.map((d) => this.of(join(path, d.name)))), own);
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

/* ------------------------------------------------------------------ */
/* Categories                                                           */
/* ------------------------------------------------------------------ */

interface Target {
  entry: CleanupEntry;
  /** Removes it (null while it is kept); returns the bytes freed when they differ from the entry's. */
  clean: (() => Promise<number | void>) | null;
}

interface Category {
  id: CleanupId;
  name: string;
  detail: string;
  recommended: boolean;
  upTo?: boolean;
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
const HELPER_BUILD = /^(?:godmode-computer|computer)-[0-9a-f]{12}$/;

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

  // Every Godmode build unpacks its computer helper once; the newest is the one in use.
  const bin = join(config().dataDir, "bin");
  const helpers = await Promise.all(
    (await names(bin)).filter((n) => HELPER_BUILD.test(n)).map(async (n) => ({ path: join(bin, n), size: await scan.sizes.of(join(bin, n)) })),
  );
  helpers.sort((a, b) => b.size.modified - a.size.modified);
  for (const h of helpers.slice(1)) {
    if (scan.at - h.size.modified > 7 * DAY) targets.push(await target(scan, h.path, "Computer helper of an older Godmode version"));
  }
  return {
    id: "temp-files",
    name: "Leftovers of interrupted work",
    detail: "Temporary files of runs, clones and imports that were cut off — when Godmode quit in the middle of them.",
    recommended: true,
    targets,
  };
}

/** Caches Chromium rebuilds by itself; cookies, logins and site data stay. */
const PROFILE_CACHES = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const BROWSER_CACHES = ["GrShaderCache", "GraphiteDawnCache", "ShaderCache"];

/** Chromium holds `SingletonLock` (→ "<host>-<pid>") while it runs; one left by a crash names a process that is gone. */
function chromiumRunning(userDataDir: string): boolean {
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
            if (open()) throw new Error("The browser was opened in the meantime.");
            for (const cache of caches) await remove(cache);
          },
    });
  }
  return {
    id: "browser-cache",
    name: "Browser caches",
    detail: "Pictures, scripts and shaders Chromium keeps from visited pages. Sign-ins, cookies and site data stay.",
    recommended: true,
    targets,
  };
}

/** Why a checkout can't go without losing work; null = everything in it is safe in its repository. */
async function unsavedWork(dir: string): Promise<string | null> {
  const gitPath = await lstat(join(dir, ".git")).catch(() => null);
  // No checkout at all: a worktree whose creation was cut off.
  if (!gitPath) return null;
  const status = await runGit(["status", "--porcelain"], { cwd: dir, timeoutMs: 60_000 }).catch(() => null);
  if (!status?.ok) return "Git can't read this folder — have a look at it before removing it.";
  if (status.stdout.trim()) return "Has uncommitted changes.";
  // A full clone (tasks from before worktrees) holds its own commits; a worktree's live in its repository.
  if (gitPath.isDirectory()) {
    const unpushed = await runGit(["rev-list", "-n", "1", "--branches", "--not", "--remotes"], { cwd: dir, timeoutMs: 60_000 }).catch(() => null);
    if (!unpushed?.ok) return "Git can't read this folder — have a look at it before removing it.";
    if (unpushed.stdout.trim()) return "Has commits that were never pushed.";
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

async function taskWorktrees(scan: Scan): Promise<Category> {
  const root = config().tasksDir;
  const tasks = new Map(all<TaskRow>("SELECT id, number, title, status, conversation_id, completed_at, updated_at FROM tasks").map((t) => [t.id, t]));
  const targets: Target[] = [];
  for (const name of await names(root)) {
    const dir = join(root, name);
    if (!(await isDir(dir))) continue;
    const task = tasks.get(name);
    if (task) {
      const finished = task.status === "done" || task.status === "cancelled";
      const grace = scan.automatic ? FINISHED_GRACE.automatic : FINISHED_GRACE.asked;
      if (!finished || scan.at - Date.parse(task.completed_at ?? task.updated_at) < grace) continue;
      if (task.conversation_id && scan.busyChats.has(task.conversation_id)) continue;
    }
    const label = task ? `#${task.number} ${task.title}` : "Folder of a deleted task";
    targets.push(await target(scan, dir, label, { kept: await unsavedWork(dir), clean: () => removeCheckout(dir) }));
  }
  return {
    id: "task-worktrees",
    name: "Worktrees of finished tasks",
    detail: "Checkouts of tasks that are done or cancelled, and of deleted ones. Their branches stay — moving a task back to Todo checks it out again.",
    recommended: true,
    targets,
  };
}

async function taskClones(scan: Scan): Promise<Category | null> {
  const root = join(reposDir(), ".tasks");
  const clones = (await names(root)).filter((n) => n.endsWith(".git"));
  if (!clones.length || !resolveGit()) return null;
  const used = new Set(all<{ repo_url: string }>("SELECT DISTINCT repo_url FROM tasks WHERE repo_url != ''").map((t) => basename(repoCacheDir(t.repo_url))));
  const targets: Target[] = [];
  for (const name of clones) {
    if (used.has(name)) continue;
    const dir = join(root, name);
    const label = name.replace(/-[0-9a-f]{12}\.git$/, "");
    targets.push(await target(scan, dir, label, { kept: await cloneInUse(dir) }));
  }
  return {
    id: "task-clones",
    name: "Clones no task uses",
    detail: "Godmode's copies of repositories whose tasks are all gone. One that holds commits never pushed stays.",
    recommended: true,
    targets,
  };
}

async function cloneInUse(dir: string): Promise<string | null> {
  const worktrees = await runGit(["worktree", "list", "--porcelain"], { cwd: dir, timeoutMs: 60_000 }).catch(() => null);
  if (!worktrees?.ok) return "Git can't read this clone — have a look at it before removing it.";
  const checkouts = worktrees.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== dir && !p.endsWith(".git"));
  for (const path of checkouts) if (await isDir(path)) return "A task folder still uses it.";
  const unpushed = await runGit(["rev-list", "-n", "1", "--branches", "--not", "--remotes"], { cwd: dir, timeoutMs: 60_000 }).catch(() => null);
  if (!unpushed?.ok) return "Git can't read this clone — have a look at it before removing it.";
  return unpushed.stdout.trim() ? "Holds commits that were never pushed." : null;
}

async function agentHistory(scan: Scan): Promise<Category | null> {
  if (!resolveGit()) return null;
  const targets: Target[] = [];
  for (const agent of all<{ id: string; name: string; repo_path: string }>("SELECT id, name, repo_path FROM agents ORDER BY name")) {
    const objects = join(agent.repo_path, ".git", "objects");
    const loose = (await names(objects)).filter((n) => /^[0-9a-f]{2}$/.test(n)).map((n) => join(objects, n));
    const size = sum(await Promise.all(loose.map((d) => scan.sizes.of(d))));
    if (size.bytes < WORTH_IT) continue;
    const kept = scan.busyAgents.has(agent.id) ? "Working right now." : null;
    targets.push({
      entry: { name: agent.name, path: agent.repo_path, bytes: size.bytes, modifiedAt: iso(size.modified), kept },
      clean: kept
        ? null
        : () =>
            withRepoLock(agent.repo_path, async () => {
              const git = join(agent.repo_path, ".git");
              const before = (await new Sizes().of(git)).bytes;
              // Objects only: refs and reflogs stay as isomorphic-git wrote them.
              const res = await runGit(["repack", "-a", "-d", "-q"], { cwd: agent.repo_path, timeoutMs: 10 * 60_000 });
              if (!res.ok) throw new Error(res.stderr.trim().split("\n").pop() || "git repack failed");
              return Math.max(0, before - (await new Sizes().of(git)).bytes);
            }),
    });
  }
  return {
    id: "agent-history",
    name: "Agent histories",
    detail: "Every run lands in its agent's git history as loose files. Packing them keeps every version in a fraction of the space.",
    recommended: true,
    upTo: true,
    targets,
  };
}

function pragma(name: string): number {
  const row = getDb().query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return Number(row?.[name] ?? 0);
}

function database(scan: Scan): Category {
  const path = config().dbPath;
  const free = pragma("freelist_count") * pragma("page_size");
  const wal = fileSize(`${path}-wal`);
  const targets: Target[] = [];
  if (free + wal >= WORTH_IT) {
    targets.push({
      entry: { name: "godmode.db", path, bytes: free + wal, modifiedAt: null, kept: null },
      clean: async () => {
        const before = fileSize(path) + fileSize(`${path}-wal`);
        const db = getDb();
        // In WAL mode VACUUM writes the compacted pages to the WAL; only the checkpoint after it shrinks the file.
        if (pragma("freelist_count") > 0) db.run("VACUUM");
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        db.run("PRAGMA optimize");
        return Math.max(0, before - fileSize(path) - fileSize(`${path}-wal`));
      },
    });
  }
  return {
    id: "database",
    name: "Database",
    detail: "Room left in Godmode's database by deleted chats, runs and notifications, given back to the disk.",
    recommended: true,
    blocked: databaseBlocked(scan, path),
    targets,
  };
}

function databaseBlocked(scan: Scan, path: string): string | null {
  if (scan.busyAgents.size) return BUSY;
  if (backupInProgress()) return "A backup is being made or restored.";
  // VACUUM writes a compacted copy before it replaces the original.
  if ((diskSpace()?.freeBytes ?? Infinity) < fileSize(path) * 1.2) return "Not enough free disk space to compact the database.";
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
  return { id: "old-logs", name: "Old logs", detail: "Logs that were replaced by newer ones more than a week ago, and logs of deleted VMs.", recommended: true, targets };
}

async function vmDownloads(scan: Scan): Promise<Category | null> {
  if (!vmSupport().supported) return null;
  const dir = join(vmRoot(), "downloads");
  const layers = await names(dir);
  const targets = layers.length ? [await target(scan, dir, `${layers.length} partly downloaded ${layers.length === 1 ? "layer" : "layers"}`, { clean: async () => { for (const l of layers) await remove(join(dir, l)); } })] : [];
  return {
    id: "vm-downloads",
    name: "Unfinished VM downloads",
    detail: "Parts of macOS images whose download stopped. Downloading the image again continues from them.",
    recommended: false,
    blocked: imageDownloadInProgress() ? "An image is downloading right now." : null,
    targets,
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
  return {
    id: "trash",
    name: "Trash",
    detail: "Deleted agents, removed repositories and what a backup restore replaced — kept instead of deleted, in case they held work.",
    recommended: false,
    targets,
  };
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
      return {
        entry: { name: i.name, path: null, bytes: i.sizeBytes ?? 0, modifiedAt: null, kept },
        clean: kept ? null : () => removeImage(i.image),
      };
    });
  return {
    id: "vm-images",
    name: "Downloaded macOS images",
    detail: "What new VMs and resets start from. VMs made from an image keep working; it is downloaded again when needed.",
    recommended: false,
    targets,
  };
}

const SCANNERS: Record<CleanupId, (scan: Scan) => Promise<Category | null> | Category> = {
  "temp-files": tempFiles,
  "browser-cache": browserCaches,
  "task-worktrees": taskWorktrees,
  "task-clones": taskClones,
  "agent-history": agentHistory,
  database,
  "old-logs": oldLogs,
  "vm-downloads": vmDownloads,
  trash,
  "vm-images": vmImages,
};

async function category(id: CleanupId, scan: Scan): Promise<Category | null> {
  try {
    return await SCANNERS[id](scan);
  } catch (err) {
    log.warn(`could not look at ${id}`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Self check                                                           */
/* ------------------------------------------------------------------ */

function diskSpace(): { freeBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(config().dataDir);
    return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch {
    return null;
  }
}

function databaseCheck(): HealthCheck {
  const base = { id: "database", name: "Database" } as const;
  try {
    const problems = (getDb().query("PRAGMA quick_check").all() as Record<string, string>[]).map((r) => Object.values(r)[0]);
    if (problems.length === 1 && problems[0] === "ok") return { ...base, status: "ok", detail: `Intact · ${formatBytes(fileSize(config().dbPath))}` };
    return { ...base, status: "error", detail: `Damaged (${problems[0]}). Restore a backup from Settings → Backup.` };
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
  const db = basename(cfg.dbPath);
  const areas: [StorageArea, string, string[]][] = [
    ["agents", "Agents", [cfg.agentsDir]],
    ["browser", "Browser", [cfg.browserDir, join(cfg.dataDir, "browser-use")]],
    ["vms", "Virtual machines", [cfg.vmDir]],
    ["repos", "Worktrees & clones", [cfg.tasksDir, reposDir()]],
    ["database", "Database & logs", [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`, cfg.logsDir]],
  ];
  const known = new Set(areas.flatMap(([, , paths]) => paths));
  const rest = (await names(cfg.dataDir)).map((n) => join(cfg.dataDir, n)).filter((p) => !known.has(p) && basename(p) !== db);
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

export async function scanCleanup(): Promise<CleanupReport> {
  const scan = newScan();
  const disk = diskSpace();
  const [usage, categories, worktrees] = await Promise.all([
    storage(scan),
    Promise.all(CLEANUP_IDS.map((id) => category(id, scan))),
    worktreeCheck(),
  ]);
  const items = categories
    .filter((c): c is Category => !!c)
    .map((c) => {
      const cleanable = c.targets.filter((t) => !t.entry.kept);
      return {
        id: c.id,
        name: c.name,
        detail: c.detail,
        bytes: cleanable.reduce((n, t) => n + t.entry.bytes, 0),
        count: cleanable.length,
        recommended: c.recommended,
        upTo: !!c.upTo,
        blocked: c.blocked ?? null,
        entries: c.targets
          .map((t) => t.entry)
          .sort((a, b) => Number(!!a.kept) - Number(!!b.kept) || b.bytes - a.bytes)
          .slice(0, ENTRY_LIMIT),
      };
    });
  return {
    checkedAt: now(),
    dataDir: config().dataDir,
    disk,
    storage: usage,
    checks: [databaseCheck(), diskCheck(disk), worktrees],
    items,
    lastRun: lastCleanup(),
  };
}

/** The recommended items: what the automatic cleanup and `godmode cleanup --fix` take care of. */
export const RECOMMENDED: CleanupId[] = ["temp-files", "browser-cache", "task-worktrees", "task-clones", "agent-history", "database", "old-logs"];

/**
 * Clean the given items. Each is looked at again first — between the report and the click, a browser may have opened
 * or a task may have been reopened — and what must stay is left alone.
 */
export async function runCleanup(ids: readonly CleanupId[], opts: { automatic?: boolean } = {}): Promise<CleanupRun> {
  const startedAt = now();
  const results: CleanupResult[] = [];
  for (const id of CLEANUP_IDS.filter((i) => ids.includes(i))) {
    const scan = newScan(!!opts.automatic);
    const c = await category(id, scan);
    if (!c) continue;
    const result: CleanupResult = { id, name: c.name, ok: true, freedBytes: 0, removed: 0, kept: 0, output: "" };
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
        errors.push(`${t.entry.name}: ${err instanceof Error ? err.message : String(err)}`);
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
  return run;
}
