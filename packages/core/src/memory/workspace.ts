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
/** What may come out of tmp/ into the versioned workspace: a script or a file, not a whole build. */
export const RESCUE_MAX = 25_000_000;
const SCRATCH_LIMIT = 60;
/** Names of secrets and keys: tmp/ isn't versioned, the rest of the workspace is — they never come out of it. */
const SECRET =
  /(^|\/)(\.?env(\.[^/]*)?|[^/]*\.(env|pem|key|p8|p12|pfx|jks|keystore|kdbx|ppk)|\.?(netrc|npmrc|pypirc|pgpass)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|service-account[^/]*|[^/]*(secret|credential|passw|token|apikey|api-key|private)[^/]*)$/i;
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

/** The entry is, or holds, something named like a secret (hidden files included). */
async function holdsSecret(path: string, rel: string): Promise<boolean> {
  if (SECRET.test(rel)) return true;
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return false;
  for (const name of await readdir(path).catch(() => [] as string[])) {
    if (await holdsSecret(join(path, name), name)) return true;
  }
  return false;
}

/** The entry holds files git doesn't keep (a repository of its own, or files its own .gitignore leaves out). */
async function holdsUnversioned(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return false;
  for (const name of await readdir(path).catch(() => [] as string[])) {
    if (name === ".git" || name === ".gitignore" || (await holdsUnversioned(join(path, name)))) return true;
  }
  return false;
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
const NOT_BEFORE = "(?<![A-Za-z0-9._-])";
/** `workspace/` as a path segment (also the end of an absolute path). */
const RELATIVE = `${NOT_BEFORE}${escape(WORKSPACE_DIR)}/`;

/** `workspace/<rel>` as a path of its own (a full stop after it ends the sentence), or a path below it. */
function mentionPattern(rel: string, flags = "", prefix = RELATIVE): RegExp {
  return new RegExp(`${prefix}${escape(rel)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, flags);
}

/** `workspace/<rel>` itself (a folder named as a place), not a path below it. */
function folderPattern(rel: string, prefix = RELATIVE): RegExp {
  return new RegExp(`${prefix}${escape(rel)}/?(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_-])`);
}

/** The agent as far as references go. */
export type Owner = Pick<Agent, "id" | "repoPath" | "instructions">;

interface References {
  /** Where an entry must stay: the agent's instructions, automations and follow-ups (label → text). */
  pinned: [string, string][];
  /** Memory files (path → content): their mentions are rewritten when an entry moves. */
  memory: Record<string, string>;
}

function references(agent: Owner): References {
  const pinned: [string, string][] = [["the instructions", agent.instructions]];
  for (const r of all<{ name: string; prompt: string }>("SELECT name, prompt FROM routines WHERE agent_id = ?", agent.id)) pinned.push([`the automation "${r.name}"`, r.prompt]);
  for (const f of all<{ note: string }>("SELECT note FROM followups WHERE agent_id = ?", agent.id)) pinned.push(["a follow-up", f.note]);
  return { pinned, memory: snapshotMemory(agent.repoPath).files };
}

function pinnedElsewhere(agent: Owner, pattern: RegExp): string | null {
  const routine = all<{ name: string; prompt: string }>("SELECT name, prompt FROM routines WHERE agent_id != ?", agent.id).find((r) => pattern.test(r.prompt));
  if (routine) return `the automation "${routine.name}" of another agent`;
  const other = all<{ name: string; instructions: string }>("SELECT name, instructions FROM agents WHERE id != ?", agent.id).find((a) => pattern.test(a.instructions));
  return other ? `the instructions of ${other.name}` : null;
}

/**
 * What keeps the entry where it is: a mention of it or of something in it, or of a folder it lies in (named as a
 * place; tmp/ and uploads/ are places for everything and don't count).
 */
function pinnedBy(agent: Owner, refs: References, rel: string): string | null {
  // Other agents name this agent's files by their absolute path only.
  const abs = `${escape(join(agent.repoPath, WORKSPACE_DIR))}/`;
  const parts = rel.split("/");
  const patterns: [RegExp, RegExp][] = [[mentionPattern(rel), mentionPattern(rel, "", abs)]];
  for (let i = parts.length - 1; i > 0; i--) {
    const folder = parts.slice(0, i).join("/");
    if (!RESERVED.includes(folder)) patterns.push([folderPattern(folder), folderPattern(folder, abs)]);
  }
  for (const [own, elsewhere] of patterns) {
    const pin = refs.pinned.find(([, text]) => own.test(text))?.[0] ?? pinnedElsewhere(agent, elsewhere);
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

/**
 * A lookup of where the agent's memory, instructions, automations or follow-ups name `workspace/<rel>` or something in
 * it (null = nowhere), read once for many entries.
 */
export function namedBy(agent: Owner): (rel: string) => string | null {
  const refs = references(agent);
  return (rel) => pinnedBy(agent, refs, rel) ?? memoryMentions(refs, rel)[0] ?? null;
}

/** Paths in tmp/ the agent's notes name (`tmp/...`, existing ones only) → where they are named. */
function namedScratch(root: string, refs: References): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = new RegExp(`${NOT_BEFORE}${escape(WORKSPACE_DIR)}/(tmp/[A-Za-z0-9._/-]+)`, "g");
  const texts: [string, string][] = [...Object.entries(refs.memory), ...refs.pinned.map(([label, text]) => [label, text] as [string, string])];
  for (const [where, text] of texts) {
    for (const m of text.matchAll(pattern)) {
      const rel = m[1]!.replace(/[./]+$/, "");
      if (rel.split("/").some((p) => p === ".." || p.startsWith(".")) || !exists(join(root, rel))) continue;
      const list = found.get(rel) ?? [];
      if (!list.includes(where)) list.push(where);
      found.set(rel, list);
    }
  }
  return found;
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
export async function workspaceInventory(agent: Owner & Pick<Agent, "name">, at = new Date()): Promise<Inventory> {
  const root = workspaceRoot(agent.repoPath);
  if (!root) return { text: "", entries: 0 };
  const names = readdirSync(root)
    .filter((n) => !n.startsWith(".") && !RESERVED.includes(n))
    .sort((a, b) => a.localeCompare(b));
  const refs = references(agent);
  const scratch = [...namedScratch(root, refs)].sort(([a], [b]) => a.localeCompare(b));
  if (!names.length && !scratch.length) return { text: "", entries: 0 };
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
  const kept: string[] = [];
  for (const [rel, where] of scratch.slice(0, SCRATCH_LIMIT)) {
    const stats = await measure(join(root, rel));
    const notes = [`named in ${where.join(", ")}`];
    if (pinnedBy(agent, refs, rel)) notes.push("stays");
    else if (stats.bytes > RESCUE_MAX) notes.push(`too large to move out (over ${formatBytes(RESCUE_MAX)})`);
    else if (await holdsSecret(join(root, rel), rel)) notes.push("looks like a secret: stays out of git, in tmp/");
    const kind = stats.files > 1 ? `folder, ${stats.files} files` : "file";
    kept.push(`- \`${rel}\` — ${kind}, ${formatBytes(stats.bytes)}, last changed ${day(stats.modified)} · ${notes.join(" · ")}`);
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
    ...(kept.length
      ? [
          "",
          "## Named in your notes, but lying in tmp/",
          "",
          `Godmode clears what lies in tmp/ untouched for a week, but keeps these because your notes name them. Move what you still use (scripts, helpers, data) into a proper folder such as \`scripts/\` with workspace_tidy (up to ${formatBytes(RESCUE_MAX)} each); for what you no longer need, drop the mention from your memory so it can go.`,
          "",
          ...kept,
          scratch.length > SCRATCH_LIMIT ? `\n(${scratch.length - SCRATCH_LIMIT} more are not listed.)` : "",
        ]
      : []),
    "",
  ].join("\n");
  return { text, entries: names.length + scratch.length };
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

