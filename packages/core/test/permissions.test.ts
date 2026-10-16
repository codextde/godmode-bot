import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionId } from "@godmode/shared";
import { config, loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { __setUvxForTests, runDoctor } from "../src/services/doctor";
import { probeFullDiskAccessFresh } from "../src/services/fullDiskAccess";
import { __setPrivacyProbeForTests, checkPermissions, fixPermission, hostApp } from "../src/services/permissions";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { fakeTools, type FakeTools } from "./fixtures/fake-tools";

// Mode bits and ownership are POSIX; root may do everything, so nothing would ever look broken.
const posix = process.platform !== "win32" && process.getuid?.() !== 0;
const suite = posix ? describe : describe.skip;

let dataDir: string;
let claudeDir: string;
let tools: FakeTools;
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR;

const mode = (path: string) => statSync(path).mode & 0o777;
const status = async (id: PermissionId) => (await checkPermissions({ privacy: false })).permissions.find((p) => p.id === id)!;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-permissions-"));
  claudeDir = join(dataDir, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  loadConfig({ dataDir });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
  tools = fakeTools(join(dataDir, "fake-bin"));
  __setUvxForTests(tools.uvx);
  // No native helper in tests: the macOS privacy checks would start it.
  __setPrivacyProbeForTests(async () => null);
  updateSettings({ runner: { claudePath: tools.claude }, computer: { enabled: false } });
});

afterAll(() => {
  __setUvxForTests(undefined);
  __setPrivacyProbeForTests(undefined);
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeDir;
  closeDb();
  resetSettingsCache();
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Every test starts from a healthy data folder.
  loadConfig({ dataDir });
  chmodSync(config().dbPath, 0o600);
  rmSync(claudeDir, { recursive: true, force: true });
  mkdirSync(claudeDir, { mode: 0o700 });
});

