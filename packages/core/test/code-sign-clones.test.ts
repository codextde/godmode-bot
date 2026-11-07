import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { __setCodeSignClonesForTests, elapsedSeconds, leftoverClones } from "../src/browser/codeSignClones";

const dir = mkdtempSync(join(tmpdir(), "godmode-clones-"));

afterAll(() => {
  __setCodeSignClonesForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function clone(name: string, executable: string, bornAt: number): string {
  const path = join(dir, "com.example.Browser.code_sign_clone", name);
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

  test.skipIf(process.platform !== "darwin")("a clone born right after a process that still runs started stays", async () => {
    __setCodeSignClonesForTests({ dir });
    const own = clone("code_sign_clone.Own123", basename(process.execPath), performance.timeOrigin + 500);
    const gone = clone("code_sign_clone.Gone12", "No Such Browser", Date.now() - 2 * 60 * 60_000);
    const found = (await leftoverClones(Date.now() + 2 * 60 * 60_000, 60 * 60_000)).map((c) => c.path);
    expect(found).toContain(gone);
    expect(found).not.toContain(own);
  });
});
