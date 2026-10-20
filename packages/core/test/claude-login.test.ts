import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { all, closeDb, getMeta, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import {
  cancelClaudeLogin,
  claudeLoginStatus,
  noteAnthropicKeyChanged,
  noteClaudeSignedOut,
  noteClaudeWorks,
  recheckClaudeSignedOut,
  startClaudeLogin,
  submitClaudeLoginCode,
} from "../src/services/claudeLogin";

let dataDir: string;
let configDir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

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
  configDir = join(dataDir, "claude-config");
  mkdirSync(configDir);
  writeFileSync(join(configDir, ".credentials.json"), "{}");
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
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
    expect(claudeLoginStatus()).toMatchObject({ state: "done", url: null, message: null, signedOut: null });
    expect(claudeLoginStatus().signedInAt).toBeString();
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

  test("a run that finds Claude signed out says so until a run works", async () => {
    await noteClaudeSignedOut({ apiKey: false });
    const out = claudeLoginStatus().signedOut;
    expect(out).toMatchObject({ apiKey: false });
    expect(JSON.parse(getMeta("claude.signed_out")!)).toMatchObject({ at: out!.at, apiKey: false });
    await noteClaudeSignedOut({ apiKey: false });
    expect(claudeLoginStatus().signedOut?.at).toBe(out!.at);
    expect(all("SELECT id FROM notifications WHERE title = 'Claude is signed out'")).toHaveLength(1);
    noteClaudeWorks();
    expect(claudeLoginStatus().signedOut).toBeNull();
    expect(getMeta("claude.signed_out")).toBeNull();
  });

  test("signing in again ends it", async () => {
    await noteClaudeSignedOut({ apiKey: false });
    expect(claudeLoginStatus().signedOut).not.toBeNull();
    startClaudeLogin();
    await until(() => !!claudeLoginStatus().url);
    submitClaudeLoginCode("good-code");
    await until(() => claudeLoginStatus().state !== "waiting");
    expect(claudeLoginStatus()).toMatchObject({ state: "done", signedOut: null });
  });

  test("new credentials (a sign-in in a terminal) end it", async () => {
    await noteClaudeSignedOut({ apiKey: false });
    await recheckClaudeSignedOut();
    expect(claudeLoginStatus().signedOut).not.toBeNull();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(configDir, ".credentials.json"), later, later);
    await recheckClaudeSignedOut();
    expect(claudeLoginStatus().signedOut).not.toBeNull();
    await Bun.sleep(10_050);
    await recheckClaudeSignedOut();
    expect(claudeLoginStatus().signedOut).toBeNull();
  }, 20_000);

  test("a failure from before the last sign-in is old news", async () => {
    const before = performance.now();
    startClaudeLogin();
    await until(() => !!claudeLoginStatus().url);
    submitClaudeLoginCode("good-code");
    await until(() => claudeLoginStatus().state !== "waiting");
    await noteClaudeSignedOut({ apiKey: false, since: before });
    expect(claudeLoginStatus().signedOut).toBeNull();
    await noteClaudeSignedOut({ apiKey: false, since: performance.now() });
    expect(claudeLoginStatus().signedOut).not.toBeNull();
    noteClaudeWorks();
  });

  test("a refused API key: a new key ends it, signing in doesn't apply", async () => {
    await noteClaudeSignedOut({ apiKey: true });
    expect(claudeLoginStatus().signedOut?.apiKey).toBe(true);
    expect(all("SELECT id FROM notifications WHERE title = 'Claude refused the API key'")).toHaveLength(1);
    noteAnthropicKeyChanged();
    expect(claudeLoginStatus().signedOut).toBeNull();
  });
});
