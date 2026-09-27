import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb, run } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import {
  createAgent,
  commitAgentRepo,
  deleteAgent,
  ensureAgentRepo,
  ensureDefaultAgent,
  getAgent,
  getDefaultAgentId,
  listAgentCommits,
  listAgentFiles,
  listAgents,
  peersFor,
  readAgentFile,
  setAgentStatus,
  touchAgentRun,
  updateAgent,
  writeAgentFile,
} from "../src/agents/service";
import * as repo from "../src/agents/repo";
import { AGENT_TEMPLATES } from "../src/agents/templates";
import { HttpError } from "../src/util";

let dataDir: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-agents-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function expectHttpError(p: Promise<unknown> | (() => unknown), status: number, match?: string | RegExp) {
  let error: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  if (match) expect((error as HttpError).message).toMatch(match);
}

function workspace(name: string): string {
  const id = `wsp_${name}`;
  const ts = new Date().toISOString();
  insert("workspaces", { id, name, slug: name.toLowerCase(), created_at: ts, updated_at: ts });
  return id;
}

describe("agent creation", () => {
  test("creates the repository with generated files and an initial commit", async () => {
    const agent = await createAgent({ name: "Invoice Bot", instructions: "Collect invoices from vendor portals." });
    expect(agent.slug).toBe("invoice-bot");
    expect(agent.repoPath).toBe(join(dataDir, "agents", "invoice-bot"));
    expect(agent.avatar).toBe("🤖");
    expect(agent.color).toBe("violet");
    expect(agent.model).toBe("");
    expect(agent.status).toBe("idle");
    expect(agent.permissions).toEqual({
      canManageAgents: false,
      allowDelegation: true,
      delegateTo: [],
      secretAccess: "fill",
      credentialIds: null,
      totpIds: null,
      maxBudgetUsd: null,
    });
    expect(agent.browser).toEqual({ profileId: null, enabled: true, headless: null });

    for (const file of [
      "CLAUDE.md",
      "MEMORY.md",
      ".gitignore",
      "state/agent.json",
      "memory/.gitkeep",
      "workspace/.gitkeep",
      "conversations/.gitkeep",
      "runs/.gitkeep",
      ".git/HEAD",
    ]) {
      expect(existsSync(join(agent.repoPath, file))).toBe(true);
    }
    const claudeMd = readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# 🤖 Invoice Bot");
    expect(claudeMd).toContain("Collect invoices from vendor portals.");
    expect(claudeMd).toContain("## Your files");
    expect(claudeMd).toContain("## Ground rules");
    // The tool guide and login procedure come from the runner's appended system prompt, not CLAUDE.md.
    expect(claudeMd).not.toContain("vault_fill_login");
    expect(claudeMd).not.toContain("report_missing_login");
    expect(claudeMd.split("\n").length).toBeLessThan(150);
    expect(readFileSync(join(agent.repoPath, ".gitignore"), "utf8")).toContain("workspace/tmp/");
    expect(readFileSync(join(agent.repoPath, ".git/HEAD"), "utf8")).toContain("refs/heads/main");

    const state = JSON.parse(readFileSync(join(agent.repoPath, "state/agent.json"), "utf8"));
    expect(state.id).toBe(agent.id);
    expect(state.status).toBeUndefined();

    const commits = await listAgentCommits(agent.id);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe("Create agent Invoice Bot");
    expect(commits[0]!.author).toBe("Godmode Bot");
  });

  test("slugs are unique across agents and existing directories", async () => {
    const a = await createAgent({ name: "Research Bot" });
    const b = await createAgent({ name: "Research Bot" });
    expect(a.slug).toBe("research-bot");
    expect(b.slug).toBe("research-bot-2");
    mkdirSync(join(dataDir, "agents", "leftover"), { recursive: true });
    const c = await createAgent({ name: "Leftover" });
    expect(c.slug).toBe("leftover-2");
  });

  test("uses the configured default secret access and emits agent.updated", async () => {
    updateSettings({ security: { defaultSecretAccess: "reveal" } });
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    try {
      const agent = await createAgent({ name: "Api Bot" });
      expect(agent.permissions.secretAccess).toBe("reveal");
      expect(events.some((e) => e.type === "agent.updated" && e.agent.id === agent.id)).toBe(true);
    } finally {
      off();
      updateSettings({ security: { defaultSecretAccess: "fill" } });
    }
  });

  test("rejects invalid input", async () => {
    await expectHttpError(createAgent({ name: "   " }), 400, /name is required/);
    await expectHttpError(createAgent({ name: "X", workspaceId: "wsp_missing" }), 400, /Workspace not found/);
    await expectHttpError(createAgent({ name: "X", effort: "turbo" as never }), 400, /Invalid effort/);
    await expectHttpError(createAgent({ name: "X", browser: { profileId: "bpr_missing" } }), 400, /Browser profile/);
  });
});

