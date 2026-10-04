import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, CleanupItem, CleanupReport, CleanupRun } from "@godmode/shared";
import { createAgent } from "../src/agents/service";
import { ensureDefaultProfile } from "../src/browser/manager";
import { config, loadConfig } from "../src/config";
import { closeDb, getDb, insert, openDb, run as sql } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { __setTempDirForTests, lastCleanup, runCleanup, scanCleanup } from "../src/services/cleanup";
import { __resetMaintenanceForTests, runMaintenance, stopMaintenance } from "../src/services/maintenance";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { repoCacheDir } from "../src/tasks/git";
import { setVmSupportForTests } from "../src/vm/tart";

const suite = process.platform !== "win32" ? describe : describe.skip;

let dataDir: string;
let tempDir: string;
let agent: Agent;
let taskNumber = 0;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const git = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
};

/** Make `path` (and everything in it) look untouched for `ms`. */
function age(path: string, ms: number) {
  const when = new Date(Date.now() - ms);
  const walk = (p: string) => {
    try {
      for (const name of readdirSync(p)) walk(join(p, name));
    } catch {
      /* a file */
    }
    utimesSync(p, when, when);
  };
  walk(path);
}

function file(path: string, bytes = 64 * 1024, ms = 0) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
  if (ms) age(path, ms);
  return path;
}

function item(report: CleanupReport, id: CleanupItem["id"]): CleanupItem {
  const found = report.items.find((i) => i.id === id);
  if (!found) throw new Error(`no ${id} in the report`);
  return found;
}

const paths = (i: CleanupItem) => i.entries.filter((e) => !e.kept).map((e) => e.path);

