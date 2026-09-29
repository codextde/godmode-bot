/**
 * Folders and git repositories attached to workspaces. Repositories are cloned with the system git (so this
 * computer's git sign-in applies: SSH keys, credential helpers) into <data>/repos/<workspace id>/<name>. Every run of
 * an agent in the workspace gets the usable ones with --add-dir; a clone that is missing is cloned first, one that
 * hasn't been updated for a while is fast-forwarded when it has no local changes.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkspaceSource, WorkspaceSourceInput } from "@godmode/shared";
import { isValidBranch, parseGitUrl } from "@godmode/shared";
import { config } from "../config";
import { all, get, insert, run, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { moveToTrash } from "../agents/repo";
import { badRequest, childEnv, hostnameOf, newId, notFound, now, which } from "../util";
import { normalizeWorkingDirectory, workingDirectoryProblem } from "./folders";

const log = logger("sources");

export const MAX_SOURCES = 20;
const CLONE_TIMEOUT_MS = 15 * 60_000;
const SYNC_TIMEOUT_MS = 2 * 60_000;
/** Before a run, clones not updated for this long are fast-forwarded (quickly, or not at all). */
const RUN_SYNC_AFTER_MS = 15 * 60_000;
const RUN_SYNC_TIMEOUT_MS = 20_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NO_GIT = "git isn't installed on this computer. Install it (Settings → System shows how) to use repositories.";

