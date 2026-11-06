import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createAgent, ensureDefaultAgent, getAgent, listAgents, teamOf, updateAgent } from "../src/agents/service";
import * as repo from "../src/agents/repo";
import { createWorkspace, listWorkspaces } from "../src/services/workspaces";
import { createProject, deleteProject, listProjects } from "../src/services/projects";
import { createRoutine, getRoutine, listRoutines } from "../src/services/routines";
import { createConversation, listConversations } from "../src/services/conversations";
import { createTask, dispatch, getTask, listTasks } from "../src/tasks/service";
import { listArchive, setArchived } from "../src/services/archive";
import { triggerRoutine } from "../src/scheduler/scheduler";
import { teamBelow } from "../src/memory/team";
import { callTool } from "../src/mcp/tools";
import { HttpError } from "../src/util";

let dataDir: string;
let main: Agent;
const made: Agent[] = [];

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-archive-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  main = await ensureDefaultAgent();
});

afterAll(async () => {
  for (const a of [main, ...made]) await repo.repoIdle(a.repoPath);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function agent(input: Parameters<typeof createAgent>[0]): Promise<Agent> {
  const a = await createAgent(input);
  made.push(a);
  return a;
}

async function status(fn: () => unknown): Promise<number> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  throw new Error("expected an error");
}

const ids = (list: { id: string }[]) => list.map((x) => x.id);
const ctx = (agentId: string) => ({ runId: "run_archive_test", agentId, conversationId: "cnv_archive_test", workspaceId: null, depth: 0 });
const text = (out: { content: { text: string }[] }) => out.content.map((c) => c.text).join("\n");

describe("archiving an agent", () => {
  test("takes it out of the lists until it is restored", async () => {
    const scout = await agent({ name: "Scout" });
    expect(ids(listAgents())).toContain(scout.id);

    await setArchived("agent", scout.id, true);
    expect(ids(listAgents())).not.toContain(scout.id);
    expect(ids(listAgents({ includeArchived: true }))).toContain(scout.id);
    const archived = getAgent(scout.id);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.status).toBe("disabled");
    expect(archived.enabled).toBe(true);
    expect(ids(listArchive().agents)).toContain(scout.id);

    await setArchived("agent", scout.id, false);
    const back = getAgent(scout.id);
    expect(back).toMatchObject({ archived: false, archivedAt: null, status: "idle" });
    expect(ids(listAgents())).toContain(scout.id);
    expect(ids(listArchive().agents)).not.toContain(scout.id);
  });

  test("the built-in agent can't be archived", async () => {
    expect(await status(() => setArchived("agent", main.id, true))).toBe(400);
    expect(getAgent(main.id).archived).toBe(false);
  });

  test("hides its chats", async () => {
    const writer = await agent({ name: "Writer" });
    const chat = createConversation({ agentId: writer.id });
    expect(ids(listConversations({ limit: 500 }))).toContain(chat.id);
    await setArchived("agent", writer.id, true);
    expect(ids(listConversations({ limit: 500 }))).not.toContain(chat.id);
    await setArchived("agent", writer.id, false);
    expect(ids(listConversations({ limit: 500 }))).toContain(chat.id);
  });

  test("its reports report to its lead while it is archived", async () => {
    const head = await agent({ name: "Head of sales" });
    const lead = await agent({ name: "Team lead", reportsTo: head.id });
    const rep = await agent({ name: "Rep", reportsTo: lead.id });
    expect(teamBelow(head).map((a) => a.id).sort()).toEqual([lead.id, rep.id].sort());

    await setArchived("agent", lead.id, true);
    const listed = listAgents().find((a) => a.id === rep.id)!;
    expect(listed.reportsTo).toBe(head.id);
    expect(ids(teamBelow(head))).toEqual([rep.id]);
    expect(teamOf(getAgent(head.id)).reports.map((a) => a.id)).toContain(rep.id);
    expect(teamOf(getAgent(rep.id)).lead?.id).toBe(head.id);
    // The stored lead stays, and saving the report with it still works.
    expect(get<{ reports_to: string }>("SELECT reports_to FROM agents WHERE id = ?", rep.id)!.reports_to).toBe(lead.id);
    expect((await updateAgent(rep.id, { reportsTo: lead.id, description: "Calls leads" })).reportsTo).toBe(lead.id);

    await setArchived("agent", lead.id, false);
    expect(listAgents().find((a) => a.id === rep.id)!.reportsTo).toBe(lead.id);
    expect(teamBelow(head).map((a) => a.id).sort()).toEqual([lead.id, rep.id].sort());
  });
});