suite("permission checks", () => {
  test("a fresh data folder passes every file check", async () => {
    const report = await checkPermissions({ privacy: false });
    expect(report.permissions.map((p) => p.id)).toEqual(["data-dir", "data-private", "tool-binaries", "claude-config"]);
    for (const p of report.permissions) {
      expect(p.ok).toBe(true);
      expect(p.required).toBe(true);
      expect(p.fixHint).toBe("");
    }
    expect(report.ok).toBe(true);
  });

  test("folders made later with ordinary permissions are no alarm: the data folder guards them", async () => {
    // What coding tasks and the claude-mem install create (a plain mkdir, 0755 with the usual umask).
    for (const name of ["tasks", "plugins"]) {
      mkdirSync(join(dataDir, name), { recursive: true });
      chmodSync(join(dataDir, name), 0o755);
    }
    const report = await checkPermissions({ privacy: false });
    expect(report.permissions.filter((p) => !p.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a missing folder is found and created again", async () => {
    rmSync(config().logsDir, { recursive: true });
    const before = await status("data-dir");
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("logs is missing");
    expect(before.fix).toBe("auto");
    expect((await checkPermissions({ privacy: false })).ok).toBe(false);

    const fixed = await fixPermission("data-dir");
    expect(fixed).toMatchObject({ kind: "permission", id: "data-dir", name: "Data folder", outcome: "fixed" });
    expect(mode(config().logsDir)).toBe(0o700);
    expect((await status("data-dir")).ok).toBe(true);
  });

  test("a folder Godmode may not write gets its permissions back", async () => {
    chmodSync(config().agentsDir, 0o500);
    chmodSync(config().dbPath, 0o400);
    const before = await status("data-dir");
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("can't be written");
    expect(before.detail).toContain("and 1 more");

    expect((await fixPermission("data-dir")).outcome).toBe("fixed");
    expect(mode(config().agentsDir)).toBe(0o700);
    expect(mode(config().dbPath)).toBe(0o600);
  });

  test("what Godmode can't repair says what the human has to do, and the rest is still repaired", async () => {
    rmSync(config().backupsDir, { recursive: true });
    writeFileSync(config().backupsDir, "not a folder");
    chmodSync(config().agentsDir, 0o500);
    try {
      const before = await status("data-dir");
      expect(before.ok).toBe(false);
      // One of the two can be repaired, so there is something to click.
      expect(before.fix).toBe("auto");
      expect(before.fixHint).toContain("Godmode can repair part of this");
      expect(before.fixHint).toContain("Move it out of the way");
      expect(before.fixHint).not.toContain("chown");

      const result = await fixPermission("data-dir");
      expect(result.outcome).toBe("manual");
      expect(result.output).toContain("backups is not a folder");
      expect(result.output).toContain("Move it out of the way");
      expect(mode(config().agentsDir)).toBe(0o700);

      const after = await status("data-dir");
      expect(after.fix).toBe("manual");
      expect(after.detail).not.toContain("more");
    } finally {
      rmSync(config().backupsDir);
    }
  });

  test("a repair that uncovers the next problem goes on", async () => {
    // Nothing inside a folder that can't be entered is visible, so the database only shows up after the first repair.
    chmodSync(config().dbPath, 0o400);
    chmodSync(dataDir, 0o000);
    try {
      expect((await fixPermission("data-dir")).outcome).toBe("fixed");
      expect(mode(dataDir)).toBe(0o700);
      expect(mode(config().dbPath)).toBe(0o600);
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  test("what lies behind a link is checked, but never changed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "godmode-permissions-outside-"));
    const elsewhere = join(outside, "tasks");
    const program = join(outside, "program");
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o555);
    writeFileSync(program, "#!/bin/sh\n", { mode: 0o644 });
    rmSync(join(dataDir, "tasks"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(dataDir, "tasks"));
    mkdirSync(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
    symlinkSync(program, join(dataDir, "bin", "godmode-computer-linked"));
    try {
      const before = await status("data-dir");
      expect(before.ok).toBe(false);
      expect(before.detail).toContain("tasks can't be written");
      expect(before.fix).toBe("manual");
      expect(before.fixHint).toContain("link to another place");
      expect((await fixPermission("data-dir")).outcome).toBe("manual");
      expect((await fixPermission("data-private")).outcome).toBe("fixed");
      expect((await fixPermission("tool-binaries")).outcome).toBe("fixed");
      // Untouched, whatever was asked.
      expect(mode(elsewhere)).toBe(0o555);
      expect(mode(program)).toBe(0o644);

      // The same for a file inside a folder that is a link: the log of a `logs` folder kept on another disk.
      rmSync(join(dataDir, "tasks"));
      chmodSync(elsewhere, 0o755);
      const log = join(elsewhere, "godmode.jsonl");
      writeFileSync(log, "");
      chmodSync(log, 0o400);
      rmSync(config().logsDir, { recursive: true });
      symlinkSync(elsewhere, config().logsDir);
      const logs = await status("data-dir");
      expect(logs.detail).toContain("godmode.jsonl can't be written");
      expect(logs.fix).toBe("manual");
      expect((await fixPermission("data-dir")).outcome).toBe("manual");
      expect(mode(log)).toBe(0o400);

      // A link that leads nowhere only matters for folders Godmode can't do without.
      rmSync(config().logsDir);
      symlinkSync(join(outside, "gone"), join(dataDir, "vm"));
      expect((await status("data-dir")).detail).toContain("logs is missing");
      expect((await fixPermission("data-dir")).outcome).toBe("fixed");
    } finally {
      rmSync(join(dataDir, "tasks"), { force: true });
      rmSync(join(dataDir, "vm"), { force: true });
      rmSync(join(dataDir, "bin", "godmode-computer-linked"));
      chmodSync(elsewhere, 0o755);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("data other users could read is made private again", async () => {
    chmodSync(dataDir, 0o755);
    chmodSync(config().dbPath, 0o644);
    writeFileSync(join(dataDir, ".vault-key"), "secret", { mode: 0o644 });
    chmodSync(join(dataDir, ".vault-key"), 0o644);

    const before = await status("data-private");
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("can be opened by other users");
    expect(before.detail).toContain("and 2 more");
    expect(before.fix).toBe("auto");

    expect((await fixPermission("data-private")).outcome).toBe("fixed");
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(config().dbPath)).toBe(0o600);
    expect(mode(join(dataDir, ".vault-key"))).toBe(0o600);
    rmSync(join(dataDir, ".vault-key"));
  });

  test("tools that lost their executable bit can be started again", async () => {
    const helper = join(dataDir, "bin", "godmode-computer-abc123");
    mkdirSync(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
    writeFileSync(helper, "#!/bin/sh\n", { mode: 0o644 });
    chmodSync(tools.claude, 0o644);

    const before = await status("tool-binaries");
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("may not be started");
    expect(before.detail).toContain("and 1 more");

    // The system check saw the claude CLI as broken…
    expect((await runDoctor(true)).dependencies.find((d) => d.id === "claude")!.ok).toBe(false);
    expect((await fixPermission("tool-binaries")).outcome).toBe("fixed");
    expect(mode(helper) & 0o100).toBe(0o100);
    expect(mode(tools.claude) & 0o100).toBe(0o100);
    // …and looks again by itself after the repair.
    expect((await runDoctor()).dependencies.find((d) => d.id === "claude")!.ok).toBe(true);
    rmSync(helper);
  });

  test("Claude Code's folder must be writable; a missing one is fine", async () => {
    chmodSync(claudeDir, 0o500);
    const before = await status("claude-config");
    expect(before.ok).toBe(false);
    expect(before.path).toBe(claudeDir);
    expect((await fixPermission("claude-config")).outcome).toBe("fixed");
    expect(mode(claudeDir)).toBe(0o700);

    writeFileSync(join(claudeDir, ".claude.json"), "{}");
    chmodSync(join(claudeDir, ".claude.json"), 0o400);
    expect((await status("claude-config")).ok).toBe(false);
    expect((await fixPermission("claude-config")).outcome).toBe("fixed");

    rmSync(claudeDir, { recursive: true });
    expect((await status("claude-config")).ok).toBe(true);
  });

  // macOS: a locked file (Finder → Get Info → Locked) can't be changed even by its owner.
  test.if(process.platform === "darwin")("a repair that doesn't take is not offered again", async () => {
    const key = join(dataDir, ".vault-key");
    writeFileSync(key, "secret");
    chmodSync(key, 0o644);
    Bun.spawnSync(["/usr/bin/chflags", "uchg", key]);
    try {
      expect((await status("data-private")).fix).toBe("auto");
      const result = await fixPermission("data-private");
      expect(result.outcome).toBe("failed");
      expect(result.output).toContain(".vault-key");

      const after = await status("data-private");
      expect(after.ok).toBe(false);
      expect(after.fix).toBe("manual");
      expect(after.fixHint).toContain("couldn't change this");
      // Asked again, nothing is attempted: it is the human's to solve.
      expect((await fixPermission("data-private")).outcome).toBe("manual");
    } finally {
      Bun.spawnSync(["/usr/bin/chflags", "nouchg", key]);
      rmSync(key);
    }
  });

  test("fixing something that works, or doesn't exist here, changes nothing", async () => {
    expect(await fixPermission("data-private")).toMatchObject({ outcome: "fixed", output: "Only your user account can open the data folder" });
    // Not a Mac (no answer from the privacy probe): nothing to check, nothing to ask for.
    expect((await fixPermission("accessibility", { interactive: false })).outcome).toBe("failed");
    expect((await fixPermission("nope" as PermissionId)).outcome).toBe("failed");
    const ids = (await checkPermissions()).permissions.map((p) => p.id);
    expect(ids).not.toContain("accessibility");
    expect(ids).not.toContain("screen-recording");
  });
});

describe("macOS privacy permissions", () => {
  afterAll(() => __setPrivacyProbeForTests(async () => null));

  test("every permission gets a row with what the guide needs, even with computer use off", async () => {
    __setPrivacyProbeForTests(async () => ({ accessibility: false, screenRecording: true, fullDiskAccess: true, fullDiskAccessHere: false }));
    const rows = (await checkPermissions()).permissions.filter((p) => p.privacy);
    expect(rows.map((p) => p.id)).toEqual(["accessibility", "screen-recording", "full-disk-access"]);
    const [ax, sr, fda] = rows;
    expect(ax).toMatchObject({ ok: false, required: false, fix: "request", privacy: { pane: "Accessibility", addManually: false, inUse: false } });
    expect(sr).toMatchObject({ ok: true, fixHint: "", privacy: { pane: "Screen & System Audio Recording" } });
    // Granted for what Godmode starts from now on, but the running core only gets it after a restart.
    expect(fda).toMatchObject({ ok: true, privacy: { pane: "Full Disk Access", addManually: true, restartNeeded: true } });
    expect(fda!.detail).toContain("restart");
  });

  test("a permission computer use needs counts as in use once computer use is on", async () => {
    __setPrivacyProbeForTests(async () => ({ accessibility: false, screenRecording: false, fullDiskAccess: false, fullDiskAccessHere: false }));
    updateSettings({ computer: { enabled: true } });
    try {
      const rows = (await checkPermissions()).permissions.filter((p) => p.privacy);
      expect(rows.find((p) => p.id === "screen-recording")!.privacy!.inUse).toBe(true);
      expect(rows.find((p) => p.id === "full-disk-access")).toMatchObject({ ok: false, privacy: { restartNeeded: false } });
      // The background upkeep never opens a system dialog.
      expect((await fixPermission("screen-recording", { interactive: false })).outcome).toBe("manual");
    } finally {
      updateSettings({ computer: { enabled: false } });
    }
  });

  test("a check that can't answer leaves its row out", async () => {
    __setPrivacyProbeForTests(async () => ({ accessibility: null, screenRecording: null, fullDiskAccess: null, fullDiskAccessHere: null }));
    expect((await checkPermissions()).permissions.filter((p) => p.privacy)).toEqual([]);
  });

  test("the app macOS asks about is Godmode's bundle, or the terminal it runs in", () => {
    const bundle = mkdtempSync(join(tmpdir(), "godmode-host-"));
    const app = join(bundle, "Godmode Bot.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key>\n<string>dev.codext.godmode</string></dict></plist>");
    try {
      const none = () => null;
      expect(hostApp(join(app, "Contents", "MacOS", "godmode-core"), {}, none)).toEqual({ name: "Godmode Bot", path: app, bundleId: "dev.codext.godmode" });
      // Started from source inside Godmode's app: it is still Godmode's entry.
      expect(hostApp("/opt/homebrew/bin/bun", {}, () => app)).toEqual({ name: "Godmode Bot", path: app, bundleId: "dev.codext.godmode" });
      expect(hostApp("/opt/homebrew/bin/bun", {}, () => "/System/Applications/Utilities/Terminal.app")).toMatchObject({ name: "Terminal", bundleId: null });
      expect(hostApp("/opt/homebrew/bin/bun", { __CFBundleIdentifier: "com.apple.Terminal" }, none)).toEqual({ name: "Terminal", path: null, bundleId: null });
      expect(hostApp("/opt/homebrew/bin/bun", { __CFBundleIdentifier: "dev.codext.godmode" }, none)).toEqual({ name: "Godmode Bot", path: null, bundleId: "dev.codext.godmode" });
      expect(hostApp("/opt/homebrew/bin/bun", {}, none).name).toBe("the app that started Godmode");
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  test("Full Disk Access from a new process: refused, allowed, or nothing to try", async () => {
    const home = mkdtempSync(join(tmpdir(), "godmode-fda-"));
    const mail = join(home, "Mail");
    mkdirSync(mail);
    const candidates = [{ path: join(home, "missing.db"), dir: false }, { path: mail, dir: true }];
    const seen: string[][] = [];
    try {
      expect(await probeFullDiskAccessFresh(async (argv) => (seen.push(argv), { code: 1, stderr: `ls: ${mail}: Operation not permitted` }), candidates)).toBe(false);
      expect(seen).toEqual([["/bin/ls", mail]]);
      expect(await probeFullDiskAccessFresh(async () => ({ code: 0, stderr: "" }), candidates)).toBe(true);
      expect(await probeFullDiskAccessFresh(async () => ({ code: 0, stderr: "" }), [{ path: join(home, "nope"), dir: true }])).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
