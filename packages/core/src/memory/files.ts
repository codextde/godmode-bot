/**
 * An agent's memory files: MEMORY.md and the notes under memory/ in its repository.
 *
 * Used to load the memory into a run's system prompt, to notice when it changed between two turns of a chat, and to
 * snapshot what a dream rewrote so the human can review and undo it. Symlinks are never followed, and restores go
 * through the confined repository helpers.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DreamFileChange } from "@godmode/shared";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_DIR = "memory";
/** Characters of MEMORY.md loaded into a run's system prompt. Dreams keep the file well below this. */
export const MEMORY_PROMPT_LIMIT = 12_000;
const MAX_SNAPSHOT_FILE = 256 * 1024;
const MAX_SNAPSHOT_TOTAL = 2 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 500;

/**
 * The memory files at one moment: `files` holds the content of every text file that was read; `skipped` lists paths
 * that exist but weren't read (too large, binary, symlinked, over the snapshot limits) — their state is unknown, so
 * they are never reported as changed, restored or deleted.
 */
export interface MemorySnapshot {
  files: Record<string, string>;
  skipped: string[];
}

type Read = { text: string } | "skip" | "absent";

function readEntry(abs: string, max: number): Read {
  let info;
  try {
    info = lstatSync(abs);
  } catch {
    return "absent";
  }
  if (!info.isFile() || info.size > max) return "skip";
  try {
    const buf = readFileSync(abs);
    return buf.includes(0) ? "skip" : { text: buf.toString("utf8") };
  } catch {
    return "skip";
  }
}

function readText(abs: string, max: number): string | null {
  const entry = readEntry(abs, max);
  return typeof entry === "object" ? entry.text : null;
}

/** MEMORY.md, or null when the agent has none. */
export function readMemory(repoPath: string): string | null {
  return readText(join(repoPath, MEMORY_FILE), MAX_SNAPSHOT_FILE);
}

/** Short fingerprint of MEMORY.md ("" when it doesn't exist). */
export function memoryDigest(repoPath: string): string {
  const text = readMemory(repoPath);
  return text === null ? "" : createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** MEMORY.md for the system prompt: trimmed, and cut at a line break when it is longer than `limit`. */
export function memoryForPrompt(repoPath: string, limit = MEMORY_PROMPT_LIMIT): { text: string; truncated: boolean } | null {
  const text = readMemory(repoPath)?.trim();
  if (!text) return null;
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", limit);
  return { text: text.slice(0, cut > limit / 2 ? cut : limit).trimEnd(), truncated: true };
}

/** MEMORY.md and the files under memory/ (recursively; hidden entries are ignored, symlinks never followed). */
export function snapshotMemory(repoPath: string): MemorySnapshot {
  const snap: MemorySnapshot = { files: {}, skipped: [] };
  let total = 0;
  const add = (rel: string, abs: string) => {
    const entry = readEntry(abs, MAX_SNAPSHOT_FILE);
    if (entry === "absent") return;
    const count = Object.keys(snap.files).length;
    if (entry === "skip" || count >= MAX_SNAPSHOT_FILES || total + entry.text.length > MAX_SNAPSHOT_TOTAL) {
      snap.skipped.push(rel);
      return;
    }
    snap.files[rel] = entry.text;
    total += entry.text.length;
  };
  add(MEMORY_FILE, join(repoPath, MEMORY_FILE));
  const walk = (relDir: string, depth: number) => {
    const abs = join(repoPath, relDir);
    let info;
    try {
      info = lstatSync(abs);
    } catch {
      return;
    }
    if (info.isSymbolicLink() || depth > 6) {
      snap.skipped.push(relDir);
      return;
    }
    if (!info.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      snap.skipped.push(relDir);
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const rel = `${relDir}/${name}`;
      let entry;
      try {
        entry = lstatSync(join(repoPath, rel));
      } catch {
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) walk(rel, depth + 1);
      else add(rel, join(repoPath, rel));
    }
  };
  walk(MEMORY_DIR, 0);
  return snap;
}

/** A snapshot stored before the format had `skipped` (a bare path → content map). */
export function parseSnapshot(json: string | null): MemorySnapshot | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === "object" && "files" in value) return value as MemorySnapshot;
    if (value && typeof value === "object") return { files: value as Record<string, string>, skipped: [] };
  } catch {
    /* corrupt */
  }
  return null;
}

/** A path that was skipped (or lies under a skipped directory) in either snapshot has an unknown state. */
function unknown(path: string, ...snaps: MemorySnapshot[]): boolean {
  return snaps.some((s) => s.skipped.some((p) => path === p || path.startsWith(`${p}/`)));
}

/** Files that differ between two snapshots (MEMORY.md first, then by path). Paths of unknown state are left out. */
export function diffSnapshots(before: MemorySnapshot, after: MemorySnapshot): DreamFileChange[] {
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changes: DreamFileChange[] = [];
  for (const path of paths) {
    if (unknown(path, before, after)) continue;
    const b = before.files[path] ?? null;
    const a = after.files[path] ?? null;
    if (b !== a) changes.push({ path, before: b, after: a });
  }
  return changes.sort((x, y) => (x.path === MEMORY_FILE ? -1 : y.path === MEMORY_FILE ? 1 : x.path.localeCompare(y.path)));
}

/** Only memory files may be restored (paths come from the database). */
export function isMemoryPath(path: string): boolean {
  if (path === MEMORY_FILE) return true;
  const parts = path.split("/");
  return parts[0] === MEMORY_DIR && parts.length > 1 && parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.startsWith("."));
}

/** The current content of a memory file (null = missing or not a readable text file). */
export function currentMemoryFile(repoPath: string, path: string): string | null {
  return readText(join(repoPath, path), MAX_SNAPSHOT_FILE);
}

/** No symlink on the way from the repository to `rel` (the file itself included, when it exists). */
function confined(repoPath: string, rel: string): boolean {
  let probe = repoPath;
  for (const part of rel.split("/")) {
    probe = join(probe, part);
    try {
      if (lstatSync(probe).isSymbolicLink()) return false;
    } catch {
      break; // the rest doesn't exist yet
    }
  }
  try {
    const root = realpathSync(repoPath);
    const parent = relative(root, realpathSync(dirname(join(repoPath, rel))));
    return parent === "" || (!parent.startsWith("..") && !parent.startsWith(sep));
  } catch {
    return true; // the parent directory doesn't exist yet: it is created inside the repository
  }
}

/** The path is a memory file that restoreFiles may write or delete. */
export function canRestore(repoPath: string, path: string): boolean {
  return isMemoryPath(path) && confined(repoPath, path);
}

/**
 * Put the files back the way they were before the changes (a file that didn't exist is removed). Synchronous, so a
 * rolled-back dream is fully undone before the agent's next run reads its memory. Returns the paths restored.
 */
export function restoreFiles(repoPath: string, changes: DreamFileChange[]): string[] {
  const restored: string[] = [];
  for (const change of changes) {
    if (!canRestore(repoPath, change.path)) continue;
    const abs = join(repoPath, change.path);
    if (change.before === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, change.before, "utf8");
    }
    restored.push(change.path);
  }
  return restored;
}
