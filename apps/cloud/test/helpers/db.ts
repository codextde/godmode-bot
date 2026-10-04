/** Database helpers for tests: a fresh schema per test file, and truncation between tests. */
import path from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { closeDb, db } from "@/server/db";
import { resetShared } from "@/server/shared";

const MIGRATIONS = path.join(import.meta.dirname, "../../drizzle");

/** Drops everything and applies the migrations. Call once per file, in `beforeAll`. */
export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end();
  }
  resetShared();
}

/** Empties every table (keeps the schema). Call in `beforeEach` when tests must not see each other's rows. */
export async function truncateAll(): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = rows.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  resetShared();
}

/** Call in `afterAll`. */
export async function closeDatabase(): Promise<void> {
  await closeDb();
}
