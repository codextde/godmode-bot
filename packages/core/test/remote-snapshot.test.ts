import { afterAll, beforeAll, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { ensureDefaultAgent, listAgentCommits } from "../src/agents/service";
import { ensureDefaultProfile } from "../src/browser/manager";
import { config, loadConfig } from "../src/config";
import { all, closeDb, get, getMeta, insert, openDb, run as sql } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import type { MemorySnapshot } from "../src/memory/files";
import { mergeMemory, readMemoryState, writeMemoryState } from "../src/remote/memorySync";
import { appliedDigest, applySnapshot, buildSnapshot, snapshotDigest, type ConfigSnapshot } from "../src/remote/snapshot";
import * as runner from "../src/runner/runner";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { HttpError } from "../src/util";
import { randomKey } from "../src/vault/crypto";
import * as vault from "../src/vault/vault";

const VAULT_PASSPHRASE = "vault passphrase of the controller";
const PASSWORD = "hunter2-very-secret";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const TS = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";
const MIRRORED = [
  "workspaces",
  "projects",
  "agents",
  "credentials",
  "totp",
  "secrets",
  "mcp_servers",
  "composio_connections",
  "api_tools",
  "ssh_servers",
  "mods",
  "browser_profiles",
  "workspace_sources",
  "vms",
];

/** Agents the tests pretend are working (the real list is passed through, so other test files are not affected). */
const working: string[] = [];
const realRunner = { ...runner };
mock.module("../src/runner/runner", () => ({
  ...realRunner,
  listActiveRuns: () => [
    ...realRunner.listActiveRuns(),
    ...working.map((agentId) => ({
      runId: `run_of_${agentId}`,
      agentId,
      conversationId: "cnv_working",
      status: "running" as const,
      parentRunId: null,
      trigger: "chat" as const,
    })),
  ],
}));

let controller: string;
let runnerDir: string;
/** A second runner that never gets the vault key. */
let lockedRunner: string;
/** A third runner whose own default agent is working when the first setup arrives. */
let busyRunner: string;
/** A folder both computers have. */
let shared: string;
/** The controller's setup as the fresh runner first received it. */
let first: ConfigSnapshot;
let keychain: Mock<typeof Bun.secrets.set>;

/** One process plays both computers: point the core at the other one's data directory. */
function use(dataDir: string) {
  closeDb();
  loadConfig({ dataDir });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
}

function row(table: string, id: string): Record<string, unknown> {
  return get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${table === "secrets" ? "key" : "id"} = ?`, id)!;
}

function exists(table: string, id: string): boolean {
  return get(`SELECT 1 FROM ${table} WHERE ${table === "secrets" ? "key" : "id"} = ?`, id) !== null;
}

/** Everything a sync may write, to prove that one didn't. */
function state(): unknown {
  return {
    tables: Object.fromEntries(MIRRORED.map((t) => [t, all(`SELECT * FROM ${t} ORDER BY 1`)])),
    settings: all("SELECT * FROM settings ORDER BY key"),
    chats: all("SELECT * FROM conversations ORDER BY id"),
    vault: vault.vaultMetaForBackup(),
    digest: appliedDigest(),
  };
}

/** Make a change on the controller and bring the runner up to date. */
async function sync(change: () => void): Promise<{ digest: string; warnings: string[] }> {
  use(controller);
  change();
  const snapshot = buildSnapshot();
  use(runnerDir);
  return applySnapshot(snapshot);
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected a rejection");
}

beforeAll(async () => {
  setLogLevel("error");
  // Remembering the vault key must never reach the real keychain of the computer the tests run on.
  keychain = spyOn(Bun.secrets, "set").mockRejectedValue(new Error("no keychain in tests"));
  controller = mkdtempSync(join(tmpdir(), "godmode-snapshot-controller-"));
  runnerDir = mkdtempSync(join(tmpdir(), "godmode-snapshot-runner-"));
  lockedRunner = mkdtempSync(join(tmpdir(), "godmode-snapshot-locked-"));
  busyRunner = mkdtempSync(join(tmpdir(), "godmode-snapshot-busy-"));
  shared = mkdtempSync(join(tmpdir(), "godmode-snapshot-folder-"));

  use(controller);
  vault.lock();
  await vault.setup(VAULT_PASSPHRASE, false);
  const cfg = config();
  const stamps = { created_at: TS, updated_at: TS };
  insert("workspaces", { id: "ws_ops", name: "Ops", slug: "ops", description: "Operations", ...stamps });
  insert("vms", {
    id: "vm_abcd1234",
    name: "Sandbox",
    image: "ghcr.io/example/macos",
    cpu: 4,
    memory_mb: 8192,
    disk_gb: 50,
    display: "1920x1080",
    provisioned_at: TS,
    ...stamps,
  });
  insert("agents", { id: "agt_main", name: "Godmode", slug: "godmode", is_default: 1, repo_path: join(cfg.agentsDir, "godmode"), ...stamps });
  insert("agents", {
    id: "agt_helper",
    workspace_id: "ws_ops",
    name: "Helper",
    slug: "helper",
    instructions: "Answer briefly.",
    working_directory: shared,
    status: "running",
    last_run_at: TS,
    repo_path: join(cfg.agentsDir, "helper"),
    ...stamps,
  });
  insert("agents", {
    id: "agt_lost",
    name: "Lost",
    slug: "lost",
    working_directory: "/nonexistent/godmode-snapshot-test",
    repo_path: join(cfg.agentsDir, "lost"),
    ...stamps,
  });
  insert("credentials", {
    id: "cred_github",
    workspace_id: "ws_ops",
    name: "GitHub",
    username: "ada",
    password_enc: vault.seal(PASSWORD, "credentials.password:cred_github"),
    last_used_at: TS,
    ...stamps,
  });
  insert("credentials", { id: "cred_old", name: "Old service", username: "ada", ...stamps });
  insert("totp", {
    id: "totp_github",
    issuer: "GitHub",
    secret_enc: vault.seal(TOTP_SECRET, "totp.secret:totp_github"),
    credential_id: "cred_github",
    last_used_at: TS,
    ...stamps,
  });
  vault.setAppSecret("openai_api_key", "sk-test-openai-key");
  insert("mcp_servers", {
    id: "mcp_notes",
    agent_id: "agt_helper",
    name: "Notes",
    command: "notes-mcp",
    env_enc: vault.seal('{"TOKEN":"mcp-token-123"}', "mcp_servers.env:mcp_notes"),
    ...stamps,
  });
  insert("composio_connections", { id: "cmp_github", connected_account_id: "ca_1", toolkit: "github", user_id: "user_1", status: "ACTIVE", ...stamps });
  insert("api_tools", {
    id: "api_weather",
    name: "Weather",
    base_url: "https://api.example.com",
    key_enc: vault.seal("weather-key-123", "api_tools.key:api_weather"),
    last_used_at: TS,
    ...stamps,
  });
  insert("ssh_servers", {
    id: "ssh_box",
    name: "Box",
    host: "box.example.com",
    username: "root",
    password_enc: vault.seal("ssh-password-1", "ssh_servers.password:ssh_box"),
    last_connected_at: TS,
    last_error: "timed out",
    ...stamps,
  });
  insert("mods", {
    id: "mod_guard",
    name: "guard",
    title: "Guard",
    files: '{".claude-plugin/plugin.json":"{\\"name\\":\\"guard\\"}"}',
    enabled: 1,
    check_report: '{"ok":true}',
    check_key: "this computer's Claude Code",
    ...stamps,
  });
  insert("browser_profiles", {
    id: "bp_main",
    name: "Default",
    user_data_dir: join(cfg.browserDir, "bp_main"),
    is_default: 1,
    cookie_count: 12,
    imported_from: "Chrome",
    imported_at: TS,
    ...stamps,
  });
  insert("workspace_sources", {
    id: "src_site",
    workspace_id: "ws_ops",
    kind: "git",
    path: "site",
    url: "https://example.com/site.git",
    commit_sha: "abc123",
    synced_at: TS,
    ...stamps,
  });
  insert("workspace_sources", { id: "src_folder", workspace_id: "ws_ops", kind: "folder", path: shared, ...stamps });
  updateSettings({
    general: { theme: "dark" },
    runner: { claudePath: "/controller/bin/claude", extraArgs: ["--controller"], model: "claude-test-model" },
    browser: { chromePath: "/controller/Chrome" },
    voice: { openaiBaseUrl: "https://controller.example/v1" },
    security: { autoLockMinutes: 15 },
    server: { port: 9999 },
    diagnostics: { verbose: true },
  });
});

afterAll(() => {
  vault.lock();
  closeDb();
  resetSettingsCache();
  keychain.mockRestore();
  for (const dir of [controller, runnerDir, lockedRunner, busyRunner, shared]) rmSync(dir, { recursive: true, force: true });
});

describe("building a snapshot", () => {
  test("carries the digest snapshotDigest reports, and the same setup always has the same digest", () => {
    const snapshot = buildSnapshot();
    expect(snapshot.v).toBe(1);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotDigest()).toBe(snapshot.digest);
    expect(buildSnapshot().digest).toBe(snapshot.digest);
  });

  test("leaves out what belongs to this computer", () => {
    const snapshot = buildSnapshot();
    expect(Object.keys(snapshot.tables).sort()).toEqual([...MIRRORED].sort());
    const helper = snapshot.tables.agents!.find((r) => r.id === "agt_helper")!;
    expect(helper).toMatchObject({ slug: "helper", instructions: "Answer briefly.", working_directory: shared });
    for (const column of ["repo_path", "status", "last_run_at"]) expect(helper).not.toHaveProperty(column);
    expect(snapshot.tables.credentials![0]).not.toHaveProperty("last_used_at");
    // What a computer's own Claude Code says about a mod stays with that computer.
    expect(snapshot.tables.mods![0]).toMatchObject({ name: "guard", enabled: 1 });
    expect(snapshot.tables.mods![0]).not.toHaveProperty("check_report");
    expect(snapshot.tables.mods![0]).not.toHaveProperty("check_key");
    expect(snapshot.tables.browser_profiles![0]).not.toHaveProperty("user_data_dir");
    expect(snapshot.tables.browser_profiles![0]).not.toHaveProperty("cookie_count");
    // Folders are paths on this computer; repositories can be cloned anywhere.
    expect(snapshot.tables.workspace_sources!.map((r) => r.id)).toEqual(["src_site"]);
    expect(snapshot.tables.workspace_sources![0]).not.toHaveProperty("commit_sha");

    expect(Object.keys(snapshot.settings).sort()).toEqual(["browser", "computer", "general", "memory", "runner", "security", "vm", "voice"]);
    expect(snapshot.settings.runner).toMatchObject({ model: "claude-test-model" });
    expect(snapshot.settings.runner).not.toHaveProperty("claudePath");
    expect(snapshot.settings.runner).not.toHaveProperty("extraArgs");
    expect(snapshot.settings.browser).not.toHaveProperty("chromePath");
    expect(snapshot.settings.voice).not.toHaveProperty("openaiBaseUrl");

    // Sealed values travel sealed; the key travels next to them (the link encrypts everything).
    expect(JSON.stringify(snapshot.tables)).not.toContain(PASSWORD);
    expect(Buffer.from(snapshot.vault.dek!, "base64")).toHaveLength(32);
    expect(snapshot.vault).toMatchObject({ kdf: expect.any(String), wrappedDek: expect.any(String), canary: expect.any(String) });
  });

  test("the digest ignores when a login was last used", () => {
    const before = snapshotDigest();
    sql("UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE id = 'cred_github'", LATER, LATER);
    sql("UPDATE agents SET status = 'error', last_run_at = ? WHERE id = 'agt_helper'", LATER);
    sql("UPDATE browser_profiles SET cookie_count = 99 WHERE id = 'bp_main'");
    expect(snapshotDigest()).toBe(before);

    sql("UPDATE credentials SET username = 'grace' WHERE id = 'cred_github'");
    expect(snapshotDigest()).not.toBe(before);
    sql("UPDATE credentials SET username = 'ada' WHERE id = 'cred_github'");
    expect(snapshotDigest()).toBe(before);
  });

  test("a locked vault sends no key, and locking doesn't change the digest", async () => {
    const unlocked = buildSnapshot();
    vault.lock();
    const locked = buildSnapshot();
    expect(locked.vault.dek).toBeNull();
    expect(locked.vault.wrappedDek).toBe(unlocked.vault.wrappedDek);
    expect(locked.digest).toBe(unlocked.digest);
    await vault.unlock(VAULT_PASSPHRASE);
  });
});

describe("applying a snapshot on a runner", () => {
  test("a fresh runner with its own default agent accepts the controller's setup", async () => {
    use(controller);
    first = buildSnapshot();

    // A runner's first start: its own default agent and browser profile, and the programs found on that computer.
    use(runnerDir);
    vault.lock();
    ensureDefaultProfile();
    const own = await ensureDefaultAgent();
    expect(own.slug).toBe("godmode");
    expect(own.id).not.toBe("agt_main");
    updateSettings({
      runner: { claudePath: "/runner/bin/claude", extraArgs: ["--runner"] },
      browser: { chromePath: "/runner/Chrome" },
      server: { port: 7001 },
    });
    expect(appliedDigest()).toBeNull();

    const result = await applySnapshot(first);
    expect(result).toEqual({ digest: first.digest, warnings: [] });
    expect(appliedDigest()).toBe(first.digest);

    expect(exists("agents", own.id)).toBe(false);
    expect(all<{ id: string }>("SELECT id FROM agents WHERE is_default = 1")).toEqual([{ id: "agt_main" }]);
    expect(row("agents", "agt_main")).toMatchObject({ slug: "godmode", repo_path: join(runnerDir, "agents", "godmode") });
    // The repository of the runner's own agent was put aside, and the controller's agent got a new one.
    expect(readdirSync(join(runnerDir, "agents", ".trash")).some((name) => name.startsWith("godmode-"))).toBe(true);
    expect(JSON.parse(readFileSync(join(runnerDir, "agents", "godmode", "state", "agent.json"), "utf8"))).toMatchObject({ id: "agt_main" });
    expect(all<{ id: string }>("SELECT id FROM browser_profiles")).toEqual([{ id: "bp_main" }]);
  });

  test("every mirrored table arrives with the controller's values and the runner's own paths", () => {
    const expected = structuredClone(first.tables);
    // That folder doesn't exist on the runner.
    expected.agents!.find((r) => r.id === "agt_lost")!.working_directory = null;
    expect(buildSnapshot().tables).toEqual(expected);
    expect(row("agents", "agt_helper")).toMatchObject({ working_directory: shared, workspace_id: "ws_ops" });

    expect(row("agents", "agt_helper")).toMatchObject({ repo_path: join(runnerDir, "agents", "helper"), status: "idle", last_run_at: null });
    expect(row("browser_profiles", "bp_main")).toMatchObject({
      user_data_dir: join(runnerDir, "browser", "bp_main"),
      cookie_count: 0,
      imported_from: null,
      imported_at: null,
    });
    expect(row("credentials", "cred_github").last_used_at).toBeNull();
    expect(row("ssh_servers", "ssh_box")).toMatchObject({ last_connected_at: null, last_error: null });
    expect(row("mods", "mod_guard")).toMatchObject({ name: "guard", enabled: 1, check_report: null, check_key: null });
    expect(row("vms", "vm_abcd1234").provisioned_at).toBeNull();
    expect(row("workspace_sources", "src_site")).toMatchObject({ commit_sha: null, synced_at: null });
    expect(exists("workspace_sources", "src_folder")).toBe(false);

    for (const slug of ["godmode", "helper", "lost"]) {
      expect(existsSync(join(runnerDir, "agents", slug, ".git"))).toBe(true);
    }
    expect(readFileSync(join(runnerDir, "agents", "helper", "CLAUDE.md"), "utf8")).toContain("Answer briefly.");
  });

  test("a sealed login opens with the adopted key, also after the runner restarted", async () => {
    expect(vault.status()).toMatchObject({ initialized: true, unlocked: true, rememberDevice: true });
    expect(getMeta("vault.remember_method")).toBe("file");
    expect(vault.vaultMetaForBackup()).toEqual({ kdf: first.vault.kdf, wrappedDek: first.vault.wrappedDek, canary: first.vault.canary });
    expect(vault.open(row("credentials", "cred_github").password_enc as string, "credentials.password:cred_github")).toBe(PASSWORD);
    expect(vault.open(row("totp", "totp_github").secret_enc as string, "totp.secret:totp_github")).toBe(TOTP_SECRET);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-openai-key");
    expect(vault.open(row("ssh_servers", "ssh_box").password_enc as string, "ssh_servers.password:ssh_box")).toBe("ssh-password-1");
    // The runner knows the copied secrets, so it keeps them out of its own logs and transcripts.
    expect(vault.withoutSecrets(`the password is ${PASSWORD}`)).not.toContain(PASSWORD);

    // Remembered on the runner (in these tests in its data directory, never in the real keychain).
    expect(getMeta("vault.remember_method")).toBe("file");
    vault.lock();
    expect(await vault.tryAutoUnlock()).toBe(true);
    expect(vault.open(row("credentials", "cred_github").password_enc as string, "credentials.password:cred_github")).toBe(PASSWORD);
  });

  test("settings arrive, but the programs to run and where the runner listens stay its own", () => {
    const settings = getSettings();
    expect(settings.general.theme).toBe("dark");
    expect(settings.runner.model).toBe("claude-test-model");
    expect(settings.runner.claudePath).toBe("/runner/bin/claude");
    expect(settings.runner.extraArgs).toEqual(["--runner"]);
    expect(settings.browser.chromePath).toBe("/runner/Chrome");
    // Never set on the runner: its default, not the controller's endpoint.
    expect(settings.voice.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(settings.server.port).toBe(7001);
    expect(settings.diagnostics.verbose).toBe(false);
    expect(settings.onboardingComplete).toBe(true);
    // Nobody could unlock a runner's vault again: it doesn't lock itself.
    expect(settings.security.autoLockMinutes).toBe(0);
    expect(vault.status().autoLockMinutes).toBe(0);
  });

  test("applying the same snapshot again changes nothing", async () => {
    const before = state();
    const claudeMd = readFileSync(join(runnerDir, "agents", "helper", "CLAUDE.md"), "utf8");
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    const result = await applySnapshot(first);
    off();
    expect(result).toEqual({ digest: first.digest, warnings: [] });
    expect(state()).toEqual(before);
    expect(events).toEqual([]);
    expect(readFileSync(join(runnerDir, "agents", "helper", "CLAUDE.md"), "utf8")).toBe(claudeMd);
  });

  test("a login deleted on the controller disappears while the runner's chats and runs stay", async () => {
    insert("conversations", { id: "cnv_runner", agent_id: "agt_helper", title: "Started on the runner", created_at: TS, updated_at: TS });
    insert("messages", { id: "msg_runner", conversation_id: "cnv_runner", role: "user", content: "Check the build", created_at: TS });
    insert("runs", {
      id: "run_runner",
      agent_id: "agt_helper",
      conversation_id: "cnv_runner",
      trigger: "chat",
      status: "succeeded",
      prompt: "Check the build",
      created_at: TS,
    });

    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    const result = await sync(() => sql("DELETE FROM credentials WHERE id = 'cred_old'"));
    off();
    expect(result.warnings).toEqual([]);
    expect(result.digest).not.toBe(first.digest);
    expect(exists("credentials", "cred_old")).toBe(false);
    expect(exists("credentials", "cred_github")).toBe(true);
    expect(events).toEqual([{ type: "entity.changed", entity: "credentials" }]);

    expect(row("conversations", "cnv_runner")).toMatchObject({ agent_id: "agt_helper", title: "Started on the runner" });
    expect(row("messages", "msg_runner")).toMatchObject({ content: "Check the build" });
    expect(row("runs", "run_runner")).toMatchObject({ status: "succeeded" });
  });

  test("what the runner tracks about itself survives an update from the controller", async () => {
    sql("UPDATE agents SET status = 'running', last_run_at = ? WHERE id = 'agt_helper'", LATER);
    sql("UPDATE credentials SET last_used_at = ? WHERE id = 'cred_github'", LATER);
    sql("UPDATE totp SET last_used_at = ? WHERE id = 'totp_github'", LATER);
    sql("UPDATE api_tools SET last_used_at = ? WHERE id = 'api_weather'", LATER);
    sql("UPDATE ssh_servers SET last_connected_at = ?, last_error = 'refused' WHERE id = 'ssh_box'", LATER);
    sql("UPDATE browser_profiles SET cookie_count = 42, imported_from = 'Chrome on the runner', imported_at = ? WHERE id = 'bp_main'", LATER);
    sql("UPDATE workspace_sources SET commit_sha = 'def456', head_branch = 'main', synced_at = ? WHERE id = 'src_site'", LATER);
    sql("UPDATE vms SET provisioned_at = ?, last_started_at = ? WHERE id = 'vm_abcd1234'", LATER, LATER);

    const result = await sync(() => {
      sql("UPDATE agents SET instructions = 'Answer in detail.', updated_at = ? WHERE id = 'agt_helper'", LATER);
      sql("UPDATE credentials SET username = 'grace' WHERE id = 'cred_github'");
      sql("UPDATE totp SET issuer = 'GitHub Inc' WHERE id = 'totp_github'");
      sql("UPDATE api_tools SET base_url = 'https://api.example.org' WHERE id = 'api_weather'");
      sql("UPDATE ssh_servers SET host = 'box.example.org' WHERE id = 'ssh_box'");
      sql("UPDATE browser_profiles SET name = 'Main' WHERE id = 'bp_main'");
      sql("UPDATE workspace_sources SET branch = 'release' WHERE id = 'src_site'");
      sql("UPDATE vms SET name = 'Sandbox 2' WHERE id = 'vm_abcd1234'");
    });
    expect(result.warnings).toEqual([]);

    expect(row("agents", "agt_helper")).toMatchObject({
      instructions: "Answer in detail.",
      updated_at: LATER,
      status: "running",
      last_run_at: LATER,
      repo_path: join(runnerDir, "agents", "helper"),
    });
    expect(row("credentials", "cred_github")).toMatchObject({ username: "grace", last_used_at: LATER });
    expect(row("totp", "totp_github")).toMatchObject({ issuer: "GitHub Inc", last_used_at: LATER });
    expect(row("api_tools", "api_weather")).toMatchObject({ base_url: "https://api.example.org", last_used_at: LATER });
    expect(row("ssh_servers", "ssh_box")).toMatchObject({ host: "box.example.org", last_connected_at: LATER, last_error: "refused" });
    expect(row("browser_profiles", "bp_main")).toMatchObject({
      name: "Main",
      cookie_count: 42,
      imported_from: "Chrome on the runner",
      imported_at: LATER,
      user_data_dir: join(runnerDir, "browser", "bp_main"),
    });
    expect(row("workspace_sources", "src_site")).toMatchObject({ branch: "release", commit_sha: "def456", head_branch: "main", synced_at: LATER });
    expect(row("vms", "vm_abcd1234")).toMatchObject({ name: "Sandbox 2", provisioned_at: LATER, last_started_at: LATER });
    // The agent works from its CLAUDE.md: new instructions have to reach it.
    expect(readFileSync(join(runnerDir, "agents", "helper", "CLAUDE.md"), "utf8")).toContain("Answer in detail.");
  });

  test("an agent that moved out of a workspace keeps its chats when the workspace is deleted", async () => {
    const result = await sync(() => {
      sql("UPDATE agents SET workspace_id = NULL WHERE id = 'agt_helper'");
      sql("DELETE FROM workspaces WHERE id = 'ws_ops'");
    });
    expect(result.warnings).toEqual([]);
    expect(exists("workspaces", "ws_ops")).toBe(false);
    // The workspace's login and repository went with it, as on the controller.
    expect(exists("credentials", "cred_github")).toBe(false);
    expect(exists("workspace_sources", "src_site")).toBe(false);
    expect(row("agents", "agt_helper").workspace_id).toBeNull();
    expect(exists("conversations", "cnv_runner")).toBe(true);
    expect(exists("messages", "msg_runner")).toBe(true);
    expect(exists("runs", "run_runner")).toBe(true);
    expect(exists("mcp_servers", "mcp_notes")).toBe(true);
  });

  test("an agent removed on the controller is kept while one of its runs is active", async () => {
    await sync(() => {
      insert("workspaces", { id: "ws_temp", name: "Temp", slug: "temp", created_at: TS, updated_at: TS });
      insert("agents", {
        id: "agt_temp",
        workspace_id: "ws_temp",
        name: "Temp worker",
        slug: "temp-worker",
        repo_path: join(config().agentsDir, "temp-worker"),
        created_at: TS,
        updated_at: TS,
      });
    });
    insert("conversations", { id: "cnv_temp", agent_id: "agt_temp", created_at: TS, updated_at: TS });
    expect(existsSync(join(runnerDir, "agents", "temp-worker", ".git"))).toBe(true);

    const synced = appliedDigest();
    working.push("agt_temp");
    const during = await sync(() => sql("DELETE FROM workspaces WHERE id = 'ws_temp'"));
    expect(during.warnings).toHaveLength(1);
    expect(during.warnings[0]).toContain("Temp worker");
    // Not recorded as applied: the controller still sees a difference and syncs again.
    expect(during.digest).toBe(synced!);
    expect(appliedDigest()).toBe(synced);
    // Its workspace is gone; the agent and its chat are not.
    expect(exists("workspaces", "ws_temp")).toBe(false);
    expect(row("agents", "agt_temp").workspace_id).toBeNull();
    expect(exists("conversations", "cnv_temp")).toBe(true);
    expect(existsSync(join(runnerDir, "agents", "temp-worker", ".git"))).toBe(true);

    working.length = 0;
    const after = await sync(() => {});
    expect(after.warnings).toEqual([]);
    expect(after.digest).not.toBe(synced!);
    expect(appliedDigest()).toBe(after.digest);
    expect(exists("agents", "agt_temp")).toBe(false);
    expect(exists("conversations", "cnv_temp")).toBe(false);
    expect(existsSync(join(runnerDir, "agents", "temp-worker"))).toBe(false);
    expect(readdirSync(join(runnerDir, "agents", ".trash")).some((name) => name.startsWith("temp-worker-"))).toBe(true);
  });

  test("a runner whose own default agent is working gets the controller's default agent once that run is over", async () => {
    use(controller);
    const snapshot = buildSnapshot();
    use(busyRunner);
    const own = await ensureDefaultAgent();
    working.push(own.id);
    const during = await applySnapshot(snapshot);
    // Both are "godmode": the runner's stays for its run, the controller's has to wait for the folder.
    expect(during.warnings).toHaveLength(2);
    expect(during.digest).toBe("");
    expect(appliedDigest()).toBeNull();
    expect(exists("agents", own.id)).toBe(true);
    expect(exists("agents", "agt_main")).toBe(false);
    expect(exists("agents", "agt_helper")).toBe(true);

    working.length = 0;
    expect(await applySnapshot(snapshot)).toEqual({ digest: snapshot.digest, warnings: [] });
    expect(all<{ id: string }>("SELECT id FROM agents WHERE slug = 'godmode'")).toEqual([{ id: "agt_main" }]);
    expect(JSON.parse(readFileSync(join(busyRunner, "agents", "godmode", "state", "agent.json"), "utf8"))).toMatchObject({ id: "agt_main" });
    use(runnerDir);
  });

  test("a snapshot from another version is applied as far as both sides know it", async () => {
    use(controller);
    const snapshot = buildSnapshot();
    // A newer controller: a column and a table this runner doesn't have. An older one: a column it doesn't send.
    snapshot.tables.ssh_servers![0]!.jump_host = "bastion.example.com";
    delete snapshot.tables.ssh_servers![0]!.description;
    snapshot.tables.future_things = [{ id: "ft_1", name: "Unknown here" }];
    (snapshot.settings as Record<string, unknown>).future = { enabled: true };
    use(runnerDir);
    sql("DELETE FROM ssh_servers WHERE id = 'ssh_box'");
    const result = await applySnapshot(snapshot);
    expect(result).toEqual({ digest: snapshot.digest, warnings: [] });
    expect(row("ssh_servers", "ssh_box")).toMatchObject({ host: "box.example.org", description: "" });
    expect(get("SELECT 1 FROM settings WHERE key = 'future'")).toBeNull();
  });

  test("unsafe ids are skipped with a warning and nothing is written outside the data directory", async () => {
    use(controller);
    const snapshot = buildSnapshot();
    const { agents, browser_profiles: profiles, vms, mcp_servers: servers, mods } = snapshot.tables;
    agents!.push({ ...agents![0]!, id: "agt_evil", name: "Evil", slug: "../evil", is_default: 0 });
    // An agent's id names the folder of its browser files.
    agents!.push({ ...agents![0]!, id: "../../agt_escape", name: "Escape artist", slug: "escape-artist", is_default: 0 });
    profiles!.push({ ...profiles![0]!, id: "../../outside", name: "Outside", is_default: 0 });
    vms!.push({ ...vms![0]!, id: "vm_../../x", name: "Escape" });
    servers!.push({ ...servers![0]!, id: "mcp_evil", agent_id: "agt_evil" });
    // A mod's name names the folder its files are written to.
    mods!.push({ ...mods![0]!, id: "mod_evil", name: "../evil" });

    use(runnerDir);
    const result = await applySnapshot(snapshot);
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings.join("\n")).toContain('mod "../evil"');
    expect(result.warnings.join("\n")).toContain('agent "Evil"');
    expect(result.warnings.join("\n")).toContain('agent "Escape artist"');
    expect(result.warnings.join("\n")).toContain('browser profile "Outside"');
    expect(result.warnings.join("\n")).toContain('virtual machine "Escape"');
    // The MCP server of the agent that wasn't copied.
    expect(result.warnings.join("\n")).toContain("1 item(s)");
    expect(exists("agents", "agt_evil")).toBe(false);
    expect(exists("agents", "../../agt_escape")).toBe(false);
    expect(existsSync(join(runnerDir, "agents", "escape-artist"))).toBe(false);
    expect(exists("browser_profiles", "../../outside")).toBe(false);
    expect(exists("vms", "vm_../../x")).toBe(false);
    expect(exists("mcp_servers", "mcp_evil")).toBe(false);
    expect(exists("mods", "mod_evil")).toBe(false);
    expect(exists("mods", "mod_guard")).toBe(true);
    expect(existsSync(join(runnerDir, "evil"))).toBe(false);
    // Everything else arrived.
    expect(exists("agents", "agt_helper")).toBe(true);
    expect(exists("mcp_servers", "mcp_notes")).toBe(true);
    expect(exists("vms", "vm_abcd1234")).toBe(true);
  });

  test("a snapshot that can't be applied leaves the runner exactly as it was", async () => {
    use(controller);
    const snapshot = buildSnapshot();
    use(runnerDir);
    const before = state();

    const wrongKey = await rejection(applySnapshot({ ...snapshot, vault: { ...snapshot.vault, dek: randomKey().toString("base64") } }));
    expect(wrongKey).toBeInstanceOf(HttpError);
    expect(wrongKey).toMatchObject({ status: 400, message: "The vault key doesn't match" });

    // An agent of a workspace that isn't there: the whole snapshot is refused, not half of it applied (the VM and the
    // SSH server it no longer lists are still here afterwards).
    const broken = structuredClone(snapshot);
    broken.tables.agents!.find((r) => r.id === "agt_helper")!.workspace_id = "ws_missing";
    broken.tables.vms = [];
    broken.tables.ssh_servers = [];
    expect(String(await rejection(applySnapshot(broken)))).toContain("FOREIGN KEY");

    const unreadable = await rejection(applySnapshot({ ...snapshot, v: 2 } as unknown as ConfigSnapshot));
    expect(unreadable).toMatchObject({ status: 400 });

    expect(state()).toEqual(before);
    expect(vault.isUnlocked()).toBe(true);
  });

  test("the vault refuses a key that doesn't open its canary", async () => {
    const meta = vault.vaultMetaForBackup() as { kdf: string; wrappedDek: string; canary: string };
    const err = await rejection(vault.adoptKey(randomKey().toString("base64"), meta));
    expect(err).toMatchObject({ status: 400, message: "The vault key doesn't match" });
    expect(vault.vaultMetaForBackup()).toEqual(meta);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-openai-key");
  });

  test("without the key, a runner whose vault is from another setup says so", async () => {
    use(controller);
    const snapshot = buildSnapshot();
    use(lockedRunner);
    vault.lock();
    const result = await applySnapshot({ ...snapshot, vault: { ...snapshot.vault, dek: null } });
    expect(result.warnings).toEqual(["The vault on the runner is from another setup — unlock the vault in Godmode and sync again."]);
    expect(vault.status()).toMatchObject({ initialized: false, unlocked: false });
    // The setup itself arrived; its secrets open once the key does.
    expect(exists("agents", "agt_helper")).toBe(true);
    expect(appliedDigest()).toBe(snapshot.digest);
  });

  test("once the vault is unlocked in Godmode, the next sync brings the key and the copied secrets open", async () => {
    use(controller);
    await vault.unlock(VAULT_PASSPHRASE);
    const snapshot = buildSnapshot();
    use(lockedRunner);
    vault.lock();
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    const result = await applySnapshot(snapshot);
    off();
    expect(result.warnings).toEqual([]);
    expect(vault.status()).toMatchObject({ initialized: true, unlocked: true, rememberDevice: true });
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-openai-key");
    expect(events.some((e) => e.type === "vault.status" && e.status.unlocked)).toBe(true);
  });

  test("a vault from before canaries gets one, so the remembered key still opens it after a restart", async () => {
    const { kdf, wrappedDek } = first.vault;
    sql("DELETE FROM meta WHERE key = 'vault.canary'");
    await vault.adoptKey(first.vault.dek!, { kdf: kdf!, wrappedDek: wrappedDek!, canary: null });
    expect(getMeta("vault.canary")).not.toBeNull();
    vault.lock();
    expect(await vault.tryAutoUnlock()).toBe(true);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-openai-key");
  });
});

describe("merging an agent's memory", () => {
  const snap = (files: Record<string, string>, skipped: string[] = []): MemorySnapshot => ({ files, skipped });

  test("a change on one side only is taken from that side", () => {
    const base = snap({ "MEMORY.md": "a\n", "memory/notes.md": "n\n" });
    const local = snap({ "MEMORY.md": "a\nlocal\n", "memory/notes.md": "n\n" });
    const remote = snap({ "MEMORY.md": "a\n", "memory/notes.md": "n\nremote\n", "memory/new.md": "fresh\n" });
    const { merged, changedLocal, changedRemote } = mergeMemory(base, local, remote);
    expect(merged.files).toEqual({ "MEMORY.md": "a\nlocal\n", "memory/notes.md": "n\nremote\n", "memory/new.md": "fresh\n" });
    expect(changedLocal).toBe(true);
    expect(changedRemote).toBe(true);
  });

  test("nothing changed means nothing to write on either side", () => {
    const same = snap({ "MEMORY.md": "a\n" });
    expect(mergeMemory(same, snap({ "MEMORY.md": "a\n" }), snap({ "MEMORY.md": "a\n" }))).toEqual({ merged: same, changedLocal: false, changedRemote: false });
    // Only the runner learned something: the controller's copy is the one to update.
    const result = mergeMemory(same, snap({ "MEMORY.md": "a\n" }), snap({ "MEMORY.md": "a\nb\n" }));
    expect(result.changedLocal).toBe(true);
    expect(result.changedRemote).toBe(false);
  });

  test("when both sides changed a file, local's lines stay in order and remote's new lines follow — none is lost", () => {
    const base = snap({ "MEMORY.md": "# Memory\n- likes tea\n" });
    const local = snap({ "MEMORY.md": "# Memory\n- likes green tea\n- works at Acme\n" });
    const remote = snap({ "MEMORY.md": "# Memory\n- likes tea\n\n- birthday in May\n- works at Acme\n" });
    const { merged, changedLocal, changedRemote } = mergeMemory(base, local, remote);
    expect(merged.files["MEMORY.md"]).toBe("# Memory\n- likes green tea\n- works at Acme\n- likes tea\n- birthday in May\n");
    expect(changedLocal).toBe(true);
    expect(changedRemote).toBe(true);
    for (const line of [...local.files["MEMORY.md"]!.split("\n"), ...remote.files["MEMORY.md"]!.split("\n")]) {
      expect(merged.files["MEMORY.md"]!.split("\n")).toContain(line);
    }
    // Merged once, both sides agree: the next sync has nothing to do.
    expect(mergeMemory(merged, merged, merged)).toMatchObject({ changedLocal: false, changedRemote: false });
  });

  test("the first sync has no base: files of both sides are kept and differing ones merged", () => {
    const { merged } = mergeMemory(null, snap({ "MEMORY.md": "local\n", "memory/a.md": "a\n" }), snap({ "MEMORY.md": "remote\n", "memory/b.md": "b\n" }));
    expect(merged.files).toEqual({ "MEMORY.md": "local\nremote\n", "memory/a.md": "a\n", "memory/b.md": "b\n" });
  });

  test("a file deleted on one side and untouched on the other is deleted", () => {
    const base = snap({ "MEMORY.md": "a\n", "memory/old.md": "old\n", "memory/stale.md": "stale\n" });
    const local = snap({ "MEMORY.md": "a\n", "memory/stale.md": "stale\n" });
    const remote = snap({ "MEMORY.md": "a\n", "memory/old.md": "old\n" });
    const { merged, changedLocal, changedRemote } = mergeMemory(base, local, remote);
    expect(merged.files).toEqual({ "MEMORY.md": "a\n" });
    expect(changedLocal).toBe(true);
    expect(changedRemote).toBe(true);
  });

  test("a file deleted on one side but changed on the other is kept", () => {
    const base = snap({ "memory/plan.md": "v1\n", "memory/todo.md": "v1\n" });
    const local = snap({ "memory/todo.md": "v2 local\n" });
    const remote = snap({ "memory/plan.md": "v2 remote\n" });
    const { merged } = mergeMemory(base, local, remote);
    expect(merged.files).toEqual({ "memory/plan.md": "v2 remote\n", "memory/todo.md": "v2 local\n" });
  });

  test("a file one side couldn't read is left alone on both", () => {
    const base = snap({ "memory/big.md": "small once\n" });
    const local = snap({}, ["memory/big.md"]);
    const remote = snap({ "memory/big.md": "small once\n" });
    const { merged, changedLocal, changedRemote } = mergeMemory(base, local, remote);
    expect(merged).toEqual({ files: {}, skipped: ["memory/big.md"] });
    expect(changedLocal).toBe(false);
    expect(changedRemote).toBe(false);
  });
});

describe("reading and writing an agent's memory", () => {
  test("writing a memory state makes the files equal to it, commits, and touches nothing but memory", async () => {
    use(runnerDir);
    const repo = join(runnerDir, "agents", "helper");
    mkdirSync(join(repo, "memory"), { recursive: true });
    writeFileSync(join(repo, "memory", "old.md"), "outdated\n");
    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf8");

    const before = readMemoryState("agt_helper");
    expect(before.snapshot.files["memory/old.md"]).toBe("outdated\n");
    expect(before.snapshot.files["MEMORY.md"]).toBeDefined();
    expect(readMemoryState("agt_helper").digest).toBe(before.digest);

    const target: MemorySnapshot = {
      files: {
        "MEMORY.md": "# Memory\n- synced\n",
        "memory/people/ada.md": "Ada likes tea\n",
        "CLAUDE.md": "hijacked",
        "../escape.md": "outside",
        "memory/../../escape.md": "outside",
      },
      skipped: [],
    };
    const after = await writeMemoryState("agt_helper", target, "Sync memory with Godmode");
    expect(after.snapshot.files).toEqual({ "MEMORY.md": "# Memory\n- synced\n", "memory/people/ada.md": "Ada likes tea\n" });
    expect(after.digest).not.toBe(before.digest);
    expect(after).toEqual(readMemoryState("agt_helper"));
    expect(existsSync(join(repo, "memory", "old.md"))).toBe(false);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(claudeMd);
    expect(existsSync(join(runnerDir, "agents", "escape.md"))).toBe(false);
    expect(existsSync(join(runnerDir, "escape.md"))).toBe(false);

    const [latest] = await listAgentCommits("agt_helper", 1);
    expect(latest!.message.trim()).toBe("Sync memory with Godmode");
  });

  test("the digest is the same for the same files on another computer", async () => {
    const files = readMemoryState("agt_helper").snapshot.files;
    use(controller);
    await writeMemoryState("agt_helper", { files, skipped: [] }, "Sync memory with the runner");
    const here = readMemoryState("agt_helper");
    use(runnerDir);
    expect(readMemoryState("agt_helper").digest).toBe(here.digest);
  });

  test("a memory state without text is refused instead of read as deleted files", async () => {
    const before = readMemoryState("agt_helper");
    const err = await rejection(writeMemoryState("agt_helper", { files: { "MEMORY.md": null } } as unknown as MemorySnapshot, "Sync"));
    expect(err).toMatchObject({ status: 400 });
    expect(readMemoryState("agt_helper")).toEqual(before);
  });
});
