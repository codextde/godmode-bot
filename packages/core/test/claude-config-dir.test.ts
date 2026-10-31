import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { applyClaudeConfigDir, claudeConfigDir } from "../src/services/claudeUpdate";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { resetSettingsCache } from "../src/services/settings";

let dataDir: string;
const realConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-claude-config-dir-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(() => {
  applyClaudeConfigDir("");
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runner.claudeConfigDir", () => {
  test("an empty setting leaves the inherited folder alone", () => {
    process.env.CLAUDE_CONFIG_DIR = join(dataDir, "inherited");
    expect(applyClaudeConfigDir("")).toBe(false);
    expect(claudeConfigDir()).toBe(join(dataDir, "inherited"));
  });

  test("a folder is applied with ~ expanded, and clearing it restores the inherited one", () => {
    expect(applyClaudeConfigDir("~/.claude-work")).toBe(true);
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude-work"));
    expect(applyClaudeConfigDir("~/.claude-work")).toBe(false);
    expect(applyClaudeConfigDir(join(dataDir, "other"))).toBe(true);
    expect(claudeConfigDir()).toBe(join(dataDir, "other"));
    expect(applyClaudeConfigDir("")).toBe(true);
    expect(claudeConfigDir()).toBe(join(dataDir, "inherited"));
  });

  test("only absolute paths, ~ paths or empty are accepted", () => {
    const check = (claudeConfigDir: unknown) => () => checkSettingsPatch({ runner: { claudeConfigDir } }, () => {});
    expect(check("~/.claude-work")).not.toThrow();
    expect(check("/Users/me/.claude-work")).not.toThrow();
    expect(check("")).not.toThrow();
    expect(check("relative/dir")).toThrow();
    expect(check(42)).toThrow();
  });
});
