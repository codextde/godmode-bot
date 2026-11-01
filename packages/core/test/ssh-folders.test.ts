import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listingScript, parseListing } from "../src/ssh/folders";

describe("folders on an SSH server", () => {
  test("lists the subfolders, marks git repositories and leaves hidden ones out unless asked", () => {
    const home = mkdtempSync(join(tmpdir(), "gm-ssh-folders-"));
    try {
      for (const d of ["b app", "A", ".hidden", "repo/.git"]) mkdirSync(join(home, d), { recursive: true });
      const run = (path: string | undefined, hidden: boolean) =>
        Bun.spawnSync(["sh", "-c", listingScript(path, hidden)], { env: { PATH: process.env.PATH ?? "", HOME: home } });
      const res = run(undefined, false);
      const listing = parseListing(res.stdout.toString())!;
      expect(listing.home).toBe(listing.path);
      expect(listing.entries.map((e) => [e.name, e.git])).toEqual([["A", false], ["b app", false], ["repo", true]]);
      expect(parseListing(run("~", true).stdout.toString())!.entries.map((e) => e.name)).toContain(".hidden");
      expect(parseListing(run("~/repo", false).stdout.toString())!.parent).toBe(listing.path);
      expect(run("~/missing", false).exitCode).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
