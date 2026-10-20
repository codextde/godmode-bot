/**
 * The Files page: the human looks through an agent's repository and tidies it by hand — folder sizes, the agent's
 * notes, a search, a review of what clutters it (build output, junk, empty entries, copies, large files, stale and
 * unsorted entries, memory notes nothing links to), new folders, moves and deletes.
 *
 * A delete goes into the agent's bin (`<agents>/.deleted-files/<agent>/<entry>/`), where it waits to be put back until
 * the automatic cleanup removes what is older than DELETED_DAYS (services/cleanup.ts). A move points the agent's memory
 * at the new place. Godmode's own files stay where they are (lockReason), nothing moves while the agent dreams (the
 * dream's rollback and undo would lose track of it), symlinks are never followed, and every change is committed.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  Agent,
  AgentFileInfo,
  AgentFileMoveResult,
  AgentFileRestoreResult,
  AgentFileSearchHit,
  AgentFileSize,
  AgentFilesDeleteResult,
  AgentFilesOverview,
  AgentNote,
  DeletedAgentFile,
  FileReview,
  FileReviewItem,
  FileReviewKind,
} from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { config } from "../config";
import { all } from "../db";
import { isDreaming } from "../memory/dreaming";
import { memoryTopics } from "../memory/editor";
import { MEMORY_DIR, MEMORY_FILE, canRestore, memoryChars, snapshotMemory } from "../memory/files";
import { listNotes, namesOf, noteTitle, WORKSPACE_DIR } from "../memory/workspace";
import { HttpError, badRequest, conflict, notFound, now } from "../util";
import { AGENT_REPO_DIRS } from "./claudeMd";
import { commitAllInLock, resolveRepoPath, withRepoLock } from "./repo";
import { withRepo } from "./service";

const BIN = ".deleted-files";
/** What the human deleted waits this long in the agent's bin, then the automatic cleanup removes it. */
export const DELETED_DAYS = 30;
const DAY = 86_400_000;
/** Entries one size count visits at most (a folder with more counts as "at least"). */
const COUNT_BUDGET = 400_000;
const REVIEW_BUDGET = 250_000;
const SEARCH_BUDGET = 80_000;
const SEARCH_LIMIT = 100;
const SEARCH_READ_MAX = 512 * 1024;
const LARGE = 25 * 1024 * 1024;
const LARGE_SCRATCH = 50 * 1024 * 1024;
const STALE_DAYS = 30;
const RECENT_DAYS = 3;
const HASH_MIN = 1024;
const HASH_MAX_FILE = 1024 * 1024 * 1024;
const HASH_BUDGET = 2 * 1024 * 1024 * 1024;
const KIND_LIMIT = 200;
const MAX_PATHS = 500;
const CACHE_MS = 30_000;

const SCRATCH = `${WORKSPACE_DIR}/tmp`;
const UPLOADS = `${WORKSPACE_DIR}/uploads`;

/** Installed packages and caches: installing or building again brings them back. */
const BUILD = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  ".pytest_cache",
  ".parcel-cache",
  ".svelte-kit",
  ".dart_tool",
  ".expo",
]);
/** Build output, when it lies next to a project file. */
const OUTPUT = new Set(["build", "dist", "out", "target", ".build"]);
const PROJECT_FILES = ["package.json", "build.gradle", "build.gradle.kts", "pubspec.yaml", "Cargo.toml", "pyproject.toml", "setup.py", "Package.swift", "pom.xml", "Podfile"];
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|npm-debug\.log.*|yarn-error\.log|~\$.*|\.~lock\..*#)$|\.(log|tmp|temp|bak|swp|crdownload|part)$/i;
const TEXT = /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|toml|html?|css|xml|sh|py|m?js|ts|tsx|jsx|sql|env\.example)$/i;
const NOTE = /\.(md|markdown)$/i;
const ROOT_KNOWN = new Set([MEMORY_FILE, "CLAUDE.md", ".gitignore", ...AGENT_REPO_DIRS]);

/* ------------------------------------------------------------------ */
/* What stays put                                                       */
/* ------------------------------------------------------------------ */

const FIXED: Record<string, string> = {
  "": "The agent's repository itself.",
  [MEMORY_FILE]: "The agent's memory: edit it here, but it stays.",
  "CLAUDE.md": "Written from the agent's settings — change them in its Settings tab.",
  ".gitignore": "Keeps scratch files and run logs out of the agent's history.",
  [WORKSPACE_DIR]: "Every agent has this folder.",
  [MEMORY_DIR]: "Every agent has this folder.",
  [SCRATCH]: "Godmode's scratch folder: what lies in it goes by itself a week after its last change.",
  [UPLOADS]: "Where the files you attach in chats land.",
};
const GODMODE_DIRS: Record<string, string> = {
  conversations: "Chat transcripts are written by Godmode.",
  runs: "Run logs are written by Godmode — Settings → Cleanup removes the old ones.",
  state: "A snapshot of the agent's settings, written by Godmode.",
};

