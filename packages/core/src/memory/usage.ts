/**
 * Which memory notes tasks actually use. MEMORY.md is loaded into every task; a note under memory/ only counts when a
 * task opens or writes it (Read, Edit, Write, a shell command naming it, a Grep that found it, `team_memory_read` by a
 * lead). A note no task used for UNUSED_DAYS, while the agent kept working (UNUSED_RUNS runs since), is handed to the
 * agent's next dream: merged into a note that is used, linked better from MEMORY.md, or dropped — so memory stays what
 * tasks need instead of growing forever. An agent that simply wasn't needed for a month keeps its notes as they are.
 *
 * Counting started with the migration that made the table (meta memory.usesSince). A note's clock also starts when it
 * was last written (a new note, an edit in the app), and when a dream writes it. A dream reading a note is no use.
 * The team profile reaches every task through the prompt, never through a read: it is not counted at all.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Run } from "@godmode/shared";
import { all, get, getMeta, run as sql, tx } from "../db";
import { logger } from "../log";
import { MEMORY_DIR } from "./files";
import { PROFILE_FILE } from "./profile";

const log = logger("memory-usage");

export const UNUSED_DAYS = 30;
/** Finished runs of the agent since a note's last use before it counts as unused. */
export const UNUSED_RUNS = 5;
const DAY = 86_400_000;
const SINCE_KEY = "memory.usesSince";
const MAX_NOTES = 300;
const READS = ["Read"];
const WRITES = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const TEAM_READ = "mcp__godmode__team_memory_read";
const MENTION = /(?:~|\.{0,2})?[\p{L}\p{N}_./-]*memory\/[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*\.md/gu;
/** How much of a Grep's answer is looked through for the notes it found. */
const RESULT_MAX = 20_000;

function realpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * A path a tool named, as a note of the repository ("memory/x.md"), or null when it is no note of it. A run in a VM or
 * on a moved data folder sees the repository elsewhere: a path through a folder of the agent's name counts too.
 */
export function noteOf(repoPath: string, path: string): string | null {
  let p = path.trim();
  if (!p) return null;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  let rel = p.replace(/^\.\//, "");
  if (isAbsolute(p)) {
    rel = relative(repoPath, p);
    const real = rel.startsWith("..") ? realpath(repoPath) : null;
    if (real) rel = relative(real, p);
    const elsewhere = rel.startsWith("..") ? p.split(sep).join("/").lastIndexOf(`/${basename(repoPath)}/${MEMORY_DIR}/`) : -1;
    if (elsewhere >= 0) rel = p.split(sep).join("/").slice(elsewhere + basename(repoPath).length + 2);
  }
  const note = rel.split(sep).join("/");
  if (!note.startsWith(`${MEMORY_DIR}/`) || note.split("/").includes("..") || note === PROFILE_FILE) return null;
  return note;
}

function inputOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The notes (by agent id) a run's tools touched; `writes` only = what it wrote (a dream). */
export function notesUsedBy(runId: string, agentId: string, repoPath: string, writes = false): Map<string, Set<string>> {
  const tools = writes ? WRITES : [...READS, ...WRITES, "Bash", "Grep", TEAM_READ];
  // Only messages that name a note at all are taken apart: a run's steps can hold megabytes of screenshots.
  const rows = all<{ name: string; input: string | null; result: string | null }>(
    `SELECT json_extract(b.value, '$.name') AS name, json_extract(b.value, '$.input') AS input,
       substr(json_extract(b.value, '$.result'), 1, ${RESULT_MAX}) AS result
     FROM messages m, json_each(m.blocks) b
     WHERE m.run_id = ? AND instr(m.blocks, '${MEMORY_DIR}/') > 0 AND json_extract(b.value, '$.type') = 'tool_use'
       AND json_extract(b.value, '$.name') IN (${tools.map(() => "?").join(", ")})`,
    runId,
    ...tools,
  );
  const used = new Map<string, Set<string>>();
  const add = (agent: string, note: string | null) => {
    if (!note) return;
    if (!used.has(agent)) used.set(agent, new Set());
    used.get(agent)!.add(note);
  };
  const mentions = (text: string) => {
    for (const m of text.matchAll(MENTION)) add(agentId, noteOf(repoPath, m[0]));
  };
  for (const row of rows) {
    const input = inputOf(row.input);
    if (READS.includes(row.name) || WRITES.includes(row.name)) add(agentId, noteOf(repoPath, str(input.file_path) || str(input.notebook_path)));
    else if (row.name === "Bash") mentions(str(input.command));
    else if (row.name === "Grep") mentions(`${str(input.path)}\n${row.result ?? ""}`);
    else if (row.name === TEAM_READ) {
      const other = get<{ id: string; repo_path: string }>("SELECT id, repo_path FROM agents WHERE id = ? OR slug = ?", str(input.agentId), str(input.agentId));
      if (other) add(other.id, noteOf(other.repo_path, str(input.path)));
    }
  }
  return used;
}

/** Note the memory a finished run used. A dream's reads don't count; what a dream wrote starts its clock. */
export function recordMemoryUse(run: Pick<Run, "id" | "agentId" | "trigger" | "finishedAt">): void {
  try {
    const agent = get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE id = ?", run.agentId);
    if (!agent) return;
    const dream = run.trigger === "dream";
    const used = notesUsedBy(run.id, run.agentId, agent.repo_path, dream);
    if (!used.size) return;
    const at = run.finishedAt ?? new Date().toISOString();
    tx(() => {
      for (const [agentId, notes] of used) {
        for (const note of notes) {
          sql(
            `INSERT INTO memory_note_uses (agent_id, path, last_used_at, uses) VALUES (?, ?, ?, ?)
             ON CONFLICT(agent_id, path) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at), uses = uses + excluded.uses`,
            agentId,
            note,
            at,
            dream ? 0 : 1,
          );
        }
      }
    });
  } catch (err) {
    log.warn(`could not note the memory run ${run.id} used`, err);
  }
}

/** A dream looked at these unused notes and kept them: they are not handed to a dream again for another UNUSED_DAYS. */
export function markReviewed(agentId: string, repoPath: string, paths: readonly string[], at = new Date().toISOString()): void {
  const existing = new Set(listNotes(repoPath).map((n) => n.path));
  tx(() => {
    for (const path of paths) {
      if (!existing.has(path)) continue;
      sql(
        `INSERT INTO memory_note_uses (agent_id, path, last_used_at, uses) VALUES (?, ?, ?, 0)
         ON CONFLICT(agent_id, path) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at)`,
        agentId,
        path,
        at,
      );
    }
  });
}

export interface NoteUse {
  path: string;
  bytes: number;
  /** When a task last used it; null = not since counting started. */
  lastUsedAt: string | null;
  uses: number;
  /** No task used it for UNUSED_DAYS while the agent kept working (and counting ran that long). */
  unused: boolean;
}

function listNotes(repoPath: string): { path: string; bytes: number; modified: number }[] {
  const out: { path: string; bytes: number; modified: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= MAX_NOTES || name.startsWith(".")) continue;
      const abs = join(dir, name);
      const info = lstatSync(abs, { throwIfNoEntry: false });
      if (!info) continue;
      const path = `${rel}/${name}`;
      if (info.isDirectory() && depth < 3) walk(abs, path, depth + 1);
      else if (info.isFile() && name.endsWith(".md") && path !== PROFILE_FILE) out.push({ path, bytes: info.size, modified: info.mtimeMs });
    }
  };
  walk(join(repoPath, MEMORY_DIR), MEMORY_DIR, 0);
  return out;
}

