import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SEARCH_MARK_END, SEARCH_MARK_START, type SearchChatHit, type SearchNoteHit, type SearchResults, type SearchTaskHit } from "@godmode/shared";
import { all, get, getDb, run, tx } from "../db";
import { SEARCH_REBUILD_SQL } from "../db/migrations";
import { listAgentNotes } from "../agents/files";
import { logger } from "../log";
import { matchExpr, parseQuery, type Term } from "./searchQuery";

const log = logger("search");

const RRF_K = 10;
const RANK_WINDOW = 5_000;
const NOTE_SYNC_MS = 15_000;
const NOTE_CHUNK_CHARS = 1_600;
const NOTE_READ_MAX = 512 * 1024;
const SNIPPET = `'${SEARCH_MARK_START}', '${SEARCH_MARK_END}', '…', 14`;

export function makeSnippet(text: string, words: string[], width = 160): string {
  let folded = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
    i += ch.length;
  }
  at.push(text.length);
  const ranges: [number, number][] = [];
  for (const word of words) {
    const pattern = word.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+");
    for (const m of folded.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}[\\p{L}\\p{N}]*`, "gu"))) ranges.push([at[m.index]!, at[m.index + m[0].length]!]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(width / 3));
  if (start > 0) {
    const space = text.lastIndexOf(" ", start);
    start = space > first - width / 2 ? space + 1 : start;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const space = text.indexOf(" ", end);
    end = space >= 0 && space - end < 20 ? space : end;
  }
  let out = "";
  let pos = start;
  for (const [a, b] of ranges) {
    if (a < pos || b > end) continue;
    out += text.slice(pos, a) + SEARCH_MARK_START + text.slice(a, b) + SEARCH_MARK_END;
    pos = b;
  }
  out += text.slice(pos, end);
  return `${start > 0 ? "…" : ""}${out.replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function rrf(rank: number, weight = 1): number {
  return weight / (RRF_K + rank);
}

function recency(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 1;
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  return 1 + 0.6 * Math.exp(-days / 21);
}

type ChatAcc = { hit: SearchChatHit; score: number; msgs: number };

function searchChats(terms: Term[], fixes: Map<number, string[]>, limit: number): SearchChatHit[] {
  const expr = matchExpr(terms, fixes);
  const acc = new Map<string, ChatAcc>();
  const touch = (row: { id: string; title: string; agent_id: string; archived: number; at: string | null }): ChatAcc => {
    let entry = acc.get(row.id);
    if (!entry) {
      entry = {
        hit: { id: row.id, title: row.title, agentId: row.agent_id, archived: !!row.archived, at: row.at ?? "", messageId: null, snippet: null, titleMatch: false },
        score: 0,
        msgs: 0,
      };
      acc.set(row.id, entry);
    }
    return entry;
  };
  const conv = "c.id, c.title, c.agent_id, c.archived, COALESCE(c.last_message_at, c.created_at) AS at";

  const titles = all<{ id: string; title: string; agent_id: string; archived: number; at: string | null }>(
    `SELECT ${conv} FROM (SELECT rowid, rank FROM search_titles WHERE search_titles MATCH ? ORDER BY rank LIMIT 60) s
     JOIN conversations c ON c.rowid = s.rowid WHERE c.private = 0 ORDER BY s.rank`,
    expr,
  );
  titles.forEach((row, i) => {
    const e = touch(row);
    e.hit.titleMatch = true;
    e.score += rrf(i, 1.5);
  });

  const messages = all<{ id: string; title: string; agent_id: string; archived: number; at: string | null; mid: string; mrow: number }>(
    `SELECT ${conv}, m.id AS mid, m.rowid AS mrow
     FROM (SELECT rowid, rank FROM (SELECT rowid, bm25(search_messages) AS rank FROM search_messages WHERE search_messages MATCH ? ORDER BY rowid DESC LIMIT ${RANK_WINDOW}) ORDER BY rank LIMIT 400) s
     JOIN messages m ON m.rowid = s.rowid JOIN conversations c ON c.id = m.conversation_id WHERE c.private = 0 ORDER BY s.rank`,
    expr,
  );
  const best = new Map<string, number>();
  messages.forEach((row, i) => {
    const e = touch(row);
    if (e.msgs === 0) {
      e.hit.messageId = row.mid;
      best.set(row.id, row.mrow);
      e.score += rrf(i);
    } else if (e.msgs < 5) e.score += rrf(i, 0.15);
    e.msgs++;
  });

  if (terms.length > 1 && acc.size < limit) {
    let common: Set<string> | null = null;
    terms.forEach((term, i) => {
      const single = matchExpr([term], fixes.has(i) ? new Map([[0, fixes.get(i)!]]) : new Map());
      const ids = new Set(
        all<{ id: string }>(
          `SELECT DISTINCT m.conversation_id AS id FROM (SELECT rowid FROM search_messages WHERE search_messages MATCH ? ORDER BY rowid DESC LIMIT ${RANK_WINDOW}) s JOIN messages m ON m.rowid = s.rowid`,
          single,
        ).map((r) => r.id),
      );
      for (const r of all<{ id: string }>(`SELECT c.id FROM search_titles s JOIN conversations c ON c.rowid = s.rowid WHERE search_titles MATCH ?`, single)) ids.add(r.id);
      common = common ? new Set([...common].filter((id) => ids.has(id))) : ids;
    });
    const extra = [...(common ?? new Set<string>())].filter((id) => !acc.has(id)).slice(0, 200);
    if (extra.length) {
      const rows = all<{ id: string; title: string; agent_id: string; archived: number; at: string | null }>(
        `SELECT ${conv} FROM conversations c WHERE c.private = 0 AND c.id IN (${extra.map(() => "?").join(",")}) ORDER BY at DESC`,
        ...extra,
      );
      rows.forEach((row, i) => (touch(row).score += rrf(i + 20, 0.4)));
    }
  }

  const top = [...acc.values()]
    .map((e) => ({ ...e, score: e.score * recency(e.hit.at) * (e.hit.archived ? 0.7 : 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.hit);
  const rows = best.size ? all<{ rowid: number; content: string }>(`SELECT rowid, content FROM messages WHERE rowid IN (${[...best.values()].map(() => "?").join(",")})`, ...best.values()) : [];
  const content = new Map(rows.map((r) => [r.rowid, r.content]));
  const words = terms.flatMap((t, i) => fixes.get(i) ?? [t.text]);
  for (const hit of top) {
    const text = content.get(best.get(hit.id) ?? -1);
    if (text) hit.snippet = makeSnippet(text, words);
  }
  return top;
}

function searchTasks(terms: Term[], fixes: Map<number, string[]>, limit: number): SearchTaskHit[] {
  const rows = all<{ id: string; number: number; title: string; status: string; archived_at: string | null; snip: string }>(
    `SELECT t.id, t.number, t.title, t.status, t.archived_at, snippet(search_tasks, 1, ${SNIPPET}) AS snip
     FROM search_tasks s JOIN tasks t ON t.rowid = s.rowid
     WHERE search_tasks MATCH ? ORDER BY (t.archived_at IS NOT NULL), bm25(search_tasks, 4.0, 1.0) LIMIT ?`,
    matchExpr(terms, fixes),
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    archived: r.archived_at !== null,
    snippet: r.snip.includes(SEARCH_MARK_START) ? r.snip : null,
  }));
}

function searchNotes(terms: Term[], fixes: Map<number, string[]>, limit: number): SearchNoteHit[] {
  const rows = all<{ agent_id: string; path: string; line: number; heading: string; snip: string }>(
    `SELECT agent_id, path, line, heading, snippet(search_notes, 4, ${SNIPPET}) AS snip
     FROM search_notes WHERE search_notes MATCH ? ORDER BY bm25(search_notes, 0, 0, 0, 3.0, 1.0) LIMIT ?`,
    `{heading body} : (${matchExpr(terms, fixes)})`,
    limit * 3,
  );
  const seen = new Set<string>();
  const hits: SearchNoteHit[] = [];
  for (const r of rows) {
    const key = `${r.agent_id}:${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ agentId: r.agent_id, path: r.path, line: r.line, heading: r.heading, snippet: r.snip });
    if (hits.length >= limit) break;
  }
  return hits;
}

function osa(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

function nextKey(prefix: string): string {
  const cp = [...prefix];
  const last = cp.pop()!;
  return cp.join("") + String.fromCodePoint(last.codePointAt(0)! + 1);
}

export function corrections(terms: Term[]): Map<number, string[]> {
  const fixes = new Map<number, string[]>();
  terms.forEach((term, i) => {
    if (term.phrase || term.text.length < 4) return;
    if (get("SELECT 1 FROM search_vocab WHERE term >= ? AND term < ? LIMIT 1", term.text, nextKey(term.text))) return;
    const max = term.text.length <= 6 ? 1 : 2;
    const first = [...term.text][0]!;
    const candidates = all<{ term: string; doc: number }>(
      "SELECT term, doc FROM search_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?",
      first,
      nextKey(first),
      Math.max(1, term.text.length - max),
      term.text.length + max + 4,
    );
    const scored: { term: string; dist: number; doc: number }[] = [];
    for (const c of candidates) {
      const dist = Math.min(osa(term.text, c.term, max), c.term.length > term.text.length ? osa(term.text, c.term.slice(0, term.text.length), max) : max + 1);
      if (dist <= max) scored.push({ term: c.term, dist, doc: c.doc });
    }
    scored.sort((a, b) => a.dist - b.dist || b.doc - a.doc);
    const picked = scored.slice(0, 3).map((x) => x.term);
    if (picked.length) fixes.set(i, picked);
  });
  return fixes;
}

const noteIndex = new Map<string, number>();
let notesSyncedAt = 0;
let notesSync: Promise<void> | null = null;

export function chunkMarkdown(text: string): { line: number; heading: string; body: string }[] {
  const chunks: { line: number; heading: string; body: string }[] = [];
  const lines = text.split("\n");
  let heading = "";
  let start = 1;
  let buf: string[] = [];
  const flush = (next: number) => {
    const body = buf.join("\n").trim();
    if (body || heading) chunks.push({ line: start, heading, body });
    buf = [];
    start = next;
  };
  lines.forEach((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush(i + 1);
      heading = h[1]!.trim();
      return;
    }
    buf.push(line);
    if (buf.join("\n").length > NOTE_CHUNK_CHARS && line.trim() === "") flush(i + 2);
  });
  flush(lines.length);
  return chunks;
}

async function syncNotes(): Promise<void> {
  const agents = all<{ id: string }>("SELECT id FROM agents");
  const present = new Set<string>();
  for (const { id } of agents) {
    const notes = await listAgentNotes(id).catch(() => []);
    for (const note of notes) {
      const key = `${id}\u0000${note.path}`;
      present.add(key);
      const mtime = Date.parse(note.modifiedAt);
      if (noteIndex.get(key) === mtime) continue;
      if (note.bytes > NOTE_READ_MAX) continue;
      const repo = get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE id = ?", id)?.repo_path;
      if (!repo) continue;
      const text = await readFile(join(repo, note.path), "utf8").catch(() => null);
      if (text === null) continue;
      tx(() => {
        run("DELETE FROM search_notes WHERE agent_id = ? AND path = ?", id, note.path);
        for (const c of chunkMarkdown(text)) {
          run("INSERT INTO search_notes (agent_id, path, line, heading, body) VALUES (?, ?, ?, ?, ?)", id, note.path, c.line, c.heading, c.body);
        }
      });
      noteIndex.set(key, mtime);
    }
  }
  for (const key of [...noteIndex.keys()]) {
    if (present.has(key)) continue;
    const [agentId, path] = key.split("\u0000") as [string, string];
    run("DELETE FROM search_notes WHERE agent_id = ? AND path = ?", agentId, path);
    noteIndex.delete(key);
  }
}

export function refreshNotes(force = false): Promise<void> {
  if (notesSync) return notesSync;
  if (!force && Date.now() - notesSyncedAt < NOTE_SYNC_MS) return Promise.resolve();
  if (notesSyncedAt === 0) run("DELETE FROM search_notes");
  notesSync = syncNotes()
    .catch((err) => log.warn(`notes index: ${String(err)}`))
    .finally(() => {
      notesSyncedAt = Date.now();
      notesSync = null;
    });
  return notesSync;
}

export function resetNoteIndex(): void {
  noteIndex.clear();
  notesSyncedAt = 0;
}

export function rebuildSearchIndex(): void {
  getDb().run(SEARCH_REBUILD_SQL);
}

export async function search(query: string, opts: { limit?: number; notes?: boolean } = {}): Promise<SearchResults> {
  const started = performance.now();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
  const terms = parseQuery(query.slice(0, 300));
  const empty: SearchResults = { query, corrected: null, chats: [], tasks: [], notes: [], tookMs: 0 };
  if (!terms.length) return empty;
  const withNotes = opts.notes !== false;
  if (withNotes) {
    const pending = refreshNotes();
    if (notesSyncedAt === 0) await pending;
  }
  const runAll = (fixes: Map<number, string[]>) => ({
    chats: searchChats(terms, fixes, limit),
    tasks: searchTasks(terms, fixes, Math.min(limit, 8)),
    notes: withNotes ? searchNotes(terms, fixes, Math.min(limit, 8)) : [],
  });
  let found = runAll(new Map());
  let corrected: string | null = null;
  if (!found.chats.length && !found.tasks.length && !found.notes.length) {
    const fixes = corrections(terms);
    if (fixes.size) {
      found = runAll(fixes);
      corrected = terms.map((t, i) => fixes.get(i)?.[0] ?? t.text).join(" ");
    }
  }
  return { query, corrected, ...found, tookMs: Math.round((performance.now() - started) * 10) / 10 };
}
