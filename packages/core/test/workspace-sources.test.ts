import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSource } from "@godmode/shared";
import { parseGitUrl } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb, run } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace } from "../src/services/workspaces";
import { __setRunSyncWaitForTests, gitFailure, prepareSources, reposDir, syncSource } from "../src/services/workspaceSources";
import { buildSystemPrompt, resumeContextPrefix } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";
import { HttpError } from "../src/util";
import { startGitServer, type GitServer } from "./fixtures/git-server";

let dataDir: string;
let outside: string;
let server: GitServer;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-sources-"));
  outside = mkdtempSync(join(tmpdir(), "godmode-sources-folders-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  server = startGitServer();
});

afterAll(() => {
  server.close();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function folder(name: string): string {
  const path = join(outside, name);
  mkdirSync(path, { recursive: true });
  return path;
}

async function settled(workspaceId: string, sourceId: string): Promise<WorkspaceSource> {
  for (let i = 0; i < 300; i++) {
    const source = getWorkspace(workspaceId).sources.find((s) => s.id === sourceId);
    if (!source) throw new Error("source is gone");
    if (source.status !== "cloning" && source.status !== "syncing") return source;
    await Bun.sleep(50);
  }
  throw new Error("clone did not finish");
}

function status(err: unknown): number {
  expect(err).toBeInstanceOf(HttpError);
  return (err as HttpError).status;
}

describe("parseGitUrl", () => {
  test("normalizes web links and keeps SSH URLs", () => {
    expect(parseGitUrl("https://github.com/codextde/godmode-bot")).toEqual({ url: "https://github.com/codextde/godmode-bot.git", name: "godmode-bot", branch: null });
    expect(parseGitUrl("https://github.com/codextde/godmode-bot/tree/feature/x")).toMatchObject({ branch: "feature/x" });
    expect(parseGitUrl("https://gitlab.com/group/sub/app/-/tree/main")).toEqual({ url: "https://gitlab.com/group/sub/app.git", name: "app", branch: "main" });
    expect(parseGitUrl("git@github.com:codextde/godmode-bot.git")).toEqual({ url: "git@github.com:codextde/godmode-bot.git", name: "godmode-bot", branch: null });
  });

  test("refuses credentials, local paths and other transports", () => {
    for (const bad of ["https://user:token@github.com/a/b.git", "https://token@github.com/a/b.git", "file:///etc", "/Users/me/repo", "ext::sh -c id", "--upload-pack=x", ""]) {
      expect(parseGitUrl(bad)).toHaveProperty("error");
    }
  });
});

describe("workspace folders", () => {
  test("are added, kept, reordered and removed", () => {
    const a = folder("site");
    const b = folder("docs");
    const ws = createWorkspace({ name: "Folders", sources: [{ kind: "folder", path: a }] });
    expect(ws.sources).toHaveLength(1);
    expect(ws.sources[0]).toMatchObject({ kind: "folder", name: "site", path: a, status: "ready", error: null });
    const id = ws.sources[0]!.id;

    const both = updateWorkspace(ws.id, { sources: [{ kind: "folder", path: b }, { kind: "folder", path: a }, { kind: "folder", path: a }] });
    expect(both.sources.map((s) => s.name)).toEqual(["docs", "site"]);
    expect(both.sources[1]!.id).toBe(id);

    expect(updateWorkspace(ws.id, { color: "rose" }).sources).toHaveLength(2);
    expect(updateWorkspace(ws.id, { sources: [{ kind: "folder", path: a }] }).sources.map((s) => s.id)).toEqual([id]);
    expect(listWorkspaces().find((w) => w.id === ws.id)!.sources).toHaveLength(1);
  });

  test("must exist and stay out of the data directory", () => {
    const ws = createWorkspace({ name: "Guarded" });
    for (const path of [join(outside, "nope"), dataDir, join(dataDir, "agents"), "relative/path"]) {
      let err: unknown;
      try {
        updateWorkspace(ws.id, { sources: [{ kind: "folder", path }] });
      } catch (e) {
        err = e;
      }
      expect(status(err)).toBe(400);
    }
    expect(getWorkspace(ws.id).sources).toEqual([]);
  });

  test("a folder that went missing is reported, skipped by runs, and doesn't block saving", async () => {
    const gone = folder("gone");
    const ws = createWorkspace({ name: "Missing", sources: [{ kind: "folder", path: gone }] });
    rmSync(gone, { recursive: true });
    expect(getWorkspace(ws.id).sources[0]).toMatchObject({ status: "missing" });
    expect(updateWorkspace(ws.id, { name: "Missing 2", sources: [{ kind: "folder", path: gone }] }).sources).toHaveLength(1);
    const prepared = await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: () => {}, signal: new AbortController().signal });
    expect(prepared.sources).toEqual([]);
    expect(prepared.notices[0]).toContain('"gone" was skipped');
  });
});