/** Since when uses are counted (null on a database from before). */
export function usesCountedSince(): string | null {
  return getMeta(SINCE_KEY);
}

/** The agent's notes with when tasks last used them, the longest unused first. */
export function noteUses(agentId: string, repoPath: string, at = new Date()): NoteUse[] {
  const since = Date.parse(usesCountedSince() ?? "");
  const rows = new Map(
    all<{ path: string; last_used_at: string; uses: number }>("SELECT path, last_used_at, uses FROM memory_note_uses WHERE agent_id = ?", agentId).map((r) => [r.path, r]),
  );
  const notes = listNotes(repoPath).map((n) => {
    const row = rows.get(n.path);
    return { ...n, row, from: Math.max(row ? Date.parse(row.last_used_at) : since, n.modified) };
  });
  const oldest = notes.reduce((a, n) => Math.min(a, n.from), Infinity);
  // The agent's own work since: a month without being needed is no reason to forget.
  const runs = Number.isFinite(oldest)
    ? all<{ t: string }>(
        "SELECT finished_at AS t FROM runs WHERE agent_id = ? AND trigger NOT IN ('dream', 'check') AND finished_at > ?",
        agentId,
        new Date(oldest).toISOString(),
      ).map((r) => Date.parse(r.t))
    : [];
  return notes
    .map(({ row, from, modified: _modified, ...n }) => ({
      ...n,
      lastUsedAt: row && row.uses > 0 ? row.last_used_at : null,
      uses: row?.uses ?? 0,
      unused: Number.isFinite(from) && at.getTime() - from >= UNUSED_DAYS * DAY && runs.filter((t) => t > from).length >= UNUSED_RUNS,
    }))
    .sort((a, b) => Number(b.unused) - Number(a.unused) || (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || b.bytes - a.bytes);
}

export function unusedNotes(agentId: string, repoPath: string, at = new Date()): NoteUse[] {
  return noteUses(agentId, repoPath, at).filter((n) => n.unused);
}
