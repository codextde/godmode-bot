/**
 * Folders and git repositories attached to workspaces. Repositories are cloned with the system git (so this
 * computer's git sign-in applies: SSH keys, credential helpers) into <data>/repos/<workspace id>/<name>. Every run of
 * an agent in the workspace gets the usable ones with --add-dir; a clone that is missing is cloned first, one that
 * hasn't been updated for a while is fast-forwarded when it has no local changes.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
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
/** Before a run, clones not updated for this long are fast-forwarded. */
const RUN_SYNC_AFTER_MS = 15 * 60_000;
/** How long a run waits for that update; a slower fetch goes on behind the run (see `prepareSource`). */
let runSyncWaitMs = 20_000;

/** How long a run waits for a fast-forward that has begun (status, merge: a few seconds, 40 s at most). */
const RUN_UPDATE_WAIT_MS = 45_000;

export function __setRunSyncWaitForTests(ms: number) {
  runSyncWaitMs = ms;
}
/** How long a run waits for a first clone; it goes on without it after that (the clone continues). */
const RUN_CLONE_WAIT_MS = 90_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NO_GIT = "git isn't installed on this computer. Install it (Settings → System shows how) to use repositories.";

interface SourceRow {
  id: string;
  workspace_id: string;
  /** null = the workspace's own; else one of its projects'. */
  project_id: string | null;
  kind: "folder" | "git";
  path: string;
  url: string | null;
  branch: string | null;
  position: number;
  error: string | null;
  note: string | null;
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

const busy = new Map<string, { kind: "cloning" | "syncing"; done: Promise<void>; abort: AbortController }>();
/** Last update a run started per source: a failing remote isn't retried on every run. */
const runSyncAttempts = new Map<string, number>();

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

/** A folder that is a git repository's top level (a worktree of its own counts): tasks get their own worktree of it. */
export function isRepoFolder(path: string): boolean {
  return isClone(path);
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
      git: !problem && isRepoFolder(row.path),
      status: problem ? "missing" : "ready",
      error: problem,
      note: null,
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
    git: true,
    // A clone whose last update failed is still usable: `error` says what went wrong.
    status: busy.get(row.id)?.kind ?? (cloned ? "ready" : row.error ? "error" : "missing"),
    error: path ? row.error : "This repository can't be cloned: its folder name isn't valid. Remove it and add it again.",
    note: cloned ? row.note : null,
    commit: cloned ? row.commit_sha : null,
    headBranch: cloned ? row.head_branch : null,
    syncedAt: row.synced_at,
  };
}

/** The workspace's own sources (projectId null) or one project's. */
function rowsOf(workspaceId: string, projectId: string | null = null): SourceRow[] {
  return all<SourceRow>(
    "SELECT * FROM workspace_sources WHERE workspace_id = ? AND project_id IS ? ORDER BY position, created_at",
    workspaceId,
    projectId,
  );
}

export function listSources(workspaceId: string, projectId: string | null = null): WorkspaceSource[] {
  return rowsOf(workspaceId, projectId).map(toModel);
}

/** Every workspace's own sources by workspace id, and every project's by project id. */
export function sourcesByOwner(): { workspaces: Map<string, WorkspaceSource[]>; projects: Map<string, WorkspaceSource[]> } {
  const workspaces = new Map<string, WorkspaceSource[]>();
  const projects = new Map<string, WorkspaceSource[]>();
  for (const row of all<SourceRow>("SELECT * FROM workspace_sources ORDER BY workspace_id, position, created_at")) {
    const map = row.project_id ? projects : workspaces;
    const key = row.project_id ?? row.workspace_id;
    const list = map.get(key) ?? [];
    list.push(toModel(row));
    map.set(key, list);
  }
  return { workspaces, projects };
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
 * same URL and branch) keeps it, clone included. Only new folders are validated, so a workspace whose folder went
 * missing can still be saved. Call inside the caller's transaction; run the returned function once it committed — it
 * starts cloning new repositories and moves removed clones to the trash.
 */