describe("archiving a workspace", () => {
  test("puts away its agents, projects, automations and tickets, and brings them back", async () => {
    const ws = createWorkspace({ name: "Closed line" });
    const project = createProject({ workspaceId: ws.id, name: "Launch" });
    const member = await agent({ name: "Closer", workspaceId: ws.id });
    const routine = createRoutine({ agentId: member.id, name: "Daily", cron: "0 8 * * *", prompt: "Check" });
    const ticket = createTask({ workspaceId: ws.id, title: "Ship it" });

    await setArchived("workspace", ws.id, true);
    expect(ids(listWorkspaces())).not.toContain(ws.id);
    expect(ids(listWorkspaces({ archived: true }))).toContain(ws.id);
    expect(ids(listProjects())).not.toContain(project.id);
    expect(ids(listAgents())).not.toContain(member.id);
    expect(getAgent(member.id).archived).toBe(true);
    expect(getAgent(member.id).archivedAt).toBeNull();
    expect(ids(listRoutines())).not.toContain(routine.id);
    expect(ids(listTasks())).not.toContain(ticket.id);
    const archive = listArchive();
    expect(ids(archive.workspaces)).toContain(ws.id);
    expect(ids(archive.agents)).not.toContain(member.id);
    expect(ids(archive.projects)).not.toContain(project.id);
    expect(ids(archive.routines)).not.toContain(routine.id);

    await setArchived("workspace", ws.id, false);
    expect(ids(listWorkspaces())).toContain(ws.id);
    expect(ids(listProjects())).toContain(project.id);
    expect(ids(listAgents())).toContain(member.id);
    expect(ids(listRoutines())).toContain(routine.id);
    expect(ids(listTasks())).toContain(ticket.id);
    expect(ids(listArchive().workspaces)).not.toContain(ws.id);
  });
});

describe("archiving a project", () => {
  test("puts away the agents that belong to it", async () => {
    const ws = createWorkspace({ name: "Agency" });
    const project = createProject({ workspaceId: ws.id, name: "Client A" });
    const member = await agent({ name: "Client A dev", workspaceId: ws.id, projectId: project.id });
    const other = await agent({ name: "Agency ops", workspaceId: ws.id });

    await setArchived("project", project.id, true);
    expect(ids(listProjects(ws.id))).not.toContain(project.id);
    expect(getAgent(member.id).archived).toBe(true);
    expect(ids(listAgents())).not.toContain(member.id);
    expect(ids(listAgents())).toContain(other.id);
    expect(ids(listArchive().projects)).toContain(project.id);

    await setArchived("project", project.id, false);
    expect(getAgent(member.id).archived).toBe(false);
    expect(ids(listProjects(ws.id))).toContain(project.id);
  });
});

