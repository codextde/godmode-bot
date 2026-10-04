/**
 * The database handle. One pool per process, kept on `globalThis`: Next.js and the custom server (server/main.ts) are
 * bundled separately but run in the same process, and `next dev` reloads modules.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; services accept `Db | Tx` where they can run inside one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface Shared {
  pool?: Pool;
  db?: Db;
}

const shared = ((globalThis as { __godmodeCloudDb?: Shared }).__godmodeCloudDb ??= {});

export function pool(): Pool {
  if (!shared.pool) {
    shared.pool = new Pool({ connectionString: config().databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    // A dropped idle connection must not take the process down.
    shared.pool.on("error", (err) => console.error("[db] idle connection error:", err.message));
  }
  return shared.pool;
}

/** The connection is made on the first query, so importing this during `next build` needs no database. */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    shared.db ??= drizzle({ client: pool(), schema });
    const value = Reflect.get(shared.db, prop, receiver);
    return typeof value === "function" ? value.bind(shared.db) : value;
  },
});

export async function closeDb(): Promise<void> {
  const current = shared.pool;
  shared.pool = undefined;
  shared.db = undefined;
  await current?.end();
}

export { schema };
export * from "./schema";
