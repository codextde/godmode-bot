import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { localizePaths, missingFolders } from "../src/remote/localPaths";

const home = mkdtempSync(join(tmpdir(), "godmode-home-"));
mkdirSync(join(home, ".godmode", "shared", "sales"), { recursive: true });

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("paths of another computer's home", () => {
  test("map to this computer's home; existing folders and this home stay", () => {
    expect(localizePaths("Log to /Users/someone-else-xyz/.godmode/shared/sales/sent.md.", home)).toBe(`Log to ${home}/.godmode/shared/sales/sent.md.`);
    expect(localizePaths(`See ${home}/notes.md and ${homedir()}/x`, home)).toBe(`See ${home}/notes.md and ${homedir()}/x`);
    expect(localizePaths("cd /home/other-user-xyz/work && ls", home)).toBe(`cd ${home}/work && ls`);
    expect(localizePaths("no paths here, just text/Users/a/b", home)).toBe("no paths here, just text/Users/a/b");
  });

  test("folders the prompt needs that aren't here are named; files still to be written are fine", () => {
    expect(missingFolders("Append to /Users/other-xyz/.godmode/shared/sales/sent.md", home)).toEqual([]);
    expect(missingFolders("Read /Users/other-xyz/.godmode/shared/leads/ki-leads.md, then /Users/other-xyz/.godmode/shared/leads/", home)).toEqual([
      `${home}/.godmode/shared/leads`,
    ]);
    expect(missingFolders("Nothing outside: /tmp/x/y.md", home)).toEqual([]);
  });
});
