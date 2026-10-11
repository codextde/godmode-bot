/**
 * Tidying an agent's workspace while it dreams (memory/dreaming.ts): an inventory of what lies in `workspace/`, and
 * the moves the dream asks for through `workspace_tidy` — sorting an entry into another folder, or discarding it into
 * `workspace/tmp/`, where the cleanup removes it after a week (services/cleanup.ts). Everything a dream does here is
 * recorded, rolled back with a failed dream and put back when the human undoes it.
 *
 * The dream never touches files itself (it has no shell): every move goes through here, confined to `workspace/`, never
 * through a symlink, never over an existing entry. `tmp/` (Godmode clears it) and `uploads/` (the human's files) stay
 * out, and so does anything changed in the last few days or named by the agent's instructions, automations or
 * follow-ups. Paths the agent's memory names are rewritten to the new place; a discard waits until the memory no longer
 * names the entry.
 */
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Agent, DreamWorkspaceChange } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { all } from "../db";
import { canRestore, snapshotMemory } from "./files";

export const WORKSPACE_DIR = "workspace";
/** Top-level folders a dream leaves alone: Godmode clears tmp/ by itself, uploads/ holds what the human attached. */
const RESERVED = ["tmp", "uploads"];
/** Entries changed this recently may belong to work in progress: they stay where they are. */
export const RECENT_DAYS = 3;
/** Moves one dream may make. */
export const MAX_TIDY_CHANGES = 300;
const INVENTORY_LIMIT = 400;
const PEEK = 5;
const DAY = 86_400_000;
const JUNK = new Set([".DS_Store", ".gitkeep"]);

export interface EntryStats {
  bytes: number;
  files: number;
  /**
   * Newest change of a file in it (ms); an empty folder's own. Folders don't count: sorting changes them, work doesn't.
   */
  modified: number;
}

/** Size, file count and newest change of a file or folder (symlinks are counted, never followed). */
export async function measure(path: string): Promise<EntryStats> {
  const st = await lstat(path).catch(() => null);
  if (!st) return { bytes: 0, files: 0, modified: 0 };
  if (!st.isDirectory()) return { bytes: st.size, files: 1, modified: st.mtimeMs };
  const children = await readdir(path).catch(() => [] as string[]);
  const parts = await Promise.all(children.map((name) => measure(join(path, name))));
  const total = parts.reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files, modified: Math.max(a.modified, b.modified) }), {
    bytes: 0,
    files: 0,
    modified: 0,
  });
  return total.files ? total : { ...total, modified: st.mtimeMs };
}

/* ------------------------------------------------------------------ */
/* Paths                                                                */
/* ------------------------------------------------------------------ */

/**
 * A path from the dream as a path inside `workspace/` ("" = invalid): relative ("reports/a.pdf"), with the "workspace/"
 * prefix or absolute inside the agent's workspace. No hidden segments, no "..".
 */