describe("agent updates", () => {
  test("updateAgent regenerates CLAUDE.md and state/agent.json and commits", async () => {
    const agent = await createAgent({ name: "Writer", instructions: "Write blog posts." });
    const updated = await updateAgent(agent.id, {
      name: "Senior Writer",
      instructions: "Write long-form articles in British English.",
      permissions: { allowDelegation: false, maxBudgetUsd: 5 },
      subagents: [{ name: "editor", description: "Proofreads drafts", prompt: "You proofread text." }],
    });
    expect(updated.slug).toBe("writer");
    expect(updated.name).toBe("Senior Writer");
    expect(updated.permissions.allowDelegation).toBe(false);
    expect(updated.permissions.secretAccess).toBe("fill");

    const claudeMd = readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# 🤖 Senior Writer");
    expect(claudeMd).toContain("British English");
    expect(claudeMd).not.toContain("Write blog posts.");
    expect(claudeMd).toContain("**editor** — Proofreads drafts");
    expect(claudeMd).toContain("$5");
    expect(JSON.parse(readFileSync(join(agent.repoPath, "state/agent.json"), "utf8")).name).toBe("Senior Writer");

    const commits = await listAgentCommits(agent.id);
    expect(commits.map((c) => c.message)).toEqual(["Update agent settings", "Create agent Writer"]);
  });

  test("disabling sets status disabled, re-enabling returns to idle", async () => {
    const agent = await createAgent({ name: "Toggle" });
    expect((await updateAgent(agent.id, { enabled: false })).status).toBe("disabled");
    setAgentStatus(agent.id, "idle");
    expect(getAgent(agent.id).status).toBe("disabled");
    expect((await updateAgent(agent.id, { enabled: true })).status).toBe("idle");
  });

  test("setAgentStatus and touchAgentRun update runtime fields", async () => {
    const agent = await createAgent({ name: "Runner" });
    setAgentStatus(agent.id, "running");
    expect(getAgent(agent.id).status).toBe("running");
    touchAgentRun(agent.id);
    expect(getAgent(agent.id).lastRunAt).not.toBeNull();
    setAgentStatus("agt_unknown", "idle"); // ignored
  });
});

