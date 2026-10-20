import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentFileInfo, AgentFileMoveResult, AgentFileSearchHit, AgentFileSize, AgentFilesDeleteResult, AgentNote, DeletedAgentFile, FileReview, GitCommit } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb, run } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { expiredDeletedFiles } from "../src/agents/files";
import { runCleanup, scanCleanup } from "../src/services/cleanup";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let agent: Agent;

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`http://127.0.0.1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

const at = (rel: string) => join(agent.repoPath, rel);

function put(rel: string, content: string | Buffer, daysAgo = 0) {
  mkdirSync(join(at(rel), ".."), { recursive: true });
  writeFileSync(at(rel), content);
  if (daysAgo) {
    const t = new Date(Date.now() - daysAgo * 86_400_000);
    utimesSync(at(rel), t, t);
  }
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-agent-files-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  agent = (await call<Agent>("POST", "/api/agents", { name: "Tidy Bot" })).data;
  await call("GET", `/api/agents/${agent.id}/files?path=`);
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("files page", () => {
  test("folder sizes count every file below, without following links", async () => {
    put("workspace/reports/a.md", "x".repeat(1000));
    put("workspace/reports/deep/b.txt", "y".repeat(500));
    symlinkSync("/etc", at("workspace/reports/outside"));
    const sizes = (await call<AgentFileSize[]>("GET", `/api/agents/${agent.id}/files/sizes?path=workspace`)).data;
    const reports = sizes.find((s) => s.path === "workspace/reports")!;
    expect(reports.files).toBe(3);
    expect(reports.bytes).toBeGreaterThanOrEqual(1500);
    expect(reports.bytes).toBeLessThan(1600);
    expect((await call("GET", `/api/agents/${agent.id}/files/sizes?path=..`)).status).toBe(403);
    rmSync(at("workspace/reports/outside"));
  });

  test("delete goes to the bin and comes back; Godmode's own files stay", async () => {
    put("workspace/old/report.md", "# Old report\n");
    put("memory/old-note.md", "# Old\n");
    const res = await call<AgentFilesDeleteResult>("POST", `/api/agents/${agent.id}/files/delete`, {
      paths: ["workspace/old", "workspace/old/report.md", "memory/old-note.md", "MEMORY.md", "CLAUDE.md", "runs", "workspace/tmp", "workspace/missing.md"],
    });
    expect(res.status).toBe(200);
    expect(res.data.deleted.map((d) => d.path).sort()).toEqual(["memory/old-note.md", "workspace/old"]);
    const refused = Object.fromEntries(res.data.refused.map((r) => [r.path, r.reason]));
    expect(Object.keys(refused).sort()).toEqual(["CLAUDE.md", "MEMORY.md", "runs", "workspace/missing.md", "workspace/old/report.md", "workspace/tmp"]);
    expect(existsSync(at("workspace/old"))).toBe(false);
    expect(existsSync(at("MEMORY.md"))).toBe(true);

    const commits = (await call<GitCommit[]>("GET", `/api/agents/${agent.id}/commits`)).data;
    expect(commits[0]!.message).toMatch(/^Delete (memory\/old-note\.md|workspace\/old) and 1 more$/);

    const bin = (await call<DeletedAgentFile[]>("GET", `/api/agents/${agent.id}/files/deleted`)).data;
    expect(bin).toHaveLength(2);
    const folder = bin.find((b) => b.path === "workspace/old")!;
    expect(folder.type).toBe("dir");
    expect(folder.files).toBe(1);

    // Something new took its place meanwhile: it comes back next to it.
    put("workspace/old", "new file");
    const restored = await call<{ path: string }>("POST", `/api/agents/${agent.id}/files/deleted/${folder.id}/restore`);
    expect(restored.data.path).toBe("workspace/old (restored)");
    expect(readFileSync(at("workspace/old (restored)/report.md"), "utf8")).toBe("# Old report\n");

    const note = bin.find((b) => b.path === "memory/old-note.md")!;
    expect((await call("DELETE", `/api/agents/${agent.id}/files/deleted/${note.id}`)).status).toBe(200);
    expect((await call<DeletedAgentFile[]>("GET", `/api/agents/${agent.id}/files/deleted`)).data).toHaveLength(0);
    expect((await call("POST", `/api/agents/${agent.id}/files/deleted/${note.id}/restore`)).status).toBe(404);
    expect((await call("POST", `/api/agents/${agent.id}/files/delete`, { paths: [".git/config"] })).status).toBe(403);
  });

  test("a move points the memory at the new place, never over another entry", async () => {
    put("workspace/drafts/plan.md", "# Plan\n");
    put("memory/topic.md", "# Topic\nSee workspace/drafts/plan.md.\n");
    writeFileSync(at("MEMORY.md"), "# Memory\n- [Topic](memory/topic.md)\n- Plan: workspace/drafts/plan.md\n- Other agent: /x/other/workspace/drafts/plan.md\n");
    const moved = await call<AgentFileMoveResult>("POST", `/api/agents/${agent.id}/files/move`, { from: "workspace/drafts/plan.md", to: "workspace/plans/q4.md" });
    expect(moved.status).toBe(200);
    expect(moved.data.rewritten.sort()).toEqual(["MEMORY.md", "memory/topic.md"]);
    const memory = readFileSync(at("MEMORY.md"), "utf8");
    expect(memory).toContain("- Plan: workspace/plans/q4.md");
    expect(memory).toContain("/x/other/workspace/drafts/plan.md");

    const renamed = await call<AgentFileMoveResult>("POST", `/api/agents/${agent.id}/files/move`, { from: "memory/topic.md", to: "memory/topics/main.md" });
    expect(renamed.data.rewritten).toEqual(["MEMORY.md"]);
    expect(readFileSync(at("MEMORY.md"), "utf8")).toContain("(memory/topics/main.md)");

    put("workspace/plans/other.md", "x");
    expect((await call("POST", `/api/agents/${agent.id}/files/move`, { from: "workspace/plans/other.md", to: "workspace/plans/q4.md" })).status).toBe(409);
    expect((await call("POST", `/api/agents/${agent.id}/files/move`, { from: "workspace/plans", to: "workspace/plans/inner" })).status).toBe(400);
    expect((await call("POST", `/api/agents/${agent.id}/files/move`, { from: "workspace/plans/other.md", to: "state/other.md" })).status).toBe(400);
    expect((await call("POST", `/api/agents/${agent.id}/files/move`, { from: "MEMORY.md", to: "workspace/m.md" })).status).toBe(403);
    expect((await call<GitCommit[]>("GET", `/api/agents/${agent.id}/commits`)).data[0]!.message).toBe("Move memory/topic.md to memory/topics/main.md");
  });

  test("inspect says what names a path and whether it may go", async () => {
    const info = (await call<AgentFileInfo[]>("POST", `/api/agents/${agent.id}/files/inspect`, { paths: ["workspace/plans/q4.md", "memory/topics/main.md", "CLAUDE.md"] })).data;
    const by = Object.fromEntries(info.map((i) => [i.path, i]));
    expect(by["workspace/plans/q4.md"]!.namedBy).toContain("MEMORY.md");
    expect(by["memory/topics/main.md"]!.namedBy).toEqual(["MEMORY.md"]);
    expect(by["CLAUDE.md"]!.locked).toContain("settings");
  });

  test("new folders only inside workspace/ or memory/", async () => {
    expect((await call("POST", `/api/agents/${agent.id}/files/folder`, { path: "workspace/clients/acme" })).status).toBe(200);
    expect(existsSync(at("workspace/clients/acme"))).toBe(true);
    expect((await call("POST", `/api/agents/${agent.id}/files/folder`, { path: "workspace/clients/acme" })).status).toBe(409);
    expect((await call("POST", `/api/agents/${agent.id}/files/folder`, { path: "runs/x" })).status).toBe(400);
  });

  test("the review finds clutter and marks what the agent still names", async () => {
    const big = Buffer.alloc(4096, 7);
    put("workspace/app/package.json", "{}");
    put("workspace/app/node_modules/left-pad/index.js", "module.exports = 1;");
    put("workspace/app/dist/bundle.js", "x");
    put("workspace/shots/one.png", big, 5);
    put("workspace/shots/copy-of-one.png", big, 1);
    put("workspace/.DS_Store", "x");
    put("workspace/empty.txt", "");
    mkdirSync(at("workspace/nothing-here"), { recursive: true });
    put("workspace/archive/2026-08/notes.md", "# August\n", 60);
    put("workspace/loose-report.md", "# Loose\n", 10);
    put("firebase-debug.log", "debug");
    put("memory/forgotten.md", "# Nobody links here\n");
    writeFileSync(at("MEMORY.md"), `${readFileSync(at("MEMORY.md"), "utf8")}- [Gone](memory/gone.md)\n- Shots: workspace/shots/one.png\n`);

    const review = (await call<FileReview>("GET", `/api/agents/${agent.id}/files/review?fresh=1`)).data;
    const kind = (path: string) => review.items.find((i) => i.path === path)?.kind;
    expect(kind("workspace/app/node_modules")).toBe("build");
    expect(kind("workspace/app/dist")).toBe("build");
    expect(kind("workspace/app/node_modules/left-pad/index.js")).toBeUndefined();
    expect(kind("workspace/.DS_Store")).toBe("junk");
    expect(kind("firebase-debug.log")).toBe("junk");
    expect(kind("workspace/empty.txt")).toBe("empty");
    expect(kind("workspace/nothing-here")).toBe("empty");
    const copy = review.items.find((i) => i.path === "workspace/shots/copy-of-one.png")!;
    expect(copy.kind).toBe("duplicate");
    expect(copy.related).toBe("workspace/shots/one.png");
    expect(kind("workspace/archive")).toBe("stale");
    expect(kind("workspace/loose-report.md")).toBe("loose");
    expect(kind("memory/forgotten.md")).toBe("unlinked-note");
    expect(kind("memory/topics/main.md")).toBeUndefined();
    const broken = review.items.find((i) => i.kind === "broken-link")!;
    expect(broken.path).toBe("memory/gone.md");
    expect(broken.related).toBe("MEMORY.md");
    expect(review.items.some((i) => i.path === "workspace/uploads" || i.path === "workspace/tmp")).toBe(false);
  });

  test("notes list and search", async () => {
    const notes = (await call<AgentNote[]>("GET", `/api/agents/${agent.id}/files/notes`)).data;
    const by = Object.fromEntries(notes.map((n) => [n.path, n]));
    expect(by["MEMORY.md"]!.linked).toBe(true);
    expect(by["memory/topics/main.md"]!.linked).toBe(true);
    expect(by["memory/forgotten.md"]!.linked).toBe(false);
    expect(by["workspace/plans/q4.md"]!.title).toBe("Plan");
    expect(by["workspace/plans/q4.md"]!.namedBy).toBe("MEMORY.md");

    const hits = (await call<AgentFileSearchHit[]>("GET", `/api/agents/${agent.id}/files/search?q=nobody%20links`)).data;
    expect(hits).toEqual([{ path: "memory/forgotten.md", type: "file", line: 1, snippet: "# Nobody links here" }]);
    const byName = (await call<AgentFileSearchHit[]>("GET", `/api/agents/${agent.id}/files/search?q=q4`)).data;
    expect(byName.map((h) => h.path)).toContain("workspace/plans/q4.md");
    expect((await call<AgentFileSearchHit[]>("GET", `/api/agents/${agent.id}/files/search?q=left-pad`)).data).toEqual([]);
  });

  test("nothing moves while the agent dreams", async () => {
    run("INSERT INTO runs (id, agent_id, conversation_id, trigger, status, prompt, created_at) VALUES ('run_dream', ?, 'cnv_dream', 'dream', 'running', '', datetime('now'))", agent.id);
    run("INSERT INTO dreams (id, agent_id, run_id, status, reason, created_at) VALUES ('drm_x', ?, 'run_dream', 'running', 'manual', datetime('now'))", agent.id);
    try {
      expect((await call("POST", `/api/agents/${agent.id}/files/delete`, { paths: ["workspace/loose-report.md"] })).status).toBe(409);
      expect((await call("POST", `/api/agents/${agent.id}/files/move`, { from: "workspace/loose-report.md", to: "workspace/r.md" })).status).toBe(409);
    } finally {
      run("DELETE FROM dreams WHERE id = 'drm_x'");
      run("DELETE FROM runs WHERE id = 'run_dream'");
    }
  });

  test("the cleanup empties what waited in the bin for 30 days", async () => {
    put("workspace/expired.md", "bye");
    const del = (await call<AgentFilesDeleteResult>("POST", `/api/agents/${agent.id}/files/delete`, { paths: ["workspace/expired.md"] })).data;
    const entry = del.deleted[0]!;
    const binEntry = join(dataDir, "agents", ".deleted-files", agent.id, entry.id);
    writeFileSync(join(binEntry, "entry.json"), JSON.stringify({ ...entry, deletedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }));
    expect(expiredDeletedFiles().map((e) => e.path)).toEqual(["workspace/expired.md"]);
    const item = (await scanCleanup()).items.find((i) => i.id === "deleted-files")!;
    expect(item.count).toBe(1);
    expect(item.recommended).toBe(true);
    await runCleanup(["deleted-files"]);
    expect(existsSync(binEntry)).toBe(false);
    expect(readdirSync(join(dataDir, "agents", ".deleted-files", agent.id))).toEqual([]);
  });

  test("overview row per agent", async () => {
    const rows = (await call<{ agentId: string; notes: number; bytes: number }[]>("GET", "/api/files/overview")).data;
    const row = rows.find((r) => r.agentId === agent.id)!;
    expect(row.notes).toBeGreaterThanOrEqual(4);
    expect(row.bytes).toBeGreaterThan(0);
  });
});
