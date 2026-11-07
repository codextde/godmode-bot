import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { __setCodeSignClonesForTests, elapsedSeconds, leftoverClones } from "../src/browser/codeSignClones";

const dir = mkdtempSync(join(tmpdir(), "godmode-clones-"));

afterAll(() => {
  __setCodeSignClonesForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;

function clone(name: string, executable: string, bornAt: number, group = join(dir, "com.example.Browser.code_sign_clone")): string {
  const path = join(group, name);
  const exe = join(path, "Browser.app.bundle", "Contents", "MacOS", executable);
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, "");
  const when = new Date(bornAt);
  utimesSync(path, when, when);
  return path;
}

describe("Chrome's app clones", () => {
  test("reads ps elapsed times", () => {
    expect(elapsedSeconds("00:07")).toBe(7);
    expect(elapsedSeconds("58:55")).toBe(3535);
    expect(elapsedSeconds("17:03:16")).toBe(61_396);
    expect(elapsedSeconds("04-22:26:22")).toBe(426_382);
    expect(elapsedSeconds("-")).toBeNull();
  });

  test("a browser is known by the path it was started as or by the kernel's 16-character name", async () => {
    const now = Date.now();
    const beta = clone("code_sign_clone.Beta12", "Google Chrome Beta", now - 3 * HOUR);
    const other = clone("code_sign_clone.Othr12", "Google Chrome Beta", now - 5 * HOUR);
    const elsewhere = mkdtempSync(join(tmpdir(), "godmode-clones-elsewhere-"));
    const outside = clone("code_sign_clone.Link12", "Nothing", now - 5 * HOUR, elsewhere);
    symlinkSync(elsewhere, join(dir, "com.example.Linked.code_sign_clone"));
    __setCodeSignClonesForTests({ dir, list: async () => [{ name: "google chrome be", startedAt: now - 3 * HOUR - 20 * 60_000 }] });
    try {
      const found = (await leftoverClones(now, HOUR)).map((c) => c.path);
      expect(found).toContain(other);
      expect(found).not.toContain(beta);
      expect(found.some((p) => p.startsWith(elsewhere) || p.includes("Linked"))).toBe(false);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(beta, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(join(dir, "com.example.Linked.code_sign_clone"));
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("a clone born right after a process that still runs started stays", async () => {
    __setCodeSignClonesForTests({ dir });
    const own = clone("code_sign_clone.Own123", basename(process.execPath), performance.timeOrigin + 500);
    const gone = clone("code_sign_clone.Gone12", "No Such Browser", Date.now() - 2 * HOUR);
    const found = (await leftoverClones(Date.now() + 2 * HOUR, HOUR)).map((c) => c.path);
    expect(found).toContain(gone);
    expect(found).not.toContain(own);
  });
});
