import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { CLAUDE_RELEASES_URL, claudeChannel, claudeUpdateStatus, compareVersions, isPackageManaged, updateClaude } from "../src/services/claudeUpdate";

const suite = process.platform === "win32" ? describe.skip : describe;

let dataDir: string;
let binDir: string;
let configDir: string;
const realFetch = globalThis.fetch;
const realConfigDir = process.env.CLAUDE_CONFIG_DIR;
let feed: Record<string, string> = {};
let fetched: string[] = [];

const FAKE_CLAUDE = `#!/bin/sh
DIR="$(dirname "$0")"
case "$1" in
  --version) echo "$(cat "$DIR/version") (Claude Code)" ;;
  update)
    if [ -f "$DIR/target" ]; then
      echo "Successfully updated from $(cat "$DIR/version") to version $(cat "$DIR/target")"
      cp "$DIR/target" "$DIR/version"
    else
      printf 'Claude is managed by Homebrew.\\n\\nTo update, run:\\n  brew upgrade claude-code\\n'
    fi ;;
esac
`;

const setInstalled = (version: string) => writeFileSync(join(binDir, "version"), version);
const setUpdateTarget = (version: string | null) => (version ? writeFileSync(join(binDir, "target"), version) : rmSync(join(binDir, "target"), { force: true }));
const setChannel = (channel: string | null) => writeFileSync(join(configDir, "settings.json"), JSON.stringify(channel ? { autoUpdatesChannel: channel } : {}));

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-claude-update-"));
  binDir = join(dataDir, "bin");
  configDir = join(dataDir, "claude-config");
  mkdirSync(binDir);
  mkdirSync(configDir);
  writeFileSync(join(binDir, "claude"), FAKE_CLAUDE);
  chmodSync(join(binDir, "claude"), 0o755);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  updateSettings({ runner: { claudePath: join(binDir, "claude") } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    const channel = url.startsWith(`${CLAUDE_RELEASES_URL}/`) ? url.slice(CLAUDE_RELEASES_URL.length + 1) : "";
    return feed[channel] ? new Response(`${feed[channel]}\n`) : new Response("<html>not found</html>", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  feed = { latest: "2.1.283", stable: "2.1.274" };
  fetched = [];
  setChannel(null);
  setInstalled("2.1.274");
  setUpdateTarget(null);
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("2.1.283", "2.1.274")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("2.1.0", "2.1.0")).toBe(0);
    expect(compareVersions("3.0.0", "2.99.99")).toBe(1);
  });

  test("a pre-release sorts before its release", () => {
    expect(compareVersions("2.2.0-beta.1", "2.2.0")).toBe(-1);
    expect(compareVersions("2.2.0", "2.2.0-beta.1")).toBe(1);
  });
});

describe("isPackageManaged", () => {
  test("recognises Homebrew, Nix and winget installs", () => {
    expect(isPackageManaged("/opt/homebrew/Caskroom/claude-code/2.1.274/claude")).toBe(true);
    expect(isPackageManaged("/usr/local/Cellar/claude-code/2.1.274/bin/claude")).toBe(true);
    expect(isPackageManaged("/nix/store/abc-claude-code-2.1.274/bin/claude")).toBe(true);
    expect(isPackageManaged("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode\\claude.exe")).toBe(true);
    expect(isPackageManaged("/Users/me/.local/share/claude/versions/2.1.274")).toBe(false);
    expect(isPackageManaged("/Users/me/.npm-global/bin/claude")).toBe(false);
  });
});

suite("claude update", () => {
  test("follows Claude Code's own release channel", () => {
    expect(claudeChannel()).toBe("latest");
    setChannel("stable");
    expect(claudeChannel()).toBe("stable");
    writeFileSync(join(configDir, "settings.json"), "{ not json");
    expect(claudeChannel()).toBe("latest");
  });

  test("reports an update when the channel is ahead of the installed version", async () => {
    const status = await claudeUpdateStatus(true);
    expect(status).toMatchObject({ current: "2.1.274", latest: "2.1.283", channel: "latest", updateAvailable: true });
    expect(fetched).toEqual([`${CLAUDE_RELEASES_URL}/latest`]);
  });

  test("no update on the stable channel when stable is already installed", async () => {
    setChannel("stable");
    const status = await claudeUpdateStatus(true);
    expect(status).toMatchObject({ current: "2.1.274", latest: "2.1.274", channel: "stable", updateAvailable: false });
  });

  test("no update prompt when a package manager owns the install", async () => {
    const cask = join(dataDir, "Caskroom", "claude-code", "2.1.274");
    const brewBin = join(dataDir, "homebrew-bin");
    mkdirSync(cask, { recursive: true });
    mkdirSync(brewBin, { recursive: true });
    writeFileSync(join(cask, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    writeFileSync(join(brewBin, "version"), "2.1.274");
    symlinkSync(join(cask, "claude"), join(brewBin, "claude"));
    updateSettings({ runner: { claudePath: join(brewBin, "claude") } });
    try {
      const status = await claudeUpdateStatus(true);
      expect(status).toMatchObject({ current: "2.1.274", latest: "2.1.283", updateAvailable: false });
    } finally {
      updateSettings({ runner: { claudePath: join(binDir, "claude") } });
    }
  });

  test("never offers a downgrade", async () => {
    setInstalled("2.1.290");
    expect((await claudeUpdateStatus(true)).updateAvailable).toBe(false);
  });

  test("caches the release feed and keeps the last known version when it is unreachable", async () => {
    await claudeUpdateStatus(true);
    await claudeUpdateStatus(false);
    expect(fetched).toHaveLength(1);
    feed = {};
    const status = await claudeUpdateStatus(true);
    expect(status.latest).toBe("2.1.283");
    expect(status.updateAvailable).toBe(true);
  });

  test("a feed that does not return a version never replaces the known one", async () => {
    setChannel("stable");
    await claudeUpdateStatus(true);
    feed = { stable: "<html>oops</html>" };
    const status = await claudeUpdateStatus(true);
    expect(status.latest).toBe("2.1.274");
    expect(status.updateAvailable).toBe(false);
  });

  test("updateClaude runs `claude update` and reports the new version", async () => {
    setUpdateTarget("2.1.283");
    const [a, b] = await Promise.all([updateClaude(), updateClaude()]);
    expect(b).toBe(a);
    expect(a).toMatchObject({ ok: true, previous: "2.1.274", version: "2.1.283" });
    expect(a.output).toContain("Successfully updated");
    expect(readFileSync(join(binDir, "version"), "utf8").trim()).toBe("2.1.283");
    expect((await claudeUpdateStatus(true)).updateAvailable).toBe(false);
  });

  test("updateClaude fails with the CLI's guidance when nothing was upgraded", async () => {
    const res = await updateClaude();
    expect(res.ok).toBe(false);
    expect(res.version).toBe("2.1.274");
    expect(res.output).toContain("brew upgrade claude-code");
  });

  test("updateClaude is ok when the CLI was already current", async () => {
    setInstalled("2.1.283");
    const res = await updateClaude();
    expect(res).toMatchObject({ ok: true, previous: "2.1.283", version: "2.1.283" });
  });
});