describe("workspace repositories", () => {
  test("bad URLs and branches are refused", () => {
    const ws = createWorkspace({ name: "Bad URLs" });
    const attempts = [
      { kind: "git" as const, url: "https://user:secret@example.com/a/b.git" },
      { kind: "git" as const, url: "file:///tmp/repo" },
      { kind: "git" as const, url: server.url, branch: "--upload-pack=touch" },
    ];
    for (const source of attempts) {
      let err: unknown;
      try {
        updateWorkspace(ws.id, { sources: [source] });
      } catch (e) {
        err = e;
      }
      expect(status(err)).toBe(400);
    }
  });

  test("are cloned when added, updated on sync, and trashed when removed", async () => {
    const ws = createWorkspace({ name: "Repos", sources: [{ kind: "git", url: server.url }] });
    const added = ws.sources[0]!;
    expect(added).toMatchObject({ kind: "git", name: "app", url: server.url, branch: null });
    expect(added.path).toBe(join(reposDir(), ws.id, "app"));

    const cloned = await settled(ws.id, added.id);
    expect(cloned.status).toBe("ready");
    expect(cloned.headBranch).toBe("main");
    expect(cloned.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(readFileSync(join(cloned.path, "README.md"), "utf8")).toBe("# App\n");

    const next = server.commit("CHANGELOG.md", "v2\n");
    expect(syncSource(ws.id, added.id).status).toBe("syncing");
    const synced = await settled(ws.id, added.id);
    expect(synced.commit).toBe(next);
    expect(existsSync(join(synced.path, "CHANGELOG.md"))).toBe(true);

    // Local work is never overwritten: with changes, a sync only fetches and says why.
    writeFileSync(join(synced.path, "README.md"), "# Local edit\n");
    server.commit("NEWS.md", "news\n");
    syncSource(ws.id, added.id);
    const kept = await settled(ws.id, added.id);
    expect(kept.commit).toBe(next);
    expect(kept.note).toContain("local changes");
    expect(readFileSync(join(synced.path, "README.md"), "utf8")).toBe("# Local edit\n");

    updateWorkspace(ws.id, { sources: [] });
    for (let i = 0; i < 100 && existsSync(synced.path); i++) await Bun.sleep(20);
    expect(existsSync(synced.path)).toBe(false);
    expect(readdirSync(join(reposDir(), ".trash")).some((n) => n.startsWith(`${ws.id}-app`))).toBe(true);
  });

  test("the same repository twice gets separate folders; a branch is checked out", async () => {
    const branchUrl = server.url;
    const ws = createWorkspace({
      name: "Twice",
      sources: [
        { kind: "git", url: server.url },
        { kind: "git", url: branchUrl, branch: "main" },
      ],
    });
    expect(ws.sources.map((s) => s.path.split(/[\\/]/).at(-1))).toEqual(["app", "app-2"]);
    const second = await settled(ws.id, ws.sources[1]!.id);
    expect(second).toMatchObject({ status: "ready", branch: "main", headBranch: "main" });
  });

  test("an unreachable repository reports an error and runs go on without it", async () => {
    const ws = createWorkspace({ name: "Unreachable", sources: [{ kind: "git", url: "http://127.0.0.1:9/missing.git" }] });
    const failed = await settled(ws.id, ws.sources[0]!.id);
    expect(failed.status).toBe("error");
    expect(failed.error).toBeTruthy();
    const prepared = await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: () => {}, signal: new AbortController().signal });
    expect(prepared.sources).toEqual([]);
    expect(prepared.notices[0]).toContain("couldn't be cloned");
  });

  test("a failed update keeps the clone usable, and runs don't retry it every time", async () => {
    const ws = createWorkspace({ name: "Flaky", sources: [{ kind: "git", url: server.url }] });
    const source = await settled(ws.id, ws.sources[0]!.id);
    Bun.spawnSync(["git", "remote", "set-url", "origin", "http://127.0.0.1:9/gone.git"], { cwd: source.path });
    run("UPDATE workspace_sources SET synced_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", source.id);

    const labels: string[] = [];
    const first = await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: (l) => labels.push(l), signal: new AbortController().signal });
    expect(labels).toEqual(["Updating app …"]);
    expect(first.sources.map((s) => s.path)).toEqual([source.path]);
    const failed = getWorkspace(ws.id).sources[0]!;
    expect(failed.status).toBe("ready");
    expect(failed.error).toContain("127.0.0.1");

    const again: string[] = [];
    await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: (l) => again.push(l), signal: new AbortController().signal });
    expect(again).toEqual([]);
  });

  test("a run doesn't wait for a slow update: the fetch finishes behind it without touching the checkout", async () => {
    const ws = createWorkspace({ name: "Slow", sources: [{ kind: "git", url: server.url }] });
    const source = await settled(ws.id, ws.sources[0]!.id);
    run("UPDATE workspace_sources SET synced_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", source.id);
    const next = server.commit("SLOW.md", "slow\n");
    server.delayMs = 400;
    __setRunSyncWaitForTests(150);
    try {
      const started = Date.now();
      const first = await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: () => {}, signal: new AbortController().signal });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(first.sources.map((s) => s.path)).toEqual([source.path]);
      // The run started with the files as they were: nothing changes under it.
      const behind = await settled(ws.id, source.id);
      expect(behind.error).toBeNull();
      expect(behind.commit).toBe(source.commit);
      expect(existsSync(join(source.path, "SLOW.md"))).toBe(false);

      // Another run soon after leaves it alone too: the first may still work in that checkout.
      server.delayMs = 0;
      __setRunSyncWaitForTests(20_000);
      const labels: string[] = [];
      await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: (l) => labels.push(l), signal: new AbortController().signal });
      expect(labels).toEqual([]);
      expect(existsSync(join(source.path, "SLOW.md"))).toBe(false);
      // An update by hand fast-forwards to what was fetched.
      syncSource(ws.id, source.id);
      expect((await settled(ws.id, source.id)).commit).toBe(next);
      expect(existsSync(join(source.path, "SLOW.md"))).toBe(true);
    } finally {
      server.delayMs = 0;
      __setRunSyncWaitForTests(20_000);
    }
  });

  test("an update by hand while a fetch runs behind a run fast-forwards once that fetch is done", async () => {
    const ws = createWorkspace({ name: "Asked", sources: [{ kind: "git", url: server.url }] });
    const source = await settled(ws.id, ws.sources[0]!.id);
    run("UPDATE workspace_sources SET synced_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", source.id);
    const next = server.commit("ASKED.md", "asked\n");
    server.delayMs = 400;
    __setRunSyncWaitForTests(100);
    try {
      await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: () => {}, signal: new AbortController().signal });
      expect(getWorkspace(ws.id).sources[0]!.status).toBe("syncing");
      syncSource(ws.id, source.id);
      const done = await settled(ws.id, source.id);
      expect(done.commit).toBe(next);
      expect(existsSync(join(source.path, "ASKED.md"))).toBe(true);
    } finally {
      server.delayMs = 0;
      __setRunSyncWaitForTests(20_000);
    }
  });

  test("removing a repository while it clones stops the clone", async () => {
    server.delayMs = 400;
    try {
      const ws = createWorkspace({ name: "Impatient", sources: [{ kind: "git", url: server.url }] });
      const source = ws.sources[0]!;
      expect(source.status).toBe("cloning");
      const started = Date.now();
      await deleteWorkspace(ws.id);
      expect(Date.now() - started).toBeLessThan(2_000);
      await Bun.sleep(100);
      expect(existsSync(join(reposDir(), ws.id))).toBe(false);
    } finally {
      server.delayMs = 0;
    }
  });

  test("runs clone missing repositories first", async () => {
    const ws = createWorkspace({ name: "Lazy", sources: [{ kind: "git", url: server.url }] });
    const source = await settled(ws.id, ws.sources[0]!.id);
    rmSync(source.path, { recursive: true });
    expect(getWorkspace(ws.id).sources[0]!.status).toBe("missing");
    const labels: string[] = [];
    const prepared = await prepareSources([{ workspaceId: ws.id, projectId: null }], { onActivity: (l) => labels.push(l), signal: new AbortController().signal });
    expect(labels).toEqual(["Cloning app …"]);
    expect(prepared.sources).toEqual([{ kind: "git", name: "app", path: source.path, url: server.url, branch: null }]);
    expect(existsSync(join(source.path, ".git"))).toBe(true);
  });

  test("deleting the workspace trashes its clones", async () => {
    const ws = createWorkspace({ name: "Doomed", sources: [{ kind: "git", url: server.url }] });
    const source = await settled(ws.id, ws.sources[0]!.id);
    await deleteWorkspace(ws.id);
    expect(existsSync(source.path)).toBe(false);
    expect(existsSync(join(reposDir(), ws.id))).toBe(false);
  });

  test("git failures read like advice", () => {
    expect(gitFailure({ stderr: "fatal: Remote branch nope not found in upstream origin", timedOut: false }, "https://github.com/a/b.git", "nope")).toContain(
      'The branch "nope" doesn\'t exist',
    );
    expect(gitFailure({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", timedOut: false }, "https://github.com/a/b.git", null)).toContain(
      "sign in to git",
    );
    expect(gitFailure({ stderr: "", timedOut: true }, "git@github.com:a/b.git", null)).toBe("Timed out talking to github.com.");
  });
});