interface SourceRow {
  id: string;
  workspace_id: string;
  kind: "folder" | "git";
  path: string;
  url: string | null;
  branch: string | null;
  position: number;
  error: string | null;
  commit_sha: string | null;
  head_branch: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A usable source as a run sees it. */
export interface RunSource {
  kind: "folder" | "git";
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
}

const busy = new Map<string, { kind: "cloning" | "syncing"; done: Promise<void> }>();

export function reposDir(): string {
  return join(config().dataDir, "repos");
}

function trashDir(): string {
  return join(reposDir(), ".trash");
}

export function isSafeCloneDir(name: string): boolean {
  return SAFE_SEGMENT.test(name);
}

/** Where a git source is cloned; null when a (restored) row names an unsafe directory. */
function clonePath(row: Pick<SourceRow, "workspace_id" | "path">): string | null {
  if (!SAFE_SEGMENT.test(row.workspace_id) || !SAFE_SEGMENT.test(row.path)) return null;
  return join(reposDir(), row.workspace_id, row.path);
}

function isClone(path: string | null): path is string {
  return !!path && existsSync(join(path, ".git"));
}

function nameOf(row: SourceRow): string {
  if (row.kind === "folder") return basename(row.path) || row.path;
  const parsed = parseGitUrl(row.url ?? "");
  return "error" in parsed ? row.path : parsed.name;
}

function toModel(row: SourceRow): WorkspaceSource {
  if (row.kind === "folder") {
    const problem = workingDirectoryProblem(row.path);
    return {
      id: row.id,
      kind: "folder",
      name: nameOf(row),
      path: row.path,
      url: null,
      branch: null,
      status: problem ? "missing" : "ready",
      error: problem,
      commit: null,
      headBranch: null,
      syncedAt: null,
    };
  }
  const path = clonePath(row);
  const cloned = isClone(path);
  return {
    id: row.id,
    kind: "git",
    name: nameOf(row),
    path: path ?? "",
    url: row.url,
    branch: row.branch,
    status: busy.get(row.id)?.kind ?? (row.error ? "error" : cloned ? "ready" : "missing"),
    error: path ? row.error : "This repository can't be cloned: its folder name isn't valid. Remove it and add it again.",
    commit: cloned ? row.commit_sha : null,
    headBranch: cloned ? row.head_branch : null,
    syncedAt: row.synced_at,
  };
}

function rowsOf(workspaceId: string): SourceRow[] {
  return all<SourceRow>("SELECT * FROM workspace_sources WHERE workspace_id = ? ORDER BY position, created_at", workspaceId);
}

export function listSources(workspaceId: string): WorkspaceSource[] {
  return rowsOf(workspaceId).map(toModel);
}

/** Every workspace's sources, by workspace id. */
export function sourcesByWorkspace(): Map<string, WorkspaceSource[]> {
  const out = new Map<string, WorkspaceSource[]>();
  for (const row of all<SourceRow>("SELECT * FROM workspace_sources ORDER BY workspace_id, position, created_at")) {
    const list = out.get(row.workspace_id) ?? [];
    list.push(toModel(row));
    out.set(row.workspace_id, list);
  }
  return out;
}

function cloneDirName(name: string, taken: Set<string>, workspaceId: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "repo";
  let dir = base;
  for (let i = 2; taken.has(dir.toLowerCase()) || existsSync(join(reposDir(), workspaceId, dir)); i++) dir = `${base}-${i}`;
  taken.add(dir.toLowerCase());
  return dir;
}

/**
 * Replace a workspace's sources with `inputs` (in order). An input naming an existing source (the same folder, or the
 * same URL and branch) keeps it, clone included; new repositories start cloning, removed clones go to the trash.
 * Only new folders are validated, so a workspace whose folder went missing can still be saved.
 */
export function setSources(workspaceId: string, inputs: WorkspaceSourceInput[]): void {
  if (inputs.length > MAX_SOURCES) throw badRequest(`A workspace can have up to ${MAX_SOURCES} folders and repositories.`);
  const current = rowsOf(workspaceId);
  const taken = new Set(current.filter((r) => r.kind === "git").map((r) => r.path.toLowerCase()));
  const kept = new Map<string, number>();
  const added: SourceRow[] = [];
  const seen = new Set<string>();
  const ts = now();

  /** Handled: a duplicate input, or one that keeps an existing source. */
  const known = (key: string, matches: (r: SourceRow) => boolean, position: number): boolean => {
    if (seen.has(key)) return true;
    const existing = current.find((r) => !kept.has(r.id) && matches(r));
    if (!existing) return false;
    seen.add(key);
    kept.set(existing.id, position);
    return true;
  };

  inputs.forEach((input, position) => {
    if (input.kind === "folder") {
      const raw = input.path?.trim() ?? "";
      if (raw && known(`folder:${raw}`, (r) => r.kind === "folder" && r.path === raw, position)) return;
      const path = normalizeWorkingDirectory(raw);
      if (!path) throw badRequest("Pick a folder to add.");
      if (known(`folder:${path}`, (r) => r.kind === "folder" && r.path === path, position)) return;
      seen.add(`folder:${path}`);
      added.push(newRow(workspaceId, { kind: "folder", path, url: null, branch: null, position }, ts));
      return;
    }
    const parsed = parseGitUrl(input.url ?? "");
    if ("error" in parsed) throw badRequest(parsed.error);
    const branch = input.branch?.trim() || parsed.branch || null;
    if (branch && !isValidBranch(branch)) throw badRequest(`"${branch}" isn't a valid branch name.`);
    const key = `git:${parsed.url}#${branch ?? ""}`;
    if (known(key, (r) => r.kind === "git" && r.url === parsed.url && (r.branch ?? null) === branch, position)) return;
    seen.add(key);
    const dir = cloneDirName(parsed.name, taken, workspaceId);
    added.push(newRow(workspaceId, { kind: "git", path: dir, url: parsed.url, branch, position }, ts));
  });

  const removed = current.filter((r) => !kept.has(r.id));
  const moved = current.filter((r) => kept.has(r.id) && kept.get(r.id) !== r.position);
  if (!added.length && !removed.length && !moved.length) return;
  tx(() => {
    for (const r of removed) run("DELETE FROM workspace_sources WHERE id = ?", r.id);
    for (const r of moved) run("UPDATE workspace_sources SET position = ?, updated_at = ? WHERE id = ?", kept.get(r.id)!, ts, r.id);
    for (const r of added) insert("workspace_sources", { ...r });
  });
  for (const r of added) if (r.kind === "git") void track(r, "cloning", () => cloneRepo(r));
  void trashClones(removed);
}

function newRow(workspaceId: string, v: Pick<SourceRow, "kind" | "path" | "url" | "branch" | "position">, ts: string): SourceRow {
  return { id: newId("src"), workspace_id: workspaceId, ...v, error: null, commit_sha: null, head_branch: null, synced_at: null, created_at: ts, updated_at: ts };
}

/** Move the clones of removed git sources to <data>/repos/.trash (they may hold unpushed work). */
export async function trashClones(rows: SourceRow[]): Promise<void> {
  for (const row of rows) {
    if (row.kind !== "git") continue;
    await busy.get(row.id)?.done;
    const path = clonePath(row);
    if (!path || !existsSync(path)) continue;
    try {
      const moved = await moveToTrash(path, trashDir(), `${row.workspace_id}-${row.path}`);
      if (moved) log.info(`moved clone of ${row.url} to ${moved}`);
      const parent = dirname(path);
      if (existsSync(parent) && !readdirSync(parent).length) rmdirSync(parent);
    } catch (err) {
      log.warn(`could not move clone ${path} to the trash`, err);
    }
  }
}

/** Git sources of a workspace, for trashing their clones once the workspace is deleted. */
export function gitSourceRows(workspaceId: string): SourceRow[] {
  return rowsOf(workspaceId).filter((r) => r.kind === "git");
}

/** Clone the repository now, or update the clone. Returns right away; the source's status shows the progress. */
export function syncSource(workspaceId: string, sourceId: string): WorkspaceSource {
  const row = get<SourceRow>("SELECT * FROM workspace_sources WHERE id = ? AND workspace_id = ?", sourceId, workspaceId);
  if (!row) throw notFound("Folder or repository");
  if (row.kind !== "git") throw badRequest("Only repositories can be updated.");
  if (!busy.has(row.id)) {
    if (isClone(clonePath(row))) void track(row, "syncing", () => pullRepo(row, SYNC_TIMEOUT_MS));
    else void track(row, "cloning", () => cloneRepo(row));
  }
  return toModel(row);
}

/** Run `work` for a source unless something already runs for it; failures are stored on the source. */
function track(row: SourceRow, kind: "cloning" | "syncing", work: () => Promise<void>): Promise<void> {
  const running = busy.get(row.id);
  if (running) return running.done;
  const done = work()
    .then(() => {
      run("UPDATE workspace_sources SET error = NULL WHERE id = ?", row.id);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${kind === "cloning" ? "clone" : "update"} of ${row.url} failed: ${message}`);
      run("UPDATE workspace_sources SET error = ?, updated_at = ? WHERE id = ?", message, now(), row.id);
    })
    .finally(() => {
      busy.delete(row.id);
      bus.changed("workspaces");
    });
  busy.set(row.id, { kind, done });
  bus.changed("workspaces");
  return done;
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

let sshCommand: Promise<string | undefined> | null = null;

/** Never let git or ssh wait for a password or a host key confirmation nobody can answer. */
async function gitEnv(): Promise<Record<string, string | undefined>> {
  sshCommand ??= (async () => {
    if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return undefined;
    const configured = await exec(["config", "--get", "core.sshCommand"], { cwd: tmpdir(), timeoutMs: 5_000, env: childEnv() }).catch(() => null);
    return configured?.ok && configured.stdout.trim() ? undefined : "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new";
  })();
  const ssh = await sshCommand;
  return childEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}) });
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function exec(args: string[], opts: { cwd?: string; timeoutMs: number; env: Record<string, string | undefined> }): Promise<GitResult> {
  const bin = which("git");
  if (!bin) throw new Error(NO_GIT);
  const proc = Bun.spawn([bin, "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0 && !timedOut, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function git(args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<GitResult> {
  return exec(args, { ...opts, env: await gitEnv() });
}

/** A git failure in words a human can act on. */
export function gitFailure(res: Pick<GitResult, "stderr" | "timedOut">, url: string, branch: string | null): string {
  const host = hostnameOf(url.includes("://") ? url : `ssh://${url.replace(":", "/")}`) || "the server";
  if (res.timedOut) return `Timed out talking to ${host}.`;
  const text = res.stderr;
  if (/remote branch .* not found|couldn't find remote ref/i.test(text)) return `The branch "${branch}" doesn't exist in this repository.`;
  if (/could not resolve host|name or service not known|nodename nor servname/i.test(text)) return `Can't reach ${host} — check the URL and your internet connection.`;
  if (/host key verification failed/i.test(text)) return `${host}'s SSH host key doesn't match the one this computer knows (~/.ssh/known_hosts).`;
  if (/repository not found|not found|could not read username|authentication failed|permission denied|terminal prompts disabled|access denied|403/i.test(text)) {
    return `Git couldn't open the repository on ${host}. Check the URL — for a private repository, sign in to git on this computer first (an SSH key for git@ URLs, or a credential helper such as \`gh auth login\`).`;
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^cloning into/i.test(l));
  const last = lines.findLast((l) => /^(fatal|error):/i.test(l)) ?? lines.at(-1) ?? "git failed";
  return last.replace(/^(fatal|error):\s*/i, "").slice(0, 300);
}

async function recordHead(row: SourceRow, path: string): Promise<void> {
  const [commit, branch] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"], { cwd: path, timeoutMs: 10_000 }),
    git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, timeoutMs: 10_000 }),
  ]);
  const head = branch.ok ? branch.stdout.trim() : "";
  run(
    "UPDATE workspace_sources SET commit_sha = ?, head_branch = ?, synced_at = ?, updated_at = ? WHERE id = ?",
    commit.ok ? commit.stdout.trim() || null : null,
    head && head !== "HEAD" ? head : null,
    now(),
    now(),
    row.id,
  );
}