export function setSources(workspaceId: string, inputs: WorkspaceSourceInput[], projectId: string | null = null): () => void {
  if (inputs.length > MAX_SOURCES) throw badRequest(`A ${projectId ? "project" : "workspace"} can have up to ${MAX_SOURCES} folders and repositories.`);
  const current = rowsOf(workspaceId, projectId);
  // Clones of the workspace and all its projects share one folder.
  const taken = new Set(gitSourceRows(workspaceId).map((r) => r.path.toLowerCase()));
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
      added.push(newRow(workspaceId, projectId, { kind: "folder", path, url: null, branch: null, position }, ts));
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
    added.push(newRow(workspaceId, projectId, { kind: "git", path: dir, url: parsed.url, branch, position }, ts));
  });

  const removed = current.filter((r) => !kept.has(r.id));
  const moved = current.filter((r) => kept.has(r.id) && kept.get(r.id) !== r.position);
  if (!added.length && !removed.length && !moved.length) return () => {};
  tx(() => {
    for (const r of removed) run("DELETE FROM workspace_sources WHERE id = ?", r.id);
    for (const r of moved) run("UPDATE workspace_sources SET position = ?, updated_at = ? WHERE id = ?", kept.get(r.id)!, ts, r.id);
    for (const r of added) insert("workspace_sources", { ...r });
  });
  return () => {
    for (const r of added) if (r.kind === "git") void track(r, "cloning", (signal) => cloneRepo(r, signal));
    void trashClones(removed);
  };
}