describe("prompt", () => {
  const sources = {
    workspace: "Acme",
    items: [
      { kind: "folder" as const, name: "site", path: "/work/site", url: null, branch: null },
      { kind: "git" as const, name: "app", path: "/data/repos/wsp_1/app", url: "https://github.com/acme/app.git", branch: "develop" },
    ],
  };

  test("lists the workspace's folders and repositories", () => {
    const system = buildSystemPrompt({
      agent: { id: "agt_1", name: "Bot", repoPath: "/data/agents/bot", permissions: { allowDelegation: false, canManageAgents: false, secretAccess: "fill" } } as never,
      settings: getSettings(),
      peers: [],
      browserAvailable: false,
      sources,
    });
    expect(system).toContain('### Workspace folders and repositories\nAttached to the "Acme" workspace for every agent in it');
    expect(system).toContain("- `/work/site` (folder)");
    expect(system).toContain("- `/data/repos/wsp_1/app` (clone of https://github.com/acme/app.git, branch `develop`)");
    expect(system).toContain("share these clones");
  });

  test("resumed turns restate them", () => {
    const prefix = resumeContextPrefix(null, "/data/agents/bot", { sources });
    expect(prefix).toContain("Workspace folders and repositories (added to this session): `/work/site` (folder), `/data/repos/wsp_1/app` (clone of");
    expect(resumeContextPrefix(null, "/data/agents/bot")).not.toContain("Workspace folders");
  });
});