/**
 * Point the memory's mentions of `workspace/<from>` at `workspace/<to>`: relative ones and this agent's absolute ones
 * (another agent's workspace has paths of its own). Reads the files as they are now. Returns the files rewritten.
 */
function rewriteMemory(repoPath: string, refs: References, from: string, to: string): string[] {
  const pattern = mentionPattern(from, "g");
  const own = (text: string, at: number) => at === 0 || text[at - 1] !== "/" || text.slice(0, at - 1).endsWith(repoPath);
  refs.memory = snapshotMemory(repoPath).files;
  const changed: string[] = [];
  for (const [path, text] of Object.entries(refs.memory)) {
    const next = text.replace(pattern, (match: string, at: number) => (own(text, at) ? `${WORKSPACE_DIR}/${to}` : match));
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

export interface TidyHooks {
  /** Asked right before each move: false once the dream has ended (or is being stopped), and nothing more moves. */
  active?: () => boolean;
  /** Called right after each move, before anything else can happen (the move is on disk now). */
  record?: (change: DreamWorkspaceChange) => void;
}

/**
 * Carry out a dream's tidy operations, in order. Each one is checked on its own; refusals don't stop the rest. Callers
 * run one call at a time per dream (memory/dreaming.ts).
 */
export async function applyTidy(agent: Owner, operations: TidyOperation[], hooks: TidyHooks = {}, at = new Date()): Promise<TidyOutcome[]> {
  const root = workspaceRoot(agent.repoPath);
  if (!root) return operations.map((op) => ({ change: null, line: `${op.path}: there is no workspace folder.` }));
  const refs = references(agent);
  const outcomes: TidyOutcome[] = [];
  for (const op of operations) {
    refs.memory = snapshotMemory(agent.repoPath).files;
    const from = workspacePath(agent.repoPath, op.path);
    const skip = (why: string) => outcomes.push({ change: null, line: `${op.path}: skipped — ${why}` });
    if (!from) {
      skip("not a path inside workspace/.");
      continue;
    }
    const fromScratch = from.startsWith("tmp/");
    if (reserved(from) && !fromScratch) {
      skip("tmp/ and uploads/ are not sorted (Godmode clears tmp/, uploads/ are the human's files).");
      continue;
    }
    if (fromScratch && op.action === "discard") {
      skip("what lies in tmp/ goes by itself once nothing names it — drop the mention from your memory instead.");
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
    if (fromScratch && stats.bytes > RESCUE_MAX) {
      skip(`it is ${formatBytes(stats.bytes)}: only what you need (a script, a file) comes out of tmp/, up to ${formatBytes(RESCUE_MAX)}.`);
      continue;
    }
    if (fromScratch && (await holdsSecret(fromAbs, from))) {
      skip("it looks like a secret: tmp/ isn't versioned, the rest of the workspace is, so it stays in tmp/.");
      continue;
    }
    const pin = pinnedBy(agent, refs, from);
    if (pin) {
      skip(`it is named in ${pin}, so it stays where it is.`);
      continue;
    }

    let to: string;
    if (op.action === "discard") {
      const named = memoryMentions(refs, from);
      if (named.length) {
        skip(`${named.join(", ")} still name${named.length === 1 ? "s" : ""} it. Keep it, or remove those mentions first.`);
        continue;
      }
      if (await holdsUnversioned(fromAbs)) {
        skip("it holds files git doesn't keep (a repository of its own or ignored files), so they would be gone for good. Keep it, or move it.");
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

    // From here to the record nothing awaits: a dream that ends meanwhile can't miss a move in its rollback.
    if (hooks.active && !hooks.active()) {
      outcomes.push({ change: null, line: `${op.path}: not moved — the dream has ended.` });
      break;
    }
    const toAbs = join(root, to);
    if (exists(toAbs)) {
      skip(`${to} already exists — pick a free name.`);
      continue;
    }
    try {
      mkdirSync(dirname(toAbs), { recursive: true });
      renameSync(fromAbs, toAbs);
    } catch (err) {
      skip(`it couldn't be moved (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const change: DreamWorkspaceChange = { action: op.action, from, to, bytes: stats.bytes };
    hooks.record?.(change);
    pruneEmpty(root, from);
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
  // Later moves of the same dream may have taken an entry on from where an earlier one put it, or moved the folder it
  // went into: what lies at or below a moved path moves with it.
  const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  let placed = new Set<string>();
  const freed = new Set<string>();
  for (const c of changes) {
    placed = new Set([...placed].map((p) => (under(p, c.from) ? `${c.to}${p.slice(c.from.length)}` : p)));
    placed.add(c.to);
    for (const f of [...freed]) if (under(f, c.to)) freed.delete(f);
    freed.add(c.from);
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