async function cloneRepo(row: SourceRow): Promise<void> {
  const path = clonePath(row);
  if (!path || !row.url) throw new Error("This repository can't be cloned: its folder name isn't valid. Remove it and add it again.");
  if (!which("git")) throw new Error(NO_GIT);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && !isClone(path)) await moveToTrash(path, trashDir(), `${row.workspace_id}-${row.path}`);
  const tmp = `${path}.cloning-${Date.now().toString(36)}`;
  const res = await git(["clone", "--quiet", ...(row.branch ? ["--branch", row.branch] : []), "--", row.url, tmp], {
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (!res.ok) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(gitFailure(res, row.url, row.branch));
  }
  // Removed while cloning: nothing to keep.
  if (!get("SELECT id FROM workspace_sources WHERE id = ?", row.id)) {
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  renameSync(tmp, path);
  await recordHead(row, path);
  log.info(`cloned ${row.url} into ${path}`);
}

/** Fetch, then fast-forward when the clone has no local changes and its branch tracks one. Local work is never touched. */
async function pullRepo(row: SourceRow, timeoutMs: number): Promise<void> {
  const path = clonePath(row);
  if (!isClone(path) || !row.url) throw new Error("The repository isn't cloned yet.");
  const fetched = await git(["fetch", "--quiet", "--prune", "origin"], { cwd: path, timeoutMs });
  if (!fetched.ok) throw new Error(gitFailure(fetched, row.url, row.branch));
  const status = await git(["status", "--porcelain", "--untracked-files=no"], { cwd: path, timeoutMs: 10_000 });
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: path, timeoutMs: 10_000 });
  if (status.ok && !status.stdout.trim() && upstream.ok) {
    await git(["merge", "--ff-only", "--quiet", "@{u}"], { cwd: path, timeoutMs: 30_000 });
  }
  await recordHead(row, path);
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

