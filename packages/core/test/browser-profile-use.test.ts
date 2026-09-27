import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { HttpError } from "../src/util";
import { installProfileUse, profileUseStatus, resolveProfileUse, syncWithProfileUse } from "../src/browser/profileUse";

const FAKE_KEY = "bu_test_key_1234567890";
let dataDir: string;
const savedKey = process.env.BROWSER_USE_API_KEY;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-profile-use-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  delete process.env.BROWSER_USE_API_KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.BROWSER_USE_API_KEY;
  else process.env.BROWSER_USE_API_KEY = savedKey;
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

const suite = process.platform === "win32" ? describe.skip : describe;

suite("profile-use", () => {
  test("status explains what is missing", () => {
    const status = profileUseStatus();
    expect(status.hasApiKey).toBe(false);
    expect(status.lastSyncAt).toBeNull();
    expect(status.detail.length).toBeGreaterThan(10);
  });

  test("never resolves a binary planted in a temp dir", () => {
    const planted = mkdtempSync(join(tmpdir(), "godmode-plant-"));
    const savedTmp = process.env.TMPDIR;
    try {
      writeFileSync(join(planted, "profile-use"), "#!/bin/sh\necho pwned\n");
      chmodSync(join(planted, "profile-use"), 0o755);
      process.env.TMPDIR = planted;
      expect(resolveProfileUse()).not.toBe(join(planted, "profile-use"));
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(planted, { recursive: true, force: true });
    }
  });

  test("install refuses a download whose SHA-256 does not match the pinned release", async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(new Uint8Array(200_000).fill(7));
    }) as typeof fetch;
    try {
      await expect(installProfileUse()).rejects.toThrow("SHA-256");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/github\.com\/browser-use\/profile-use-releases\/releases\/download\/v\d+\.\d+\.\d+\/profile-use-/);
    expect(existsSync(join(dataDir, "bin", "profile-use"))).toBe(false);
  });

  test("sync passes filters, redacts the API key and reports the cloud profile id", async () => {
    // Fake binary in Godmode's managed bin dir (resolved before PATH).
    const bin = join(dataDir, "bin", "profile-use");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\necho "args: $*"\necho "using key $BROWSER_USE_API_KEY"\necho "Synced to cloud profile 123e4567-e89b-12d3-a456-426614174000"\n`);
    chmodSync(bin, 0o755);
    expect(resolveProfileUse()).toBe(bin);

    await expect(syncWithProfileUse({})).rejects.toThrow("API key");
    process.env.BROWSER_USE_API_KEY = FAKE_KEY;

    const status = profileUseStatus();
    expect(status).toMatchObject({ installed: true, path: bin, hasApiKey: true });

    const res = await syncWithProfileUse({ browser: "Google Chrome", profile: "Profile 1", domains: ["github.com"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("args: sync --browser Google Chrome --profile Profile 1 --domain github.com");
    expect(res.output).not.toContain(FAKE_KEY);
    expect(res.output).toContain("••••••••");
    expect(res.cloudProfileId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(profileUseStatus().lastSyncAt).not.toBeNull();

    const all = await syncWithProfileUse({});
    expect(all.output).toContain("args: sync --all");

    await expect(syncWithProfileUse({ domains: ["bad domain"] })).rejects.toBeInstanceOf(HttpError);
    await expect(syncWithProfileUse({ sourcePath: join(dataDir, "not-a-browser", "Default") })).rejects.toThrow("not a known local browser profile");
  });
});
