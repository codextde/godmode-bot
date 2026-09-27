/**
 * Git helpers for agent repositories (isomorphic-git, no git binary required).
 *
 * Every operation that touches a repository is serialized per repository with a promise-chain mutex,
 * so the runner, the settings writer and the file editor never interleave git index updates.
 * File access is confined to the repository: paths are resolved (including symlinks) and must stay
 * inside it, and `.git` is never readable or writable through these helpers.
 */
import git from "isomorphic-git";
import fs from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentFileEntry, GitCommit } from "@godmode/shared";
import { config } from "../config";
import { HttpError, badRequest, forbidden, notFound } from "../util";

export const GIT_AUTHOR = { name: "Godmode Bot", email: "bot@godmode.local" };
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Per-repository mutex                                                */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<void>>();

/** Git repositories managed here always live inside the Godmode data directory — never anywhere else. */
function assertManagedDir(dir: string) {
  const root = resolve(config().dataDir);
  const rel = relative(root, resolve(dir));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing repository operation outside the Godmode data directory: ${resolve(dir)}`);
  }
}

/** Run `fn` exclusively for the repository at `dir` (FIFO per repository). */
export function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  try {
    assertManagedDir(dir);
  } catch (err) {
    return Promise.reject(err);
  }
  const key = resolve(dir);
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return result;
}

/** Resolves once every operation queued so far for the repository has settled. */
export function repoIdle(dir: string): Promise<void> {
  return locks.get(resolve(dir)) ?? Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* Git operations                                                      */
/* ------------------------------------------------------------------ */

async function ensureGit(dir: string) {
  await mkdir(dir, { recursive: true });
  if (!fs.existsSync(join(dir, ".git"))) {
    await git.init({ fs, dir, defaultBranch: "main" });
  }
}

/** Create the directory and initialize a git repository on branch `main` (idempotent). */
export function initRepo(dir: string): Promise<void> {
  return withRepoLock(dir, () => ensureGit(dir));
}

/**
 * Stage every addition, modification and deletion (respecting .gitignore) and commit.
 * Returns the new commit oid, or null when the working tree already matches HEAD.
 */
export function commitAll(dir: string, message: string): Promise<string | null> {
  return withRepoLock(dir, () => commitAllInLock(dir, message));
}

/** Same as commitAll, for callers that already hold the lock via withRepoLock(dir, …). */
export async function commitAllInLock(dir: string, message: string): Promise<string | null> {
  await ensureGit(dir);
  const cache = {};
  const indexSecond = await stat(join(dir, ".git", "index")).then(
    (s) => Math.floor(s.mtimeMs / 1000),
    () => null,
  );
  let matrix: StatusRow[] = await git.statusMatrix({ fs, dir, cache });
  if (indexSecond !== null) matrix = await recheckRacyFiles(dir, matrix, indexSecond, cache);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  let changed = false;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    const matchesHead = (head === 1 && workdir === 1) || (head === 0 && workdir === 0);
    if (!matchesHead) changed = true;
    if (workdir === 0) toRemove.push(filepath);
    else toAdd.push(filepath);
  }
  for (const filepath of toRemove) await git.remove({ fs, dir, filepath, cache });
  if (toAdd.length) await git.add({ fs, dir, filepath: toAdd, cache });
  if (!changed) return null;
  return git.commit({ fs, dir, message: message.trim() || "Update", author: GIT_AUTHOR, cache });
}

type StatusRow = [string, number, number, number];

/**
 * isomorphic-git trusts the index stat cache at one-second granularity and has no racy-git handling, so a file
 * rewritten with the same size in the same second the index was written looks unchanged. Re-hash such
 * "racily clean" files (mtime second >= index mtime second) and refresh their status rows.
 */
async function recheckRacyFiles(dir: string, matrix: StatusRow[], indexSecond: number, cache: object): Promise<StatusRow[]> {
  const racy: string[] = [];
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head !== 1 || workdir !== 1 || stage !== 1) continue;
    const s = await lstat(join(dir, filepath)).catch(() => null);
    if (s && Math.floor(s.mtimeMs / 1000) >= indexSecond) racy.push(filepath);
  }
  if (!racy.length) return matrix;
  await git.add({ fs, dir, filepath: racy, cache });
  const fresh = new Map((await git.statusMatrix({ fs, dir, filepaths: racy, cache })).map((row) => [row[0], row]));
  return matrix.map((row) => fresh.get(row[0]) ?? row);
}

/** Most recent commits on HEAD (newest first). Empty for a repository without commits. */
export function log(dir: string, depth = 50): Promise<GitCommit[]> {
  return withRepoLock(dir, async () => {
    if (!fs.existsSync(join(dir, ".git"))) return [];
    try {
      const commits = await git.log({ fs, dir, ref: "HEAD", depth: Math.max(1, Math.min(depth, 1000)) });
      return commits.map((c) => ({
        oid: c.oid,
        message: c.commit.message.trim(),
        author: c.commit.author.name,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
      }));
    } catch (err) {
      if (err instanceof Error && err.name === "NotFoundError") return [];
      throw err;
    }
  });
}

/** Move a repository out of the way into `trashDir/<name>-<timestamp>` (never deletes). */
export function moveToTrash(dir: string, trashDir: string, name: string): Promise<string | null> {
  return withRepoLock(dir, async () => {
    if (!fs.existsSync(dir)) return null;
    await mkdir(trashDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = join(trashDir, `${name}-${stamp}`);
    for (let i = 2; fs.existsSync(target); i++) target = join(trashDir, `${name}-${stamp}-${i}`);
    await rename(dir, target);
    return target;
  });
}

/* ------------------------------------------------------------------ */
/* Confined file access                                                */
/* ------------------------------------------------------------------ */

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function touchesGitDir(root: string, target: string): boolean {
  return relative(root, target)
    .split(sep)
    .some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Resolve a repository-relative path lexically. Rejects absolute paths, traversal outside the repository
 * and anything inside `.git`. Returns the absolute path and the normalized relative path ("" = root).
 */
export function resolveRepoPath(root: string, relPath: string): { abs: string; rel: string } {
  if (typeof relPath !== "string" || relPath.includes("\0")) throw badRequest("Invalid path");
  const cleaned = relPath.replace(/\\/g, "/").trim();
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) {
    throw forbidden("Path must be relative to the agent repository");
  }
  const base = resolve(root);
  const abs = resolve(base, cleaned);
  if (!isInside(base, abs)) throw forbidden("Path is outside the agent repository");
  if (touchesGitDir(base, abs)) throw forbidden("Access to .git is not allowed");
  const rel = relative(base, abs).split(sep).filter(Boolean).join("/");
  return { abs, rel };
}

/** Follow symlinks: the real location of `abs` (or of its nearest existing ancestor) must stay inside the repo. */
async function assertRealInside(root: string, abs: string): Promise<void> {
  const realRoot = await realpath(root);
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(probe);
      if (parent === probe) throw forbidden("Path is outside the agent repository");
      probe = parent;
      continue;
    }
    if (!isInside(realRoot, real)) throw forbidden("Path is outside the agent repository");
    if (touchesGitDir(realRoot, real)) throw forbidden("Access to .git is not allowed");
    return;
  }
}

function ensureRepoExists(root: string) {
  if (!fs.existsSync(root)) throw notFound("Agent repository");
}

/** List a directory of the repository (dirs first, then files; `.git` excluded). */
export async function listFiles(dir: string, relPath = ""): Promise<AgentFileEntry[]> {
  ensureRepoExists(dir);
  const { abs, rel } = resolveRepoPath(dir, relPath);
  await assertRealInside(dir, abs);
  let info: fs.Stats;
  try {
    info = await stat(abs);
  } catch {
    throw notFound("Directory");
  }
  if (!info.isDirectory()) throw badRequest("Path is not a directory");

  const realRoot = await realpath(dir);
  const entries: AgentFileEntry[] = [];
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") continue;
    const childAbs = join(abs, entry.name);
    let s: fs.Stats;
    try {
      s = await lstat(childAbs);
      if (s.isSymbolicLink()) {
        const real = await realpath(childAbs);
        if (!isInside(realRoot, real) || touchesGitDir(realRoot, real)) continue;
        s = await stat(childAbs);
      }
    } catch {
      continue;
    }
    if (!s.isDirectory() && !s.isFile()) continue;
    entries.push({
      path: rel ? `${rel}/${entry.name}` : entry.name,
      type: s.isDirectory() ? "dir" : "file",
      size: s.isDirectory() ? 0 : s.size,
      modifiedAt: s.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true, sensitivity: "base" });
  });
  return entries;
}

function decodeText(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Read a UTF-8 text file from the repository (max 2 MB). */
export async function readRepoFile(dir: string, relPath: string): Promise<{ path: string; content: string }> {
  ensureRepoExists(dir);
  const { abs, rel } = resolveRepoPath(dir, relPath);
  if (!rel) throw badRequest("A file path is required");
  await assertRealInside(dir, abs);
  let info: fs.Stats;
  try {
    info = await stat(abs);
  } catch {
    throw notFound("File");
  }
  if (info.isDirectory()) throw badRequest("Path is a directory");
  if (!info.isFile()) throw badRequest("Not a regular file");
  if (info.size > MAX_FILE_BYTES) throw new HttpError(413, "File is too large to open (max 2 MB)", "too_large");
  const content = decodeText(await readFile(abs));
  if (content === null) throw new HttpError(415, "Binary files cannot be opened as text", "binary_file");
  return { path: rel, content };
}

/** Write a UTF-8 text file inside the repository (creates parent directories). Returns the relative path. */
export async function writeRepoFile(dir: string, relPath: string, content: string): Promise<string> {
  ensureRepoExists(dir);
  const { abs, rel } = resolveRepoPath(dir, relPath);
  if (!rel) throw badRequest("A file path is required");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new HttpError(413, "File is too large (max 2 MB)", "too_large");
  }
  return withRepoLock(dir, async () => {
    await assertRealInside(dir, abs);
    const existing = await stat(abs).catch(() => null);
    if (existing?.isDirectory()) throw badRequest("Path is a directory");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return rel;
  });
}
