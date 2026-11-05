/**
 * Which memory notes tasks actually use. MEMORY.md is loaded into every task; a note under memory/ only counts when a
 * task opens or writes it (Read, Edit, Write, a shell command naming it, `team_memory_read` by a lead). A note no task
 * used for UNUSED_DAYS is handed to the agent's next dream: merged into a note that is used, linked better from
 * MEMORY.md, or dropped — so memory stays what tasks need instead of growing forever.
 *
 * Counting started with the migration that made the table (meta memory.usesSince): a note is only called unused once
 * that long has passed. A dream reading a note is no use, but a note a dream creates starts its clock then.
 */
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Run } from "@godmode/shared";
import { all, get, getMeta, run as sql, tx } from "../db";
import { logger } from "../log";
import { MEMORY_DIR } from "./files";

const log = logger("memory-usage");

export const UNUSED_DAYS = 30;
const DAY = 86_400_000;
const SINCE_KEY = "memory.usesSince";
const MAX_NOTES = 300;
const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const TEAM_READ = "mcp__godmode__team_memory_read";
const MENTION = /(?:~|\.{0,2})?[\w./-]*memory\/[\w.-]+(?:\/[\w.-]+)*\.md/g;

/** A path a tool named, as a note of the repository ("memory/x.md"), or null when it is no note of it. */
export function noteOf(repoPath: string, path: string): string | null {
  let p = path.trim();
  if (!p) return null;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  const rel = isAbsolute(p) ? relative(repoPath, p) : p.replace(/^\.\//, "");
  const note = rel.split(sep).join("/");
  if (!note.startsWith(`${MEMORY_DIR}/`) || note.split("/").includes("..")) return null;
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

/** The notes (by agent id) a run's tools touched. */
export function notesUsedBy(runId: string, agentId: string, repoPath: string): Map<string, Set<string>> {
  const rows = all<{ name: string; input: string | null }>(
    `SELECT json_extract(b.value, '$.name') AS name, json_extract(b.value, '$.input') AS input
     FROM messages m, json_each(m.blocks) b
     WHERE m.run_id = ? AND json_extract(b.value, '$.type') = 'tool_use'
       AND json_extract(b.value, '$.name') IN (${[...FILE_TOOLS, "Bash", "Grep", TEAM_READ].map(() => "?").join(", ")})`,
    runId,
    ...FILE_TOOLS,
    "Bash",
    "Grep",
    TEAM_READ,
  );
  const used = new Map<string, Set<string>>();
  const add = (agent: string, note: string | null) => {
    if (!note) return;
    if (!used.has(agent)) used.set(agent, new Set());
    used.get(agent)!.add(note);
  };
  for (const row of rows) {
    const input = inputOf(row.input);
    if (FILE_TOOLS.includes(row.name)) add(agentId, noteOf(repoPath, str(input.file_path) || str(input.notebook_path)));
    else if (row.name === "Grep") add(agentId, str(input.path).endsWith(".md") ? noteOf(repoPath, str(input.path)) : null);
    else if (row.name === "Bash") for (const m of str(input.command).matchAll(MENTION)) add(agentId, noteOf(repoPath, m[0]));
    else if (row.name === TEAM_READ) {
      const other = get<{ id: string; repo_path: string }>("SELECT id, repo_path FROM agents WHERE id = ? OR slug = ?", str(input.agentId), str(input.agentId));
      if (other) add(other.id, noteOf(other.repo_path, str(input.path)));
    }
  }
  return used;
}

/** Note the memory a finished run used. A dream's own reads don't count; a note it created starts its clock. */
export function recordMemoryUse(run: Pick<Run, "id" | "agentId" | "trigger" | "finishedAt">): void {
  try {
    const agent = get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE id = ?", run.agentId);
    if (!agent) return;
    const used = notesUsedBy(run.id, run.agentId, agent.repo_path);
    if (!used.size) return;
    const at = run.finishedAt ?? new Date().toISOString();
    const dream = run.trigger === "dream";
    tx(() => {
      for (const [agentId, notes] of used) {
        for (const note of notes) {
          if (dream) sql("INSERT OR IGNORE INTO memory_note_uses (agent_id, path, last_used_at, uses) VALUES (?, ?, ?, 0)", agentId, note, at);
          else
            sql(
              `INSERT INTO memory_note_uses (agent_id, path, last_used_at, uses) VALUES (?, ?, ?, 1)
               ON CONFLICT(agent_id, path) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at), uses = uses + 1`,
              agentId,
              note,
              at,
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
  /** No task used it for UNUSED_DAYS (and counting ran that long). */
  unused: boolean;
}

function listNotes(repoPath: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
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
      if (info.isDirectory() && depth < 3) walk(abs, `${rel}/${name}`, depth + 1);
      else if (info.isFile() && name.endsWith(".md")) out.push({ path: `${rel}/${name}`, bytes: info.size });
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
  return listNotes(repoPath)
    .map((n) => {
      const row = rows.get(n.path);
      const from = row ? Date.parse(row.last_used_at) : since;
      return {
        ...n,
        lastUsedAt: row && row.uses > 0 ? row.last_used_at : null,
        uses: row?.uses ?? 0,
        unused: Number.isFinite(from) && at.getTime() - from >= UNUSED_DAYS * DAY,
      };
    })
    .sort((a, b) => Number(b.unused) - Number(a.unused) || (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || b.bytes - a.bytes);
}

export function unusedNotes(agentId: string, repoPath: string, at = new Date()): NoteUse[] {
  return noteUses(agentId, repoPath, at).filter((n) => n.unused);
}
