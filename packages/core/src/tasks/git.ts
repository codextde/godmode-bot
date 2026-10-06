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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** New files that look like secrets (env files, keys, keystores); they are never committed, and never pushed. */
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

/** Who Godmode's own commits are by, in a repository without a configured author. */
async function identity(dir: string): Promise<string[]> {
  return (await gitOk(["config", "user.email"], dir)) ? [] : ["-c", "user.name=Godmode", "-c", "user.email=godmode@localhost"];
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

/** Commits the checked out branch (or `head`) has on top of its base. */
export async function commitsAhead(dir: string, base: string, head = "HEAD"): Promise<number> {
  return Number(await git(["rev-list", "--count", `${await baseRef(dir, base)}..${head}`], dir)) || 0;
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
    await git([...(await identity(dir)), "commit", "-m", opts.message], dir);
  }
  return { skipped };
}

/** Text with its secrets replaced; text without one comes back unchanged. */
type Clean = (text: string) => string;

/** Patches as the lines they add, whatever the human's git config says. A moved file adds only the lines that changed (-M). */
const ADDED = ["-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
/** Where the branch stays as the agent left it when Godmode rewrote it: refs of the task's worktree only, never pushed. */
const WITH_SECRETS = "refs/worktree/godmode/with-secrets";
/** Binary files show no lines, so they are read whole — up to this size (larger ones are media, not configuration). */
const MAX_BINARY_READ = 20 * 1024 * 1024;

/** The lines `-U0` patches add (in a merge: the ones none of its parents has), without their "+". */
function addedLines(patch: string): string {
  const lines: string[] = [];
  let plus = "";
  for (const line of patch.split("\n")) {
    const hunk = /^@@+/.exec(line);
    if (hunk) plus = "+".repeat(hunk[0].length - 1);
    else if (line.startsWith("diff --")) plus = "";
    else if (plus && line.startsWith(plus)) lines.push(line.slice(plus.length));
  }
  return lines.join("\n");
}

/**
 * Take secrets out of what a push would publish — the commits that are neither on the base nor on the remote yet — so
 * the branch can always be pushed. Only what those commits add counts: files that look like secrets, and what `clean`
 * changes (a saved secret) in a file name, an added line, a binary file the branch ends with, or a commit message.
 * Such files go back to what the remote has (new ones stay in the worktree, untracked), a secret in a text file is
 * replaced there, and a file that still adds one (binary, not UTF-8, a link, unwritable) is left out too. Every commit
 * is pushed, not only the last, so those commits become one on top of what the remote has; the branch as it was stays
 * in the worktree as the ref `kept`. `head` is the commit to push — null when the branch moved meanwhile (a turn that
 * started during the push committed): that turn's end pushes it. `removed` is null when there was nothing to take out.
 */
export async function removeSecrets(opts: {
  dir: string;
  base: string;
  lastPushed: string | null;
  message: string;
  clean: Clean;
}): Promise<{ head: string | null; removed: { left: string[]; replaced: string[]; kept: string } | null }> {
  const { dir, clean } = opts;
  const hit = (text: string) => clean(text) !== text;
  const old = await git(["rev-parse", "HEAD"], dir);
  const unpushed = ["--ignore-missing", old, "--not", await baseRef(dir, opts.base), "--remotes=origin", ...(opts.lastPushed ? [opts.lastPushed] : [])];
  const log = (...args: string[]) => git(["log", "--no-show-signature", ...args, ...unpushed], dir);
  const added = (await log("--cc", "--no-renames", "--diff-filter=A", "--name-only", "-z", "--format=")).split("\0");
  const left = new Set(added.filter((f) => f && (SECRET_FILE.test(f) || hit(f))));
  // Binary files (numstat "-") show no lines: every version the commits add is read whole; the last one is left out.
  const binary = new Set((await log("--numstat", "--no-renames", "-z", "--format=")).split("\0").filter((l) => l.startsWith("-\t-\t")).map((l) => l.slice(4)));
  let inBinary = false;
  if (binary.size) {
    const raw = (await log("--raw", "--no-abbrev", "--no-renames", "-z", "--format=")).split("\0"); // ":<modes> <old> <new> <status>", path
    const hits = new Map<string, Set<string>>();
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const [sha, path] = [raw[i]!.split(" ")[3], raw[i + 1]!];
      if (!sha || /^0+$/.test(sha) || !binary.has(path) || hits.get(path)?.has(sha)) continue;
      if (Number(await git(["cat-file", "-s", sha], dir)) > MAX_BINARY_READ || !hit(await git(["cat-file", "blob", sha], dir))) continue;
      hits.set(path, (hits.get(path) ?? new Set()).add(sha));
    }
    inBinary = hits.size > 0;
    if (inBinary) {
      for (const entry of (await git(["--literal-pathspecs", "ls-tree", "-z", old, "--", ...hits.keys()], dir)).split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab > 0 && hits.get(entry.slice(tab + 1))?.has(entry.slice(0, tab).split(" ")[2]!)) left.add(entry.slice(tab + 1));
      }
    }
  }
  const inText = hit(await log("--format=%B")) || hit(addedLines(await log("-p", "--cc", ...ADDED, "--format=")));
  if (!left.size && !inText && !inBinary) return { head: old, removed: null };

  const kept = `${WITH_SECRETS}/${old}`;
  // With a reflog: git cleaning up from another checkout of the repository doesn't see this worktree's refs, only their logs.
  await git(["update-ref", "--create-reflog", "-m", "godmode: before removing secrets", kept, old], dir);
  // The commits the unpushed ones start from: all on the remote already, so pushing the new commit never overwrites anything.
  const edges = (await git(["rev-list", "--boundary", ...unpushed], dir)).split("\n").filter((l) => l.startsWith("-"));
  if (!edges.length) throw new GitError("The branch shares no history with its base.");
  // The branch's own one first (git lists a merged base first): left-out files go back to the branch's version.
  const line = (await git(["rev-list", "--first-parent", ...unpushed], dir)).split("\n").at(-1);
  const own = await git(["rev-parse", "--verify", "--quiet", `${line}^`], dir).catch(() => "");
  const parents = (await git(["merge-base", "--independent", ...edges.map((l) => l.slice(1))], dir)).split("\n").sort((a, b) => Number(b === own) - Number(a === own));
  /** The changes from `parent` to what git has staged — or to `tree` once it is written. */
  const diff = (parent: string, args: string[], paths: string[] = [], tree?: string) =>
    git(["--literal-pathspecs", "diff", ...(tree ? [] : ["--cached"]), ...args, parent, ...(tree ? [tree] : []), "--", ...paths], dir);
  /** Per parent, the staged files that were moved (new name → old one): checked together, a moved file adds only what changed. */
  const moves = new Map<string, Map<string, string>>();
  const movedFrom = async (parent: string, path: string) => {
    if (!moves.has(parent)) {
      const out = (await diff(parent, ["-M", "--diff-filter=R", "--name-status", "-z"])).split("\0");
      const map = new Map<string, string>();
      for (let i = 0; i + 2 < out.length; i += 3) map.set(out[i + 2]!, out[i + 1]!);
      moves.set(parent, map);
    }
    return moves.get(parent)!.get(path);
  };
  /** Whether the new commit (staged, or `tree`) adds a secret (to `path`): only what none of the parents has counts. */
  const adds = async (path?: string, tree?: string) => {
    for (const parent of parents) {
      const from = path && (await movedFrom(parent, path));
      if (!hit(addedLines(await diff(parent, ADDED, [...(path ? [path] : []), ...(from ? [from] : [])], tree)))) return false;
    }
    return true;
  };

  const replaced: string[] = [];
  const changed = inText && (await adds()) ? (await diff(parents[0]!, ["--no-renames", "--diff-filter=d", "--name-only", "-z"])).split("\0") : [];
  for (const path of changed) {
    if (!path || left.has(path) || !(await adds(path))) continue;
    const file = join(dir, path);
    try {
      const bytes = lstatSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file) : null;
      const text = bytes?.toString() ?? "";
      // Only plain text is rewritten: never through a link, never binary data or a file that wouldn't come back byte for byte.
      if (bytes && !bytes.includes(0) && Buffer.from(text).equals(bytes) && hit(text)) {
        writeFileSync(file, clean(text));
        if ((await gitOk(["--literal-pathspecs", "add", "--", path], dir)) && !(await adds(path))) {
          replaced.push(path);
          continue;
        }
      }
    } catch {
      /* can't be read or written: left out */
    }
    left.add(path);
  }
  if (left.size) await git(["--literal-pathspecs", "reset", "-q", parents[0]!, "--", ...left], dir);

  const tree = await git(["write-tree"], dir);
  /** The tree is the checked commit plus the files taken care of, as they were left — nothing a turn staged meanwhile. */
  const checked = async () => {
    const touched = new Set([...replaced, ...left]);
    if ((await git(["diff", "--name-only", "--no-renames", "-z", old, tree], dir)).split("\0").some((f) => f && !touched.has(f))) return false;
    if (left.size && (await diff(parents[0]!, ["--name-only"], [...left], tree))) return false;
    for (const path of replaced) if (await adds(path, tree)) return false;
    return true;
  };
  if (await checked()) {
    // Nothing but secrets on top of what the remote has: the branch goes back to that.
    const nothing = parents.length === 1 && tree === (await git(["rev-parse", `${parents[0]}^{tree}`], dir));
    const message = clean(`${opts.message}\n\n${await log("--reverse", "--format=- %s")}`);
    const commit = nothing ? parents[0]! : await git([...(await identity(dir)), "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message], dir);
    // HEAD must still be the checked commit.
    if (await gitOk(["update-ref", "-m", "godmode: secrets removed before pushing", "HEAD", commit, old], dir)) {
      return { head: commit, removed: { left: [...left].filter((f) => lstatSync(join(dir, f), { throwIfNoEntry: false })), replaced, kept } };
    }
  }
  // A turn that started meanwhile staged or committed something unchecked: nothing is pushed now, its end pushes the branch.
  await gitOk(["update-ref", "-d", kept], dir);
  return { head: null, removed: null };
}

/**
 * Push the branch. `pushed: false` when it has no commits on top of the base (nothing to review). Commits someone else
 * pushed to the branch since `lastPushed` are merged in first (a conflict stops with an error) — the lease makes sure
 * nothing that arrived meanwhile is overwritten; the agent's own rewrites of what Godmode pushed may replace it. Only
 * the task's branch is fetched, and nothing is written to the repository's config (it may be the human's own).
 */
export async function pushBranch(opts: {
  dir: string;
  base: string;
  branch: string;
  lastPushed: string | null;
  /** The commit to push (the one checked for secrets) — not what a turn that started meanwhile commits. Default: HEAD. */
  head?: string;
}): Promise<{ pushed: boolean; sha: string }> {
  const { dir, base, branch } = opts;
  return serialized(await repoKey(dir), async () => {
    let head = opts.head ?? (await git(["rev-parse", "HEAD"], dir));
    if (!(await commitsAhead(dir, base, head))) return { pushed: false, sha: head };
    const listed = await git(["ls-remote", "origin", `refs/heads/${branch}`], dir, PUSH_TIMEOUT_MS);
    const remote = listed.split(/\s/)[0] || null;
    if (remote && remote !== opts.lastPushed && !(await gitOk(["merge-base", "--is-ancestor", remote, head], dir))) {
      // Merged in the worktree, so only while it still has the checked commit: a turn that started meanwhile pushes when it ends.
      if ((await git(["rev-parse", "HEAD"], dir)) !== head) return { pushed: false, sha: head };
      await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir, CLONE_TIMEOUT_MS);
      if (!(await gitOk([...(await identity(dir)), "merge", "--no-edit", `origin/${branch}`], dir))) {
        await gitOk(["merge", "--abort"], dir);
        throw new GitError(`Someone pushed to ${branch} and it conflicts with the agent's work — resolve it on the branch, then move the task to Todo.`);
      }
      head = await git(["rev-parse", "HEAD"], dir);
    }
    await git(["push", `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`, "origin", `${head}:refs/heads/${branch}`], dir, PUSH_TIMEOUT_MS);
    return { pushed: true, sha: head };
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

/**
 * Merge an open GitHub pull request with a merge commit — or squash/rebase when the repository allows only those.
 * `problem` says why it couldn't be merged (null when it was).
 */
export async function mergePullRequest(dir: string, prUrl: string): Promise<{ merged: boolean; problem: string | null }> {
  if (!ghBin()) return { merged: false, problem: "Install the GitHub CLI (gh) and run `gh auth login` to merge pull requests from Godmode." };
  const cwd = existsSync(dir) ? dir : tmpdir();
  let last = "";
  for (const method of ["--merge", "--squash", "--rebase"]) {
    const res = await gh(["pr", "merge", prUrl, method], cwd);
    if (res.ok || (await viewPullRequest(cwd, prUrl))?.state === "merged") return { merged: true, problem: null };
    last = res.err;
    if (!/not allowed|not enabled|method/i.test(res.err)) break;
  }
  return { merged: false, problem: mergeProblem(last) };
}

function mergeProblem(err: string): string {
  if (/not mergeable|cannot be cleanly created|conflict/i.test(err)) return "It has merge conflicts with its base branch — request changes so the agent resolves them.";
  if (/required status check|checks? (are|is) (pending|failing|expected)|review is required|approving review|protected branch|base branch policy/i.test(err)) {
    return `The base branch's rules don't allow merging it yet: ${err}`;
  }
  return `gh couldn't merge it: ${err || "unknown error"}`;
}
