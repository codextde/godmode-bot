import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** An in-memory D1 stand-in on bun:sqlite with the site's real migrations applied. */
export function testDb() {
  const sql = new Database(':memory:');
  const dir = path.join(import.meta.dir, '../migrations');
  for (const file of readdirSync(dir).sort()) sql.run(readFileSync(path.join(dir, file), 'utf8'));

  const prepare = (query: string) => {
    let args: SQLQueryBindings[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        args = values as SQLQueryBindings[];
        return stmt;
      },
      async run() {
        const r = sql.query(query).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async first<T>() {
        return (sql.query(query).get(...args) ?? null) as T | null;
      },
      async all<T>() {
        return { success: true, results: sql.query(query).all(...args) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { prepare, sql };
}
