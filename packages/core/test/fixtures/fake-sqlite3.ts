#!/usr/bin/env bun
/**
 * Stand-in for the guest's `sqlite3 [options] <database> <sql>` (fixtures/fake-tart.ts), so VM tests don't need the sqlite3
 * command on the machine that runs them. Like the real one: statements run in order, the rows of each are printed
 * with their columns joined by "|", and the first error ends it with exit code 1.
 */
import { Database } from "bun:sqlite";

// Options Godmode passes (no startup file, batch mode, a lock timeout) change nothing here.
const args = process.argv.slice(2);
while (args[0]?.startsWith("-")) args.splice(0, args[0] === "-init" || args[0] === "-cmd" ? 2 : 1);
const [path, sql] = args;
if (!path || sql === undefined) {
  process.stderr.write("usage: sqlite3 <database> <sql>\n");
  process.exit(2);
}
try {
  const db = new Database(path);
  // Godmode's statements end with ";\n" and never contain a line break.
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    const query = db.prepare(statement);
    if (query.columnNames.length) for (const row of query.values()) process.stdout.write(`${row.join("|")}\n`);
    else query.run();
  }
  db.close();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
