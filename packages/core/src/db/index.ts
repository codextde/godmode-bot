import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { MIGRATIONS } from "./migrations";
import { logger } from "../log";

const log = logger("db");

let db: Database | null = null;

export function openDb(path: string): Database {
  const instance = new Database(path, { create: true, strict: true });
  instance.run("PRAGMA journal_mode = WAL;");
  instance.run("PRAGMA foreign_keys = ON;");
  instance.run("PRAGMA busy_timeout = 5000;");
  instance.run("PRAGMA synchronous = NORMAL;");
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  migrate(instance);
  db = instance;
  return instance;
}

export function getDb(): Database {
  if (!db) throw new Error("database not opened");
  return db;
}

/** For tests */
export function setDb(instance: Database) {
  db = instance;
}

export function closeDb() {
  db?.close();
  db = null;
}

function migrate(instance: Database) {
  instance.run("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(
    instance
      .query<{ id: number }, []>("SELECT id FROM _migrations")
      .all()
      .map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    log.info(`applying migration ${m.id} (${m.name})`);
    instance.transaction(() => {
      instance.run(m.sql);
      instance.query("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
    })();
  }
}

/* ------------------------------------------------------------------ */
/* Tiny query helpers                                                  */
/* ------------------------------------------------------------------ */

type Param = string | number | bigint | boolean | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb().query<T, Param[]>(sql).all(...params);
}

export function get<T>(sql: string, ...params: Param[]): T | null {
  return getDb().query<T, Param[]>(sql).get(...params) ?? null;
}

export function run(sql: string, ...params: Param[]) {
  return getDb().query(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/** Build an INSERT from a plain object (keys = column names). */
export function insert(table: string, row: Record<string, Param | undefined>) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  return run(sql, ...keys.map((k) => row[k] as Param));
}

/** Build an UPDATE ... WHERE id = ? from a plain object (undefined values are skipped). */
export function update(table: string, id: string, row: Record<string, Param | undefined>) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  if (keys.length === 0) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  return run(sql, ...keys.map((k) => row[k] as Param), id);
}

export function bool(v: number | boolean | null | undefined): boolean {
  return v === 1 || v === true;
}

export function int(v: boolean | undefined): number | undefined {
  return v === undefined ? undefined : v ? 1 : 0;
}

export function json(v: unknown): string | undefined {
  return v === undefined ? undefined : JSON.stringify(v);
}

export function getMeta(key: string): string | null {
  return get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
}

export function setMeta(key: string, value: string) {
  run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export function deleteMeta(key: string) {
  run("DELETE FROM meta WHERE key = ?", key);
}
