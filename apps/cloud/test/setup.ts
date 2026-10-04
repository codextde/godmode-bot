/**
 * Runs before every test file. Tests use their own PostgreSQL database (DATABASE_URL must name a database whose name
 * contains "test", so a developer's data is never wiped) and a throwaway data directory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// NODE_ENV is typed read-only by @types/node.
Object.assign(process.env, { NODE_ENV: "test" });
process.env.DATABASE_URL ??= "postgres://localhost:5432/godmode_cloud_test";
if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error(`Refusing to run tests against ${process.env.DATABASE_URL}: the database name must contain "test".`);
}
process.env.APP_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
process.env.DATA_DIR ??= mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), "godmode-cloud-test-"));
process.env.DOMAIN ??= "http://localhost:3210";