function newRow(workspaceId: string, projectId: string | null, v: Pick<SourceRow, "kind" | "path" | "url" | "branch" | "position">, ts: string): SourceRow {
  return {
    id: newId("src"),
    workspace_id: workspaceId,
    project_id: projectId,
    ...v,
    error: null,
    note: null,
    commit_sha: null,
    head_branch: null,
    synced_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

/**
 * Stop what runs for removed git sources and move their clones to <data>/repos/.trash (they may hold unpushed work),
 * unless a source added since owns the folder again.
 */
export async function trashClones(rows: SourceRow[]): Promise<void> {
  for (const row of rows) {
    if (row.kind !== "git") continue;
    const running = busy.get(row.id);
    running?.abort.abort();
    await running?.done;
    const path = clonePath(row);
    if (!path) continue;
    try {
      const owned = get("SELECT id FROM workspace_sources WHERE workspace_id = ? AND kind = 'git' AND path = ?", row.workspace_id, row.path);
      if (!owned && existsSync(path)) {
        const moved = await moveToTrash(path, trashDir(), `${row.workspace_id}-${row.path}`);
        if (moved) log.info(`moved clone of ${row.url} to ${moved}`);
      }
      const parent = dirname(path);
      if (existsSync(parent) && !readdirSync(parent).length) rmdirSync(parent);
    } catch (err) {
      log.warn(`could not move clone ${path} to the trash`, err);
    }
  }
}

/** Git sources of a workspace and its projects (or of one project), for trashing their clones once it is deleted. */
export function gitSourceRows(workspaceId: string, projectId?: string): SourceRow[] {
  return projectId
    ? rowsOf(workspaceId, projectId).filter((r) => r.kind === "git")
    : all<SourceRow>("SELECT * FROM workspace_sources WHERE workspace_id = ? AND kind = 'git'", workspaceId);
}

/** Clone the repository now, or update the clone. Returns right away; the source's status shows the progress. */
export function syncSource(workspaceId: string, sourceId: string): WorkspaceSource {
  const row = get<SourceRow>("SELECT * FROM workspace_sources WHERE id = ? AND workspace_id = ?", sourceId, workspaceId);
  if (!row) throw notFound("Folder or repository");
  if (row.kind !== "git") throw badRequest("Only repositories can be updated.");
  if (!busy.has(row.id)) {
    if (isClone(clonePath(row))) void track(row, "syncing", (signal) => pullRepo(row, SYNC_TIMEOUT_MS, signal));
    else void track(row, "cloning", (signal) => cloneRepo(row, signal));
  } else updateAsked.add(row.id);
  return toModel(row);
}

/** The human asked for an update while a fetch ran behind a run: that fetch fast-forwards after all. */
const updateAsked = new Set<string>();

/** Run `work` for a source unless something already runs for it; failures are stored on the source. */
function track(row: SourceRow, kind: "cloning" | "syncing", work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const running = busy.get(row.id);
  if (running) return running.done;
  const abort = new AbortController();
  const done = work(abort.signal)
    .then(() => {
      run("UPDATE workspace_sources SET error = NULL WHERE id = ?", row.id);
    })
    .catch((err) => {
      if (abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      // What git itself said and how long it took: "timed out" alone doesn't tell a slow network from a waiting helper.
      log.warn(`${kind === "cloning" ? "clone" : "update"} of ${row.url} failed: ${message}`, err instanceof GitError ? err.details : undefined);
      run("UPDATE workspace_sources SET error = ?, updated_at = ? WHERE id = ?", message, now(), row.id);
    })
    .finally(() => {
      busy.delete(row.id);
      updateAsked.delete(row.id);
      bus.changed("workspaces");
    });
  busy.set(row.id, { kind, done, abort });
  bus.changed("workspaces");
  return done;
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

let sshCommand: Promise<string | undefined> | null = null;

/**
 * Never let git or ssh wait for a password or a host key confirmation nobody can answer, and keep the SSH command
 * out of the clone's own config (an agent that may edit files there must not choose what runs on this computer).
 */
async function gitEnv(): Promise<Record<string, string | undefined>> {
  sshCommand ??= (async () => {
    if (process.env.GIT_SSH_COMMAND) return undefined;
    const env = childEnv();
    const configured = await exec(["config", "--global", "--get", "core.sshCommand"], { cwd: tmpdir(), timeoutMs: 5_000, env }).catch(() => null);
    if (configured?.ok && configured.stdout.trim()) return configured.stdout.trim();
    if (process.env.GIT_SSH) return JSON.stringify(process.env.GIT_SSH);
    return "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new";
  })();
  const ssh = await sshCommand;
  return childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never", ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}) });
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/** A failed git command in words for the human (the message), with what git reported for the diagnostic log. */
class GitError extends Error {
  readonly details: { step: string; ms: number; timedOut: boolean; stderr: string };
  constructor(step: string, res: GitResult, url: string, branch: string | null) {
    super(gitFailure(res, url, branch));
    this.details = { step, ms: res.ms, timedOut: res.timedOut, stderr: res.stderr.trim().slice(-600) };
  }
}

async function exec(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<GitResult> {
  const bin = which("git");
  if (!bin) throw new Error(NO_GIT);
  if (opts.signal?.aborted) return { ok: false, stdout: "", stderr: "", timedOut: false, ms: 0 };
  const started = performance.now();
  // Settings in a clone's .git/config that would run programs on this computer (hooks, fsmonitor) are ignored.
  const safe = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`];
  const proc = Bun.spawn([bin, ...safe, ...args], { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  const stop = () => proc.kill();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    // A stopped git's transport helper may hold the pipes a little longer: don't wait for it.
    const stopped = timedOut || !!opts.signal?.aborted;
    const [stdout, stderr] = stopped ? await Promise.race([output, Bun.sleep(500).then(() => ["", ""] as const)]) : await output;
    return { ok: code === 0 && !stopped, stdout, stderr, timedOut, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
}

async function git(args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<GitResult> {
  return exec(args, { ...opts, env: await gitEnv() });
}

/** Godmode's hardened git (no prompts, no clone hooks or fsmonitor, pinned SSH command) for other git work (tasks). */
export const runGit = git;

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

async function recordHead(row: SourceRow, path: string, note: string | null): Promise<void> {
  const [commit, branch] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"], { cwd: path, timeoutMs: 10_000 }),
    git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, timeoutMs: 10_000 }),
  ]);
  const head = branch.ok ? branch.stdout.trim() : "";
  const ts = now();
  run(
    "UPDATE workspace_sources SET commit_sha = ?, head_branch = ?, note = ?, synced_at = ?, updated_at = ? WHERE id = ?",
    commit.ok ? commit.stdout.trim() || null : null,
    head && head !== "HEAD" ? head : null,
    note,
    ts,
    ts,
    row.id,
  );
}

async function cloneRepo(row: SourceRow, signal: AbortSignal): Promise<void> {
  const path = clonePath(row);
  if (!path || !row.url) throw new Error("This repository can't be cloned: its folder name isn't valid. Remove it and add it again.");
  if (!which("git")) throw new Error(NO_GIT);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Whatever sits where the clone goes is left over (an interrupted clone, a removed source's folder).
  if (existsSync(path)) await moveToTrash(path, trashDir(), `${row.workspace_id}-${row.path}`);
  const tmp = `${path}.cloning-${Date.now().toString(36)}`;
  const res = await git(["clone", "--quiet", ...(row.branch ? ["--branch", row.branch] : []), "--", row.url, tmp], {
    timeoutMs: CLONE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    rmSync(tmp, { recursive: true, force: true });
    if (signal.aborted) return;
    throw new GitError("clone", res, row.url, row.branch);
  }
  // Removed while cloning: nothing to keep.
  if (signal.aborted || !get("SELECT id FROM workspace_sources WHERE id = ?", row.id)) {
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  renameSync(tmp, path);
  await recordHead(row, path, null);
  log.info(`cloned ${row.url} into ${path}`);
}

/**
 * Fetch, then fast-forward when the clone has no local changes and its branch tracks one. Local work is never touched.
 * `mayUpdate` is asked once the fetch is done: false leaves the checkout as it is (what was fetched stays).
 */
async function pullRepo(row: SourceRow, timeoutMs: number, signal: AbortSignal, mayUpdate: () => boolean = () => true): Promise<void> {
  const path = clonePath(row);
  if (!isClone(path) || !row.url) throw new Error("The repository isn't cloned yet.");
  const fetched = await git(["fetch", "--quiet", "--prune", "origin"], { cwd: path, timeoutMs, signal });
  if (signal.aborted) return;
  if (!fetched.ok) throw new GitError("fetch", fetched, row.url, row.branch);
  if (!mayUpdate() && !updateAsked.has(row.id)) {
    log.info(`fetched ${row.url} in ${Math.round(fetched.ms / 1000)} s — a run started meanwhile, so its checkout is updated later`);
    return;
  }
  const status = await git(["status", "--porcelain", "--untracked-files=no"], { cwd: path, timeoutMs: 10_000 });
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: path, timeoutMs: 10_000 });
  let note: string | null = null;
  if (!upstream.ok) note = "The checked out branch doesn't track a remote branch, so it wasn't updated.";
  else if (!status.ok || status.stdout.trim()) note = "Has local changes, so it wasn't updated. Commit or discard them to get the latest changes.";
  else {
    const merged = await git(["merge", "--ff-only", "--quiet", "@{u}"], { cwd: path, timeoutMs: 30_000, signal });
    if (!merged.ok && !signal.aborted) note = "Has local commits that aren't on the remote, so it wasn't updated.";
  }
  if (signal.aborted) return;
  await recordHead(row, path, note);
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

/** Resolves when `work` finishes, the run is cancelled or `timeoutMs` passed — whichever comes first. */
function settle(work: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    void work.then(done);
  });
}

async function prepareSource(
  row: SourceRow,
  opts: { onActivity: (label: string) => void; signal: AbortSignal },
): Promise<{ source?: RunSource; notice?: string }> {
  const name = nameOf(row);
  if (row.kind === "folder") {
    const problem = workingDirectoryProblem(row.path);
    return problem
      ? { notice: `The ${row.project_id ? "project" : "workspace"} folder "${name}" was skipped: ${problem}` }
      : { source: { kind: "folder", name, path: row.path, url: null, branch: null } };
  }
  const path = clonePath(row);
  if (!path) return { notice: `The repository "${name}" was skipped: its folder name isn't valid. Remove it from the workspace and add it again.` };
  if (!isClone(path)) {
    opts.onActivity(`Cloning ${name} …`);
    await settle(track(row, "cloning", (signal) => cloneRepo(row, signal)), opts.signal, RUN_CLONE_WAIT_MS);
  } else if (!busy.has(row.id) && Date.now() - Math.max(row.synced_at ? Date.parse(row.synced_at) : 0, runSyncAttempts.get(row.id) ?? 0) > RUN_SYNC_AFTER_MS) {
    runSyncAttempts.set(row.id, Date.now());
    opts.onActivity(`Updating ${name} …`);
    // The run doesn't wait long. A fetch that takes longer isn't stopped (stopped, it would start over before every
    // run and never get through): it finishes behind the run, which keeps the files it started with. The checkout is
    // fast-forwarded by a later update (RUN_SYNC_AFTER_MS on — runs of other chats may work in it meanwhile), which
    // then has nothing left to load.
    let waiting = true;
    let updating = false;
    const synced = track(row, "syncing", (signal) =>
      pullRepo(row, SYNC_TIMEOUT_MS, signal, () => {
        updating ||= waiting;
        return waiting;
      }),
    );
    await settle(synced, opts.signal, runSyncWaitMs);
    waiting = false;
    // The fetch was done in time and the fast-forward is under way: the run doesn't start in a checkout that changes.
    if (updating) await settle(synced, opts.signal, RUN_UPDATE_WAIT_MS);
  }
  if (isClone(path)) return { source: { kind: "git", name, path, url: row.url, branch: row.branch } };
  if (busy.get(row.id)?.kind === "cloning") return { notice: `The repository "${name}" is still being cloned — it's available once that's done.` };
  const error = get<{ error: string | null }>("SELECT error FROM workspace_sources WHERE id = ?", row.id)?.error;
  return { notice: `The repository "${name}" couldn't be cloned${error ? `: ${error}` : "."}` };
}

/**
 * The workspace's usable folders and repositories for a run: missing clones are cloned first (`onActivity` names
 * them) and stale ones updated, all at once and time-boxed. What can't be used is skipped with a notice; the run goes
 * on without it.
 */
export async function prepareSources(
  owners: { workspaceId: string; projectId: string | null }[],
  opts: { onActivity: (label: string) => void; signal: AbortSignal },
): Promise<{ sources: RunSource[]; notices: string[] }> {
  const rows = owners.flatMap((o) => rowsOf(o.workspaceId, o.projectId));
  const prepared = await Promise.all(rows.map((row) => prepareSource(row, opts)));
  return {
    sources: prepared.flatMap((p) => (p.source ? [p.source] : [])),
    notices: prepared.flatMap((p) => (p.notice ? [p.notice] : [])),
  };
}
