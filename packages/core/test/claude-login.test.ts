import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { cancelClaudeLogin, claudeLoginStatus, startClaudeLogin, submitClaudeLoginCode } from "../src/services/claudeLogin";

let dataDir: string;

const FAKE_CLAUDE = `#!/bin/sh
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
printf "Paste code here if prompted > "
read code
if [ "$code" = "good-code" ]; then echo "Login successful."; exit 0; fi
echo "OAuth error: Invalid code" >&2
exit 1
`;

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-claude-login-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  const bin = join(dataDir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  updateSettings({ runner: { claudePath: bin } } as never);
});

afterAll(() => {
  cancelClaudeLogin();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("claude login", () => {
  test("shows the sign-in link and finishes with the pasted code", async () => {
    expect(startClaudeLogin().state).toBe("waiting");
    await until(() => !!claudeLoginStatus().url);
    expect(claudeLoginStatus().url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
    expect(startClaudeLogin().state).toBe("waiting");
    submitClaudeLoginCode("good-code");
    await until(() => claudeLoginStatus().state !== "waiting");
    expect(claudeLoginStatus()).toEqual({ state: "done", url: null, message: null });
  });

  test("a wrong code fails with the CLI's message", async () => {
    startClaudeLogin();
    await until(() => !!claudeLoginStatus().url);
    submitClaudeLoginCode("bad");
    await until(() => claudeLoginStatus().state !== "waiting");
    expect(claudeLoginStatus().state).toBe("failed");
    expect(claudeLoginStatus().message).toContain("Invalid code");
  });

  test("cancel stops a waiting sign-in", async () => {
    startClaudeLogin();
    await until(() => !!claudeLoginStatus().url);
    expect(cancelClaudeLogin().state).toBe("idle");
    expect(claudeLoginStatus().state).toBe("idle");
  });
});
