import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** An in-memory D1 stand-in on node:sqlite with the site's real migrations applied. */
export function testDb() {
  const sql = new DatabaseSync(':memory:');
  const dir = path.join(import.meta.dirname, '../migrations');
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(path.join(dir, file), 'utf8'));

  const prepare = (query: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        args = values as SQLInputValue[];
        return stmt;
      },
      async run() {
        const r = sql.prepare(query).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async first<T>() {
        const row = sql.prepare(query).get(...args);
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>() {
        return { success: true, results: sql.prepare(query).all(...args).map((r) => ({ ...r })) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { prepare, sql };
}
