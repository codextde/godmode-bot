/**
 * Git and pull requests for coding tasks: clone the repository onto the task's branch, push it when the agent is done
 * and open a pull request with the GitHub CLI (or link to the page that opens one). Uses the human's own git
 * credentials (credential helper, SSH keys) and `gh` login; nothing ever prompts.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PullRequestState, TaskPullRequest } from "@godmode/shared";
import { resolveGh, resolveGit, runCommand, stripAnsi, toolPath } from "../services/doctor";
import { childEnv, newId } from "../util";

const CLONE_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 60_000;

let ghOverride: string | null | undefined;

/** Tests: use this gh binary (null = pretend gh isn't installed); undefined = auto-detect. */
export function __setGhForTests(path: string | null | undefined) {
  ghOverride = path;
}

export class GitError extends Error {
  constructor(message: string) {
    super(hideCredentials(message));
  }
}

/** A remote URL without the user/token part (`https://user:token@host/…` → `https://host/…`), for prompts and messages. */
export function hideCredentials(text: string): string {
  return text.replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, "$1");
}

/** New files that look like secrets (env files, keys, keystores); they are never committed. */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|\.netrc)$/i;

function env() {
  return childEnv({ PATH: toolPath(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
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
  const bin = resolveGit();
  if (!bin) throw new GitError("git is not installed (Settings → System).");
  const res = await runCommand([bin, ...args], { cwd, env: env(), timeoutMs });
  if (res.timedOut) throw new GitError(`git ${args[0]} timed out`);
  if (res.code !== 0) throw new GitError(lastLines(res.stderr || res.stdout) || `git ${args[0]} failed`);
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

/** A remote that can be cloned: https/ssh/git URL, scp-like `git@host:owner/repo`, or a local path (tests). */
export function validRepoUrl(url: string): boolean {
  const u = url.trim();
  if (!u || /\s/.test(u) || u.startsWith("-")) return false;
  return /^(https?|ssh|git|file):\/\//i.test(u) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(u) || u.startsWith("/");
}

/** Branch name git accepts (subset of `git check-ref-format`). */
export function validBranchName(name: string): boolean {
  return /^[\w][\w./-]*$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock") && !name.includes("//");
}

async function defaultBranch(dir: string): Promise<string> {
  try {
    return (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).replace(/^origin\//, "");
  } catch {
    for (const candidate of ["main", "master"]) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], dir)) return candidate;
    }
    throw new GitError("Could not find the repository's default branch — set a base branch on the task or workspace.");
  }
}

/**
 * Clone (or refresh) the checkout and switch to the task's branch, created from `origin/<base>` the first time.
 * Returns the base branch used ("" base = the repository's default branch).
 */
export async function prepareCheckout(opts: { dir: string; url: string; base: string; branch: string }): Promise<{ base: string }> {
  const { dir, url, branch } = opts;
  if (existsSync(join(dir, ".git"))) {
    await git(["remote", "set-url", "origin", url], dir);
    await git(["fetch", "--prune", "origin"], dir, CLONE_TIMEOUT_MS);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    await git(["clone", "--origin", "origin", "--", url, dir], dirname(dir), CLONE_TIMEOUT_MS);
  }
  const base = opts.base || (await defaultBranch(dir));
  if (!(await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], dir))) {
    throw new GitError(`The branch "${base}" doesn't exist in ${url}.`);
  }
  if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir)) {
    await git(["checkout", branch], dir);
    // Take what was pushed to the branch meanwhile (review commits, "Update branch" merges), when it fast-forwards.
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], dir)) await gitOk(["merge", "--ff-only", `origin/${branch}`], dir);
  } else await git(["checkout", "--no-track", "-b", branch, `origin/${base}`], dir);
  return { base };
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
  const added = await git(["diff", "--name-only", "--diff-filter=A", "-z", `origin/${base}...HEAD`], dir);
  return added.split("\0").filter((f) => f && SECRET_FILE.test(f));
}