function task(fields: { status: string; completedAt?: string | null; repoUrl?: string }): string {
  const id = `tsk_test${++taskNumber}`;
  const ts = new Date().toISOString();
  insert("tasks", {
    id,
    number: taskNumber,
    title: `Task ${taskNumber}`,
    status: fields.status,
    repo_url: fields.repoUrl ?? "",
    completed_at: fields.completedAt ?? null,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

async function makeRepo(name: string): Promise<string> {
  const dir = join(dataDir, "src-repos", name);
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-cleanup-"));
  tempDir = join(dataDir, "system-tmp");
  mkdirSync(tempDir);
  loadConfig({ dataDir, token: "test-token" });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
  setVmSupportForTests(false);
  __setTempDirForTests(tempDir);
  agent = await createAgent({ name: "Cleaner" });
});

afterAll(() => {
  stopMaintenance();
  __resetMaintenanceForTests();
  __setTempDirForTests(null);
  setVmSupportForTests(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

suite("the report", () => {
  test("adds up the data folder and checks it", async () => {
    file(join(config().attachmentsDir, "tasks", "tat_1", "big.bin"), 2 * 1024 * 1024);
    const report = await scanCleanup();
    expect(report.dataDir).toBe(dataDir);
    expect(report.disk?.totalBytes).toBeGreaterThan(0);
    const areas = Object.fromEntries(report.storage.map((s) => [s.area, s.bytes]));
    expect(areas.other).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(areas.agents).toBeGreaterThan(0);
    expect(areas.database).toBeGreaterThan(0);
    // Largest first, everything else last.
    const named = report.storage.filter((s) => s.area !== "other").map((s) => s.bytes);
    expect(named).toEqual([...named].sort((a, b) => b - a));
    expect(report.storage.at(-1)?.area).toBe("other");
    expect(report.checks.map((c) => [c.id, c.status])).toContainEqual(["database", "ok"]);
    expect(report.checks.find((c) => c.id === "disk")?.detail).toMatch(/free of/);
    // VMs aren't supported here: nothing about them.
    expect(report.items.map((i) => i.id)).not.toContain("vm-images");
    expect(report.items.map((i) => i.id)).not.toContain("vm-downloads");
  });
});

suite("leftovers of interrupted work", () => {
  test("only Godmode's own temp files, once nothing uses them", async () => {
    const stale = file(join(tempDir, "godmode-mcp-run_aaaaaaaaaaaaaaaa.json"), 1024, 2 * DAY);
    const sameDay = file(join(tempDir, "godmode-mcp-run_hhhhhhhhhhhhhhhh.json"), 1024, 2 * HOUR);
    const fresh = file(join(tempDir, "godmode-prompt-run_bbbbbbbbbbbbbbbb.md"), 1024);
    const importDir = join(tempDir, "godmode-import-x1");
    file(join(importDir, "Cookies"), 4096);
    age(importDir, 2 * DAY);
    const recentImport = join(tempDir, "godmode-import-x2");
    file(join(recentImport, "Cookies"), 4096);
    age(recentImport, 2 * HOUR);
    const foreign = file(join(tempDir, "somebody-elses.json"), 1024, 3 * DAY);

    const profile = ensureDefaultProfile();
    const runs = join(dataDir, "browser-use", profile.id, agent.id, "runs");
    const oldRun = join(runs, "run_cccccccccccccccc");
    file(join(oldRun, "config.json"), 512);
    age(oldRun, 2 * HOUR);
    const newRun = join(runs, "run_dddddddddddddddd");
    file(join(newRun, "config.json"), 512);
    const goneProfile = join(dataDir, "browser-use", "bpr_gone");
    file(join(goneProfile, "agt_x", "config.json"), 512);

    const clone = join(dataDir, "repos", "wsp_1", "site.cloning-abc123");
    file(join(clone, "HEAD"), 128);
    age(clone, 2 * DAY);

    const bin = join(dataDir, "bin");
    const oldHelper = file(join(bin, "godmode-computer-aaaaaaaaaaaa"), 4096, 10 * DAY);
    const currentHelper = file(join(bin, "godmode-computer-bbbbbbbbbbbb"), 4096, 9 * DAY);

    const leftovers = item(await scanCleanup(), "temp-files");
    expect(leftovers.recommended).toBe(true);
    expect(paths(leftovers).sort()).toEqual([stale, importDir, oldRun, goneProfile, clone, oldHelper].sort());

    const result = await runCleanup(["temp-files"]);
    expect(result.results).toMatchObject([{ id: "temp-files", ok: true, removed: 6 }]);
    expect(result.freedBytes).toBeGreaterThan(0);
    for (const gone of [stale, importDir, oldRun, goneProfile, clone, oldHelper]) expect(existsSync(gone)).toBe(false);
    for (const kept of [fresh, sameDay, recentImport, foreign, newRun, currentHelper]) expect(existsSync(kept)).toBe(true);
  });
});

suite("browser caches", () => {
  test("are cleared while the browser is closed; sign-ins stay", async () => {
    const dir = ensureDefaultProfile().userDataDir;
    const cache = file(join(dir, "Default", "Cache", "Cache_Data", "f_000001"), 300 * 1024);
    const codeCache = file(join(dir, "Default", "Code Cache", "js", "index"), 100 * 1024);
    const shaders = file(join(dir, "GrShaderCache", "data_0"), 50 * 1024);
    const cookies = file(join(dir, "Default", "Cookies"), 20 * 1024);

    symlinkSync(`somehost-${process.pid}`, join(dir, "SingletonLock"));
    let caches = item(await scanCleanup(), "browser-cache");
    expect(caches.count).toBe(0);
    expect(caches.entries[0]?.kept).toMatch(/browser is open/);
    expect((await runCleanup(["browser-cache"])).results[0]).toMatchObject({ removed: 0, kept: 1 });
    expect(existsSync(cache)).toBe(true);

    // A lock left by a browser that crashed names a process that is gone.
    rmSync(join(dir, "SingletonLock"));
    symlinkSync("somehost-2147483646", join(dir, "SingletonLock"));
    caches = item(await scanCleanup(), "browser-cache");
    expect(caches.count).toBe(1);
    expect(caches.bytes).toBeGreaterThanOrEqual(450 * 1024);
    await runCleanup(["browser-cache"]);
    for (const gone of [cache, codeCache, shaders]) expect(existsSync(gone)).toBe(false);
    expect(existsSync(cookies)).toBe(true);
  });
});

suite("task worktrees and clones", () => {
  let main: string;

  beforeAll(async () => {
    main = await makeRepo("app");
  });

  test("worktrees of tasks finished a while ago go, unless they hold changes", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
    const done = task({ status: "done", completedAt: twoDaysAgo });
    const dirty = task({ status: "cancelled", completedAt: twoDaysAgo });
    const justDone = task({ status: "done", completedAt: new Date().toISOString() });
    const working = task({ status: "in_progress" });
    for (const [id, branch] of [[done, "t1"], [dirty, "t2"], [justDone, "t3"], [working, "t4"]] as const) {
      await git(["worktree", "add", "-q", "-b", `godmode/${branch}`, join(config().tasksDir, id)], main);
    }
    writeFileSync(join(config().tasksDir, dirty, "notes.txt"), "work in progress\n");
    const orphan = join(config().tasksDir, "tsk_deleted");
    file(join(orphan, "half-created.txt"), 1024);

    const report = await scanCleanup();
    const worktrees = item(report, "task-worktrees");
    expect(paths(worktrees).sort()).toEqual([join(config().tasksDir, done), orphan].sort());
    expect(worktrees.entries.find((e) => e.path === join(config().tasksDir, dirty))?.kept).toMatch(/uncommitted/);
    expect(worktrees.entries.find((e) => e.path === join(config().tasksDir, done))?.name).toMatch(/^#\d+ Task/);
    expect(report.checks.find((c) => c.id === "worktrees")).toMatchObject({ status: "warn" });

    const result = await runCleanup(["task-worktrees"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 2, kept: 1 });
    expect(existsSync(join(config().tasksDir, done))).toBe(false);
    expect(existsSync(join(config().tasksDir, dirty))).toBe(true);
    // Unregistered from the repository; the branch (and its commits) stays.
    expect(await git(["worktree", "list"], main)).not.toContain(done);
    expect(await git(["branch", "--list", "godmode/t1"], main)).toContain("godmode/t1");
    expect((await scanCleanup()).checks.find((c) => c.id === "worktrees")).toMatchObject({ status: "ok" });
  });

  test("clones no task uses go, unless they hold commits that were never pushed", async () => {
    const mirror = async (url: string) => {
      const dir = repoCacheDir(url);
      mkdirSync(dir, { recursive: true });
      await git(["init", "-q", "--bare"], dir);
      await git(["remote", "add", "origin", main], dir);
      await git(["fetch", "-q", "origin"], dir);
      return dir;
    };
    const unused = await mirror("https://example.com/acme/unused.git");
    const used = await mirror("https://example.com/acme/used.git");
    task({ status: "todo", repoUrl: "https://example.com/acme/used.git" });
    const unpushed = await mirror("https://example.com/acme/unpushed.git");
    const sha = await git(["commit-tree", "origin/main^{tree}", "-p", "origin/main", "-m", "agent work"], unpushed);
    await git(["branch", "godmode/9-report", sha], unpushed);

    const clones = item(await scanCleanup(), "task-clones");
    expect(paths(clones)).toEqual([unused]);
    expect(clones.entries.find((e) => e.path === unpushed)?.kept).toMatch(/never pushed/);
    expect(clones.entries.map((e) => e.path)).not.toContain(used);
    expect(clones.entries.find((e) => e.path === unused)?.name).toBe("unused.git".replace(".git", ""));

    await runCleanup(["task-clones"]);
    expect(existsSync(unused)).toBe(false);
    expect(existsSync(unpushed)).toBe(true);
    expect(existsSync(used)).toBe(true);
  });
});

suite("agent histories and the database", () => {
  test("loose git objects are packed", async () => {
    const work = join(agent.repoPath, "workspace", "notes");
    mkdirSync(work, { recursive: true });
    for (let i = 0; i < 400; i++) writeFileSync(join(work, `note-${i}.md`), `note ${i}\n`.repeat(20));
    await git(["add", "-A"], agent.repoPath);
    await git(["commit", "-q", "-m", "notes"], agent.repoPath);

    const history = item(await scanCleanup(), "agent-history");
    expect(history.upTo).toBe(true);
    expect(history.entries.map((e) => e.name)).toEqual(["Cleaner"]);
    const result = await runCleanup(["agent-history"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(result.freedBytes).toBeGreaterThan(512 * 1024);
    const objects = readdirSync(join(agent.repoPath, ".git", "objects"));
    expect(objects.filter((n) => /^[0-9a-f]{2}$/.test(n))).toEqual([]);
    expect(readdirSync(join(agent.repoPath, ".git", "objects", "pack")).some((n) => n.endsWith(".pack"))).toBe(true);
    expect(await git(["log", "--oneline", "-1"], agent.repoPath)).toContain("notes");
  });

  test("waits for runs another Godmode process is working on", async () => {
    insert("runs", { id: "run_elsewhere0001", agent_id: agent.id, conversation_id: "cnv_elsewhere", trigger: "manual", status: "running", prompt: "x", created_at: new Date().toISOString() });
    try {
      const report = await scanCleanup();
      expect(item(report, "database").blocked).toMatch(/Agents are working/);
      const stale = file(join(tempDir, "godmode-mcp-run_elsewhere0001.json"), 1024, 3 * DAY);
      expect(paths(item(await scanCleanup(), "temp-files"))).not.toContain(stale);
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_elsewhere0001'");
    }
  });

  test("free pages go back to the disk", async () => {
    const db = getDb();
    db.run("CREATE TABLE scratch (data BLOB)");
    for (let i = 0; i < 40; i++) db.query("INSERT INTO scratch (data) VALUES (?)").run(Buffer.alloc(100 * 1024, i));
    db.run("DROP TABLE scratch");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");

    const database = item(await scanCleanup(), "database");
    expect(database.bytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    const result = await runCleanup(["database"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBe(0);
    expect(item(await scanCleanup(), "database").count).toBe(0);
  });
});

suite("logs and the trash", () => {
  test("old logs and logs of deleted VMs", async () => {
    const previous = file(join(config().logsDir, "godmode.1.jsonl"), 4096, 8 * DAY);
    const current = file(join(config().logsDir, "godmode.jsonl"), 4096, 8 * DAY);
    const recentDesktop = file(join(config().logsDir, "desktop.log.1"), 4096, DAY);
    const vmLog = file(join(config().vmDir, "logs", "vm_deleted1234.log"), 4096);
    const ts = new Date().toISOString();
    insert("vms", { id: "vm_alive12345", name: "Alive", image: "x", cpu: 4, memory_mb: 8192, disk_gb: 50, display: "1280x800", created_at: ts, updated_at: ts });
    const aliveLog = file(join(config().vmDir, "logs", "vm_alive12345.log"), 4096);

    expect(paths(item(await scanCleanup(), "old-logs")).sort()).toEqual([previous, vmLog].sort());
    await runCleanup(["old-logs"]);
    expect([previous, vmLog].map(existsSync)).toEqual([false, false]);
    expect([current, recentDesktop, aliveLog].map(existsSync)).toEqual([true, true, true]);
  });

  test("the trash is listed by what it was, and only emptied on request", async () => {
    const agentTrash = join(config().agentsDir, ".trash", "old-bot-2026-09-01T10-00-00-000Z");
    file(join(agentTrash, "MEMORY.md"), 2048);
    const repoTrash = join(dataDir, "repos", ".trash", "wsp_abc-site-2026-09-02T11-30-00-000Z");
    file(join(repoTrash, "index.html"), 2048);
    const restoreTrash = join(config().browserDir, ".trash", "restore-2026-09-03T08-00-00-000Z");
    file(join(restoreTrash, "bpr_1", "Cookies"), 2048);

    const trash = item(await scanCleanup(), "trash");
    expect(trash.recommended).toBe(false);
    const byPath = Object.fromEntries(trash.entries.map((e) => [e.path, e]));
    expect(byPath[agentTrash]).toMatchObject({ name: "Agent “old-bot”", modifiedAt: "2026-09-01T10:00:00.000Z" });
    expect(byPath[repoTrash]).toMatchObject({ name: "Repository “site”" });
    expect(byPath[restoreTrash]).toMatchObject({ name: "Browser profiles before a backup was restored" });

    await runCleanup(["trash"]);
    expect([agentTrash, repoTrash, restoreTrash].map(existsSync)).toEqual([false, false, false]);
  });
});

suite("automatic cleanup", () => {
  let busy = false;

  beforeEach(() => {
    busy = false;
    sql("DELETE FROM meta WHERE key = 'cleanup.lastRun'");
    updateSettings({ onboardingComplete: true, maintenance: { autoFix: false, autoUpdate: false, autoCleanup: true } });
    __resetMaintenanceForTests({ busy: () => busy });
  });

  test("cleans what is recommended once a day, and never the trash", async () => {
    const leftover = file(join(tempDir, "godmode-settings-run_eeeeeeeeeeeeeeee.json"), 1024, 2 * DAY);
    const trashed = join(config().agentsDir, ".trash", "bot-2026-09-01T10-00-00-000Z");
    file(join(trashed, "MEMORY.md"), 1024);

    await runMaintenance();
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(trashed)).toBe(true);
    expect(lastCleanup()).toMatchObject({ automatic: true });

    const next = file(join(tempDir, "godmode-settings-run_ffffffffffffffff.json"), 1024, 2 * DAY);
    await runMaintenance();
    expect(existsSync(next)).toBe(true);
  });

  test("leaves worktrees of tasks finished this week alone", async () => {
    const main = await makeRepo("auto");
    const lastWeek = task({ status: "done", completedAt: new Date(Date.now() - 3 * DAY).toISOString() });
    const longAgo = task({ status: "done", completedAt: new Date(Date.now() - 9 * DAY).toISOString() });
    await git(["worktree", "add", "-q", "-b", "godmode/a1", join(config().tasksDir, lastWeek)], main);
    await git(["worktree", "add", "-q", "-b", "godmode/a2", join(config().tasksDir, longAgo)], main);
    await runMaintenance();
    expect(existsSync(join(config().tasksDir, lastWeek))).toBe(true);
    expect(existsSync(join(config().tasksDir, longAgo))).toBe(false);
  });

  test("waits while agents work, and stays off when switched off", async () => {
    const leftover = file(join(tempDir, "godmode-agents-run_gggggggggggggggg.json"), 1024, 2 * DAY);
    busy = true;
    await runMaintenance();
    expect(existsSync(leftover)).toBe(true);
    expect(lastCleanup()).toBeNull();

    busy = false;
    updateSettings({ maintenance: { autoCleanup: false } });
    await runMaintenance();
    expect(existsSync(leftover)).toBe(true);

    updateSettings({ maintenance: { autoCleanup: true } });
    await runMaintenance();
    expect(existsSync(leftover)).toBe(false);
  });
});

suite("routes", () => {
  const app = createApp();

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as T };
  }

  test("need the access token", async () => {
    expect((await app.request("/api/cleanup", { method: "GET" })).status).toBe(401);
    expect((await app.request("/api/cleanup", { method: "POST" })).status).toBe(401);
  });

  test("report, clean and remember", async () => {
    const report = await call<CleanupReport>("GET", "/api/cleanup");
    expect(report.status).toBe(200);
    expect(report.data.items.length).toBeGreaterThan(0);

    for (const ids of [[], ["bogus"], "trash", ["__proto__"]]) expect((await call("POST", "/api/cleanup", { ids })).status).toBe(400);
    const leftover = file(join(tempDir, "godmode-pr-zz.md"), 1024, 2 * DAY);
    const run = await call<CleanupRun>("POST", "/api/cleanup", { ids: ["temp-files", "trash"] });
    expect(run.status).toBe(200);
    expect(run.data.automatic).toBe(false);
    expect(run.data.results.map((r) => r.id)).toEqual(["temp-files", "trash"]);
    expect(existsSync(leftover)).toBe(false);
    expect((await call<CleanupReport>("GET", "/api/cleanup")).data.lastRun?.finishedAt).toBe(run.data.finishedAt);
  });
});