describe("default agent", () => {
  test("ensureDefaultAgent creates the Godmode orchestrator once", async () => {
    const agent = await ensureDefaultAgent();
    expect(agent.slug).toBe("godmode");
    expect(agent.avatar).toBe("⚡");
    expect(agent.isDefault).toBe(true);
    expect(agent.workspaceId).toBeNull();
    expect(agent.permissions.canManageAgents).toBe(true);
    expect(agent.permissions.allowDelegation).toBe(true);
    expect(getDefaultAgentId()).toBe(agent.id);
    const claudeMd = readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("orchestrator");
    expect(claudeMd).toContain("Your main AI coworker");

    const again = await ensureDefaultAgent();
    expect(again.id).toBe(agent.id);
    expect(listAgents().filter((a) => a.isDefault)).toHaveLength(1);
  });

  test("repairs a missing repository without overwriting user edits", async () => {
    const agent = await ensureDefaultAgent();
    await writeAgentFile(agent.id, "MEMORY.md", "# My memory\n");
    rmSync(join(agent.repoPath, "CLAUDE.md"));
    await ensureDefaultAgent();
    expect(existsSync(join(agent.repoPath, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(agent.repoPath, "MEMORY.md"), "utf8")).toBe("# My memory\n");
  });

  test("re-attaches the existing godmode repository after a database reset", async () => {
    const before = await ensureDefaultAgent();
    await writeAgentFile(before.id, "memory/keep.md", "keep me\n");
    run("DELETE FROM agents WHERE id = ?", before.id);
    const after = await ensureDefaultAgent();
    expect(after.id).not.toBe(before.id);
    expect(after.slug).toBe("godmode");
    expect(readFileSync(join(after.repoPath, "memory/keep.md"), "utf8")).toBe("keep me\n");
    expect((await listAgentCommits(after.id)).map((c) => c.message).slice(0, 2)).toEqual([
      "Re-attach agent Godmode",
      "Edit memory/keep.md",
    ]);
  });

  test("the default agent cannot be deleted, disabled or moved", async () => {
    const id = getDefaultAgentId()!;
    await expectHttpError(deleteAgent(id), 400, /cannot be deleted/);
    await expectHttpError(updateAgent(id, { enabled: false }), 400, /cannot be disabled/);
    const ws = workspace("Moves");
    await expectHttpError(updateAgent(id, { workspaceId: ws }), 400, /global/);
    expect(getAgent(id).isDefault).toBe(true);
  });
});

describe("agent deletion", () => {
  test("deleteAgent moves the repository to .trash", async () => {
    const agent = await createAgent({ name: "Temp Agent" });
    await deleteAgent(agent.id);
    await expectHttpError(() => getAgent(agent.id), 404);
    expect(existsSync(agent.repoPath)).toBe(false);
    const trashed = readdirSync(join(dataDir, "agents", ".trash")).filter((d) => d.startsWith("temp-agent-"));
    expect(trashed).toHaveLength(1);
    expect(existsSync(join(dataDir, "agents", ".trash", trashed[0]!, "CLAUDE.md"))).toBe(true);
  });

  test("deleted agents are removed from other agents' delegate lists", async () => {
    const target = await createAgent({ name: "Target" });
    const boss = await createAgent({ name: "Boss", permissions: { delegateTo: [target.id] } });
    await deleteAgent(target.id);
    expect(getAgent(boss.id).permissions.delegateTo).toEqual([]);
  });
});

describe("scopes and peers", () => {
  test("listAgents filters by workspace scope", async () => {
    const ws = workspace("Scoped");
    const inWs = await createAgent({ name: "Scoped Agent", workspaceId: ws });
    const defaultId = (await ensureDefaultAgent()).id;

    const global = listAgents({ workspaceId: null });
    expect(global.some((a) => a.id === inWs.id)).toBe(false);
    expect(global.some((a) => a.id === defaultId)).toBe(true);
    expect(listAgents({ workspaceId: "global" }).map((a) => a.id)).toEqual(global.map((a) => a.id));

    const scoped = listAgents({ workspaceId: ws });
    expect(scoped.map((a) => a.id).sort()).toEqual([defaultId, inWs.id].sort());
    expect(scoped[0]!.isDefault).toBe(true);

    expect(listAgents({ workspaceId: "all" }).some((a) => a.id === inWs.id)).toBe(true);
    expect(getAgent(inWs.slug).id).toBe(inWs.id);
  });

  test("peersFor respects workspace boundaries, enabled state and delegateTo", async () => {
    const wsA = workspace("PeersA");
    const wsB = workspace("PeersB");
    const a1 = await createAgent({ name: "A1", workspaceId: wsA });
    const a2 = await createAgent({ name: "A2", workspaceId: wsA });
    const b1 = await createAgent({ name: "B1", workspaceId: wsB });
    const g = await createAgent({ name: "Global Helper" });
    const off = await createAgent({ name: "Off", workspaceId: wsA, enabled: false });

    const peers = peersFor(a1).map((p) => p.id);
    expect(peers).toContain(a2.id);
    expect(peers).toContain(g.id);
    expect(peers).not.toContain(a1.id);
    expect(peers).not.toContain(b1.id);
    expect(peers).not.toContain(off.id);

    const restricted = await updateAgent(a1.id, { permissions: { delegateTo: [g.id] } });
    expect(peersFor(restricted).map((p) => p.id)).toEqual([g.id]);

    const orchestrator = getAgent(getDefaultAgentId()!);
    const all = peersFor(orchestrator).map((p) => p.id);
    expect(all).toContain(b1.id);
    expect(all).toContain(a2.id);
    expect(all).not.toContain(orchestrator.id);
  });
});

describe("repository files", () => {
  test("lists files with dirs first and without .git", async () => {
    const agent = await createAgent({ name: "Files" });
    const entries = await listAgentFiles(agent.id);
    const names = entries.map((e) => e.path);
    expect(names).not.toContain(".git");
    const firstFile = entries.findIndex((e) => e.type === "file");
    expect(entries.slice(0, firstFile).every((e) => e.type === "dir")).toBe(true);
    expect(names).toContain("CLAUDE.md");
    expect(names).toContain("workspace");
    expect((await listAgentFiles(agent.id, "state")).map((e) => e.path)).toContain("state/agent.json");
  });

  test("writes, reads and commits user edits", async () => {
    const agent = await createAgent({ name: "Editor" });
    await writeAgentFile(agent.id, "memory/notes/todo.md", "- buy milk\n");
    expect(await readAgentFile(agent.id, "memory/notes/todo.md")).toEqual({ path: "memory/notes/todo.md", content: "- buy milk\n" });
    expect((await listAgentCommits(agent.id))[0]!.message).toBe("Edit memory/notes/todo.md");
  });

  test("rejects path traversal, absolute paths, .git and escaping symlinks", async () => {
    const agent = await createAgent({ name: "Guarded" });
    const outside = join(dataDir, "secret.txt");
    writeFileSync(outside, "top secret");
    symlinkSync(outside, join(agent.repoPath, "workspace", "link.txt"));
    symlinkSync(join(agent.repoPath, ".git"), join(agent.repoPath, "gitlink"));

    for (const path of ["../../secret.txt", "../Guarded/../../secret.txt", "/etc/passwd", "C:\\Windows\\win.ini", "..\\..\\secret.txt"]) {
      await expectHttpError(readAgentFile(agent.id, path), 403);
    }
    await expectHttpError(readAgentFile(agent.id, ".git/config"), 403, /\.git/);
    await expectHttpError(readAgentFile(agent.id, "memory/../.GIT/config"), 403, /\.git/);
    await expectHttpError(readAgentFile(agent.id, "workspace/link.txt"), 403);
    await expectHttpError(readAgentFile(agent.id, "gitlink/config"), 403);
    await expectHttpError(listAgentFiles(agent.id, ".."), 403);
    await expectHttpError(listAgentFiles(agent.id, "gitlink"), 403);
    await expectHttpError(writeAgentFile(agent.id, "../evil.txt", "x"), 403);
    await expectHttpError(writeAgentFile(agent.id, ".git/hooks/post-commit", "x"), 403);
    await expectHttpError(writeAgentFile(agent.id, "workspace/link.txt", "x"), 403);
    await expectHttpError(readAgentFile(agent.id, "missing.md"), 404);
    await expectHttpError(readAgentFile(agent.id, "workspace"), 400);
    expect(readFileSync(outside, "utf8")).toBe("top secret");
    expect(existsSync(join(dataDir, "agents", "evil.txt"))).toBe(false);

    const names = (await listAgentFiles(agent.id, "workspace")).map((e) => e.path);
    expect(names).not.toContain("workspace/link.txt");
  });

  test("refuses binary and oversized files", async () => {
    const agent = await createAgent({ name: "Binary" });
    writeFileSync(join(agent.repoPath, "workspace", "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await expectHttpError(readAgentFile(agent.id, "workspace/image.bin"), 415);
    writeFileSync(join(agent.repoPath, "workspace", "big.txt"), "a".repeat(repo.MAX_FILE_BYTES + 1));
    await expectHttpError(readAgentFile(agent.id, "workspace/big.txt"), 413);
    await expectHttpError(writeAgentFile(agent.id, "workspace/big2.txt", "a".repeat(repo.MAX_FILE_BYTES + 1)), 413);
  });
});

describe("backup restore robustness", () => {
  test("missing repositories are recreated lazily and at startup", async () => {
    const a = await createAgent({ name: "Restored A" });
    const b = await createAgent({ name: "Restored B" });
    rmSync(a.repoPath, { recursive: true, force: true });
    rmSync(b.repoPath, { recursive: true, force: true });

    expect((await readAgentFile(a.id, "CLAUDE.md")).content).toContain("Restored A");
    expect((await listAgentCommits(a.id)).map((c) => c.message)).toEqual(["Create agent Restored A"]);

    await ensureDefaultAgent();
    expect(existsSync(join(b.repoPath, ".git"))).toBe(true);
    expect(existsSync(join(b.repoPath, "MEMORY.md"))).toBe(true);
  });

  test("ids of deleted MCP servers are dropped when an agent is read", async () => {
    const ts = new Date().toISOString();
    insert("mcp_servers", { id: "mcp_keep", name: "Keep", created_at: ts, updated_at: ts });
    insert("mcp_servers", { id: "mcp_drop", name: "Drop", created_at: ts, updated_at: ts });
    const agent = await createAgent({ name: "Mcp User", mcpServerIds: ["mcp_keep", "mcp_drop", "mcp_never"] });
    expect(agent.mcpServerIds).toEqual(["mcp_keep", "mcp_drop"]);
    run("DELETE FROM mcp_servers WHERE id = ?", "mcp_drop");
    expect(getAgent(agent.id).mcpServerIds).toEqual(["mcp_keep"]);
  });
});

describe("gitignore", () => {
  async function headFiles(dir: string): Promise<string[]> {
    const git = (await import("isomorphic-git")).default;
    const fs = await import("node:fs");
    return git.listFiles({ fs, dir, ref: "HEAD" });
  }

  test("new repositories keep user uploads out of git", async () => {
    const agent = await createAgent({ name: "Uploads" });
    expect(readFileSync(join(agent.repoPath, ".gitignore"), "utf8")).toContain("workspace/uploads/");
    mkdirSync(join(agent.repoPath, "workspace", "uploads"), { recursive: true });
    writeFileSync(join(agent.repoPath, "workspace", "uploads", "contract.pdf"), "private");
    writeFileSync(join(agent.repoPath, "workspace", "report.md"), "# Report");
    await commitAgentRepo(agent.id, "Run");
    const files = await headFiles(agent.repoPath);
    expect(files).toContain("workspace/report.md");
    expect(files).not.toContain("workspace/uploads/contract.pdf");
  });

  test("older repositories get the rule and stop tracking committed uploads", async () => {
    const agent = await createAgent({ name: "Legacy" });
    writeFileSync(join(agent.repoPath, ".gitignore"), "# Managed by Godmode Bot\nworkspace/tmp/\n*.tmp\n.claude-mem/\nnode_modules/");
    mkdirSync(join(agent.repoPath, "workspace", "uploads"), { recursive: true });
    writeFileSync(join(agent.repoPath, "workspace", "uploads", "old.pdf"), "private");
    await repo.commitAll(agent.repoPath, "Legacy state");
    expect(await headFiles(agent.repoPath)).toContain("workspace/uploads/old.pdf");

    await ensureAgentRepo(agent);
    const gitignore = readFileSync(join(agent.repoPath, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/\n# Added by Godmode Bot\nworkspace/uploads/\n.DS_Store\n");
    const files = await headFiles(agent.repoPath);
    expect(files).not.toContain("workspace/uploads/old.pdf");
    expect(files).toContain(".gitignore");
    expect(readFileSync(join(agent.repoPath, "workspace", "uploads", "old.pdf"), "utf8")).toBe("private");
    expect((await listAgentCommits(agent.id))[0]!.message).toBe("Update generated files");

    // Complete now: the fast path does nothing and later commits stay clean.
    await ensureAgentRepo(agent);
    expect(await repo.commitAll(agent.repoPath, "noop")).toBeNull();
  });
});

describe("git helpers", () => {
  test("refuses to touch repositories outside the Godmode data directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "godmode-outside-"));
    try {
      await expect(repo.initRepo(outside)).rejects.toThrow(/outside the Godmode data directory/);
      await expect(repo.commitAll(process.cwd(), "nope")).rejects.toThrow(/outside the Godmode data directory/);
      await expect(repo.commitAll(dataDir, "nope")).rejects.toThrow(/outside the Godmode data directory/);
      expect(existsSync(join(outside, ".git"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("commitAll stages additions, modifications and deletions and is a no-op when clean", async () => {
    const dir = join(dataDir, "plain-repo");
    await repo.initRepo(dir);
    expect(await repo.log(dir)).toEqual([]);
    writeFileSync(join(dir, "a.txt"), "1");
    writeFileSync(join(dir, "b.txt"), "1");
    expect(await repo.commitAll(dir, "first")).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.commitAll(dir, "nothing")).toBeNull();

    writeFileSync(join(dir, "a.txt"), "2");
    rmSync(join(dir, "b.txt"));
    writeFileSync(join(dir, "c.tmp"), "ignored?");
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
    expect(await repo.commitAll(dir, "second")).not.toBeNull();
    expect(await repo.commitAll(dir, "again")).toBeNull();

    const git = (await import("isomorphic-git")).default;
    const fs = await import("node:fs");
    const files = await git.listFiles({ fs, dir, ref: "HEAD" });
    expect(files.sort()).toEqual([".gitignore", "a.txt"]);
    expect((await repo.log(dir)).map((c) => c.message)).toEqual(["second", "first"]);
  });

  test("commitAll detects same-size rewrites within the same second (racy git)", async () => {
    const dir = join(dataDir, "racy-repo");
    await repo.initRepo(dir);
    writeFileSync(join(dir, "state.json"), '{"cron":"0 8 * * *"}');
    expect(await repo.commitAll(dir, "v0")).not.toBeNull();
    const git = (await import("isomorphic-git")).default;
    const fs = await import("node:fs");
    for (let i = 1; i <= 5; i++) {
      const content = `{"cron":"0 ${i} * * *"}`;
      writeFileSync(join(dir, "state.json"), content);
      expect(await repo.commitAll(dir, `v${i}`)).not.toBeNull();
      const { blob } = await git.readBlob({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: "HEAD" }), filepath: "state.json" });
      expect(new TextDecoder().decode(blob)).toBe(content);
    }
    expect(await repo.commitAll(dir, "clean")).toBeNull();
  });

  test("operations on the same repository are serialized", async () => {
    const dir = join(dataDir, "serial-repo");
    await repo.initRepo(dir);
    const order: number[] = [];
    await Promise.all([
      repo.withRepoLock(dir, async () => {
        await Bun.sleep(30);
        order.push(1);
      }),
      repo.withRepoLock(dir, async () => {
        order.push(2);
      }),
      repo.withRepoLock(dir, async () => {
        throw new Error("boom");
      }).catch(() => order.push(3)),
      repo.withRepoLock(dir, async () => {
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe("templates", () => {
  test("provide complete, well-formed agent templates", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(9);
    const ids = new Set(AGENT_TEMPLATES.map((t) => t.id));
    expect(ids.size).toBe(AGENT_TEMPLATES.length);
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.instructions.length).toBeGreaterThan(300);
      if (t.routine) expect(t.routine.cron.split(" ")).toHaveLength(5);
    }
    expect(AGENT_TEMPLATES.find((t) => t.id === "daily-briefing")!.routine!.cron).toBe("0 8 * * 1-5");
  });
});
