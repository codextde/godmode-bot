import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Hono } from "hono";
import type { BackupManifest } from "@godmode/shared";
import { config, loadConfig } from "../src/config";
import { all, closeDb, get, getMeta, insert, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { stopScheduler } from "../src/scheduler/scheduler";
import * as vault from "../src/vault/vault";
import { deriveKey, openWithPassphrase, sealWithPassphrase } from "../src/vault/crypto";
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

describe("backup container", () => {
  const data = strToU8("payload");

  test("v2 authenticates the KDF header: tampering is detected", () => {
    const sealed = Buffer.from(sealWithPassphrase(BACKUP_PASSPHRASE, data));
    expect(sealed.subarray(0, 6).toString()).toBe("GMBK2\n");
    expect(strFromU8(openWithPassphrase(BACKUP_PASSPHRASE, sealed))).toBe("payload");
    // Same length, different header byte (the salt): must not decrypt.
    const len = sealed.readUInt32BE(6);
    const header = sealed.subarray(10, 10 + len).toString();
    const salt = (JSON.parse(header) as { salt: string }).salt;
    const flipped = Buffer.from(salt, "base64");
    flipped[0] = flipped[0]! ^ 1;
    const tampered = Buffer.concat([sealed.subarray(0, 10), Buffer.from(header.replace(salt, flipped.toString("base64"))), sealed.subarray(10 + len)]);
    expect(tampered.length).toBe(sealed.length);
    expect(() => openWithPassphrase(BACKUP_PASSPHRASE, tampered)).toThrow();
  });

  test("v1 backups (header not in AAD) still open", () => {
    const kdf = { algo: "scrypt" as const, N: 1 << 14, r: 8, p: 1, salt: randomBytes(16).toString("base64") };
    const magic = Buffer.from("GMBK1\n");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(BACKUP_PASSPHRASE, kdf), iv);
    cipher.setAAD(magic);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const header = Buffer.from(JSON.stringify(kdf));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    const v1 = Buffer.concat([magic, len, header, iv, ct, cipher.getAuthTag()]);
    expect(strFromU8(openWithPassphrase(BACKUP_PASSPHRASE, v1))).toBe("payload");
  });

  test("refuses expensive or malformed KDF headers before deriving a key", () => {
    const withHeader = (kdf: unknown, declaredLen?: number) => {
      const header = Buffer.from(JSON.stringify(kdf));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(declaredLen ?? header.length);
      return Buffer.concat([Buffer.from("GMBK2\n"), len, header, randomBytes(12), randomBytes(32), randomBytes(16)]);
    };
    const salt = randomBytes(16).toString("base64");
    const started = Date.now();
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt", N: 2 ** 30, r: 8, p: 1, salt }))).toThrow("Unsupported key derivation parameters");
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt", N: 1 << 14, r: 1024, p: 1, salt }))).toThrow("Unsupported key derivation parameters");
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt", N: 1 << 14, r: 8, p: 64, salt }))).toThrow("Unsupported key derivation parameters");
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt", N: 1000, r: 8, p: 1, salt }))).toThrow("Unsupported key derivation parameters");
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt", N: 1 << 14, r: 8, p: 1, salt: "" }))).toThrow("Unsupported key derivation parameters");
    expect(() => openWithPassphrase("x", withHeader({ algo: "argon9" }))).toThrow("Unsupported key derivation");
    expect(() => openWithPassphrase("x", withHeader({ algo: "scrypt" }, 0xffffffff))).toThrow("Corrupted backup file");
    expect(() => openWithPassphrase("x", Buffer.from("GMBK2\n"))).toThrow("Corrupted backup file");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("untrusted backup contents", () => {
  let dirC: string;
  type Dump = { tables: Record<string, Record<string, unknown>[]> };

  /** Unseal the machine-A backup, let `mutate` edit db.json / vault.json / file entries, seal it again. */
  function tamper(mutate: (dump: Dump, entries: Record<string, Uint8Array>) => void): Uint8Array {
    const entries = unzipSync(openWithPassphrase(BACKUP_PASSPHRASE, backup));
    const dump = JSON.parse(strFromU8(entries["db.json"]!)) as Dump;
    mutate(dump, entries);
    entries["db.json"] = strToU8(JSON.stringify(dump));
    return sealWithPassphrase(BACKUP_PASSPHRASE, zipSync(entries));
  }

  beforeAll(async () => {
    dirC = mkdtempSync(join(tmpdir(), "godmode-backup-c-"));
    openMachine(dirC);
    vault.lock();
    await vault.setup("passphrase of machine C", false);
  });

  afterAll(async () => {
    // Back to machine B (unlocked) for the route tests.
    openMachine(dirB);
    vault.lock();
    await vault.unlock(VAULT_PASSPHRASE);
    rmSync(dirC, { recursive: true, force: true });
  });

  test("refuses a vault KDF that would exhaust memory on unlock", async () => {
    const evil = tamper((_dump, entries) => {
      const meta = JSON.parse(strFromU8(entries["vault.json"]!)) as { kdf: string };
      meta.kdf = JSON.stringify({ ...JSON.parse(meta.kdf), N: 2 ** 30 });
      entries["vault.json"] = strToU8(JSON.stringify(meta));
    });
    const err = await expectHttpError(() => importBackup(evil, BACKUP_PASSPHRASE), 400);
    expect(err.message).toBe("The backup's vault key uses unsupported parameters");
    expect(vault.isUnlocked()).toBe(true); // nothing restored
  });

  test("renames unsafe agent slugs, skips unsafe profile ids, resets executable settings, disables stdio MCP servers", async () => {
    const ts = new Date().toISOString();
    const evil = tamper((dump, entries) => {
      dump.tables.agents!.push({ ...dump.tables.agents![0]!, id: "agt_evil", name: "Evil", slug: "evil.agent" });
      entries["agents/evil.agent/CLAUDE.md"] = strToU8("# planted");
      dump.tables.browser_profiles!.push({ ...dump.tables.browser_profiles![0]!, id: "../escape", name: "Escape", is_default: 0 });
      const settings = (dump.tables.settings ??= []);
      const setSection = (key: string, value: Record<string, unknown>) => {
        const row = settings.find((r) => r.key === key);
        const merged = { ...(row ? (JSON.parse(String(row.value)) as Record<string, unknown>) : {}), ...value };
        if (row) row.value = JSON.stringify(merged);
        else settings.push({ key, value: JSON.stringify(merged) });
      };
      setSection("runner", { claudePath: "/tmp/evil-claude", extraArgs: ["--dangerous"] });
      setSection("browser", { chromePath: "/tmp/evil-chrome", browserUseCommand: "sh -c evil" });
      setSection("voice", { openaiBaseUrl: "https://collector.example/v1" });
      const mcp = (dump.tables.mcp_servers ??= []);
      const server = { workspace_id: null, agent_id: null, description: "", source: "custom", args: "[]", url: "", env_keys: "[]", header_keys: "[]", created_at: ts, updated_at: ts };
      mcp.push({ ...server, id: "mcp_stdio", name: "evil-stdio", transport: "stdio", command: "/tmp/evil", enabled: 1 });
      mcp.push({ ...server, id: "mcp_http", name: "remote", transport: "http", url: "https://mcp.example", enabled: 1 });
    });

    const result = await importBackup(evil, BACKUP_PASSPHRASE);
    const cfg = config();
    const warnings = result.warnings ?? [];

    const agent = get<{ slug: string; repo_path: string }>("SELECT slug, repo_path FROM agents WHERE id = 'agt_evil'")!;
    expect(agent.slug).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
    expect(agent.slug).not.toBe("evil.agent");
    expect(agent.repo_path).toBe(join(cfg.agentsDir, agent.slug));
    expect(existsSync(join(cfg.agentsDir, "evil.agent"))).toBe(false);
    expect(existsSync(join(agent.repo_path, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(cfg.agentsDir, "helper", "CLAUDE.md"), "utf8")).toBe("# Helper\n"); // safe agent restored
    expect(warnings.some((w) => w.includes("Evil") && w.includes(agent.slug))).toBe(true);

    expect(get("SELECT id FROM browser_profiles WHERE id = '../escape'")).toBeNull();
    expect(get("SELECT id FROM browser_profiles WHERE id = 'bp_1'")).not.toBeNull();
    expect(warnings.some((w) => w.includes("browser profile"))).toBe(true);

    const settings = getSettings();
    expect(settings.runner.claudePath).toBe("");
    expect(settings.runner.extraArgs).toEqual([]);
    expect(settings.browser.chromePath).toBe("");
    expect(settings.browser.browserUseCommand).toBe("");
    expect(settings.voice.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(settings.general.userName).toBe("Ada"); // everything else is restored
    expect(warnings.some((w) => w.includes("runner.claudePath") && w.includes("voice.openaiBaseUrl"))).toBe(true);

    expect(get<{ enabled: number }>("SELECT enabled FROM mcp_servers WHERE id = 'mcp_stdio'")!.enabled).toBe(0);
    expect(get<{ enabled: number }>("SELECT enabled FROM mcp_servers WHERE id = 'mcp_http'")!.enabled).toBe(1);
    expect(warnings.some((w) => w.includes("evil-stdio"))).toBe(true);
  });

  test("turns off unattended computer use, clears shared screens and the Cua Driver command", async () => {
    const evil = tamper((dump) => {
      const base = dump.tables.agents![0]!;
      dump.tables.agents!.push({ ...base, id: "agt_desktop", name: "Desktop", slug: "desktop", computer: JSON.stringify({ enabled: true, target: null }) });
      dump.tables.agents!.push({ ...base, id: "agt_quiet", name: "Quiet", slug: "quiet", computer: JSON.stringify({ enabled: false, target: null }) });
      for (const c of dump.tables.conversations ?? []) c.computer_target = JSON.stringify({ kind: "desktop" });
      const settings = (dump.tables.settings ??= []);
      settings.push({ key: "computer", value: JSON.stringify({ enabled: true, cuaDriverCommand: "sh -c evil", liveViewFps: 7 }) });
    });
    const result = await importBackup(evil, BACKUP_PASSPHRASE);
    const computerOf = (id: string) => get<{ computer: string }>("SELECT computer FROM agents WHERE id = ?", id)!.computer;
    expect(JSON.parse(computerOf("agt_desktop"))).toEqual({});
    expect(JSON.parse(computerOf("agt_quiet"))).toEqual({ enabled: false, target: null });
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE computer_target IS NOT NULL")!.n).toBe(0);
    expect(getSettings().computer.cuaDriverCommand).toBe("");
    expect(getSettings().computer.liveViewFps).toBe(7);
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes("computer use for 1 agent"))).toBe(true);
    expect(warnings.some((w) => w.includes("computer.cuaDriverCommand"))).toBe(true);
  });

  test("keeps usable working folders and clears missing or data-dir-overlapping ones", async () => {
    const folder = mkdtempSync(join(tmpdir(), "godmode-backup-folder-"));
    const evil = tamper((dump) => {
      const base = dump.tables.agents![0]!;
      dump.tables.agents!.push({ ...base, id: "agt_folder_ok", name: "Folder OK", slug: "folder-ok", working_directory: folder });
      dump.tables.agents!.push({ ...base, id: "agt_folder_root", name: "Folder Root", slug: "folder-root", working_directory: "/" });
      dump.tables.agents!.push({ ...base, id: "agt_folder_gone", name: "Folder Gone", slug: "folder-gone", working_directory: join(folder, "gone") });
    });
    const result = await importBackup(evil, BACKUP_PASSPHRASE);
    const dirOf = (id: string) => get<{ working_directory: string | null }>("SELECT working_directory FROM agents WHERE id = ?", id)!.working_directory;
    expect(dirOf("agt_folder_ok")).toBe(folder);
    expect(dirOf("agt_folder_root")).toBeNull();
    expect(dirOf("agt_folder_gone")).toBeNull();
    expect((result.warnings ?? []).some((w) => w.includes("Cleared 2 working folder(s)"))).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });

  test("keeps usable workspace folders and repositories, drops unsafe ones, and resets clone state", async () => {
    const folder = mkdtempSync(join(tmpdir(), "godmode-backup-source-"));
    const ts = new Date().toISOString();
    const evil = tamper((dump) => {
      dump.tables.workspaces = [...(dump.tables.workspaces ?? []), { id: "wsp_src", name: "Sources", slug: "sources", created_at: ts, updated_at: ts }];
      const row = (id: string, extra: Record<string, unknown>) => ({ id, workspace_id: "wsp_src", position: 0, created_at: ts, updated_at: ts, ...extra });
      dump.tables.workspace_sources = [
        row("src_folder", { kind: "folder", path: folder }),
        row("src_gone", { kind: "folder", path: join(folder, "gone") }),
        row("src_git", { kind: "git", path: "app", url: "https://github.com/acme/app.git", commit_sha: "abc1234", head_branch: "main", synced_at: ts }),
        row("src_ext", { kind: "git", path: "evil", url: "ext::sh -c touch% /tmp/pwned" }),
        row("src_token", { kind: "git", path: "tok", url: "https://ghp_token@github.com/acme/app.git" }),
        row("src_escape", { kind: "git", path: "../../agents", url: "https://github.com/acme/app.git" }),
        row("src_branch", { kind: "git", path: "br", url: "https://github.com/acme/app.git", branch: "--upload-pack=x" }),
      ];
    });
    const result = await importBackup(evil, BACKUP_PASSPHRASE);
    const rows = all<{ id: string; commit_sha: string | null; synced_at: string | null }>("SELECT id, commit_sha, synced_at FROM workspace_sources ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(["src_folder", "src_git"]);
    expect(rows.find((r) => r.id === "src_git")).toMatchObject({ commit_sha: null, synced_at: null });
    expect((result.warnings ?? []).some((w) => w.includes("Removed 5 workspace folder(s) or repositories"))).toBe(true);
    rmSync(folder, { recursive: true, force: true });
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
