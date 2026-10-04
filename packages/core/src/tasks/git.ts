/**
 * Git and pull requests for tasks: every task gets its own git worktree on its own branch (so tasks never touch each
 * other's files or the human's copy), coding tasks push it when the agent is done and open a pull request with the
 * GitHub CLI (or link to the page that opens one). Uses the human's own git credentials (credential helper, SSH keys)
 * and `gh` login; nothing ever prompts.
 *
 * A worktree comes from a workspace folder that is a git repository (the branch lives in that repository), or from
 * Godmode's clone of a remote repository: one bare clone per URL (<data>/repos/.tasks), shared by its tasks' worktrees.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PullRequestState, TaskPullRequest } from "@godmode/shared";
import { hostedRepo, parseGitUrl } from "@godmode/shared";
import { resolveGh, runCommand, stripAnsi, toolPath } from "../services/doctor";
import { moveToTrash } from "../agents/repo";
import { logger } from "../log";
import { gitFailure, reposDir, runGit } from "../services/workspaceSources";
import { childEnv, newId } from "../util";

const log = logger("tasks");

const CLONE_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 60_000;

let ghOverride: string | null | undefined;

/** Tests: use this gh binary (null = pretend gh isn't installed); undefined = auto-detect. */
export function __setGhForTests(path: string | null | undefined) {
  ghOverride = path;
}

export class GitError extends Error {}

/** New files that look like secrets (env files, keys, keystores); they are never committed. */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|\.netrc)$/i;

