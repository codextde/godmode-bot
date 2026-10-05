/** Applies the migrations in <app>/drizzle at start. An advisory lock keeps two starting processes from racing. */
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { config } from "@/server/config";
import { pool } from "@/server/db";

/** Arbitrary but fixed: "gmcl" in ASCII. */
const LOCK_KEY = 0x676d636c;

export async function migrate(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await applyMigrations(drizzle({ client }), { migrationsFolder: path.join(config().appDir, "drizzle") });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
