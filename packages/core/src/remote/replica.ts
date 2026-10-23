/**
 * The device group's shared data on every computer (owner: remote). Each computer of a group keeps all of it — the
 * setup, automations, the task board, My tasks, goals, passkeys, cards, paired phones — and writes it where it is used.
 * Triggers note every change in `replica_rows` (its order, when and where it was made); the computers pull from each
 * other what changed since their last pull (GET /api/link/replica/changes). Of two changes to one row the newer wins, on
 * a tie the primary's.
 *
 * The primary → secondary direction of the setup still travels as the snapshot (snapshot.ts: it carries the vault key
 * and the settings, and rewrites agent files); everything else, and the way back to the primary, comes from here. That
 * is how a secondary keeps every feature while its primary is away: what it changes meanwhile goes back afterwards.
 */
import { join } from "node:path";
import type { EntityName } from "@godmode/shared";
import { decodeValue, encodeValue, type DumpValue } from "../backup/backup";
import { config } from "../config";
import { all, get, getDb, getMeta, run as sql, setMeta, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { now } from "../util";
import { listActiveRuns } from "../runner/runner";
import { isSecondary, primaryRunnerId } from "./group";
import { LOCAL_SETTINGS, SETUP_TABLES, unsafe, withOwnFields } from "./snapshot";

const log = logger("replica");

type Value = string | number | null | Uint8Array;

export interface ReplicaTable {
  table: string;
  /** Columns that stay this computer's: never sent, never overwritten. */
  own: string[];
  entity: EntityName;
  /** The key columns (one row = one key; several columns are joined with KEY_SEP). */
  key: string[];
  /** Only rows with this value are shared. */
  only?: { column: string; value: string };
  /** Rows with one of these values are never shared (the settings that describe one computer). */
  skip?: { column: string; values: string[] };
  /** Own columns a new row can't take the column default for. */
  onInsert?: (row: Record<string, Value>) => Record<string, Value>;
  /** Part of the setup: from the primary it comes as the snapshot. */
  setup: boolean;
}

const KEY_SEP = "\u001f";
const STAMP = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const PULL_LIMIT = 500;
const DEFERRED_DAYS = 7;
const TOMBSTONE_DAYS = 45;

/** What is shared besides the setup. Tables with files on disk (task attachments) stay on the computer they're on. */
const STATE: Omit<ReplicaTable, "setup">[] = [
  { table: "goals", own: [], entity: "goals", key: ["id"] },
  { table: "tasks", own: ["repo_path"], entity: "tasks", key: ["id"] },
  { table: "task_events", own: [], entity: "tasks", key: ["id"] },
  { table: "task_dependencies", own: [], entity: "tasks", key: ["task_id", "waits_for_id"] },
  { table: "routines", own: [], entity: "routines", key: ["id"] },
  { table: "heartbeats", own: [], entity: "heartbeats", key: ["id"] },
  { table: "human_tasks", own: [], entity: "human-tasks", key: ["id"] },
  { table: "artifacts", own: [], entity: "artifacts", key: ["id"] },
  { table: "artifact_versions", own: [], entity: "artifacts", key: ["artifact_id", "version"] },
  { table: "missing_logins", own: [], entity: "missing-logins", key: ["id"] },
  { table: "notifications", own: [], entity: "notifications", key: ["id"] },
  { table: "passkeys", own: ["last_used_at"], entity: "passkeys", key: ["id"] },
  { table: "payment_cards", own: [], entity: "payment-cards", key: ["id"] },
  { table: "card_purchases", own: [], entity: "payment-cards", key: ["id"] },
  { table: "messaging_connections", own: [], entity: "messaging", key: ["id"] },
  { table: "messaging_users", own: [], entity: "messaging", key: ["id"] },
  { table: "messaging_chats", own: [], entity: "messaging", key: ["id"] },
  // A phone paired with one computer of the group works with all of them.
  { table: "mobile_devices", own: ["app_version", "last_seen_at", "last_address"], entity: "mobile", key: ["id"] },
];

/** VMs are machines of the computer they were made on. */
const NOT_SHARED = new Set(["vms"]);


let tablesCache: ReplicaTable[] | null = null;

/** A table's key columns, as the schema says (the settings-like tables are keyed by `key`, not `id`). */
function keyOf(table: string): string[] {
  const pk = all<{ name: string; pk: number }>(`PRAGMA table_info(${q(table)})`)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return pk.length ? pk : ["id"];
}

/** Columns the setup copy sends one way but that stay each computer's own here (an agent's folder exists on one computer). */
const OWN_HERE: Record<string, string[]> = { agents: ["working_directory"] };

export function replicaTables(): ReplicaTable[] {
  if (tablesCache) return tablesCache;
  const setup = SETUP_TABLES.filter((t) => !NOT_SHARED.has(t.table)).map(
    (t): ReplicaTable => ({ ...t, own: [...t.own, ...(OWN_HERE[t.table] ?? [])], key: keyOf(t.table), setup: true }),
  );
  // Settings come from the primary as part of the snapshot too; what a secondary changes goes back from here. The
  // sections that describe one computer stay where they are.
  // The sections of one computer: snapshot.ts LOCAL_SETTINGS and what a secondary keeps while it forwards.
  const ownSections = [...new Set([...LOCAL_SETTINGS, "vm"])];
  const settings: ReplicaTable = { table: "settings", own: [], entity: "settings", key: ["key"], setup: true, skip: { column: "key", values: ownSections } };
  tablesCache = [...setup, settings, ...STATE.map((t) => ({ ...t, key: keyOf(t.table), setup: false }))];
  return tablesCache;
}

function spec(table: string): ReplicaTable | undefined {
  return replicaTables().find((t) => t.table === table);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function columnsOf(table: string): string[] {
  return all<{ name: string }>(`PRAGMA table_info(${q(table)})`).map((c) => c.name);
}

/** The schema only changes with a migration (at startup): applying many changes asks once per table. */
function cachedColumns(table: string): string[] {
  let list = columnCache.get(table);
  if (!list) columnCache.set(table, (list = columnsOf(table)));
  return list;
}

function exists(table: string): boolean {
  return !!get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table);
}

/* ------------------------------------------------------------------ */
/* Triggers                                                             */
/* ------------------------------------------------------------------ */

function keyExpr(t: ReplicaTable, alias: "NEW" | "OLD"): string {
  return t.key.map((k) => `${alias}.${q(k)}`).join(` || char(31) || `);
}

function triggerSql(t: ReplicaTable): string[] {
  const columns = columnsOf(t.table);
  const shared = columns.filter((c) => !t.own.includes(c) && c !== "updated_at");
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const only = (alias: "NEW" | "OLD") =>
    (t.only ? ` AND ${alias}.${q(t.only.column)} = ${lit(t.only.value)}` : "") +
    (t.skip ? ` AND ${alias}.${q(t.skip.column)} NOT IN (${t.skip.values.map(lit).join(", ")})` : "");
  // An update and an insert instead of INSERT OR REPLACE: a foreign key action (ON DELETE SET NULL) runs the trigger
  // with its own conflict handling, and a replace would fail there.
  const key = (alias: "NEW" | "OLD") => keyExpr(t, alias);
  const note = (alias: "NEW" | "OLD", deleted: 0 | 1) => `
  UPDATE replica_seq SET n = n + 1 WHERE id = 1;
  UPDATE replica_rows SET seq = (SELECT n FROM replica_seq WHERE id = 1), at = COALESCE((SELECT at FROM replica_ctx WHERE id = 1), ${STAMP}),
         deleted = ${deleted}, origin = (SELECT origin FROM replica_ctx WHERE id = 1)
   WHERE tbl = '${t.table}' AND pk = ${key(alias)};
  INSERT INTO replica_rows (tbl, pk, seq, at, deleted, origin)
  SELECT '${t.table}', ${key(alias)}, (SELECT n FROM replica_seq WHERE id = 1), COALESCE((SELECT at FROM replica_ctx WHERE id = 1), ${STAMP}),
         ${deleted}, (SELECT origin FROM replica_ctx WHERE id = 1)
   WHERE NOT EXISTS (SELECT 1 FROM replica_rows WHERE tbl = '${t.table}' AND pk = ${key(alias)});`;
  const changed = shared.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(" OR ") || "0";
  const name = (op: string) => q(`replica_${t.table}_${op}`);
  return [
    `CREATE TRIGGER ${name("ins")} AFTER INSERT ON ${q(t.table)} WHEN 1${only("NEW")} BEGIN${note("NEW", 0)}
END`,
    `CREATE TRIGGER ${name("upd")} AFTER UPDATE ON ${q(t.table)} WHEN (${changed})${only("NEW")} BEGIN${note("NEW", 0)}
END`,
    `CREATE TRIGGER ${name("del")} AFTER DELETE ON ${q(t.table)} WHEN 1${only("OLD")} BEGIN${note("OLD", 1)}
END`,
  ];
}

/** The database the triggers were checked for (tests open several one after another). */
let ensured: object | null = null;

/**
 * Keep the triggers in step with the schema (a later migration adds a column: its changes are shared too) and note the
 * rows that were there before. Cheap when nothing changed.
 */
export function ensureReplica(): void {
  if (ensured === getDb()) return;
  if (!exists("replica_rows")) return;
  const tables = replicaTables().filter((t) => exists(t.table));
  const wanted = tables.flatMap(triggerSql);
  const digest = Bun.hash(wanted.join("\n")).toString(36);
  if (getMeta("replica.triggers") !== digest) {
    tx(() => {
      for (const old of all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'replica\\_%' ESCAPE '\\'")) {
        getDb().run(`DROP TRIGGER IF EXISTS ${q(old.name)}`);
      }
      for (const stmt of wanted) getDb().run(stmt);
      setMeta("replica.triggers", digest);
    });
  }
  if (getMeta("replica.backfilled") !== "1") backfill(tables);
  // A crash in the middle of writing another computer's changes must not make this computer's own writes look like theirs.
  sql("UPDATE replica_ctx SET origin = NULL, at = NULL WHERE id = 1");
  ensured = getDb();
}

/** Rows from before the replica: known, as old as can be, so any real change wins over them. */
function backfill(tables: ReplicaTable[]): void {
  // On a secondary what is here already came from its primary: nothing of it goes back.
  const origin = isSecondary() ? primaryRunnerId() : null;
  tx(() => {
    let n = get<{ n: number }>("SELECT n FROM replica_seq WHERE id = 1")?.n ?? 0;
    for (const t of tables) {
      const where = t.only ? ` WHERE ${q(t.only.column)} = ?` : t.skip ? ` WHERE ${q(t.skip.column)} NOT IN (${t.skip.values.map(() => "?").join(", ")})` : "";
      const rows = all<Record<string, unknown>>(`SELECT ${t.key.map(q).join(", ")} FROM ${q(t.table)}${where}`, ...(t.only ? [t.only.value] : t.skip ? t.skip.values : []));
      for (const r of rows) {
        n++;
        sql(
          "INSERT OR IGNORE INTO replica_rows (tbl, pk, seq, at, deleted, origin) VALUES (?, ?, ?, '1970-01-01T00:00:00.000Z', 0, ?)",
          t.table,
          t.key.map((k) => String(r[k])).join(KEY_SEP),
          n,
          origin,
        );
      }
    }
    sql("UPDATE replica_seq SET n = ? WHERE id = 1", n);
    setMeta("replica.backfilled", "1");
  });
}

/** Tests open several databases one after another. */
export function resetReplicaCache(): void {
  ensured = null;
  tablesCache = null;
  fkCache.clear();
  columnCache.clear();
}

/* ------------------------------------------------------------------ */
/* Who wrote it                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run `fn` as the writing of another computer's change: the triggers note it as theirs (so it isn't sent back) and as
 * made when it was made there. Synchronous only — nothing else may write in between.
 */
export function asPeer<T>(origin: string, at: string | null, fn: () => T): T {
  sql("UPDATE replica_ctx SET origin = ?, at = ? WHERE id = 1", origin, at);
  try {
    return fn();
  } finally {
    sql("UPDATE replica_ctx SET origin = NULL, at = NULL WHERE id = 1");
  }
}

/** The last change this computer counted (local or taken from another one). */
export function replicaSeq(): number {
  try {
    return get<{ n: number }>("SELECT n FROM replica_seq WHERE id = 1")?.n ?? 0;
  } catch {
    return 0;
  }
}

function ackedKey(peer: string): string {
  return `link.replica.acked.${peer}`;
}

function pulledKey(peer: string): string {
  return `link.replica.pulled.${peer}`;
}

/** Changes made here that `peer` hasn't taken yet (it says how far it got with each pull). */
export function pendingFor(peer: string): number {
  try {
    const acked = Number(getMeta(ackedKey(peer)) ?? 0);
    return get<{ c: number }>("SELECT COUNT(*) AS c FROM replica_rows WHERE seq > ? AND (origin IS NULL OR origin != ?)", acked, peer)?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Keys of `table` changed here that `peer` hasn't taken yet: a copy from it must not overwrite them. */
export function pendingKeys(peer: string, table: string): Set<string> {
  try {
    const acked = Number(getMeta(ackedKey(peer)) ?? 0);
    return new Set(all<{ pk: string }>("SELECT pk FROM replica_rows WHERE tbl = ? AND seq > ? AND origin IS NULL", table, acked).map((r) => r.pk));
  } catch {
    return new Set();
  }
}

const ackListeners = new Set<(peer: string, after: number) => void>();

/** `peer` has everything of this computer's up to `after`. */
export function ackFrom(peer: string, after: number): void {
  const acked = Number(getMeta(ackedKey(peer)) ?? 0);
  if (after > acked) setMeta(ackedKey(peer), String(after));
  for (const fn of [...ackListeners]) fn(peer, after);
}

export function onAck(fn: (peer: string, after: number) => void): () => void {
  ackListeners.add(fn);
  return () => ackListeners.delete(fn);
}

/** Joining a group: what this computer had before stays its own and is never sent (the primary's setup replaces it). */
export function keepPreJoinLocal(primary: string): void {
  try {
    sql("UPDATE replica_rows SET origin = ? WHERE origin IS NULL", primary);
  } catch (err) {
    log.warn("could not set this computer's earlier data aside", err);
  }
}

/** Keys of `table` this computer made itself (not copies): the setup copy doesn't delete them, a deletion arrives here. */
export function madeHere(table: string): Set<string> {
  try {
    return new Set(all<{ pk: string }>("SELECT pk FROM replica_rows WHERE tbl = ? AND origin IS NULL AND deleted = 0", table).map((r) => r.pk));
  } catch {
    return new Set();
  }
}

/** Forget what a computer that left the group took or gave. */
export function forgetPeer(peer: string): void {
  try {
    sql("DELETE FROM meta WHERE key IN (?, ?)", ackedKey(peer), pulledKey(peer));
    sql("DELETE FROM replica_deferred WHERE peer = ?", peer);
    sql("UPDATE replica_rows SET origin = NULL WHERE origin = ?", peer);
  } catch (err) {
    log.warn("could not forget a computer's changes", err);
  }
}

/* ------------------------------------------------------------------ */
/* Serving changes                                                      */
/* ------------------------------------------------------------------ */

export interface ReplicaChange {
  t: string;
  k: string;
  at: string;
  /** Deleted there. */
  d?: 1;
  row?: Record<string, DumpValue>;
}

export interface ReplicaPage {
  changes: ReplicaChange[];
  /** The seq to ask after next time. */
  last: number;
  more: boolean;
}

function keyWhere(t: ReplicaTable): string {
  return t.key.map((k) => `${q(k)} = ?`).join(" AND ");
}

function keyParts(t: ReplicaTable, pk: string): string[] {
  const parts = pk.split(KEY_SEP);
  return parts.length === t.key.length ? parts : [];
}

/**
 * What `peer` hasn't seen: every change after `after` that didn't come from it. `setup: false` leaves the setup out (a
 * secondary gets that as the snapshot). Pulling after N also says the peer has everything up to N.
 */
export function changesFor(peer: string, after: number, opts: { setup: boolean; limit?: number }): ReplicaPage {
  ensureReplica();
  ackFrom(peer, after);
  const limit = Math.min(Math.max(opts.limit ?? PULL_LIMIT, 1), 2000);
  const rows = all<{ tbl: string; pk: string; seq: number; at: string; deleted: number; origin: string | null }>(
    "SELECT tbl, pk, seq, at, deleted, origin FROM replica_rows WHERE seq > ? ORDER BY seq LIMIT ?",
    after,
    limit + 1,
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const changes: ReplicaChange[] = [];
  for (const r of page) {
    if (r.origin === peer) continue;
    const t = spec(r.tbl);
    // Without the setup a secondary still gets its deletions: the snapshot doesn't delete what that computer made itself.
    if (!t || (!opts.setup && t.setup && !r.deleted) || !exists(t.table)) continue;
    if (r.deleted) {
      changes.push({ t: r.tbl, k: r.pk, at: r.at, d: 1 });
      continue;
    }
    const parts = keyParts(t, r.pk);
    if (!parts.length) continue;
    const row = get<Record<string, unknown>>(`SELECT * FROM ${q(t.table)} WHERE ${keyWhere(t)}`, ...parts);
    if (!row) {
      changes.push({ t: r.tbl, k: r.pk, at: r.at, d: 1 });
      continue;
    }
    const out: Record<string, DumpValue> = {};
    for (const [k, v] of Object.entries(row)) if (!t.own.includes(k)) out[k] = encodeValue(v);
    changes.push({ t: r.tbl, k: r.pk, at: r.at, row: out });
  }
  return { changes, last: page.length ? page[page.length - 1]!.seq : after, more };
}

/* ------------------------------------------------------------------ */
/* Taking changes                                                       */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  applied: number;
  /** This computer's change of the row was newer. */
  kept: number;
  /** Waiting for a row they point at. */
  deferred: number;
  failed: number;
  entities: Set<EntityName>;
  /** Agents added or changed (their files need writing) and removed (their folders go to the trash). */
  agents: Set<string>;
  removedAgents: { slug: string; repoPath: string }[];
  /** The keys of the rows that changed, per table. */
  keys: Record<string, string[]>;
}

interface ForeignKey {
  from: string;
  table: string;
  to: string;
}

const fkCache = new Map<string, ForeignKey[]>();
const columnCache = new Map<string, string[]>();

function foreignKeys(table: string): ForeignKey[] {
  let list = fkCache.get(table);
  if (!list) {
    list = all<{ from: string; table: string; to: string | null }>(`PRAGMA foreign_key_list(${q(table)})`).map((f) => ({ from: f.from, table: f.table, to: f.to ?? "id" }));
    fkCache.set(table, list);
  }
  return list;
}

/** The first row this one points at that isn't here (nor coming with the same batch). */
function missingParent(row: Record<string, Value>, table: string, incoming: Set<string>): { table: string; id: string } | null {
  for (const fk of foreignKeys(table)) {
    const v = row[fk.from];
    if (v === null || v === undefined) continue;
    const id = String(v);
    if (incoming.has(`${fk.table}${KEY_SEP}${id}`)) continue;
    if (!get(`SELECT 1 FROM ${q(fk.table)} WHERE ${q(fk.to)} = ?`, id)) return { table: fk.table, id };
  }
  return null;
}

/** A row's last known change here. */
function localStamp(table: string, pk: string): { at: string; origin: string | null; deleted: number } | null {
  return get<{ at: string; origin: string | null; deleted: number }>("SELECT at, origin, deleted FROM replica_rows WHERE tbl = ? AND pk = ?", table, pk);
}

function emptyResult(): ApplyResult {
  return { applied: 0, kept: 0, deferred: 0, failed: 0, entities: new Set(), agents: new Set(), removedAgents: [], keys: {} };
}

/**
 * Write what `peer` changed. `peerWinsTies`: the peer is the primary. Each row is checked against its last change here
 * first; a row that points at one that isn't here yet waits (replica_deferred) and is tried with the next pull.
 */
export function applyChanges(peer: string, changes: ReplicaChange[], opts: ApplyOptions): ApplyResult {
  ensureReplica();
  const result = emptyResult();
  const incoming = new Set(changes.filter((c) => !c.d).map((c) => `${c.t}${KEY_SEP}${c.k}`));
  const write = (c: ReplicaChange) => applyOne(peer, c, opts, incoming, result);
  try {
    tx(() => {
      getDb().run("PRAGMA defer_foreign_keys = ON");
      for (const c of changes) write(c);
    });
  } catch (err) {
    // One row the batch couldn't hold (a unique name taken here meanwhile): each on its own, so the others still land.
    log.info("a batch of changes didn't fit as a whole; taking them one by one", { peer, error: err instanceof Error ? err.message : String(err) });
    const partial = emptyResult();
    for (const c of changes) {
      try {
        tx(() => {
          getDb().run("PRAGMA defer_foreign_keys = ON");
          applyOne(peer, c, opts, new Set(), partial);
        });
      } catch (one) {
        partial.failed++;
        // Kept and tried again with the next pulls (a name taken here may be free by then); never just dropped.
        try {
          defer(peer, c);
        } catch {
          /* the database is in trouble: the next pull brings it again */
        }
        log.warn(`could not take a change of ${c.t} yet`, { peer, key: c.k, error: one instanceof Error ? one.message : String(one) });
      }
    }
    Object.assign(result, partial);
  }
  return result;
}

export interface ApplyOptions {
  peerWinsTies: boolean;
  onMissing?: (table: string, id: string) => void;
  /** These changes were tried before (replica_deferred). */
  retry?: boolean;
}

function applyOne(peer: string, c: ReplicaChange, opts: ApplyOptions, incoming: Set<string>, result: ApplyResult): void {
  const t = spec(c.t);
  if (!t || !exists(t.table) || typeof c.k !== "string" || typeof c.at !== "string") return;
  const parts = keyParts(t, c.k);
  if (!parts.length) return;
  const local = localStamp(t.table, c.k);
  // The newer change wins. A tie: a deletion wins it (a row made and deleted in the same moment stays deleted), then
  // the primary's change.
  const tie = !!local && local.at === c.at;
  const keep = !!local && (local.at > c.at || (tie && !c.d && (local.deleted === 1 || (local.origin !== peer && !opts.peerWinsTies))));
  if (keep) {
    result.kept++;
    // Lost: nothing to try again.
    sql("DELETE FROM replica_deferred WHERE peer = ? AND tbl = ? AND pk = ?", peer, t.table, c.k);
    // This computer's version is newer: it goes to the peer again (it pulled past it already, or never got it).
    if (local!.at > c.at && !opts.retry) {
      sql("UPDATE replica_seq SET n = n + 1 WHERE id = 1");
      sql("UPDATE replica_rows SET seq = (SELECT n FROM replica_seq WHERE id = 1) WHERE tbl = ? AND pk = ?", t.table, c.k);
    }
    return;
  }
  const columns = cachedColumns(t.table);
  const count = () => {
    result.applied++;
    result.entities.add(t.entity);
    (result.keys[t.table] ??= []).push(c.k);
  };
  if (c.d && t.skip && t.key.length === 1 && t.skip.column === t.key[0] && t.skip.values.includes(parts[0]!)) return;
  if (c.d) {
    // Never an agent out from under a run: the deletion waits until its work ends here.
    if (t.table === "agents" && listActiveRuns().some((r) => r.agentId === parts[0])) {
      defer(peer, c);
      result.deferred++;
      return;
    }
    const before = t.table === "agents" ? get<{ slug: string }>("SELECT slug FROM agents WHERE id = ?", parts[0]!) : null;
    const res = asPeer(peer, c.at, () => sql(`DELETE FROM ${q(t.table)} WHERE ${keyWhere(t)}`, ...parts));
    if (res.changes === 0) {
      // Already gone here: remember the deletion, so an older copy of the row can't bring it back.
      sql("UPDATE replica_seq SET n = n + 1 WHERE id = 1");
      sql(
        "INSERT OR REPLACE INTO replica_rows (tbl, pk, seq, at, deleted, origin) VALUES (?, ?, (SELECT n FROM replica_seq WHERE id = 1), ?, 1, ?)",
        t.table,
        c.k,
        c.at,
        peer,
      );
      return;
    }
    if (before) result.removedAgents.push({ slug: before.slug, repoPath: join(config().agentsDir, before.slug) });
    sql("DELETE FROM replica_deferred WHERE peer = ? AND tbl = ? AND pk = ?", peer, t.table, c.k);
    count();
    return;
  }
  if (!c.row || typeof c.row !== "object") return;
  const row: Record<string, Value> = {};
  for (const [k, v] of Object.entries(c.row)) {
    if (!columns.includes(k) || t.own.includes(k)) continue;
    row[k] = decodeValue(v);
  }
  for (const [i, k] of t.key.entries()) row[k] = parts[i]!;
  if (t.only && row[t.only.column] !== t.only.value) return;
  if (t.skip && t.skip.values.includes(String(row[t.skip.column]))) return;
  if (t.table === "settings" && typeof row.value === "string") {
    row.value = withOwnFields(String(row.key), row.value, get<{ value: string }>("SELECT value FROM settings WHERE key = ?", String(row.key))?.value ?? null);
  }
  // Ids and names that become folder names here are checked like the setup copy checks them.
  const problem = unsafe(t.table, row);
  if (problem) {
    log.warn(problem, { peer });
    result.failed++;
    return;
  }
  const missing = missingParent(row, t.table, incoming);
  if (missing) {
    defer(peer, c);
    result.deferred++;
    opts.onMissing?.(missing.table, missing.id);
    return;
  }
  const isNew = !get(`SELECT 1 FROM ${q(t.table)} WHERE ${keyWhere(t)}`, ...parts);
  const extra = isNew ? (t.onInsert?.(row) ?? {}) : {};
  const names = Object.keys(row);
  const updates = names.filter((n) => !t.key.includes(n));
  const inserted = [...names, ...Object.keys(extra)];
  const set = updates.map((n) => `${q(n)} = excluded.${q(n)}`).join(", ");
  const conflict = updates.length ? `DO UPDATE SET ${set}` : "DO NOTHING";
  const res = asPeer(peer, c.at, () =>
    sql(
      `INSERT INTO ${q(t.table)} (${inserted.map(q).join(", ")}) VALUES (${inserted.map(() => "?").join(", ")}) ON CONFLICT(${t.key.map(q).join(", ")}) ${conflict}`,
      ...names.map((n) => row[n] ?? null),
      ...Object.values(extra),
    ),
  );
  // Nothing changed here (the same row): its stamp still says it is the peer's now, so it isn't sent back.
  sql("UPDATE replica_rows SET at = ?, origin = ? WHERE tbl = ? AND pk = ? AND at <= ?", c.at, peer, t.table, c.k, c.at);
  sql("DELETE FROM replica_deferred WHERE peer = ? AND tbl = ? AND pk = ?", peer, t.table, c.k);
  if (res.changes > 0) {
    count();
    if (t.table === "agents") result.agents.add(parts[0]!);
  }
}

/** Kept to try again: a change that can't be written yet (a row it points at, a name taken here, an agent at work). */
function defer(peer: string, c: ReplicaChange): void {
  sql(
    "INSERT INTO replica_deferred (peer, tbl, pk, change, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(peer, tbl, pk) DO UPDATE SET change = excluded.change",
    peer,
    c.t,
    c.k,
    JSON.stringify(c),
    now(),
  );
}

/** Changes of `peer` that waited for a row they point at: tried again (after a pull, after a chat arrived). */
export function retryDeferred(peer: string, opts: ApplyOptions): ApplyResult {
  const cutoff = new Date(Date.now() - DEFERRED_DAYS * 86_400_000).toISOString();
  sql("DELETE FROM replica_deferred WHERE peer = ? AND created_at < ?", peer, cutoff);
  const waiting = all<{ change: string }>("SELECT change FROM replica_deferred WHERE peer = ? ORDER BY created_at", peer);
  if (!waiting.length) return emptyResult();
  const changes: ReplicaChange[] = [];
  for (const w of waiting) {
    try {
      changes.push(JSON.parse(w.change) as ReplicaChange);
    } catch {
      /* a damaged entry never applies */
    }
  }
  // Not counted again as waiting when it still can't: its entry stays as it is.
  return applyChanges(peer, changes, { ...opts, onMissing: undefined, retry: true });
}

/** Deletions older than this are forgotten (every computer of the group has long taken them). */
export function pruneTombstones(peers: string[]): void {
  try {
    const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString();
    // Only what every computer of the group has taken: one that was away for long still learns about the deletion.
    const taken = peers.length ? Math.min(...peers.map((p) => Number(getMeta(ackedKey(p)) ?? 0))) : Number.MAX_SAFE_INTEGER;
    sql("DELETE FROM replica_rows WHERE deleted = 1 AND at < ? AND seq <= ?", cutoff, taken);
  } catch (err) {
    log.warn("could not prune old deletions", err);
  }
}

/** Tell the UI what changed (after the changes are committed). */
export function announce(result: ApplyResult): void {
  for (const entity of result.entities) bus.changed(entity);
}

/** Two results as one (a pull takes several pages). */
export function mergeResults(into: ApplyResult, more: ApplyResult): ApplyResult {
  into.applied += more.applied;
  into.kept += more.kept;
  into.deferred += more.deferred;
  into.failed += more.failed;
  for (const e of more.entities) into.entities.add(e);
  for (const a of more.agents) into.agents.add(a);
  into.removedAgents.push(...more.removedAgents);
  for (const [table, keys] of Object.entries(more.keys)) (into.keys[table] ??= []).push(...keys);
  return into;
}

export { emptyResult as emptyApplyResult };

export const REPLICA_KEY_SEP = KEY_SEP;
export { pulledKey as replicaPulledKey };