describe("archiving an automation", () => {
  test("by itself: it is off and never runs", async () => {
    const owner = await agent({ name: "Reporter" });
    const routine = createRoutine({ agentId: owner.id, name: "Weekly report", cron: "0 9 * * 1", prompt: "Report" });

    await setArchived("routine", routine.id, true);
    expect(ids(listRoutines())).not.toContain(routine.id);
    expect(ids(listRoutines({ includeArchived: true }))).toContain(routine.id);
    const archived = getRoutine(routine.id);
    expect(archived).toMatchObject({ archived: true, enabled: true });
    expect(archived.triggerStatus).toMatchObject({ state: "off", message: "Archived" });
    expect(await status(() => triggerRoutine(routine.id))).toBe(409);
    expect(ids(listArchive().routines)).toContain(routine.id);

    await setArchived("routine", routine.id, false);
    expect(getRoutine(routine.id).archived).toBe(false);
    expect(ids(listRoutines())).toContain(routine.id);
  });

  test("through its agent", async () => {
    const owner = await agent({ name: "Poster" });
    const routine = createRoutine({ agentId: owner.id, name: "Post", cron: "0 10 * * *", prompt: "Post" });

    await setArchived("agent", owner.id, true);
    expect(ids(listRoutines())).not.toContain(routine.id);
    expect(getRoutine(routine.id)).toMatchObject({ archived: true, archivedAt: null });
    expect(getRoutine(routine.id).triggerStatus.message).toBe("Archived");
    expect(await status(() => triggerRoutine(routine.id))).toBe(409);
    expect(ids(listArchive().routines)).not.toContain(routine.id);

    await setArchived("agent", owner.id, false);
    expect(ids(listRoutines())).toContain(routine.id);
  });
});

describe("tickets", () => {
  test("of an archived agent wait in Todo instead of getting blocked", async () => {
    const closer = await agent({ name: "Ticket closer" });
    await setArchived("agent", closer.id, true);
    const ticket = createTask({ title: "Follow up", agentId: closer.id, status: "todo" });
    await dispatch(ticket.id);
    expect(getTask(ticket.id).status).toBe("todo");
  });

  test("of an archived workspace wait in Todo", async () => {
    const ws = createWorkspace({ name: "Paused shop" });
    const worker = await agent({ name: "Global worker" });
    await setArchived("workspace", ws.id, true);
    const ticket = createTask({ workspaceId: ws.id, title: "Restock", agentId: worker.id, status: "todo" });
    await dispatch(ticket.id);
    expect(getTask(ticket.id).status).toBe("todo");
  });
});

describe("an archived project", () => {
  test("can't be deleted before it is restored", async () => {
    const ws = createWorkspace({ name: "Agency" });
    const project = createProject({ workspaceId: ws.id, name: "Old client" });
    await setArchived("project", project.id, true);
    expect(await status(() => deleteProject(project.id))).toBe(400);
    await setArchived("project", project.id, false);
    await deleteProject(project.id);
  });
});

describe("the archive tools", () => {
  test("say so when something is archived only through its workspace", async () => {
    const ws = createWorkspace({ name: "Shelved" });
    const member = await agent({ name: "Shelved worker", workspaceId: ws.id });
    await setArchived("workspace", ws.id, true);
    const out = await callTool(ctx(main.id), "archive", { kind: "agent", id: member.id, archived: false });
    expect(text(out)).toContain("isn't archived by itself");
    expect(getAgent(member.id).archived).toBe(true);
    await setArchived("workspace", ws.id, false);
  });

  test("the built-in agent archives and restores an agent", async () => {
    const helper = await agent({ name: "Helper" });
    const archived = await callTool(ctx(main.id), "archive", { kind: "agent", id: helper.id });
    expect(archived.isError).toBeUndefined();
    expect(text(archived)).toContain("Helper");
    expect(getAgent(helper.id).archived).toBe(true);

    const list = JSON.parse(text(await callTool(ctx(main.id), "archive_list", {})));
    expect(list.agents.map((a: { id: string }) => a.id)).toContain(helper.id);

    const restored = await callTool(ctx(main.id), "archive", { kind: "agent", id: helper.id, archived: false });
    expect(restored.isError).toBeUndefined();
    expect(getAgent(helper.id).archived).toBe(false);
  });

  test("an agent can't archive itself, nor the built-in agent", async () => {
    expect((await callTool(ctx(main.id), "archive", { kind: "agent", id: main.id })).isError).toBe(true);
    const lead = await agent({ name: "Ops lead", permissions: { canManageAgents: true } });
    expect((await callTool(ctx(lead.id), "archive", { kind: "agent", id: lead.id })).isError).toBe(true);
    expect((await callTool(ctx(lead.id), "archive", { kind: "agent", id: main.id })).isError).toBe(true);
    expect(getAgent(main.id).archived).toBe(false);
    expect(getAgent(lead.id).archived).toBe(false);
  });
});