/** Why `rel` can't be moved or deleted on the Files page (null = it can). */
export function lockReason(rel: string): string | null {
  if (rel in FIXED) return FIXED[rel]!;
  const parts = rel.split("/");
  if (parts.length === 2 && parts[1] === ".gitkeep" && (AGENT_REPO_DIRS as readonly string[]).includes(parts[0]!)) return "Keeps the folder in the agent's history.";
  return GODMODE_DIRS[parts[0]!] ?? null;
}

/** Where moved entries and new folders may go: inside workspace/ or memory/. */
function placeable(rel: string): boolean {
  return rel.startsWith(`${WORKSPACE_DIR}/`) || rel.startsWith(`${MEMORY_DIR}/`);
}

/** No symlink on the way from the repository down to `rel` (with `self`, the entry itself neither). */
function noLink(root: string, rel: string, self = true): boolean {
  const parts = rel ? rel.split("/") : [];
  let probe = root;
  for (let i = 0; i < parts.length; i++) {
    probe = join(probe, parts[i]!);
    if (i === parts.length - 1 && !self) break;
    try {
      if (lstatSync(probe).isSymbolicLink()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function entryOf(root: string, rel: string) {
  try {
    return lstatSync(join(root, rel));
  } catch {
    return null;
  }
}

/** A path of the repository as the human sent it, confined to it ("" = the repository itself). */
function repoPath(agent: Agent, input: string): string {
  return resolveRepoPath(agent.repoPath, input).rel;
}

function refuseWhileDreaming(agent: Agent) {
  if (isDreaming(agent.id)) {
    throw conflict(`${agent.name} is dreaming (tidying its memory and workspace) right now — try again when the dream has ended.`);
  }
}

/* ------------------------------------------------------------------ */
/* Sizes                                                                */
/* ------------------------------------------------------------------ */

interface Tally {
  bytes: number;
  files: number;
  modified: number;
  partial: boolean;
}

const NONE: Tally = { bytes: 0, files: 0, modified: 0, partial: false };

function add(a: Tally, b: Tally): Tally {
  return { bytes: a.bytes + b.bytes, files: a.files + b.files, modified: Math.max(a.modified, b.modified), partial: a.partial || b.partial };
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

const io = limiter(48);

/** Counts what lies below a path (symlinks counted, never followed) within one budget of entries. */
class Counter {
  constructor(private left = COUNT_BUDGET) {}

  async of(abs: string): Promise<Tally> {
    if (this.left-- <= 0) return { ...NONE, partial: true };
    const st = await io(() => lstat(abs)).catch(() => null);
    if (!st) return NONE;
    if (!st.isDirectory()) return { bytes: st.size, files: 1, modified: st.mtimeMs, partial: false };
    const names = await io(() => readdir(abs)).catch(() => [] as string[]);
    const total = (await Promise.all(names.map((n) => this.of(join(abs, n))))).reduce(add, NONE);
    return total.files ? total : { ...total, modified: st.mtimeMs };
  }
}

const sizeCache = new Map<string, { at: number; tally: Promise<Tally> }>();

function cachedTally(abs: string): Promise<Tally> {
  const hit = sizeCache.get(abs);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tally;
  const tally = new Counter().of(abs);
  sizeCache.set(abs, { at: Date.now(), tally });
  return tally;
}

const reviewCache = new Map<string, { at: number; review: Promise<FileReview> }>();
let overviewCache: { at: number; rows: Promise<AgentFilesOverview[]> } | null = null;

/** Something in the agent's repository changed here: sizes and the review are looked at again. */
function forget(agent: Agent) {
  for (const key of sizeCache.keys()) if (key === agent.repoPath || key.startsWith(`${agent.repoPath}/`)) sizeCache.delete(key);
  reviewCache.delete(agent.id);
  overviewCache = null;
}

function sizeOf(path: string, t: Tally): AgentFileSize {
  return { path, bytes: t.bytes, files: t.files, modifiedAt: t.modified ? new Date(t.modified).toISOString() : null, partial: t.partial };
}

/** Sizes of what lies directly in a folder of the repository. */
export async function folderSizes(agentId: string, dir: string): Promise<AgentFileSize[]> {
  const agent = await withRepo(agentId);
  const rel = repoPath(agent, dir);
  const st = entryOf(agent.repoPath, rel);
  if (!st || !noLink(agent.repoPath, rel)) throw notFound("Folder");
  if (!st.isDirectory()) throw badRequest("Path is not a folder");
  const names = readdirSync(join(agent.repoPath, rel)).filter((n) => n.toLowerCase() !== ".git");
  return Promise.all(
    names.map(async (name) => {
      const child = rel ? `${rel}/${name}` : name;
      return sizeOf(child, await cachedTally(join(agent.repoPath, child)));
    }),
  );
}

function memoryNoteCount(repoPath: string): number {
  return memoryTopics(repoPath).filter((p) => NOTE.test(p)).length;
}

function binDir(agentId: string): string {
  return join(config().agentsDir, BIN, agentId);
}

/** One row per agent: what its files take, how many notes it keeps, how long its memory is. */
export function filesOverview(): Promise<AgentFilesOverview[]> {
  if (overviewCache && Date.now() - overviewCache.at < CACHE_MS * 4) return overviewCache.rows;
  const rows = Promise.all(
    all<{ id: string; repo_path: string }>("SELECT id, repo_path FROM agents ORDER BY name").map(async (a) => {
      const workspace = join(a.repo_path, WORKSPACE_DIR);
      const [ws, scratch, memory, memoryFile] = await Promise.all([
        cachedTally(workspace),
        cachedTally(join(workspace, "tmp")),
        cachedTally(join(a.repo_path, MEMORY_DIR)),
        cachedTally(join(a.repo_path, MEMORY_FILE)),
      ]);
      let notes = memoryNoteCount(a.repo_path);
      if (entryOf(a.repo_path, WORKSPACE_DIR)?.isDirectory()) notes += listNotes(workspace).length;
      return {
        agentId: a.id,
        bytes: ws.bytes + memory.bytes + memoryFile.bytes,
        workspaceBytes: ws.bytes,
        scratchBytes: scratch.bytes,
        notes,
        memoryChars: memoryChars(a.repo_path),
        deleted: deletedEntries(a.id).length,
        partial: ws.partial || memory.partial,
      };
    }),
  );
  overviewCache = { at: Date.now(), rows };
  rows.catch(() => (overviewCache = null));
  return rows;
}

/* ------------------------------------------------------------------ */
/* Who names what                                                       */
/* ------------------------------------------------------------------ */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `rel` as a path of its own in a text (not the start of a longer name). */
function mention(rel: string, flags = ""): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._-])${escape(rel)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, flags);
}

/** Memory files that link to the memory note `rel`: by its path, by a link next to it, or as [[its-name]]. */
function memoryLinks(repoPath: string): (rel: string) => string[] {
  const files = Object.entries(snapshotMemory(repoPath).files);
  return (rel) => {
    const full = mention(rel);
    const name = basename(rel);
    const stem = name.replace(/\.(md|markdown|txt)$/i, "");
    const near = new RegExp(`\\]\\((?:\\./)?${escape(name)}(?:#[^)]*)?\\)`);
    const wiki = new RegExp(`\\[\\[${escape(stem)}(?:\\|[^\\]]*)?\\]\\]`);
    return files
      .filter(([path, text]) => path !== rel && (full.test(text) || wiki.test(text) || (dirname(path) === dirname(rel) && near.test(text))))
      .map(([path]) => path);
  };
}

/** Where the agent names a path of its repository (read once for many paths). */
function namer(agent: Agent): (rel: string) => string[] {
  const workspace = namesOf(agent);
  const memory = memoryLinks(agent.repoPath);
  return (rel) => {
    if (rel.startsWith(`${WORKSPACE_DIR}/`)) return workspace(rel.slice(WORKSPACE_DIR.length + 1));
    if (rel.startsWith(`${MEMORY_DIR}/`)) return memory(rel);
    return [];
  };
}

/** Size, what names them and whether they may go, for the paths the human is about to move or delete. */
export async function inspectFiles(agentId: string, paths: string[]): Promise<AgentFileInfo[]> {
  const agent = await withRepo(agentId);
  const named = namer(agent);
  const out: AgentFileInfo[] = [];
  for (const input of paths.slice(0, MAX_PATHS)) {
    const rel = repoPath(agent, input);
    const st = entryOf(agent.repoPath, rel);
    if (!st) continue;
    const tally = st.isSymbolicLink() ? { bytes: st.size, files: 1, modified: st.mtimeMs, partial: false } : await cachedTally(join(agent.repoPath, rel));
    out.push({ ...sizeOf(rel, tally), type: st.isDirectory() ? "dir" : "file", namedBy: named(rel), locked: lockReason(rel) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Review                                                               */
/* ------------------------------------------------------------------ */

/** Which kind wins when one path fits several. */
const PRIORITY: FileReviewKind[] = ["build", "junk", "empty", "duplicate", "large", "scratch", "stale", "loose", "unlinked-note", "broken-link"];

interface Candidate {
  kind: FileReviewKind;
  rel: string;
  dir: boolean;
  tally: Tally;
  detail: string;
  related?: string;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isProjectFolder(abs: string): boolean {
  return PROJECT_FILES.some((f) => existsSync(join(abs, f)));
}

async function sha(abs: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    createReadStream(abs)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", () => resolve(null))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

class Reviewer {
  readonly found: Candidate[] = [];
  readonly copies = new Map<number, { rel: string; modified: number }[]>();
  partial = false;
  private left = REVIEW_BUDGET;
  private counter = new Counter();

  constructor(
    private root: string,
    private at: number,
  ) {}

  private add(kind: FileReviewKind, rel: string, dir: boolean, tally: Tally, detail: string, related?: string) {
    this.found.push({ kind, rel, dir, tally, detail, related });
  }

  /** Walk a folder of the repository: what clutters it, and the files that may be copies of each other. */
  async walk(rel: string, depth: number): Promise<boolean> {
    if (this.left <= 0 || depth > 14) {
      this.partial = true;
      return false;
    }
    const abs = join(this.root, rel);
    const entries = await io(() => readdir(abs, { withFileTypes: true })).catch(() => null);
    if (!entries) return false;
    this.left -= entries.length;
    let kept = 0;
    for (const entry of entries) {
      const name = entry.name;
      const child = `${rel}/${name}`;
      const childAbs = join(abs, name);
      if (name.toLowerCase() === ".git") {
        kept++;
        continue;
      }
      if (entry.isSymbolicLink()) {
        kept++;
        continue;
      }
      if (entry.isDirectory()) {
        if (child === SCRATCH) {
          kept++;
          await this.scratch();
          continue;
        }
        if (BUILD.has(name) || (OUTPUT.has(name) && isProjectFolder(abs))) {
          const tally = await this.counter.of(childAbs);
          this.add("build", child, true, tally, BUILD.has(name) ? `Installed packages or a cache (${name}) — installing or building again brings it back.` : `Build output (${name}) — building the project again brings it back.`);
          kept++;
          continue;
        }
        // A project of its own (a clone): its files are its business, not clutter of the agent.
        if (existsSync(join(childAbs, ".git"))) {
          kept++;
          continue;
        }
        if (name.startsWith(".")) {
          kept++;
          continue;
        }
        const filled = await this.walk(child, depth + 1);
        if (filled) kept++;
        else {
          const st = await lstat(childAbs).catch(() => null);
          this.add("empty", child, true, { ...NONE, modified: st?.mtimeMs ?? 0 }, "An empty folder.");
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await io(() => lstat(childAbs)).catch(() => null);
      if (!st) continue;
      const tally: Tally = { bytes: st.size, files: 1, modified: st.mtimeMs, partial: false };
      if (JUNK.test(name)) {
        this.add("junk", child, false, tally, name === ".DS_Store" ? "Finder's folder settings — macOS writes them again when needed." : /\.log$/i.test(name) ? "A log file." : "A temporary or backup file.");
        continue;
      }
      if (name === ".gitkeep") {
        kept++;
        continue;
      }
      kept++;
      if (st.size === 0) {
        this.add("empty", child, false, tally, "An empty file.");
        continue;
      }
      if (st.size >= LARGE) this.add("large", child, false, tally, `${formatBytes(st.size)} — one of the largest files here.`);
      if (st.size >= HASH_MIN && st.size <= HASH_MAX_FILE) {
        const list = this.copies.get(st.size) ?? [];
        list.push({ rel: child, modified: st.mtimeMs });
        this.copies.set(st.size, list);
      }
    }
    return kept > 0;
  }

  /** tmp/ goes by itself: only what is large is worth a look now. */
  private async scratch() {
    const abs = join(this.root, SCRATCH);
    for (const name of await readdir(abs).catch(() => [] as string[])) {
      if (name.startsWith(".")) continue;
      const rel = `${SCRATCH}/${name}`;
      const st = await lstat(join(abs, name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      const tally = await this.counter.of(join(abs, name));
      const discarded = /^discarded-(\d{4}-\d{2}-\d{2})/.exec(name);
      if (discarded) {
        this.add("scratch", rel, st.isDirectory(), tally, `A dream sorted these out on ${discarded[1]} — the daily cleanup removes them a week after their last change.`);
      } else if (tally.bytes >= LARGE_SCRATCH) {
        const left = Math.max(0, Math.ceil((tally.modified + 7 * DAY - this.at) / DAY));
        this.add("scratch", rel, st.isDirectory(), tally, `Scratch in tmp/ — goes by itself ${left ? `in about ${left} day${left === 1 ? "" : "s"}` : "with the next daily cleanup"}, unless a note names it.`);
      }
    }
  }

  /** Top of the repository and of workspace/: stray files, and entries nobody touched for long. */
  async tops() {
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (name.startsWith(".") || ROOT_KNOWN.has(name)) continue;
      const st = await lstat(join(this.root, name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      const tally = await this.counter.of(join(this.root, name));
      if (JUNK.test(name)) this.add("junk", name, st.isDirectory(), tally, /\.log$/i.test(name) ? "A log file at the top of the repository." : "A temporary file at the top of the repository.");
      else this.add("loose", name, st.isDirectory(), tally, "Lies at the top of the repository, outside workspace/ — move it into workspace/ or delete it.");
    }
    const ws = join(this.root, WORKSPACE_DIR);
    for (const name of await readdir(ws).catch(() => [] as string[])) {
      const rel = `${WORKSPACE_DIR}/${name}`;
      if (name.startsWith(".") || rel === SCRATCH || rel === UPLOADS) continue;
      const st = await lstat(join(ws, name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      const tally = await this.counter.of(join(ws, name));
      const idle = Math.floor((this.at - tally.modified) / DAY);
      if (tally.modified && idle >= STALE_DAYS) {
        this.add("stale", rel, st.isDirectory(), tally, `Nothing in it changed for ${idle} days (last ${day(tally.modified)}).`);
      } else if (!st.isDirectory() && idle >= RECENT_DAYS) {
        this.add("loose", rel, false, tally, "Lies loose at the top of workspace/ — sort it into a folder.");
      }
    }
  }

  /** Files with the same content: the copy the agent names (or the oldest) stays. */
  async duplicates(named: (rel: string) => string[]) {
    let budget = HASH_BUDGET;
    for (const [size, list] of this.copies) {
      if (list.length < 2) continue;
      const byHash = new Map<string, { rel: string; modified: number }[]>();
      for (const file of list) {
        if (budget < size) {
          this.partial = true;
          break;
        }
        budget -= size;
        const hash = await sha(join(this.root, file.rel));
        if (!hash) continue;
        byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
      }
      for (const group of byHash.values()) {
        if (group.length < 2) continue;
        const keep = [...group].sort(
          (a, b) =>
            Number(named(b.rel).length > 0) - Number(named(a.rel).length > 0) ||
            Number(b.rel.startsWith(`${MEMORY_DIR}/`)) - Number(a.rel.startsWith(`${MEMORY_DIR}/`)) ||
            Number(a.rel.startsWith(`${SCRATCH}/`)) - Number(b.rel.startsWith(`${SCRATCH}/`)) ||
            a.modified - b.modified ||
            a.rel.length - b.rel.length,
        )[0]!;
        for (const copy of group) {
          if (copy === keep) continue;
          this.add("duplicate", copy.rel, false, { bytes: size, files: 1, modified: copy.modified, partial: false }, `Same content as ${keep.rel}.`, keep.rel);
        }
      }
    }
  }

  /** Memory notes nothing links to, and links to notes that don't exist. */
  memory(links: (rel: string) => string[]) {
    for (const rel of memoryTopics(this.root)) {
      if (!NOTE.test(rel) || links(rel).length) continue;
      const st = entryOf(this.root, rel);
      if (!st) continue;
      this.add("unlinked-note", rel, false, { bytes: st.size, files: 1, modified: st.mtimeMs, partial: false }, "No link from MEMORY.md or another note — the agent may never read it. Link it, merge it, or delete it.");
    }
    const pattern = /(?<![A-Za-z0-9._/-])memory\/[A-Za-z0-9._/-]+?\.(?:md|markdown|txt)(?![A-Za-z0-9_-])/g;
    const seen = new Set<string>();
    for (const [file, text] of Object.entries(snapshotMemory(this.root).files)) {
      for (const m of text.matchAll(pattern)) {
        const target = m[0];
        if (seen.has(target) || target.split("/").some((p) => p === ".." || p === "") || entryOf(this.root, target)) continue;
        seen.add(target);
        this.add("broken-link", target, false, NONE, `${file} links to it, but it doesn't exist.`, file);
      }
    }
  }
}

/** What clutters the agent's repository, by kind; what the agent still names is marked, never hidden. */
export async function reviewFiles(agentId: string, fresh = false): Promise<FileReview> {
  const agent = await withRepo(agentId);
  const hit = reviewCache.get(agent.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS * 2) return hit.review;
  const review = buildReview(agent);
  reviewCache.set(agent.id, { at: Date.now(), review });
  review.catch(() => reviewCache.delete(agent.id));
  return review;
}

async function buildReview(agent: Agent): Promise<FileReview> {
  const at = Date.now();
  const r = new Reviewer(agent.repoPath, at);
  const named = namer(agent);
  if (entryOf(agent.repoPath, WORKSPACE_DIR)?.isDirectory()) await r.walk(WORKSPACE_DIR, 0);
  if (entryOf(agent.repoPath, MEMORY_DIR)?.isDirectory()) await r.walk(MEMORY_DIR, 0);
  await r.tops();
  await r.duplicates(named);
  r.memory(memoryLinks(agent.repoPath));

  const byPath = new Map<string, Candidate>();
  for (const c of r.found) {
    const prev = byPath.get(c.rel);
    if (!prev || PRIORITY.indexOf(c.kind) < PRIORITY.indexOf(prev.kind)) byPath.set(c.rel, c);
  }
  // A folder already on the list covers what lies in it.
  const folders = [...byPath.values()].filter((c) => c.dir).map((c) => `${c.rel}/`);
  const items: FileReviewItem[] = [];
  const perKind = new Map<FileReviewKind, number>();
  const sorted = [...byPath.values()]
    .filter((c) => !lockReason(c.rel) && !folders.some((f) => c.rel.startsWith(f)))
    .sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || b.tally.bytes - a.tally.bytes || a.rel.localeCompare(b.rel));
  for (const c of sorted) {
    const n = perKind.get(c.kind) ?? 0;
    if (n >= KIND_LIMIT) {
      r.partial = true;
      continue;
    }
    perKind.set(c.kind, n + 1);
    const names = c.kind === "broken-link" ? [] : named(c.rel);
    items.push({
      kind: c.kind,
      path: c.rel,
      type: c.dir ? "dir" : "file",
      bytes: c.tally.bytes,
      files: c.tally.files,
      modifiedAt: c.tally.modified ? new Date(c.tally.modified).toISOString() : null,
      detail: c.detail,
      namedBy: names[0] ?? null,
      related: c.related ?? null,
    });
  }
  return { agentId: agent.id, checkedAt: new Date(at).toISOString(), items, partial: r.partial };
}

/* ------------------------------------------------------------------ */
/* Notes and search                                                     */
/* ------------------------------------------------------------------ */

/** The agent's Markdown notes: MEMORY.md, memory/ and the workspace (tmp/, uploads/ and clones left out). */
export async function listAgentNotes(agentId: string): Promise<AgentNote[]> {
  const agent = await withRepo(agentId);
  const links = memoryLinks(agent.repoPath);
  const named = namer(agent);
  const notes: AgentNote[] = [];
  const push = (rel: string, linked: boolean) => {
    const st = entryOf(agent.repoPath, rel);
    if (!st?.isFile()) return;
    const names = named(rel);
    notes.push({
      path: rel,
      title: noteTitle(join(agent.repoPath, rel)) || basename(rel),
      bytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      linked,
      namedBy: names[0] ?? null,
    });
  };
  push(MEMORY_FILE, true);
  for (const rel of memoryTopics(agent.repoPath)) if (NOTE.test(rel)) push(rel, links(rel).length > 0);
  const ws = join(agent.repoPath, WORKSPACE_DIR);
  if (entryOf(agent.repoPath, WORKSPACE_DIR)?.isDirectory()) {
    for (const note of listNotes(ws)) {
      const rel = `${WORKSPACE_DIR}/${note.rel}`;
      push(rel, named(rel).length > 0);
    }
  }
  return notes;
}

function snippetOf(line: string, at: number, length: number): string {
  const start = Math.max(0, at - 60);
  const end = Math.min(line.length, at + length + 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

/** Files and folders whose name holds `query`, and text files that contain it (first match per file). */
export async function searchAgentFiles(agentId: string, query: string): Promise<AgentFileSearchHit[]> {
  const agent = await withRepo(agentId);
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: AgentFileSearchHit[] = [];
  let left = SEARCH_BUDGET;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (hits.length >= SEARCH_LIMIT || left <= 0 || depth > 12) return;
    const entries = await readdir(join(agent.repoPath, rel), { withFileTypes: true }).catch(() => []);
    left -= entries.length;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (hits.length >= SEARCH_LIMIT) return;
      const name = entry.name;
      if (name.startsWith(".") || BUILD.has(name) || entry.isSymbolicLink()) continue;
      const child = `${rel}/${name}`;
      const nameHit = name.toLowerCase().includes(needle);
      if (entry.isDirectory()) {
        if (nameHit) hits.push({ path: child, type: "dir", line: null, snippet: null });
        if (!existsSync(join(agent.repoPath, child, ".git"))) await visit(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (nameHit) {
        hits.push({ path: child, type: "file", line: null, snippet: null });
        continue;
      }
      if (!TEXT.test(name)) continue;
      const st = await lstat(join(agent.repoPath, child)).catch(() => null);
      if (!st || st.size > SEARCH_READ_MAX) continue;
      const text = await readFile(join(agent.repoPath, child), "utf8").catch(() => "");
      const lower = text.toLowerCase();
      const at = lower.indexOf(needle);
      if (at < 0) continue;
      const lineStart = lower.lastIndexOf("\n", at) + 1;
      const lineEnd = lower.indexOf("\n", at);
      const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      hits.push({ path: child, type: "file", line: text.slice(0, at).split("\n").length, snippet: snippetOf(line, at - lineStart, needle.length) });
    }
  };
  if (entryOf(agent.repoPath, MEMORY_FILE)) {
    const text = readFileSync(join(agent.repoPath, MEMORY_FILE), "utf8");
    const at = text.toLowerCase().indexOf(needle);
    if (at >= 0) {
      const lineStart = text.lastIndexOf("\n", at) + 1;
      const lineEnd = text.indexOf("\n", at);
      hits.push({ path: MEMORY_FILE, type: "file", line: text.slice(0, at).split("\n").length, snippet: snippetOf(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd), at - lineStart, needle.length) });
    }
  }
  await visit(MEMORY_DIR, 1);
  await visit(WORKSPACE_DIR, 1);
  return hits.sort((a, b) => Number(a.line !== null) - Number(b.line !== null));
}

/* ------------------------------------------------------------------ */
/* Changes                                                              */
/* ------------------------------------------------------------------ */

/** A new, empty folder inside workspace/ or memory/. */
export async function createFolder(agentId: string, input: string): Promise<{ path: string }> {
  const agent = await withRepo(agentId);
  const rel = repoPath(agent, input);
  if (!placeable(rel)) throw badRequest("New folders go inside workspace/ or memory/.");
  if (!noLink(agent.repoPath, rel)) throw badRequest("The folder would lie behind a link.");
  if (entryOf(agent.repoPath, rel)) throw conflict(`${rel} already exists.`);
  await withRepoLock(agent.repoPath, () => mkdir(join(agent.repoPath, rel), { recursive: true }));
  forget(agent);
  return { path: rel };
}

/** Point the agent's memory at `to` wherever it named `from` (its own absolute paths too, never another agent's). */
function repointMemory(repoPath: string, from: string, to: string): string[] {
  const pattern = mention(from, "g");
  const own = (text: string, at: number) => at === 0 || text[at - 1] !== "/" || text.slice(0, at - 1).endsWith(repoPath) || text.slice(Math.max(0, at - 2), at) === "./";
  const changed: string[] = [];
  for (const [path, text] of Object.entries(snapshotMemory(repoPath).files)) {
    const next = text.replace(pattern, (match: string, at: number) => (own(text, at) ? to : match));
    if (next === text || !canRestore(repoPath, path) || !noLink(repoPath, path)) continue;
    writeFileSync(join(repoPath, path), next);
    changed.push(path);
  }
  return changed;
}

/** Rename or move an entry inside workspace/ or memory/ (never over another one); the memory follows it. */
export async function moveFile(agentId: string, fromInput: string, toInput: string): Promise<AgentFileMoveResult> {
  const agent = await withRepo(agentId);
  const from = repoPath(agent, fromInput);
  const to = repoPath(agent, toInput);
  const locked = lockReason(from);
  if (locked) throw new HttpError(403, locked, "locked");
  if (!placeable(to) || lockReason(to)) throw badRequest("Entries move inside workspace/ or memory/.");
  if (to === from) return { path: to, rewritten: [] };
  if (to.startsWith(`${from}/`)) throw badRequest("A folder can't move into itself.");
  refuseWhileDreaming(agent);
  return withRepoLock(agent.repoPath, async () => {
    const source = entryOf(agent.repoPath, from);
    if (!source) throw notFound(from);
    if (!noLink(agent.repoPath, from, false) || !noLink(agent.repoPath, to, false)) throw badRequest("The way there goes through a link.");
    const target = entryOf(agent.repoPath, to);
    // Only a new spelling of the same name (on a case-insensitive disk) may find "itself" there.
    if (target && !(target.ino === source.ino && target.dev === source.dev && from.toLowerCase() === to.toLowerCase())) {
      throw conflict(`${to} already exists — pick another name.`);
    }
    await mkdir(dirname(join(agent.repoPath, to)), { recursive: true });
    await rename(join(agent.repoPath, from), join(agent.repoPath, to));
    const rewritten = repointMemory(agent.repoPath, from, to);
    await commitAllInLock(agent.repoPath, `Move ${from} to ${to}`);
    forget(agent);
    return { path: to, rewritten };
  });
}

/* ------------------------------------------------------------------ */
/* The bin                                                              */
/* ------------------------------------------------------------------ */

const ENTRY_ID = /^[a-z0-9]{8,40}$/;

interface Stored extends DeletedAgentFile {
  dir: string;
}

function readEntry(dir: string, id: string): Stored | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, id, "entry.json"), "utf8")) as DeletedAgentFile;
    if (typeof meta.path !== "string" || !existsSync(join(dir, id, "item"))) return null;
    return { ...meta, id, dir: join(dir, id) };
  } catch {
    return null;
  }
}

function deletedEntries(agentId: string): Stored[] {
  const dir = binDir(agentId);
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }
  return ids
    .filter((id) => ENTRY_ID.test(id))
    .map((id) => readEntry(dir, id))
    .filter((e): e is Stored => !!e)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

const strip = ({ dir: _dir, ...entry }: Stored): DeletedAgentFile => entry;

export async function listDeletedFiles(agentId: string): Promise<DeletedAgentFile[]> {
  const agent = await withRepo(agentId);
  return deletedEntries(agent.id).map(strip);
}

/** Entries of every agent's bin deleted more than `days` ago (agents removed since included): for the cleanup. */
export function expiredDeletedFiles(at = Date.now(), days = DELETED_DAYS): { agentId: string; path: string; dir: string; deletedAt: string }[] {
  const root = join(config().agentsDir, BIN);
  let agents: string[];
  try {
    agents = readdirSync(root);
  } catch {
    return [];
  }
  return agents.flatMap((agentId) =>
    deletedEntries(agentId)
      .filter((e) => at - Date.parse(e.deletedAt) >= days * DAY)
      .map((e) => ({ agentId, path: e.path, dir: e.dir, deletedAt: e.deletedAt })),
  );
}

async function moveAside(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** Move entries into the agent's bin, in one commit. What must stay is refused, the rest goes. */
export async function deleteFiles(agentId: string, inputs: string[]): Promise<AgentFilesDeleteResult> {
  const agent = await withRepo(agentId);
  refuseWhileDreaming(agent);
  const paths = [...new Set(inputs.slice(0, MAX_PATHS).map((p) => repoPath(agent, p)))];
  // A folder that goes takes what lies in it along.
  const top = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
  const result: AgentFilesDeleteResult = { deleted: [], refused: [] };
  await withRepoLock(agent.repoPath, async () => {
    const bin = binDir(agent.id);
    for (const rel of top) {
      const locked = lockReason(rel);
      if (locked) {
        result.refused.push({ path: rel, reason: locked });
        continue;
      }
      const st = entryOf(agent.repoPath, rel);
      if (!st) {
        result.refused.push({ path: rel, reason: "It isn't there anymore." });
        continue;
      }
      if (!noLink(agent.repoPath, rel, false)) {
        result.refused.push({ path: rel, reason: "It lies behind a link." });
        continue;
      }
      const tally = st.isDirectory() ? await new Counter().of(join(agent.repoPath, rel)) : { bytes: st.size, files: 1, modified: st.mtimeMs, partial: false };
      const id = `${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
      const dir = join(bin, id);
      const entry: DeletedAgentFile = { id, path: rel, type: st.isDirectory() ? "dir" : "file", bytes: tally.bytes, files: tally.files, deletedAt: now() };
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, "entry.json"), JSON.stringify(entry));
        await moveAside(join(agent.repoPath, rel), join(dir, "item"));
        result.deleted.push(entry);
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        result.refused.push({ path: rel, reason: `It couldn't be moved to the bin (${err instanceof Error ? err.message : String(err)}).` });
      }
    }
    if (result.deleted.length) {
      const first = result.deleted[0]!.path;
      await commitAllInLock(agent.repoPath, result.deleted.length === 1 ? `Delete ${first}` : `Delete ${first} and ${result.deleted.length - 1} more`);
    }
  });
  for (const rel of paths) if (!top.includes(rel)) result.refused.push({ path: rel, reason: "Goes with the folder it lies in." });
  forget(agent);
  return result;
}

/** A free place next to `rel`: "notes (restored).md", "notes (restored 2).md", … */
function freePlace(root: string, rel: string): string {
  if (!entryOf(root, rel)) return rel;
  const ext = extname(rel);
  const base = ext ? rel.slice(0, -ext.length) : rel;
  for (let i = 1; ; i++) {
    const next = `${base} (restored${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!entryOf(root, next)) return next;
  }
}

/** Put a deleted entry back where it was (next to it, when something new took its place). */
export async function restoreDeletedFile(agentId: string, id: string): Promise<AgentFileRestoreResult> {
  const agent = await withRepo(agentId);
  if (!ENTRY_ID.test(id)) throw notFound("Deleted entry");
  refuseWhileDreaming(agent);
  return withRepoLock(agent.repoPath, async () => {
    const entry = readEntry(binDir(agent.id), id);
    if (!entry) throw notFound("Deleted entry");
    const original = repoPath(agent, entry.path);
    if (lockReason(original)) throw badRequest("It can't go back there.");
    if (!noLink(agent.repoPath, original, false)) throw badRequest("The way back goes through a link.");
    const rel = freePlace(agent.repoPath, original);
    await mkdir(dirname(join(agent.repoPath, rel)), { recursive: true });
    await moveAside(join(entry.dir, "item"), join(agent.repoPath, rel));
    await rm(entry.dir, { recursive: true, force: true });
    await commitAllInLock(agent.repoPath, `Restore ${rel}`);
    forget(agent);
    return { path: rel };
  });
}

/** Remove deleted entries for good: one (`id`), or the whole bin. */
export async function purgeDeletedFiles(agentId: string, id?: string): Promise<{ removed: number; bytes: number }> {
  const agent = await withRepo(agentId);
  if (id !== undefined && !ENTRY_ID.test(id)) throw notFound("Deleted entry");
  const entries = deletedEntries(agent.id).filter((e) => id === undefined || e.id === id);
  if (id !== undefined && !entries.length) throw notFound("Deleted entry");
  let bytes = 0;
  for (const e of entries) {
    await rm(e.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    bytes += e.bytes;
  }
  overviewCache = null;
  return { removed: entries.length, bytes };
}