function env() {
  return childEnv({ PATH: toolPath(), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
}

function lastLines(text: string, n = 4): string {
  return stripAnsi(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const res = await runGit(args, { cwd, timeoutMs });
  if (res.timedOut) throw new GitError(`git ${args[0]} timed out`);
  if (!res.ok) throw new GitError(lastLines(res.stderr || res.stdout) || `git ${args[0]} failed`);
  return res.stdout.trim();
}

async function gitOk(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function hasRef(dir: string, ref: string): Promise<boolean> {
  return gitOk(["rev-parse", "--verify", "--quiet", ref], dir);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The branch tasks start from when neither the task nor the workspace names one: the remote's default branch — or,
 * in a local repository without one, the branch checked out in the human's folder.
 */
async function defaultBranch(dir: string, local: boolean): Promise<string> {
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir).catch(() => "");
  if (head) return head.replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    if (await hasRef(dir, `refs/remotes/origin/${candidate}`)) return candidate;
  }
  const current = local ? await git(["symbolic-ref", "--short", "HEAD"], dir).catch(() => "") : "";
  if (current) return current;
  throw new GitError("Could not find the repository's default branch — set a base branch on the task or workspace.");
}

/** What a branch is compared with: `origin/<base>`, or the local `<base>` of a repository that doesn't have it on origin. */
async function baseRef(dir: string, base: string): Promise<string> {
  return (await hasRef(dir, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

/** Commits the checked out branch has on top of its base. */
export async function commitsAhead(dir: string, base: string): Promise<number> {
  return Number(await git(["rev-list", "--count", `${await baseRef(dir, base)}..HEAD`], dir)) || 0;
}

/* ------------------------------------------------------------------ */
/* Worktrees                                                           */
/* ------------------------------------------------------------------ */

/** Where a task's worktree comes from: Godmode's clone of a remote repository, or a workspace folder that is a git repository. */
export type TaskRepo = { kind: "remote"; url: string } | { kind: "local"; path: string };

/**
 * Git work that changes a repository's shared state (fetches, worktrees, pushes) runs one at a time per repository:
 * parallel tasks share its refs and would collide ("cannot lock ref").
 */
const repoLocks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (repoLocks.get(key) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => {});
  repoLocks.set(key, tail);
  void tail.then(() => repoLocks.get(key) === tail && repoLocks.delete(key));
  return next;
}

/** `path` with symlinks resolved, also when it doesn't exist yet. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** The lock of the repository a checkout (or a repository folder) belongs to: its common git directory. */
async function repoKey(dir: string): Promise<string> {
  return canonical(resolve(dir, await git(["rev-parse", "--git-common-dir"], dir)));
}

/** Godmode's bare clone of `url` that its tasks' worktrees share. */
export function repoCacheDir(url: string): string {
  const parsed = parseGitUrl(url);
  const name = ("error" in parsed ? "" : parsed.name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "repo";
  return join(reposDir(), ".tasks", `${name}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}.git`);
}

/** The first worktree of a remote repository clones it (slow); later ones only fetch. */
export function needsClone(repo: TaskRepo): boolean {
  return repo.kind === "remote" && !existsSync(join(repoCacheDir(repo.url), "HEAD"));
}

/**
 * Clone `url` into its cache the first time, fetch it afterwards (offline, tasks start from what it has). Only
 * remote-tracking refs come from the remote, and the remote is set again each time (an agent may have changed it).
 */
async function syncCache(url: string): Promise<string> {
  const dir = repoCacheDir(url);
  if (existsSync(join(dir, "HEAD"))) {
    await git(["remote", "set-url", "origin", url], dir);
    await gitOk(["config", "--unset-all", "remote.origin.pushurl"], dir);
    const res = await runGit(["fetch", "--quiet", "--prune", "origin"], { cwd: dir, timeoutMs: CLONE_TIMEOUT_MS });
    if (!res.ok) log.warn(`could not update the clone of ${url}, tasks start from what it has: ${gitFailure(res, url, null)}`);
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const tmp = `${dir}.cloning-${Date.now().toString(36)}`;
  try {
    await git(["init", "--quiet", "--bare", tmp], dirname(dir));
    await git(["remote", "add", "origin", url], tmp);
    const res = await runGit(["fetch", "--quiet", "origin"], { cwd: tmp, timeoutMs: CLONE_TIMEOUT_MS });
    if (!res.ok) throw new GitError(gitFailure(res, url, null));
    await gitOk(["remote", "set-head", "origin", "--auto"], tmp);
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

/**
 * The remote of a local repository, without credentials ("" = none Godmode can push to: a local path, or no origin —
 * its task branches stay in the repository). Pushes go to the remote by name, so a token in its URL keeps working.
 */
async function originUrl(dir: string): Promise<string> {
  const raw = await git(["remote", "get-url", "origin"], dir).catch(() => "");
  if (!raw) return "";
  const parsed = parseGitUrl(raw.replace(/^(https?:\/\/)[^@/]+@/i, "$1"));
  return "error" in parsed ? "" : parsed.url;
}

/** Take what was pushed to the task's branch (repositories cloned with --single-branch don't fetch it by themselves). */
function fetchBranch(dir: string, branch: string): Promise<boolean> {
  return gitOk(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir);
}

/**
 * A usable checkout: a task's worktree (`.git` file) or a full clone from before worktrees (`.git` folder), with an
 * index — a worktree whose creation was interrupted has none (its files would look deleted).
 */
async function isCheckout(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const index = await git(["rev-parse", "--git-path", "index"], dir).catch(() => "");
  return !!index && existsSync(resolve(dir, index));
}

/**
 * Create the task's worktree at `dir` — on `branch`, or for a task starting for the first time (`fresh`) on the first
 * free name from it — started from `<base>` (the remote's, else the local repository's). A task whose worktree was
 * removed gets its branch checked out again; a worktree that is there takes what was pushed to its branch meanwhile
 * (review commits, "Update branch" merges) when that fast-forwards. Returns the branch, the base branch ("" base = the
 * repository's default branch) and the repository's remote ("" = none).
 */
export async function prepareWorktree(opts: {
  dir: string;
  repo: TaskRepo;
  base: string;
  branch: string;
  fresh: boolean;
  trashDir: string;
}): Promise<{ branch: string; base: string; url: string }> {
  const { dir, repo } = opts;
  // A full clone per task (how tasks worked before worktrees) keeps being used: it may hold unpushed work.
  const legacy = repo.kind === "remote" && isDir(join(dir, ".git")) && (await isCheckout(dir));
  let key: string;
  if (legacy) key = await repoKey(dir);
  else if (repo.kind === "remote") key = canonical(repoCacheDir(repo.url));
  else {
    if (!existsSync(repo.path)) throw new GitError(`The folder ${repo.path} doesn't exist anymore.`);
    key = await repoKey(repo.path).catch(() => {
      throw new GitError(`${repo.path} isn't a git repository.`);
    });
  }
  return serialized(key, async () => {
    let main: string;
    let url: string;
    if (legacy) {
      main = dir;
      url = (repo as { url: string }).url;
      await git(["remote", "set-url", "origin", url], dir);
      await git(["fetch", "--prune", "origin"], dir, CLONE_TIMEOUT_MS);
    } else if (repo.kind === "remote") {
      url = repo.url;
      main = await syncCache(url);
    } else {
      main = repo.path;
      url = await originUrl(main);
      // The latest of the remote when it can be reached; offline, the task starts from what the repository has.
      if (url) await gitOk(["fetch", "--quiet", "origin"], main);
    }
    const base = opts.base || (await defaultBranch(main, repo.kind === "local"));
    const from = repo.kind === "remote" ? `origin/${base}` : await baseRef(main, base);
    if (!(await hasRef(main, from))) throw new GitError(`The branch "${base}" doesn't exist in ${url || main}.`);

    // A worktree the main repository lost track of (it was moved) is reconnected first.
    if (!legacy && existsSync(join(dir, ".git")) && !(await isCheckout(dir))) await gitOk(["worktree", "repair", dir], main);
    if (await isCheckout(dir)) {
      // The task's own worktree: a first start that got this far before (Godmode stopped) keeps the branch it made —
      // never whatever a clone from before worktrees has checked out (its default branch).
      const current = await git(["symbolic-ref", "--short", "HEAD"], dir).catch(() => "");
      const branch = !legacy && opts.fresh && current.startsWith(opts.branch) ? current : opts.branch;
      if (legacy && !(await hasRef(dir, `refs/heads/${branch}`))) await git(["checkout", "--no-track", "-b", branch, from], dir);
      else if (current !== branch) await git(["checkout", branch], dir);
      if (url && (await fetchBranch(dir, branch))) await gitOk(["merge", "--ff-only", `origin/${branch}`], dir);
      return { branch, base, url };
    }

    // Left over from a removed worktree or an interrupted start: kept in the trash (it may hold work), never deleted.
    if (existsSync(dir)) await moveToTrash(dir, opts.trashDir, basename(dir));
    await gitOk(["worktree", "unlock", dir], main);
    await gitOk(["worktree", "prune"], main);
    mkdirSync(dirname(dir), { recursive: true });
    let branch = opts.branch;
    // A new task never takes over a branch someone else made (task numbers start again after a reinstall).
    if (opts.fresh) {
      const taken = async (name: string) => (await hasRef(main, `refs/heads/${name}`)) || (await hasRef(main, `refs/remotes/origin/${name}`));
      for (let i = 2; await taken(branch); i++) branch = `${opts.branch}-${i}`;
    }
    if (await hasRef(main, `refs/heads/${branch}`)) {
      await git(["worktree", "add", "--quiet", dir, branch], main, CLONE_TIMEOUT_MS);
      if (url && (await fetchBranch(dir, branch))) await gitOk(["merge", "--ff-only", `origin/${branch}`], dir);
    } else {
      // Pushed before (the clone was made again since): continue from there.
      const pushed = !opts.fresh && url && (await fetchBranch(main, branch));
      await git(["worktree", "add", "--quiet", "--no-track", "-b", branch, dir, pushed ? `origin/${branch}` : from], main, CLONE_TIMEOUT_MS);
    }
    return { branch, base, url };
  });
}

/** Remove a task's checkout; a worktree is unregistered from its repository too. Its branch stays (it may hold work). */
export async function removeCheckout(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const worktree = existsSync(join(dir, ".git")) && !isDir(join(dir, ".git"));
  const common = worktree ? await repoKey(dir).catch(() => null) : null;
  rmSync(dir, { recursive: true, force: true });
  if (common) await serialized(common, () => gitOk(["--git-dir", common, "worktree", "prune"], tmpdir()));
}

/**
 * Remove a task's checkout unless `keep()` names a reason to keep it — asked inside the repository's lock, where no
 * task can be setting the checkout up meanwhile. Returns that reason, or null once the checkout is gone.
 */
export async function removeCheckoutUnless(dir: string, keep: () => Promise<string | null>): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const worktree = existsSync(join(dir, ".git")) && !isDir(join(dir, ".git"));
  const key = existsSync(join(dir, ".git")) ? await repoKey(dir).catch(() => null) : null;
  const work = async () => {
    const reason = await keep();
    if (reason) return reason;
    rmSync(dir, { recursive: true, force: true });
    if (key && worktree) await gitOk(["--git-dir", key, "worktree", "prune"], tmpdir());
    return null;
  };
  return key ? serialized(key, work) : work();
}

/** Run `work` while no task fetches into, pushes from or makes worktrees of Godmode's clone at `dir`. */
export function whileCloneIdle<T>(dir: string, work: () => Promise<T>): Promise<T> {
  return serialized(canonical(dir), work);
}

/** Commit what the agent left uncommitted, except new files that look like secrets. Returns the files left out. */
export async function commitWork(opts: { dir: string; message: string }): Promise<{ skipped: string[] }> {
  const { dir } = opts;
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], dir)).split("\0").filter(Boolean);
  const skipped = untracked.filter((f) => SECRET_FILE.test(f));
  await git(["add", "-A"], dir);
  if (skipped.length) await git(["reset", "-q", "--", ...skipped], dir);
  if (await git(["diff", "--cached", "--name-only"], dir)) {
    const identity = (await gitOk(["config", "user.email"], dir)) ? [] : ["-c", "user.name=Godmode", "-c", "user.email=godmode@localhost"];
    await git([...identity, "commit", "-m", opts.message], dir);
  }
  return { skipped };
}

/** Files the branch adds on top of its base that look like secrets (env files, keys) — committed by the agent itself. */
export async function secretFilesAdded(dir: string, base: string): Promise<string[]> {
  const added = await git(["diff", "--name-only", "--diff-filter=A", "-z", `${await baseRef(dir, base)}...HEAD`], dir);
  return added.split("\0").filter((f) => f && SECRET_FILE.test(f));
}

/** The branch's changes on top of its base (for checks before pushing). */
export async function branchDiff(dir: string, base: string): Promise<string> {
  return git(["diff", "--no-color", "--no-ext-diff", `${await baseRef(dir, base)}...HEAD`], dir);
}

/**
 * Push the branch. `pushed: false` when it has no commits on top of the base (nothing to review). Commits someone else
 * pushed to the branch since `lastPushed` are merged in first (a conflict stops with an error) — the lease makes sure
 * nothing that arrived meanwhile is overwritten; the agent's own rewrites of what Godmode pushed may replace it. Only
 * the task's branch is fetched, and nothing is written to the repository's config (it may be the human's own).
 */
export async function pushBranch(opts: { dir: string; base: string; branch: string; lastPushed: string | null }): Promise<{ pushed: boolean; sha: string }> {
  const { dir, base, branch } = opts;
  return serialized(await repoKey(dir), async () => {
    const sha = () => git(["rev-parse", "HEAD"], dir);
    if (!(await commitsAhead(dir, base))) return { pushed: false, sha: await sha() };
    const listed = await git(["ls-remote", "origin", `refs/heads/${branch}`], dir, PUSH_TIMEOUT_MS);
    const remote = listed.split(/\s/)[0] || null;
    if (remote && remote !== opts.lastPushed && !(await gitOk(["merge-base", "--is-ancestor", remote, "HEAD"], dir))) {
      await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir, CLONE_TIMEOUT_MS);
      const identity = (await gitOk(["config", "user.email"], dir)) ? [] : ["-c", "user.name=Godmode", "-c", "user.email=godmode@localhost"];
      if (!(await gitOk([...identity, "merge", "--no-edit", `origin/${branch}`], dir))) {
        await gitOk(["merge", "--abort"], dir);
        throw new GitError(`Someone pushed to ${branch} and it conflicts with the agent's work — resolve it on the branch, then move the task to Todo.`);
      }
    }
    await git(["push", `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`, "origin", `HEAD:refs/heads/${branch}`], dir, PUSH_TIMEOUT_MS);
    return { pushed: true, sha: await sha() };
  });
}

/** The page that opens a pull request for `branch` (github/gitlab), or null for other hosts. */
export function compareUrl(url: string, base: string, branch: string): string | null {
  const repo = hostedRepo(url);
  if (!repo) return null;
  if (repo.host === "github") return `https://github.com/${repo.path}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  const q = new URLSearchParams({ "merge_request[source_branch]": branch, "merge_request[target_branch]": base });
  return `https://gitlab.com/${repo.path}/-/merge_requests/new?${q}`;
}

function ghBin(): string | null {
  return ghOverride !== undefined ? ghOverride : resolveGh();
}

async function gh(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  const bin = ghBin();
  if (!bin) return { ok: false, out: "", err: "GitHub CLI (gh) is not installed" };
  const res = await runCommand([bin, ...args], { cwd, env: env(), timeoutMs: GH_TIMEOUT_MS });
  return { ok: res.code === 0, out: res.stdout.trim(), err: lastLines(res.stderr || res.stdout) };
}

function parseState(state: unknown): PullRequestState | null {
  const s = String(state ?? "").toUpperCase();
  return s === "OPEN" ? "open" : s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : null;
}

async function viewPullRequest(dir: string, ref: string, repo: string[] = []): Promise<TaskPullRequest | null> {
  const res = await gh(["pr", "view", ref, ...repo, "--json", "url,number,state"], dir);
  if (!res.ok) return null;
  try {
    const v = JSON.parse(res.out) as { url?: string; number?: number; state?: string };
    return v.url ? { url: v.url, number: v.number ?? null, state: parseState(v.state) } : null;
  } catch {
    return null;
  }
}

/**
 * Open (or find) the pull request for the pushed branch. Without gh, or when it fails, `pullRequest` links to the page
 * that opens one (github/gitlab) and `problem` says why it wasn't opened automatically.
 */
export async function openPullRequest(opts: {
  dir: string;
  url: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}): Promise<{ pullRequest: TaskPullRequest | null; problem: string | null }> {
  const fallback = compareUrl(opts.url, opts.base, opts.branch);
  const manual = (problem: string) => ({ pullRequest: fallback ? { url: fallback, number: null, state: null } : null, problem });
  const hosted = hostedRepo(opts.url);
  if (hosted?.host !== "github") return manual("Pull requests are opened automatically for GitHub repositories only.");
  if (!ghBin()) return manual("Install the GitHub CLI (gh) and run `gh auth login` to open pull requests automatically.");
  // The repository the branch was pushed to — not an `upstream` remote gh would pick in a fork.
  const repo = ["--repo", hosted.path];

  const existing = await viewPullRequest(opts.dir, opts.branch, repo);
  if (existing && existing.state === "open") return { pullRequest: existing, problem: null };

  const bodyFile = join(tmpdir(), `godmode-pr-${newId("b", 8)}.md`);
  writeFileSync(bodyFile, opts.body, { mode: 0o600 });
  try {
    const res = await gh(
      ["pr", "create", ...repo, "--base", opts.base, "--head", opts.branch, "--title", opts.title, "--body-file", bodyFile],
      opts.dir,
    );
    if (!res.ok) {
      const found = await viewPullRequest(opts.dir, opts.branch, repo);
      return found?.state === "open" ? { pullRequest: found, problem: null } : manual(`gh couldn't open the pull request: ${res.err || "unknown error"}`);
    }
    const prUrl = res.out.split("\n").map((l) => l.trim()).reverse().find((l) => /^https?:\/\//.test(l)) ?? "";
    const number = Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]) || null;
    return { pullRequest: prUrl ? { url: prUrl, number, state: "open" } : (await viewPullRequest(opts.dir, opts.branch, repo)), problem: null };
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

/** Current state of an opened pull request (null when gh can't tell). */
export async function pullRequestState(dir: string, prUrl: string): Promise<PullRequestState | null> {
  if (!ghBin()) return null;
  return (await viewPullRequest(existsSync(dir) ? dir : tmpdir(), prUrl))?.state ?? null;
}
