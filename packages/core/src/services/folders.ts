/**
 * Folders an agent or a single chat can work in (Claude's cwd): validation, the folder browser behind the
 * UI picker, and recently used folders. Paths refer to the machine the core runs on.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FolderListing } from "@godmode/shared";
import { config } from "../config";
import { all } from "../db";
import { HttpError, badRequest, notFound } from "../util";

const MAX_ENTRIES = 500;

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function absolute(input: string): string {
  const expanded = expandHome(input.trim());
  if (!isAbsolute(expanded)) throw badRequest(`Use an absolute folder path, e.g. ${join(homedir(), "Projects")}`);
  return resolve(expanded);
}

/**
 * Folders overlapping Godmode's data directory are refused: without bypass mode the working directory is where
 * Claude may edit files, and the data directory holds other agents' repositories, the database and the access token.
 * The one exception is a coding task's own checkout (tasks/<id>).
 */
function dataDirConflict(path: string, realData = realOrSelf(config().dataDir)): string | null {
  const real = realOrSelf(path);
  if (isTaskCheckout(real, realData)) return null;
  if (isInside(real, realData)) return "Pick a folder outside Godmode's data directory — agents already have their own repository there.";
  if (isInside(realData, real)) return "Pick a more specific folder — this one contains Godmode's data directory.";
  return null;
}

function isTaskCheckout(real: string, realData: string): boolean {
  const rel = relative(join(realData, "tasks"), real);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("/") && !rel.includes("\\");
}

/** Why an absolute `path` can't be a working folder, or null when it can. */
export function workingDirectoryProblem(path: string): string | null {
  if (!isAbsolute(path) || !isDirectory(path)) return `Folder not found: ${path}`;
  return dataDirConflict(path);
}

/** Absolute path of a usable working folder; empty input = no folder (null). */
export function normalizeWorkingDirectory(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  const path = absolute(input);
  const problem = workingDirectoryProblem(path);
  if (problem) throw badRequest(problem);
  return path;
}

function roots(): string[] {
  if (process.platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (existsSync(drive)) drives.push(drive);
  }
  return drives;
}

export function listFolders(input?: string, showHidden = false): FolderListing {
  const home = homedir();
  const path = input?.trim() ? absolute(input) : home;
  let names: string[];
  try {
    names = readdirSync(path, { withFileTypes: true })
      .filter((d) => showHidden || !d.name.startsWith("."))
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDirectory(join(path, d.name))))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notFound("Folder");
    if (code === "EACCES" || code === "EPERM") throw new HttpError(403, `Godmode isn't allowed to read ${path}`, "forbidden");
    throw err;
  }
  const realData = realOrSelf(config().dataDir);
  const entries = names.slice(0, MAX_ENTRIES).map((name) => {
    const p = join(path, name);
    return { name, path: p, git: existsSync(join(p, ".git")), blocked: dataDirConflict(p, realData) !== null };
  });
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home,
    roots: roots(),
    blocked: dataDirConflict(path, realData),
    entries,
    truncated: names.length > MAX_ENTRIES,
  };
}

/** Folders recently attached to chats or agents, most recent first (only ones still usable). */
export function recentFolders(limit = 6): string[] {
  const rows = all<{ path: string }>(
    `SELECT path, MAX(ts) AS ts FROM (
       SELECT working_directory AS path, COALESCE(last_message_at, updated_at) AS ts FROM conversations WHERE working_directory IS NOT NULL AND origin != 'task'
       UNION ALL
       SELECT working_directory AS path, updated_at AS ts FROM agents WHERE working_directory IS NOT NULL
     ) GROUP BY path ORDER BY ts DESC LIMIT ?`,
    limit * 3,
  );
  return rows
    .map((r) => r.path)
    .filter((p) => !workingDirectoryProblem(p))
    .slice(0, limit);
}
