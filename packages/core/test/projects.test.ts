import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, get, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, getSettings } from "../src/services/settings";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces } from "../src/services/workspaces";
import { chatSourcePaths, createProject, deleteProject, getProject, projectOfChat, updateProject } from "../src/services/projects";
import { prepareSources } from "../src/services/workspaceSources";
import { createAgent, updateAgent } from "../src/agents/service";
import { createConversation, listConversations, updateConversation } from "../src/services/conversations";
import { createTask, updateTask } from "../src/tasks/service";
import { createProfile, resolveProfileForAgent } from "../src/browser/manager";
import { instructionsSection } from "../src/runner/prompt";
import { HttpError } from "../src/util";

let dataDir: string;
let outside: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-projects-"));
  outside = mkdtempSync(join(tmpdir(), "godmode-projects-folders-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(() => {
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

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  throw new Error("expected an error");
}

const signal = () => new AbortController().signal;

describe("projects", () => {
  test("live in their workspace, with their own folders", () => {
    const shared = folder("shared");
    const app = folder("app");
    const ws = createWorkspace({ name: "Codext", sources: [{ kind: "folder", path: shared }] });
    const project = createProject({ workspaceId: ws.id, name: "Shop relaunch", instructions: "Use German.", sources: [{ kind: "folder", path: app }] });
    expect(project).toMatchObject({ workspaceId: ws.id, name: "Shop relaunch", slug: "shop-relaunch", icon: "📁", instructions: "Use German." });
    expect(project.sources.map((s) => s.path)).toEqual([app]);

    const fresh = getWorkspace(ws.id);
    expect(fresh.sources.map((s) => s.path)).toEqual([shared]);
    expect(fresh.projects.map((p) => p.id)).toEqual([project.id]);
    expect(listWorkspaces().find((w) => w.id === ws.id)!.projects[0]!.sources.map((s) => s.path)).toEqual([app]);

    const second = createProject({ workspaceId: ws.id, name: "Shop relaunch" });
    expect(second.slug).toBe("shop-relaunch-2");
    expect(updateProject(second.id, { name: "Analytics", icon: "📈" })).toMatchObject({ slug: "analytics", icon: "📈" });
    expect(getWorkspace(ws.id).projects.map((p) => p.name)).toEqual(["Analytics", "Shop relaunch"]);
  });

  test("are optional and need a workspace and a name", () => {
    const ws = createWorkspace({ name: "Bio Naturel" });
    expect(ws.projects).toEqual([]);
    expect(status(() => createProject({ workspaceId: "wsp_nope", name: "X" }))).toBe(400);
    expect(status(() => createProject({ workspaceId: ws.id, name: "  " }))).toBe(400);
  });

  test("runs get the workspace's folders and the project's", async () => {
    const shared = folder("ws-shared");
    const own = folder("project-own");
    const ws = createWorkspace({ name: "Runs", sources: [{ kind: "folder", path: shared }] });
    const project = createProject({ workspaceId: ws.id, name: "Site", sources: [{ kind: "folder", path: own }] });
    const owners = [
      { workspaceId: ws.id, projectId: null },
      { workspaceId: ws.id, projectId: project.id },
    ];
    const prepared = await prepareSources(owners, { onActivity: () => {}, signal: signal() });
    expect(prepared.sources.map((s) => s.path)).toEqual([shared, own]);
    const workspaceOnly = await prepareSources([owners[0]!], { onActivity: () => {}, signal: signal() });
    expect(workspaceOnly.sources.map((s) => s.path)).toEqual([shared]);
  });

  test("a browser profile must be global or the workspace's", () => {
    const ws = createWorkspace({ name: "Profiles" });
    const other = createWorkspace({ name: "Elsewhere" });
    const mine = createProfile({ name: "Mine", workspaceId: ws.id });
    const theirs = createProfile({ name: "Theirs", workspaceId: other.id });
    expect(createProject({ workspaceId: ws.id, name: "A", browserProfileId: mine.id }).browserProfileId).toBe(mine.id);
    expect(status(() => createProject({ workspaceId: ws.id, name: "B", browserProfileId: theirs.id }))).toBe(400);
  });
});

describe("chats, agents and tickets in a project", () => {
  test("an agent's project is in its workspace and resets when it moves", async () => {
    const ws = createWorkspace({ name: "Solakon" });
    const other = createWorkspace({ name: "Other" });
    const project = createProject({ workspaceId: ws.id, name: "Phone support" });
    await expect(createAgent({ name: "Wrong", workspaceId: other.id, projectId: project.id })).rejects.toBeInstanceOf(HttpError);
    const agent = await createAgent({ name: "Support bot", workspaceId: ws.id, projectId: project.id });
    expect(agent.projectId).toBe(project.id);
    const moved = await updateAgent(agent.id, { workspaceId: other.id });
    expect(moved.projectId).toBeNull();
  });

  test("a chat works on its own project, else on its agent's", async () => {
    const ws = createWorkspace({ name: "Chats" });
    const site = createProject({ workspaceId: ws.id, name: "Website", instructions: "Astro only." });
    const app = createProject({ workspaceId: ws.id, name: "App" });
    const agent = await createAgent({ name: "Dev", workspaceId: ws.id, projectId: site.id });

    const plain = createConversation({ agentId: agent.id });
    expect(plain.projectId).toBeNull();
    expect(projectOfChat(plain.id, agent)?.id).toBe(site.id);

    const picked = createConversation({ agentId: agent.id, projectId: app.id });
    expect(picked.projectId).toBe(app.id);
    expect(projectOfChat(picked.id, agent)?.id).toBe(app.id);

    const ids = (projectId: string) => listConversations({ projectId }).map((c) => c.id);
    expect(ids(site.id)).toContain(plain.id);
    expect(ids(site.id)).not.toContain(picked.id);
    expect(ids(app.id)).toEqual([picked.id]);

    expect(updateConversation(picked.id, { projectId: null }).projectId).toBeNull();
    expect(projectOfChat(picked.id, agent)?.id).toBe(site.id);
  });

  test("a global agent's chat may pick any project and moves to its workspace", async () => {
    const ws = createWorkspace({ name: "Global picks" });
    const project = createProject({ workspaceId: ws.id, name: "Ops" });
    const agent = await createAgent({ name: "Helper" });
    const chat = createConversation({ agentId: agent.id, projectId: project.id });
    expect(chat).toMatchObject({ projectId: project.id, workspaceId: ws.id });
    expect(listConversations({ workspaceId: ws.id }).map((c) => c.id)).toContain(chat.id);
  });

  test("a global agent in a project works with the workspace's folders too", async () => {
    const shared = folder("global-shared");
    const own = folder("global-own");
    const ws = createWorkspace({ name: "Global reach", sources: [{ kind: "folder", path: shared }] });
    const project = createProject({ workspaceId: ws.id, name: "Reach", sources: [{ kind: "folder", path: own }] });
    const agent = await createAgent({ name: "Roamer" });
    const chat = createConversation({ agentId: agent.id, projectId: project.id });
    expect(chatSourcePaths(chat.id, agent)).toEqual([shared, own]);
    expect(chatSourcePaths(createConversation({ agentId: agent.id }).id, agent)).toEqual([]);
  });

  test("a workspace agent can't work on another workspace's project", async () => {
    const ws = createWorkspace({ name: "Mine" });
    const other = createWorkspace({ name: "Not mine" });
    const project = createProject({ workspaceId: other.id, name: "Foreign" });
    const agent = await createAgent({ name: "Local", workspaceId: ws.id });
    expect(status(() => createConversation({ agentId: agent.id, projectId: project.id }))).toBe(400);
  });

  test("runs browse with the project's profile unless the chat or the agent has its own", async () => {
    const ws = createWorkspace({ name: "Browsing" });
    // The workspace's first profile is its default.
    const fallback = createProfile({ name: "Workspace profile", workspaceId: ws.id });
    const profile = createProfile({ name: "Project profile", workspaceId: ws.id });
    const project = createProject({ workspaceId: ws.id, name: "Shop", browserProfileId: profile.id });
    const agent = await createAgent({ name: "Shopper", workspaceId: ws.id });
    const inProject = createConversation({ agentId: agent.id, projectId: project.id });
    const outside = createConversation({ agentId: agent.id });
    expect(resolveProfileForAgent(agent, inProject.id).id).toBe(profile.id);
    expect(resolveProfileForAgent(agent, outside.id).id).toBe(fallback.id);
    const own = createProfile({ name: "Chat profile", workspaceId: ws.id });
    updateConversation(inProject.id, { browserProfileId: own.id });
    expect(resolveProfileForAgent(agent, inProject.id).id).toBe(own.id);
  });

  test("tickets belong to a project of their workspace; parts inherit it", () => {
    const ws = createWorkspace({ name: "Board" });
    const other = createWorkspace({ name: "Board 2" });
    const project = createProject({ workspaceId: ws.id, name: "Relaunch" });
    const foreign = createProject({ workspaceId: other.id, name: "Foreign" });
    const ticket = createTask({ workspaceId: ws.id, title: "Migrate products", projectId: project.id });
    expect(ticket.projectId).toBe(project.id);
    expect(createTask({ title: "Part", parentId: ticket.id }).projectId).toBe(project.id);
    expect(status(() => createTask({ workspaceId: ws.id, title: "Nope", projectId: foreign.id }))).toBe(400);
    expect(updateTask(ticket.id, { projectId: null }).projectId).toBeNull();
  });

  test("deleting a project keeps its chats, agents and tickets in the workspace", async () => {
    const ws = createWorkspace({ name: "Cleanup" });
    const project = createProject({ workspaceId: ws.id, name: "Temp", sources: [{ kind: "folder", path: folder("temp") }] });
    const agent = await createAgent({ name: "Temp bot", workspaceId: ws.id, projectId: project.id });
    const chat = createConversation({ agentId: agent.id, projectId: project.id });
    const ticket = createTask({ workspaceId: ws.id, title: "Temp ticket", projectId: project.id });
    await deleteProject(project.id);
    expect(status(() => getProject(project.id))).toBe(404);
    expect(get<{ project_id: string | null }>("SELECT project_id FROM agents WHERE id = ?", agent.id)?.project_id).toBeNull();
    expect(get<{ project_id: string | null }>("SELECT project_id FROM conversations WHERE id = ?", chat.id)?.project_id).toBeNull();
    expect(get<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id = ?", ticket.id)?.project_id).toBeNull();
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_sources WHERE workspace_id = ?", ws.id)?.n).toBe(0);
  });

  test("deleting the workspace takes its projects along", async () => {
    const ws = createWorkspace({ name: "Gone" });
    createProject({ workspaceId: ws.id, name: "Gone too", sources: [{ kind: "folder", path: folder("gone-too") }] });
    await deleteWorkspace(ws.id, true);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?", ws.id)?.n).toBe(0);
  });
});

describe("prompt", () => {
  test("the project's context comes after the workspace's", () => {
    const text = instructionsSection(getSettings(), {
      workspace: { name: "Codext", text: "Write to clients in German." },
      project: { name: "Shop relaunch", workspace: "Codext", description: "Shopware 6 to Shopify Plus", text: "Never touch the live theme." },
      chat: "",
    });
    expect(text).toContain('### For the "Codext" workspace\nWrite to clients in German.');
    expect(text).toContain('### For the "Shop relaunch" project (in "Codext")\nThis chat works on this project.\nWhat it is about: Shopware 6 to Shopify Plus\n\nNever touch the live theme.');
    expect(text.indexOf("Shop relaunch")).toBeGreaterThan(text.indexOf("Codext\" workspace"));
  });
});
