import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, CleanupItem, CleanupReport, CleanupRun } from "@godmode/shared";
import { commitAll, log as gitLog } from "../src/agents/repo";
import { createAgent } from "../src/agents/service";
import { ensureDefaultProfile } from "../src/browser/manager";
import { Database } from "bun:sqlite";
import { config, loadConfig } from "../src/config";
import { closeDb, get, getDb, insert, openDb, run as sql, setDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { __setTempDirForTests, lastCleanup, quickCheck, runCleanup, scanCleanup } from "../src/services/cleanup";
import { __resetMaintenanceForTests, runMaintenance, stopMaintenance } from "../src/services/maintenance";
import { createConversation } from "../src/services/conversations";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { removeCheckoutUnless, repoCacheDir } from "../src/tasks/git";
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
    const output = file(join(tempDir, "godmode-out-run_eeeeeeeeeeeeeeee.jsonl"), 4096, 2 * DAY);
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

    // The computer helper is found by its name: none of its builds is touched.
    const helper = file(join(dataDir, "bin", "godmode-computer-aaaaaaaaaaaa"), 4096, 10 * DAY);

    const leftovers = item(await scanCleanup(), "temp-files");
    expect(leftovers.recommended).toBe(true);
    expect(paths(leftovers).sort()).toEqual([stale, output, importDir, oldRun, goneProfile, clone].sort());

    const result = await runCleanup(["temp-files"]);
    expect(result.results).toMatchObject([{ id: "temp-files", ok: true, removed: 6 }]);
    expect(result.freedBytes).toBeGreaterThan(0);
    for (const gone of [stale, output, importDir, oldRun, goneProfile, clone]) expect(existsSync(gone)).toBe(false);
    for (const kept of [fresh, sameDay, recentImport, foreign, newRun, helper]) expect(existsSync(kept)).toBe(true);
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

  const worktree = async (id: string, branch: string) => {
    const dir = join(config().tasksDir, id);
    await git(["worktree", "add", "-q", "-b", `godmode/${branch}`, dir], main);
    return dir;
  };
  const twoDaysAgo = () => new Date(Date.now() - 2 * DAY).toISOString();

  test("worktrees of tasks finished a while ago go, unless they hold changes", async () => {
    const done = await worktree(task({ status: "done", completedAt: twoDaysAgo() }), "t1");
    const dirty = await worktree(task({ status: "cancelled", completedAt: twoDaysAgo() }), "t2");
    const justDone = await worktree(task({ status: "done", completedAt: new Date().toISOString() }), "t3");
    const working = await worktree(task({ status: "in_progress" }), "t4");
    writeFileSync(join(dirty, "notes.txt"), "work in progress\n");
    // Its task is gone, what it held is on its branch.
    const orphan = await worktree("tsk_deleted", "t5");
    // Not a checkout: nobody can tell what it holds.
    const stray = join(config().tasksDir, "tsk_stray");
    file(join(stray, "half-created.txt"), 1024);

    const report = await scanCleanup();
    const worktrees = item(report, "task-worktrees");
    expect(paths(worktrees).sort()).toEqual([done, orphan].sort());
    const kept = Object.fromEntries(worktrees.entries.filter((e) => e.kept).map((e) => [e.path, e.kept]));
    expect(kept[dirty]).toMatch(/uncommitted/);
    expect(kept[stray]).toMatch(/Not a git checkout/);
    expect(worktrees.entries.map((e) => e.path)).not.toContain(justDone);
    expect(worktrees.entries.map((e) => e.path)).not.toContain(working);
    // What stays is listed first.
    expect(worktrees.entries.slice(0, 2).every((e) => e.kept)).toBe(true);
    expect(worktrees.entries.find((e) => e.path === done)?.name).toMatch(/^#\d+ Task/);
    expect(report.checks.find((c) => c.id === "worktrees")).toMatchObject({ status: "warn" });

    const result = await runCleanup(["task-worktrees"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 2, kept: 2 });
    expect([done, orphan].map(existsSync)).toEqual([false, false]);
    expect([dirty, stray, justDone, working].map(existsSync)).toEqual([true, true, true, true]);
    // Unregistered from the repository; the branch (and its commits) stays.
    expect(await git(["worktree", "list"], main)).not.toContain(done);
    expect(await git(["branch", "--list", "godmode/t1"], main)).toContain("godmode/t1");
    rmSync(stray, { recursive: true });
    expect((await scanCleanup()).checks.find((c) => c.id === "worktrees")).toMatchObject({ status: "ok" });
  });

  test("work git doesn't show at first sight keeps a worktree", async () => {
    // New files, with git told not to list them.
    const hidden = await worktree(task({ status: "done", completedAt: twoDaysAgo() }), "h1");
    await git(["config", "status.showUntrackedFiles", "no"], main);
    writeFileSync(join(hidden, "report.md"), "the result\n");
    // Commits on no branch.
    const detached = await worktree(task({ status: "done", completedAt: twoDaysAgo() }), "h2");
    await git(["checkout", "-q", "--detach"], detached);
    writeFileSync(join(detached, "fix.txt"), "a fix\n");
    await git(["add", "-A"], detached);
    await git(["commit", "-q", "-m", "fix on no branch"], detached);
    // A merge that stopped half-way, with nothing left to commit.
    const merging = await worktree(task({ status: "done", completedAt: twoDaysAgo() }), "h3");
    writeFileSync(join(main, ".git", "worktrees", merging.split("/").pop()!, "MERGE_HEAD"), `${await git(["rev-parse", "HEAD"], main)}\n`);

    try {
      const worktrees = item(await scanCleanup(), "task-worktrees");
      const kept = Object.fromEntries(worktrees.entries.map((e) => [e.path, e.kept]));
      expect(kept[hidden]).toMatch(/uncommitted/);
      expect(kept[detached]).toMatch(/on no branch/);
      expect(kept[merging]).toMatch(/rebase or merge/);
      expect((await runCleanup(["task-worktrees"])).results[0]).toMatchObject({ removed: 0 });
      expect([hidden, detached, merging].map(existsSync)).toEqual([true, true, true]);
    } finally {
      await git(["config", "--unset", "status.showUntrackedFiles"], main);
    }
  });

  test("a worktree is asked about once more before it goes", async () => {
    const dir = await worktree(task({ status: "done", completedAt: twoDaysAgo() }), "r1");
    expect(await removeCheckoutUnless(dir, async () => "Its task is being worked on again.")).toBe("Its task is being worked on again.");
    expect(existsSync(dir)).toBe(true);
    expect(await removeCheckoutUnless(dir, async () => null)).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(await git(["worktree", "list"], main)).not.toContain(dir);
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

suite("agent repositories", () => {
  const working = (id: string, agentId = agent.id) =>
    insert("runs", { id, agent_id: agentId, conversation_id: "cnv_agentwork", trigger: "chat", status: "running", prompt: "x", created_at: new Date().toISOString() });

  test("scratch files nobody touched for a week go, unless the agent is working", async () => {
    const tmp = join(agent.repoPath, "workspace", "tmp");
    const build = join(tmp, "whizzper");
    file(join(build, "out", "app.apk"), 256 * 1024);
    age(build, 8 * DAY);
    const shot = file(join(tmp, "shot.png"), 1024, 8 * DAY);
    // One fresh file keeps its folder.
    const render = join(tmp, "render");
    file(join(render, "a.png"), 1024);
    age(render, 8 * DAY);
    file(join(render, "b.png"), 1024);
    const kept = file(join(agent.repoPath, "workspace", "report.pdf"), 1024, 30 * DAY);
    // A helper the agent's notes point to stays.
    const helper = join(tmp, "helpers");
    file(join(helper, "upload.mjs"), 1024, 8 * DAY);
    age(helper, 8 * DAY);
    writeFileSync(join(agent.repoPath, "memory", "playbook.md"), "- To upload, run workspace/tmp/helpers/upload.mjs.\n");

    const scratch = item(await scanCleanup(), "agent-scratch");
    expect(scratch.recommended).toBe(true);
    expect(paths(scratch).sort()).toEqual([build, shot].sort());
    expect(scratch.entries.find((e) => e.path === build)?.name).toBe("Cleaner · whizzper");
    expect(scratch.entries.find((e) => e.path === helper)?.kept).toBe("Named in memory/playbook.md — it stays until Cleaner moves it out of tmp/ or no longer needs it.");

    working("run_agentwork001");
    try {
      expect(item(await scanCleanup(), "agent-scratch").entries.every((e) => /Cleaner is working/.test(e.kept ?? ""))).toBe(true);
      expect((await runCleanup(["agent-scratch"])).results[0]).toMatchObject({ removed: 0, kept: 3 });
      expect(existsSync(build)).toBe(true);
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_agentwork001'");
    }

    expect((await runCleanup(["agent-scratch"])).results[0]).toMatchObject({ ok: true, removed: 2 });
    expect([build, shot].map(existsSync)).toEqual([false, false]);
    expect([render, kept, helper].map(existsSync)).toEqual([true, true, true]);
    rmSync(join(agent.repoPath, "memory", "playbook.md"));
    expect(paths(item(await scanCleanup(), "agent-scratch"))).toEqual([helper]);

    // A run that waits paused (for an answer) may still need its scratch.
    const other = await createAgent({ name: "Waiter" });
    const waiting = join(other.repoPath, "workspace", "tmp", "draft");
    file(join(waiting, "a.txt"), 1024);
    age(waiting, 9 * DAY);
    const chat = createConversation({ agentId: other.id, title: "Waiting" }).id;
    insert("runs", { id: "run_waiting00001", agent_id: other.id, conversation_id: chat, trigger: "chat", status: "paused", prompt: "x", created_at: new Date().toISOString() });
    insert("paused_runs", { run_id: "run_waiting00001", conversation_id: chat, agent_id: other.id, message_id: "msg_1", reason: "question", created_at: new Date().toISOString() });
    try {
      expect(item(await scanCleanup(), "agent-scratch").entries.find((e) => e.path === waiting)?.kept).toMatch(/Waiter is working/);
    } finally {
      sql("DELETE FROM paused_runs WHERE run_id = 'run_waiting00001'");
      sql("DELETE FROM runs WHERE id = 'run_waiting00001'");
    }
  });

  test("run logs older than two weeks go, unless a run may still write to them", async () => {
    const runs = join(agent.repoPath, "runs");
    const old = join(runs, "2026-01-02");
    file(join(old, "run_old00000001.jsonl"), 8192);
    age(old, 40 * DAY);
    const older = join(runs, "2026-01-01");
    file(join(older, "run_old00000002.jsonl"), 8192);
    age(older, 41 * DAY);
    // A run elsewhere that is still going appends to its log in an old folder.
    const live = join(runs, "2026-01-03");
    file(join(live, "run_livelog0001.jsonl"), 8192);
    age(live, 39 * DAY);
    working("run_livelog0001", (await createAgent({ name: "Elsewhere" })).id);
    // Written to lately: a run that continued after a pause.
    const resumed = join(runs, "2026-01-04");
    file(join(resumed, "run_resumed0001.jsonl"), 8192);
    const today = join(runs, new Date().toISOString().slice(0, 10));
    file(join(today, "run_today000001.jsonl"), 8192);
    try {
      const logs = item(await scanCleanup(), "agent-run-logs");
      expect(logs.recommended).toBe(true);
      expect(logs.entries).toHaveLength(1);
      expect(logs.entries[0]).toMatchObject({ name: "Cleaner · 2026-01-01 to 2026-01-02", path: runs, kept: null });
      expect(logs.bytes).toBeGreaterThanOrEqual(16 * 1024);

      expect((await runCleanup(["agent-run-logs"])).results[0]).toMatchObject({ ok: true, removed: 1 });
      expect([old, older].map(existsSync)).toEqual([false, false]);
      expect([live, resumed, today].map(existsSync)).toEqual([true, true, true]);
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_livelog0001'");
    }
  });

  test("older versions are packed; the current files stay loose for isomorphic-git, and every version stays", async () => {
    const data = join(agent.repoPath, "workspace", "data.bin");
    const bytes = randomBytes(11 * 1024 * 1024);
    for (let i = 0; i < 4; i++) {
      writeFileSync(data, Buffer.concat([bytes, Buffer.from([i])]));
      await commitAll(agent.repoPath, `version ${i}`);
    }
    const history = item(await scanCleanup(), "agent-history");
    expect(history.recommended).toBe(true);
    expect(paths(history)).toEqual([join(agent.repoPath, ".git")]);
    expect(history.entries[0]?.name).toMatch(/3 older versions/);

    const result = await runCleanup(["agent-history"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(result.freedBytes).toBeGreaterThan(15 * 1024 * 1024);
    expect(await git(["fsck", "--no-progress"], agent.repoPath)).toBe("");
    // isomorphic-git reads a whole pack for one object: what it reads (current files, trees, commits) stays loose.
    const current = await git(["rev-parse", "HEAD:workspace/data.bin"], agent.repoPath);
    expect(existsSync(join(agent.repoPath, ".git", "objects", current.slice(0, 2), current.slice(2)))).toBe(true);
    expect(await git(["cat-file", "-p", "HEAD~3:workspace/data.bin"], agent.repoPath).then((o) => o.length)).toBeGreaterThan(0);

    writeFileSync(join(agent.repoPath, "workspace", "after.md"), "after the pack\n");
    expect(await commitAll(agent.repoPath, "after the pack")).toBeTruthy();
    expect((await gitLog(agent.repoPath, 5)).map((c) => c.message)).toEqual(["after the pack", "version 3", "version 2", "version 1", "version 0"]);
    expect(item(await scanCleanup(), "agent-history").count).toBe(0);
    rmSync(data);
    await commitAll(agent.repoPath, "drop the data");
  });
});

suite("rebuildable folders", () => {
  test("installed packages of projects nobody worked on for a month go, unless git holds them, a note names them or the agent is working", async () => {
    const workspace = join(agent.repoPath, "workspace");
    const project = (name: string, files: string[]) => {
      const dir = join(workspace, name);
      for (const f of files) file(join(dir, f), 16 * 1024);
      age(dir, 40 * DAY);
      return dir;
    };
    const idle = project("old-app", ["package.json", "node_modules/left-pad/index.js"]);
    const python = project("py-app", ["main.py", "requirements.txt", ".venv/pyvenv.cfg", ".venv/lib/site.py"]);
    const rust = project("rust-app", ["Cargo.toml", "target/debug/app"]);
    // An edit in its sources keeps a project's packages.
    const active = project("new-app", ["package.json", "node_modules/react/index.js"]);
    file(join(active, "src", "app.ts"), 1024);
    // Folders that only share a name, or nothing would install again.
    const plainVenv = project("py-plain", ["requirements.txt", "venv/notes.txt"]);
    const javaTarget = project("java-app", ["pom.xml", "target/classes/A.class"]);
    const handMade = project("py-script", ["run.py", ".venv/pyvenv.cfg", ".venv/lib/site.py"]);
    const loose = project("loose", ["node_modules/x/index.js"]);
    // A project a note names may be run from there.
    const daily = project("daily-report", ["package.json", "node_modules/x/index.js"]);
    file(join(agent.repoPath, "memory", "daily.md"), 0);
    writeFileSync(join(agent.repoPath, "memory", "daily.md"), "- The daily report runs from workspace/daily-report every morning.\n");
    // Scratch files and uploads aren't looked into, symlinks aren't followed.
    const scratch = project("tmp/try", ["node_modules/x/index.js"]);
    const upload = project("uploads/site", ["node_modules/x/index.js"]);
    const elsewhere = join(dataDir, "elsewhere-app");
    file(join(elsewhere, "node_modules", "x", "index.js"));
    age(elsewhere, 20 * DAY);
    symlinkSync(elsewhere, join(workspace, "linked"));
    // Packages git holds.
    const vendored = project("vendored", ["package.json", "node_modules/lib/index.js"]);
    await git(["add", "-f", "workspace/vendored/node_modules/lib/index.js"], agent.repoPath);
    await git(["commit", "-q", "-m", "vendored"], agent.repoPath);

    const folders = item(await scanCleanup(), "build-folders");
    expect(folders.recommended).toBe(true);
    const gone = [join(idle, "node_modules"), join(python, ".venv"), join(rust, "target")];
    expect(paths(folders).sort()).toEqual([...gone].sort());
    expect(folders.entries).toHaveLength(5);
    expect(folders.entries.find((e) => e.path === join(vendored, "node_modules"))?.kept).toBe("Tracked by git — it stays.");
    expect(folders.entries.find((e) => e.path === join(daily, "node_modules"))?.kept).toMatch(/^Named in memory\/daily\.md/);
    expect(folders.entries.find((e) => e.path === join(idle, "node_modules"))?.name).toBe("Cleaner · old-app/node_modules");

    insert("runs", { id: "run_buildwork001", agent_id: agent.id, conversation_id: "cnv_buildwork", trigger: "chat", status: "running", prompt: "x", created_at: new Date().toISOString() });
    try {
      expect(item(await scanCleanup(), "build-folders").entries.every((e) => /Cleaner is working/.test(e.kept ?? ""))).toBe(true);
      expect((await runCleanup(["build-folders"])).results[0]).toMatchObject({ removed: 0, kept: 5 });
      expect(gone.map(existsSync)).toEqual([true, true, true]);
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_buildwork001'");
    }

    const result = await runCleanup(["build-folders"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 3, kept: 2 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(4 * 16 * 1024);
    expect(gone.map(existsSync)).toEqual([false, false, false]);
    const stay = [
      join(idle, "package.json"),
      join(python, "main.py"),
      join(rust, "Cargo.toml"),
      join(active, "node_modules"),
      join(plainVenv, "venv"),
      join(javaTarget, "target"),
      join(scratch, "node_modules"),
      join(upload, "node_modules"),
      join(elsewhere, "node_modules"),
      join(vendored, "node_modules"),
      join(handMade, ".venv"),
      join(loose, "node_modules"),
      join(daily, "node_modules"),
    ];
    expect(stay.filter((p) => !existsSync(p))).toEqual([]);
    expect(paths(item(await scanCleanup(), "build-folders"))).toEqual([]);
  });
});

suite("the database", () => {
  const bloat = () => {
    const db = getDb();
    db.run("CREATE TABLE scratch (data BLOB)");
    for (let i = 0; i < 40; i++) db.query("INSERT INTO scratch (data) VALUES (?)").run(Buffer.alloc(100 * 1024, i));
    db.run("DROP TABLE scratch");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return db;
  };

  test("free pages go back to the disk", async () => {
    // A little free room isn't worth rewriting the database.
    expect(item(await scanCleanup(), "database")).toMatchObject({ count: 0, blocked: null });

    const db = bloat();
    const database = item(await scanCleanup(), "database");
    expect(database.bytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    const result = await runCleanup(["database"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBe(0);
    expect(item(await scanCleanup(), "database").count).toBe(0);
    expect((await scanCleanup({ fresh: true })).checks.find((c) => c.id === "database")).toMatchObject({ status: "ok" });
  });

  test("the integrity check runs on its own connection in a worker", async () => {
    expect(await quickCheck(config().dbPath)).toEqual(["ok"]);
    const broken = join(tempDir, "broken.db");
    writeFileSync(broken, randomBytes(8192));
    try {
      await expect(quickCheck(broken)).rejects.toThrow(/not a database/);
    } finally {
      rmSync(broken, { force: true });
    }
  });

  test("a database without incremental vacuum switches once, then gives pages back in steps", async () => {
    const db = getDb();
    const autoVacuum = () => (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
    const freelist = () => (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    expect(autoVacuum()).toBe(2);
    db.run("PRAGMA auto_vacuum = NONE");
    db.run("VACUUM");
    expect(autoVacuum()).toBe(0);

    bloat();
    expect((await runCleanup(["database"])).results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(autoVacuum()).toBe(2);
    expect(freelist()).toBe(0);

    bloat();
    expect(freelist()).toBeGreaterThan(512);
    const result = await runCleanup(["database"]);
    expect(result.results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(freelist()).toBe(0);
  });

  test("opening the database next to a writer waits for its lock", () => {
    const writer = new Database(config().dbPath);
    writer.run("PRAGMA busy_timeout = 5000");
    writer.run("BEGIN IMMEDIATE");
    writer.run("CREATE TABLE IF NOT EXISTS held (x INTEGER)");
    const main = getDb();
    try {
      const other = openDb(config().dbPath);
      other.close();
    } finally {
      writer.run("ROLLBACK");
      writer.close();
      setDb(main);
    }
  });

  test("waits for runs another Godmode process is working on", async () => {
    const db = bloat();
    insert("runs", { id: "run_elsewhere0001", agent_id: agent.id, conversation_id: "cnv_elsewhere", trigger: "manual", status: "running", prompt: "x", created_at: new Date().toISOString() });
    try {
      expect(item(await scanCleanup(), "database").blocked).toMatch(/Agents are working/);
      expect((await runCleanup(["database"])).results[0]).toMatchObject({ ok: false, removed: 0 });
      expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBeGreaterThan(0);
      const stale = file(join(tempDir, "godmode-mcp-run_elsewhere0001.json"), 1024, 3 * DAY);
      expect(paths(item(await scanCleanup(), "temp-files"))).not.toContain(stale);
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_elsewhere0001'");
    }
    expect((await runCleanup(["database"])).results[0]).toMatchObject({ ok: true, removed: 1 });
  });
});

suite("old screenshots in chats", () => {
  let messageNumber = 0;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const message = (chat: string, createdAt: string, blocks: unknown[]) => {
    const id = `msg_pictures${++messageNumber}`;
    insert("messages", { id, conversation_id: chat, role: "assistant", content: "Done.", blocks: JSON.stringify(blocks), created_at: createdAt });
    return id;
  };
  const blocksOf = (id: string) => JSON.parse(get<{ blocks: string }>("SELECT blocks FROM messages WHERE id = ?", id)!.blocks);
  const shot = (id: string, bytes: number) => ({ type: "tool_use", id, name: "browser_screenshot", input: {}, result: "ok", image: "A".repeat(bytes) });

  test("pictures older than 30 days go; the steps, their results and newer pictures stay", async () => {
    const chat = createConversation({ agentId: agent.id, title: "Screens" }).id;
    const busyChat = createConversation({ agentId: agent.id, title: "Working" }).id;
    const old = message(chat, ago(40), [
      { type: "text", text: "Looking at the page." },
      { type: "tool_use", id: "tu_1", name: "browser_screenshot", input: { full: true }, result: "Took a screenshot.", image: "A".repeat(40_000) },
      { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/x.png" }, result: "", image: "B".repeat(30_000), isError: false },
      { type: "tool_use", id: "tu_3", name: "Bash", input: { command: "ls" }, result: "a.txt" },
    ]);
    // A message whose run stopped while its screenshots were saved apart.
    const apartAt = ago(35);
    const apart = message(chat, apartAt, [{ type: "tool_use", id: "tu_4", name: "computer", input: {}, result: "ok" }]);
    insert("message_images", { message_id: apart, block_id: "tu_4", image: "C".repeat(20_000) });
    const recent = message(chat, ago(5), [shot("tu_5", 10_000)]);
    const working = message(busyChat, ago(40), [shot("tu_6", 10_000)]);
    insert("runs", { id: "run_pictures0001", agent_id: agent.id, conversation_id: busyChat, trigger: "chat", status: "running", prompt: "x", created_at: new Date().toISOString() });
    try {
      const pictures = item(await scanCleanup(), "chat-pictures");
      expect(pictures.recommended).toBe(true);
      expect(pictures.entries).toEqual([{ name: "Cleaner · 3 pictures", path: null, bytes: 90_000, modifiedAt: apartAt, kept: null }]);

      const result = await runCleanup(["chat-pictures"]);
      expect(result.results[0]).toMatchObject({ ok: true, removed: 1, kept: 0 });
      // The pictures and their keys.
      expect(result.freedBytes).toBeGreaterThanOrEqual(90_000);
      expect(result.freedBytes).toBeLessThan(90_100);
      expect(blocksOf(old)).toEqual([
        { type: "text", text: "Looking at the page." },
        { type: "tool_use", id: "tu_1", name: "browser_screenshot", input: { full: true }, result: "Took a screenshot." },
        { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/x.png" }, result: "", isError: false },
        { type: "tool_use", id: "tu_3", name: "Bash", input: { command: "ls" }, result: "a.txt" },
      ]);
      expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM message_images WHERE message_id = ?", apart)?.n).toBe(0);
      expect(blocksOf(recent)[0].image).toHaveLength(10_000);
      expect(blocksOf(working)[0].image).toHaveLength(10_000);
      expect(item(await scanCleanup(), "chat-pictures").count).toBe(0);
      expect((await runCleanup(["chat-pictures"])).results[0]).toMatchObject({ ok: true, removed: 0, freedBytes: 0 });
    } finally {
      sql("DELETE FROM runs WHERE id = 'run_pictures0001'");
    }

    // Once its chat is done working, the picture it kept goes too; the newer one still stays.
    expect(item(await scanCleanup(), "chat-pictures").entries).toMatchObject([{ name: "Cleaner · 1 picture", bytes: 10_000 }]);
    expect((await runCleanup(["chat-pictures"])).results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(blocksOf(working)[0].image).toBeUndefined();
    expect(blocksOf(recent)[0].image).toHaveLength(10_000);
    expect(item(await scanCleanup(), "chat-pictures").count).toBe(0);
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
    sql("DELETE FROM meta WHERE key LIKE 'cleanup.%'");
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

  test("isn't put off by a cleanup by hand", async () => {
    await runCleanup(["trash"]);
    const leftover = file(join(tempDir, "godmode-settings-run_iiiiiiiiiiiiiiii.json"), 1024, 2 * DAY);
    await runMaintenance();
    expect(existsSync(leftover)).toBe(false);
  });

  test("leaves worktrees of tasks finished this week alone", async () => {
    const main = await makeRepo("auto");
    const lastWeek = task({ status: "done", completedAt: new Date(Date.now() - 3 * DAY).toISOString() });
    const longAgo = task({ status: "done", completedAt: new Date(Date.now() - 9 * DAY).toISOString() });
    await git(["worktree", "add", "-q", "-b", "godmode/a1", join(config().tasksDir, lastWeek)], main);
    await git(["worktree", "add", "-q", "-b", "godmode/a2", join(config().tasksDir, longAgo)], main);
    // Without a task (deleted, or an older backup was restored): only once nothing touched them for a week.
    const fresh = join(config().tasksDir, "tsk_restored1");
    const stale = join(config().tasksDir, "tsk_restored2");
    await git(["worktree", "add", "-q", "-b", "godmode/a3", fresh], main);
    await git(["worktree", "add", "-q", "-b", "godmode/a4", stale], main);
    age(stale, 9 * DAY);
    await runMaintenance();
    expect(existsSync(join(config().tasksDir, lastWeek))).toBe(true);
    expect(existsSync(join(config().tasksDir, longAgo))).toBe(false);
    expect([fresh, stale].map(existsSync)).toEqual([true, false]);
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