/** The branch's changes on top of its base (for checks before pushing), cut at `max` characters. */
export async function branchDiff(dir: string, base: string, max = 5_000_000): Promise<string> {
  const bin = resolveGit();
  if (!bin) throw new GitError("git is not installed (Settings → System).");
  const res = await runCommand([bin, "diff", "--no-color", "--no-ext-diff", `origin/${base}...HEAD`], { cwd: dir, env: env(), timeoutMs: GIT_TIMEOUT_MS, maxOutput: max });
  if (res.code !== 0) throw new GitError(lastLines(res.stderr) || "git diff failed");
  return res.stdout;
}

/**
 * Push the branch. `pushed: false` when it has no commits on top of the base (nothing to review). Commits someone else
 * pushed to the branch since `lastPushed` are merged in first (a conflict stops with an error) — the lease makes sure
 * nothing that arrived meanwhile is overwritten; the agent's own rewrites of what Godmode pushed may replace it.
 */
export async function pushBranch(opts: { dir: string; base: string; branch: string; lastPushed: string | null }): Promise<{ pushed: boolean; sha: string }> {
  const { dir, base, branch } = opts;
  const sha = () => git(["rev-parse", "HEAD"], dir);
  const commits = Number(await git(["rev-list", "--count", `origin/${base}..HEAD`], dir)) || 0;
  if (!commits) return { pushed: false, sha: await sha() };
  await git(["fetch", "--prune", "origin"], dir, CLONE_TIMEOUT_MS);
  const remote = (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], dir))
    ? await git(["rev-parse", `refs/remotes/origin/${branch}`], dir)
    : null;
  if (remote && remote !== opts.lastPushed && !(await gitOk(["merge-base", "--is-ancestor", remote, "HEAD"], dir))) {
    const identity = (await gitOk(["config", "user.email"], dir)) ? [] : ["-c", "user.name=Godmode", "-c", "user.email=godmode@localhost"];
    if (!(await gitOk([...identity, "merge", "--no-edit", `origin/${branch}`], dir))) {
      await gitOk(["merge", "--abort"], dir);
      throw new GitError(`Someone pushed to ${branch} and it conflicts with the agent's work — resolve it on the branch, then move the task to Todo.`);
    }
  }
  await git(["push", `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`, "-u", "origin", `HEAD:refs/heads/${branch}`], dir, PUSH_TIMEOUT_MS);
  return { pushed: true, sha: await sha() };
}

/** owner/repo of a github.com or gitlab.com remote. */
export function hostedRepo(url: string): { host: "github" | "gitlab"; path: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[/:](.+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return null;
  return { host: m[1]!.toLowerCase() === "github.com" ? "github" : "gitlab", path: m[2]! };
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

async function viewPullRequest(dir: string, ref: string): Promise<TaskPullRequest | null> {
  const res = await gh(["pr", "view", ref, "--json", "url,number,state"], dir);
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
  if (hostedRepo(opts.url)?.host !== "github") return manual("Pull requests are opened automatically for GitHub repositories only.");
  if (!ghBin()) return manual("Install the GitHub CLI (gh) and run `gh auth login` to open pull requests automatically.");

  const existing = await viewPullRequest(opts.dir, opts.branch);
  if (existing && existing.state === "open") return { pullRequest: existing, problem: null };

  const bodyFile = join(tmpdir(), `godmode-pr-${newId("b", 8)}.md`);
  writeFileSync(bodyFile, opts.body, { mode: 0o600 });
  try {
    const res = await gh(
      ["pr", "create", "--base", opts.base, "--head", opts.branch, "--title", opts.title, "--body-file", bodyFile],
      opts.dir,
    );
    if (!res.ok) {
      const found = await viewPullRequest(opts.dir, opts.branch);
      return found ? { pullRequest: found, problem: null } : manual(`gh couldn't open the pull request: ${res.err || "unknown error"}`);
    }
    const prUrl = res.out.split("\n").map((l) => l.trim()).reverse().find((l) => /^https?:\/\//.test(l)) ?? "";
    const number = Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]) || null;
    return { pullRequest: prUrl ? { url: prUrl, number, state: "open" } : (await viewPullRequest(opts.dir, opts.branch)), problem: null };
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

/** Current state of an opened pull request (null when gh can't tell). */
export async function pullRequestState(dir: string, prUrl: string): Promise<PullRequestState | null> {
  if (!ghBin()) return null;
  return (await viewPullRequest(existsSync(dir) ? dir : tmpdir(), prUrl))?.state ?? null;
}
