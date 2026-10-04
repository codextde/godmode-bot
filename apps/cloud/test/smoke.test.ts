import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "@/server/db";
import { closeDatabase, resetDatabase } from "./helpers/db";

beforeAll(resetDatabase);
afterAll(closeDatabase);

test("migrations create the schema", async () => {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_tables where schemaname = 'public'`);
  expect(r.rows[0]!.n).toBe(15);
});