export function workspacePath(repoPath: string, input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  const abs = `${join(repoPath, WORKSPACE_DIR).replace(/\\/g, "/")}/`;
  if (p.startsWith(abs)) p = p.slice(abs.length);
  p = p.replace(/^\.\//, "");
  if (p.startsWith(`${WORKSPACE_DIR}/`)) p = p.slice(WORKSPACE_DIR.length + 1);
  p = p.replace(/\/+$/, "");
  const parts = p.split("/");
  if (!p || p === WORKSPACE_DIR || p.startsWith("/") || parts.some((x) => !x || x === "." || x === ".." || x.startsWith("."))) return "";
  return parts.join("/");
}

const reserved = (rel: string) => RESERVED.some((r) => rel === r || rel.startsWith(`${r}/`));

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** The workspace folder itself, when it is a real folder of the repository. */
function workspaceRoot(repoPath: string): string | null {
  const root = join(repoPath, WORKSPACE_DIR);
  try {
    return lstatSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** No symlink from the workspace down to `rel` (the parts that exist; the entry itself included). */
function noSymlink(root: string, rel: string): boolean {
  let probe = root;
  for (const part of rel.split("/")) {
    probe = join(probe, part);
    try {
      if (lstatSync(probe).isSymbolicLink()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* What names an entry                                                  */
/* ------------------------------------------------------------------ */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `workspace/<rel>` as a path of its own (also inside an absolute path), or a path below it. */
function mentionPattern(rel: string, flags = ""): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._-])${escape(WORKSPACE_DIR)}/${escape(rel)}(?![A-Za-z0-9._-])`, flags);
}

interface References {
  /** Where an entry must stay: the agent's instructions, automations and follow-ups (label → text). */
  pinned: [string, string][];
  /** Memory files (path → content): their mentions are rewritten when an entry moves. */
  memory: Record<string, string>;
}

function references(agent: Agent): References {
  const pinned: [string, string][] = [["your instructions", agent.instructions]];
  for (const r of all<{ name: string; prompt: string }>("SELECT name, prompt FROM routines WHERE agent_id = ?", agent.id)) pinned.push([`the automation "${r.name}"`, r.prompt]);
  for (const f of all<{ note: string }>("SELECT note FROM followups WHERE agent_id = ?", agent.id)) pinned.push(["a follow-up", f.note]);
  return { pinned, memory: snapshotMemory(agent.repoPath).files };
}

/** Other agents name this agent's files by their absolute path only. */
function pinnedElsewhere(agent: Agent, rel: string): string | null {
  const abs = join(agent.repoPath, WORKSPACE_DIR, rel);
  const pattern = new RegExp(`${escape(abs)}(?![A-Za-z0-9._-])`);
  const routine = all<{ name: string; prompt: string }>("SELECT name, prompt FROM routines WHERE agent_id != ?", agent.id).find((r) => pattern.test(r.prompt));
  if (routine) return `the automation "${routine.name}" of another agent`;
  const other = all<{ name: string; instructions: string }>("SELECT name, instructions FROM agents WHERE id != ?", agent.id).find((a) => pattern.test(a.instructions));
  return other ? `the instructions of ${other.name}` : null;
}

/** What keeps the entry where it is: a mention of it, of something in it, or of a folder it lies in. */
function pinnedBy(agent: Agent, refs: References, rel: string): string | null {
  const parts = rel.split("/");
  for (let i = parts.length; i > 0; i--) {
    const path = parts.slice(0, i).join("/");
    const pattern = mentionPattern(path);
    const pin = refs.pinned.find(([, text]) => pattern.test(text))?.[0] ?? pinnedElsewhere(agent, path);
    if (pin) return pin;
  }
  return null;
}

function memoryMentions(refs: References, rel: string): string[] {
  const pattern = mentionPattern(rel);
  return Object.entries(refs.memory)
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path);
}

/* ------------------------------------------------------------------ */
/* Inventory                                                            */
/* ------------------------------------------------------------------ */

function day(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Inventory {
  /** Markdown handed to the dream ("" = nothing to tidy). */
  text: string;
  entries: number;
}

/** What lies at the top of the workspace, for the dream to sort: size, age, a peek inside, and what must stay. */
export async function workspaceInventory(agent: Agent, at = new Date()): Promise<Inventory> {
  const root = workspaceRoot(agent.repoPath);
  if (!root) return { text: "", entries: 0 };
  const names = readdirSync(root)
    .filter((n) => !n.startsWith(".") && !RESERVED.includes(n))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) return { text: "", entries: 0 };
  const refs = references(agent);
  const recent = at.getTime() - RECENT_DAYS * DAY;
  const lines: string[] = [];
  let total = 0;
  for (const name of names.slice(0, INVENTORY_LIMIT)) {
    const abs = join(root, name);
    const st = lstatSync(abs);
    const stats = await measure(abs);
    total += stats.bytes;
    const folder = st.isDirectory();
    const notes: string[] = [];
    if (st.isSymbolicLink()) notes.push("a link — stays");
    else if (stats.modified >= recent) notes.push(`changed in the last ${RECENT_DAYS} days — stays`);
    const pin = pinnedBy(agent, refs, name);
    if (pin) notes.push(`named in ${pin} — stays`);
    const named = memoryMentions(refs, name);
    if (named.length) notes.push(`named in ${named.join(", ")}`);
    if (folder) {
      const inside = readdirSync(abs)
        .filter((n) => !JUNK.has(n))
        .sort((a, b) => a.localeCompare(b));
      const peek = inside.slice(0, PEEK).map((n) => (n.length > 40 ? `${n.slice(0, 39)}…` : n));
      if (inside.length) notes.push(`e.g. ${peek.join(", ")}${inside.length > PEEK ? ", …" : ""}`);
    }
    const kind = folder ? `folder, ${stats.files} file${stats.files === 1 ? "" : "s"}` : "file";
    lines.push(`- \`${name}${folder ? "/" : ""}\` — ${kind}, ${formatBytes(stats.bytes)}, last changed ${day(stats.modified)}${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
  }
  const more = names.length - INVENTORY_LIMIT;
  const text = [
    `# Workspace of ${agent.name} — ${day(at.getTime())}`,
    "",
    `${names.length} entr${names.length === 1 ? "y" : "ies"} at the top of \`workspace/\` (${formatBytes(total)}${more > 0 ? " in the listed ones" : ""}). \`tmp/\` and \`uploads/\` are left out: Godmode clears tmp/ by itself, and uploads/ holds what the human attached.`,
    "Each line: name — kind, size, last change, then what to know (\"stays\" = workspace_tidy refuses to move it).",
    "",
    ...lines,
    more > 0 ? `\n(${more} more entries are not listed — sort the listed ones first.)` : "",
    "",
  ].join("\n");
  return { text, entries: names.length };
}

/* ------------------------------------------------------------------ */
/* Moving                                                               */
/* ------------------------------------------------------------------ */

export interface TidyOperation {
  action: "move" | "discard";
  path: string;
  /** Where to (move only), inside workspace/. */
  to?: string;
}

export interface TidyOutcome {
  change: DreamWorkspaceChange | null;
  /** One line for the dream: what happened, or why nothing did. */
  line: string;
}

/** Remove folders a move left empty, up to the workspace and never tmp/ or uploads/ (a stray .DS_Store doesn't count). */
function pruneEmpty(root: string, rel: string) {
  for (let dir = dirname(rel); dir !== "." && !RESERVED.includes(dir); dir = dirname(dir)) {
    const abs = join(root, dir);
    try {
      const left = readdirSync(abs);
      if (left.some((n) => n !== ".DS_Store")) return;
      for (const n of left) rmSync(join(abs, n), { force: true });
      rmdirSync(abs);
    } catch {
      return;
    }
  }
}

/** Point the memory's mentions of `workspace/<from>` at `workspace/<to>`. Returns the files rewritten. */
function rewriteMemory(repoPath: string, refs: References, from: string, to: string): string[] {
  const pattern = mentionPattern(from, "g");
  const changed: string[] = [];
  for (const [path, text] of Object.entries(refs.memory)) {
    const next = text.replace(pattern, `${WORKSPACE_DIR}/${to}`);
    if (next === text || !canRestore(repoPath, path)) continue;
    writeFileSync(join(repoPath, path), next, "utf8");
    refs.memory[path] = next;
    changed.push(path);
  }
  return changed;
}

function discardTarget(root: string, rel: string, at: Date): string {
  const base = `tmp/discarded-${day(at.getTime())}`;
  let to = `${base}/${rel}`;
  for (let i = 2; exists(join(root, to)); i++) to = `${base}-${i}/${rel}`;
  return to;
}

/** Carry out a dream's tidy operations, in order. Each one is checked on its own; refusals don't stop the rest. */
export async function applyTidy(agent: Agent, operations: TidyOperation[], at = new Date()): Promise<TidyOutcome[]> {
  const root = workspaceRoot(agent.repoPath);
  if (!root) return operations.map((op) => ({ change: null, line: `${op.path}: there is no workspace folder.` }));
  const refs = references(agent);
  const outcomes: TidyOutcome[] = [];
  for (const op of operations) {
    const from = workspacePath(agent.repoPath, op.path);
    const skip = (why: string) => outcomes.push({ change: null, line: `${op.path}: skipped — ${why}` });
    if (!from) {
      skip("not a path inside workspace/.");
      continue;
    }
    if (reserved(from)) {
      skip("tmp/ and uploads/ are not sorted (Godmode clears tmp/, uploads/ are the human's files).");
      continue;
    }
    const fromAbs = join(root, from);
    if (!exists(fromAbs)) {
      skip("it doesn't exist.");
      continue;
    }
    if (!noSymlink(root, from)) {
      skip("it is (or lies behind) a link.");
      continue;
    }
    const stats = await measure(fromAbs);
    if (stats.modified >= at.getTime() - RECENT_DAYS * DAY) {
      skip(`it changed in the last ${RECENT_DAYS} days and may belong to work in progress.`);
      continue;
    }
    const pin = pinnedBy(agent, refs, from);
    if (pin) {
      skip(`${pin} names it, so it stays where it is.`);
      continue;
    }

    let to: string;
    if (op.action === "discard") {
      const named = memoryMentions(refs, from);
      if (named.length) {
        skip(`${named.join(", ")} still name${named.length === 1 ? "s" : ""} it. Keep it, or remove those mentions first.`);
        continue;
      }
      to = discardTarget(root, from, at);
    } else {
      to = workspacePath(agent.repoPath, op.to ?? "");
      if (!to) {
        skip("`to` must be a path inside workspace/.");
        continue;
      }
      if (reserved(to)) {
        skip("nothing is sorted into tmp/ or uploads/ — use discard for what can go.");
        continue;
      }
      if (to === from || to.startsWith(`${from}/`)) {
        skip("it can't move into itself.");
        continue;
      }
      if (exists(join(root, to))) {
        skip(`${to} already exists — pick a free name.`);
        continue;
      }
      if (!noSymlink(root, to)) {
        skip(`${to} lies behind a link.`);
        continue;
      }
    }

    const toAbs = join(root, to);
    try {
      mkdirSync(dirname(toAbs), { recursive: true });
      renameSync(fromAbs, toAbs);
    } catch (err) {
      skip(`it couldn't be moved (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    pruneEmpty(root, from);
    const change: DreamWorkspaceChange = { action: op.action, from, to, bytes: stats.bytes };
    if (op.action === "discard") {
      outcomes.push({ change, line: `${from}: discarded (${formatBytes(stats.bytes)}) — in workspace/${to} for a week, then removed.` });
    } else {
      const rewritten = rewriteMemory(agent.repoPath, refs, from, to);
      outcomes.push({ change, line: `${from} → ${to}${rewritten.length ? ` (updated the path in ${rewritten.join(", ")})` : ""}` });
    }
  }
  return outcomes;
}

/* ------------------------------------------------------------------ */
/* Undo                                                                 */
/* ------------------------------------------------------------------ */

/** Everything the dream moved is still where it went, and its old place is free. */
export function canUndoWorkspace(repoPath: string, changes: DreamWorkspaceChange[]): boolean {
  const root = workspaceRoot(repoPath);
  if (!root) return !changes.length;
  // Later moves of the same dream may have taken an entry on from where an earlier one put it.
  const placed = new Set<string>();
  const freed = new Set<string>();
  for (const c of changes) {
    placed.delete(c.from);
    freed.add(c.from);
    placed.add(c.to);
    freed.delete(c.to);
  }
  return [...placed].every((p) => exists(join(root, p)) && noSymlink(root, p)) && [...freed].every((p) => !exists(join(root, p)));
}

/** Put back what the dream moved, newest first. Returns the paths that could not go back. */
export function undoWorkspace(repoPath: string, changes: DreamWorkspaceChange[]): string[] {
  const root = workspaceRoot(repoPath);
  if (!root) return changes.map((c) => c.from);
  const failed: string[] = [];
  for (const c of [...changes].reverse()) {
    const toAbs = join(root, c.to);
    const fromAbs = join(root, c.from);
    if (!workspacePath(repoPath, c.from) || !workspacePath(repoPath, c.to) || !exists(toAbs) || exists(fromAbs) || !noSymlink(root, c.to) || !noSymlink(root, c.from)) {
      failed.push(c.from);
      continue;
    }
    try {
      mkdirSync(dirname(fromAbs), { recursive: true });
      renameSync(toAbs, fromAbs);
      pruneEmpty(root, c.to);
    } catch {
      failed.push(c.from);
    }
  }
  return failed;
}