function settle(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    void work.then(resolve);
  });
}

/**
 * The workspace's usable folders and repositories for a run: missing clones are cloned first (`onActivity` names
 * them), stale ones updated. What can't be used is skipped with a notice; the run goes on without it.
 */
export async function prepareSources(
  workspaceId: string | null,
  opts: { onActivity: (label: string) => void; signal: AbortSignal },
): Promise<{ sources: RunSource[]; notices: string[] }> {
  const sources: RunSource[] = [];
  const notices: string[] = [];
  if (!workspaceId) return { sources, notices };
  for (const row of rowsOf(workspaceId)) {
    if (opts.signal.aborted) break;
    const name = nameOf(row);
    if (row.kind === "folder") {
      const problem = workingDirectoryProblem(row.path);
      if (problem) notices.push(`The workspace folder "${name}" was skipped: ${problem}`);
      else sources.push({ kind: "folder", name, path: row.path, url: null, branch: null });
      continue;
    }
    const path = clonePath(row);
    if (!path) {
      notices.push(`The repository "${name}" was skipped: its folder name isn't valid. Remove it from the workspace and add it again.`);
      continue;
    }
    if (!isClone(path)) {
      opts.onActivity(`Cloning ${name} …`);
      await settle(track(row, "cloning", () => cloneRepo(row)), opts.signal);
    } else if (!busy.has(row.id) && Date.now() - (row.synced_at ? Date.parse(row.synced_at) : 0) > RUN_SYNC_AFTER_MS) {
      opts.onActivity(`Updating ${name} …`);
      await settle(track(row, "syncing", () => pullRepo(row, RUN_SYNC_TIMEOUT_MS)), opts.signal);
    }
    if (opts.signal.aborted) break;
    if (isClone(path)) sources.push({ kind: "git", name, path, url: row.url, branch: row.branch });
    else {
      const error = get<{ error: string | null }>("SELECT error FROM workspace_sources WHERE id = ?", row.id)?.error;
      notices.push(`The repository "${name}" couldn't be cloned${error ? `: ${error}` : "."}`);
    }
  }
  return { sources, notices };
}
