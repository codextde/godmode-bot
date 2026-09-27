import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { Hono } from "hono";
import type { BackupManifest } from "@godmode/shared";
import { config, loadConfig } from "../src/config";
import { closeDb, get, getMeta, insert, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { stopScheduler } from "../src/scheduler/scheduler";
import * as vault from "../src/vault/vault";
import { openWithPassphrase } from "../src/vault/crypto";
import { exportBackup, importBackup } from "../src/backup/backup";
import { registerBackupRoutes } from "../src/server/routes/backup";
import { HttpError } from "../src/util";

const VAULT_PASSPHRASE = "vault passphrase of machine A";
const BACKUP_PASSPHRASE = "backup passphrase 123";
const PASSWORD = "hunter2-very-secret";

let dirA: string;
let dirB: string;
let backup: Uint8Array;
let filename: string;

function openMachine(dataDir: string) {
  closeDb();
  loadConfig({ dataDir });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
}

async function expectHttpError(fn: () => unknown, status: number): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}`);
}

beforeAll(async () => {
  setLogLevel("error");
  dirA = mkdtempSync(join(tmpdir(), "godmode-backup-a-"));
  dirB = mkdtempSync(join(tmpdir(), "godmode-backup-b-"));

  /* ---- machine A: seed data ---- */
  openMachine(dirA);
  vault.lock();
  await vault.setup(VAULT_PASSPHRASE, false);
  const ts = new Date().toISOString();
  const cfg = config();
  insert("workspaces", { id: "ws_1", name: "Ops", slug: "ops", created_at: ts, updated_at: ts });
  const repo = join(cfg.agentsDir, "helper");
  insert("agents", { id: "agt_1", workspace_id: "ws_1", name: "Helper", slug: "helper", repo_path: repo, created_at: ts, updated_at: ts });
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(repo, "memory"), { recursive: true });
  mkdirSync(join(repo, "workspace"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "# Helper\n");
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".git", "refs", "heads", "main"), "0123456789abcdef\n");
  writeFileSync(join(repo, "memory", "note.md"), "remember this");

  insert("credentials", {
    id: "cred_1",
    workspace_id: "ws_1",
    name: "GitHub",
    username: "ada",
    password_enc: vault.seal(PASSWORD, "credentials.password:cred_1"),
    created_at: ts,
    updated_at: ts,
  });
  vault.setAppSecret("openai_api_key", "sk-test-openai-key");

  const profileDir = join(cfg.browserDir, "bp_1");
  insert("browser_profiles", { id: "bp_1", name: "Default", user_data_dir: profileDir, is_default: 1, created_at: ts, updated_at: ts });
  mkdirSync(join(profileDir, "Default", "Cache"), { recursive: true });
  writeFileSync(join(profileDir, "Default", "Cookies"), "cookie-db");
  writeFileSync(join(profileDir, "Default", "Cache", "data_0"), "cached");
  writeFileSync(join(profileDir, "SingletonLock"), "lock");

  insert("sessions", { id: "ses_1", token_hash: "h", created_at: ts, expires_at: ts });
  setMeta("auth.dashboard_password", "hash-of-machine-A");
  updateSettings({ general: { userName: "Ada" }, server: { port: 9999 } });
});

afterAll(() => {
  stopScheduler();
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe("export", () => {
  test("rejects short passphrases", async () => {
    await expectHttpError(() => exportBackup({ passphrase: "short" }), 400);
  });

  test("produces an encrypted archive with db, vault and files", async () => {
    const result = await exportBackup({ passphrase: BACKUP_PASSPHRASE, includeAgentRepos: true, includeBrowserProfiles: true });
    backup = result.data;
    filename = result.filename;
    expect(filename).toMatch(/^godmode-backup-\d{8}-\d{4}\.godmode-backup$/);
    expect(existsSync(join(config().backupsDir, filename))).toBe(true);
    expect(Buffer.from(backup).includes(Buffer.from(PASSWORD))).toBe(false);

    const entries = unzipSync(openWithPassphrase(BACKUP_PASSPHRASE, backup));
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as BackupManifest;
    expect(manifest).toMatchObject({ format: "godmode-backup", version: 1 });
    expect(manifest.counts).toMatchObject({ agents: 1, credentials: 1, agentRepos: 1, browserProfiles: 1 });

    const db = strFromU8(entries["db.json"]!);
    expect(db).not.toContain(PASSWORD); // encrypted columns stay encrypted
    const tables = (JSON.parse(db) as { tables: Record<string, Record<string, unknown>[]> }).tables;
    expect(tables.sessions).toBeUndefined();
    expect(tables._migrations).toBeUndefined();
    expect(tables.meta!.some((r) => String(r.key).startsWith("auth.") || r.key === "vault.wrapped_dek")).toBe(false);
    expect(tables.settings!.some((r) => r.key === "server")).toBe(false);
    expect(JSON.parse(strFromU8(entries["vault.json"]!))).toMatchObject({ kdf: expect.any(String), wrappedDek: expect.any(String) });

    expect(strFromU8(entries["agents/helper/CLAUDE.md"]!)).toBe("# Helper\n");
    expect(entries["agents/helper/.git/HEAD"]).toBeDefined();
    expect(entries["agents/helper/workspace/"]).toBeDefined(); // empty dir marker
    expect(entries["browser/bp_1/Default/Cookies"]).toBeDefined();
    expect(entries["browser/bp_1/Default/Cache/data_0"]).toBeUndefined();
    expect(entries["browser/bp_1/SingletonLock"]).toBeUndefined();
  });

  test("keeps only the latest export in the backups dir", async () => {
    const stale = join(config().backupsDir, "godmode-backup-20000101-0000.godmode-backup");
    writeFileSync(stale, "old");
    await exportBackup({ passphrase: BACKUP_PASSPHRASE, includeAgentRepos: false });
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(config().backupsDir).filter((n) => n.endsWith(".godmode-backup"))).toHaveLength(1);
  });
});

describe("import on another machine", () => {
  beforeAll(async () => {
    openMachine(dirB);
    vault.lock();
    await vault.setup("a different passphrase for B", false);
    setMeta("auth.dashboard_password", "hash-of-machine-B");
    updateSettings({ general: { userName: "Bob" } });
    mkdirSync(join(config().agentsDir, "old-agent"), { recursive: true });
    writeFileSync(join(config().agentsDir, "old-agent", "keep.txt"), "old");
  });

  test("wrong passphrase / garbage → 400", async () => {
    const err = await expectHttpError(() => importBackup(backup, "wrong passphrase!"), 400);
    expect(err.message).toBe("Wrong backup passphrase or corrupted file");
    await expectHttpError(() => importBackup(new TextEncoder().encode("hello"), BACKUP_PASSPHRASE), 400);
    // Nothing changed.
    expect(vault.isUnlocked()).toBe(true);
    expect(getSettings().general.userName).toBe("Bob");
  });

  test("restores data, rewrites paths, locks the vault, keeps device settings", async () => {
    const result = await importBackup(backup, BACKUP_PASSPHRASE);
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ agents: 1, credentials: 1, workspaces: 1, agentRepos: 1, browserProfiles: 1 });

    const status = vault.status();
    expect(status).toMatchObject({ initialized: true, unlocked: false, rememberDevice: false });
    await expectHttpError(() => vault.unlock("a different passphrase for B"), 400);
    await vault.unlock(VAULT_PASSPHRASE);

    const cred = get<{ password_enc: string }>("SELECT password_enc FROM credentials WHERE id = 'cred_1'")!;
    expect(vault.open(cred.password_enc, "credentials.password:cred_1")).toBe(PASSWORD);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-openai-key");

    const cfg = config();
    const agent = get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE id = 'agt_1'")!;
    expect(agent.repo_path).toBe(join(cfg.agentsDir, "helper"));
    expect(readFileSync(join(agent.repo_path, "CLAUDE.md"), "utf8")).toBe("# Helper\n");
    expect(readFileSync(join(agent.repo_path, ".git", "refs", "heads", "main"), "utf8")).toBe("0123456789abcdef\n");
    expect(readFileSync(join(agent.repo_path, "memory", "note.md"), "utf8")).toBe("remember this");
    expect(statSync(join(agent.repo_path, "workspace")).isDirectory()).toBe(true);

    // Previous content of the agents dir is moved aside, not deleted.
    expect(existsSync(join(cfg.agentsDir, "old-agent"))).toBe(false);
    const trash = readdirSync(join(cfg.agentsDir, ".trash"));
    expect(trash).toHaveLength(1);
    expect(readFileSync(join(cfg.agentsDir, ".trash", trash[0]!, "old-agent", "keep.txt"), "utf8")).toBe("old");

    const profile = get<{ user_data_dir: string }>("SELECT user_data_dir FROM browser_profiles WHERE id = 'bp_1'")!;
    expect(profile.user_data_dir).toBe(join(cfg.browserDir, "bp_1"));
    expect(readFileSync(join(profile.user_data_dir, "Default", "Cookies"), "utf8")).toBe("cookie-db");

    const settings = getSettings();
    expect(settings.general.userName).toBe("Ada");
    expect(settings.server.port).not.toBe(9999); // device-specific section kept from machine B
    expect(getMeta("auth.dashboard_password")).toBe("hash-of-machine-B");
    expect(get("SELECT id FROM audit_log WHERE action = 'backup.import'")).not.toBeNull();
  });
});

describe("routes", () => {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    return c.json({ error: String(err) }, 500);
  });
  registerBackupRoutes(app);

  test("export streams an attachment; import accepts multipart", async () => {
    let res = await app.request("/api/backup/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: BACKUP_PASSPHRASE, includeAgentRepos: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="godmode-backup-\d{8}-\d{4}\.godmode-backup"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());

    res = await app.request("/api/backup/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "short" }),
    });
    expect(res.status).toBe(400);

    const wrong = new FormData();
    wrong.set("file", new File([bytes], "backup.godmode-backup"));
    wrong.set("passphrase", "not the passphrase");
    res = await app.request("/api/backup/import", { method: "POST", body: wrong });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Wrong backup passphrase or corrupted file");

    const form = new FormData();
    form.set("file", new File([bytes], "backup.godmode-backup"));
    form.set("passphrase", BACKUP_PASSPHRASE);
    res = await app.request("/api/backup/import", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, counts: { agents: 1 } });
    expect(vault.status().unlocked).toBe(false);

    res = await app.request("/api/backup/import", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});
