import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeMoveResult } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createWorkspace, getWorkspace, listWorkspaces, updateWorkspace } from "../src/services/workspaces";
import { createProject, getProject, updateProject } from "../src/services/projects";
import { PLACED_TABLES, SCOPE_ITEMS, moveProject, moveWorkspace, scopedTables } from "../src/services/scopeMoves";
import { reposDir } from "../src/services/workspaceSources";
import { createAgent, getAgent, updateAgent } from "../src/agents/service";
import { createConversation, getConversationSummary } from "../src/services/conversations";
import { createTask, getTask } from "../src/tasks/service";
import { createProfile } from "../src/browser/manager";
import { createCredential, getCredential } from "../src/vault/credentials";
import * as vault from "../src/vault/vault";
import { HttpError } from "../src/util";

let dataDir: string;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-scope-moves-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  vault.lock();
  await vault.setup("scope moves test passphrase", false);
}, 60_000);

afterAll(() => {
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function rejects(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  throw new Error("expected an error");
}

/** A git source with a clone on disk, without touching the network. */
function cloned(workspaceId: string, projectId: string | null, dir: string): string {
  const ts = new Date().toISOString();
  const id = `src_${dir}_${Math.random().toString(36).slice(2, 8)}`;
  insert("workspace_sources", { id, workspace_id: workspaceId, project_id: projectId, kind: "git", path: dir, url: `https://github.com/acme/${dir}.git`, position: 0, created_at: ts, updated_at: ts });
  mkdirSync(join(reposDir(), workspaceId, dir, ".git"), { recursive: true });
  return id;
}

const undo = (r: ScopeMoveResult) => ("projectId" in r.undo ? moveProject(r.undo.projectId, r.undo.input) : moveWorkspace(r.undo.workspaceId, r.undo.input));

describe("a project moving to another workspace", () => {
  test("takes its agents, chats, tickets, repositories and own profile along", async () => {
    const codext = createWorkspace({ name: "Codext" });
    const apps = createWorkspace({ name: "Apps" });
    const project = createProject({ workspaceId: codext.id, name: "Radio" });
    const profile = createProfile({ name: "Radio browser", workspaceId: codext.id });
    createProfile({ name: "Second", workspaceId: codext.id });
    const lead = await createAgent({ name: "Lead", workspaceId: codext.id });
    const dev = await createAgent({ name: "Radio dev", workspaceId: codext.id, projectId: project.id, reportsTo: lead.id });
    const helper = await createAgent({ name: "Helper" });
    const staying = await createAgent({ name: "Stays", workspaceId: codext.id });
    const devChat = createConversation({ agentId: dev.id });
    const helperChat = createConversation({ agentId: helper.id, projectId: project.id });
    const stayingChat = createConversation({ agentId: staying.id, projectId: project.id });
    const ticket = createTask({ workspaceId: codext.id, title: "Ship 2.0", projectId: project.id });
    const part = createTask({ title: "Store screenshots", parentId: ticket.id });
    const elsewhere = createTask({ workspaceId: codext.id, title: "Invoice" });
    const strayParent = createTask({ workspaceId: codext.id, title: "Umbrella" });
    const strayPart = createTask({ title: "Radio bit", parentId: strayParent.id, projectId: project.id });
    const source = cloned(codext.id, project.id, "radio");
    // A clone of that name is in Apps already.
    cloned(apps.id, null, "radio");
    // The profile isn't the workspace's default (the first one is), so it can go along when only the project uses it.
    expect(getWorkspace(codext.id).browserProfileId).toBe(profile.id);
    const own = createProfile({ name: "Only radio", workspaceId: codext.id });
    updateProject(project.id, { browserProfileId: own.id });

    const result = await moveProject(project.id, { workspaceId: apps.id });
    expect(result.project).toMatchObject({ id: project.id, workspaceId: apps.id, browserProfileId: own.id });
    expect(result.moved).toMatchObject({ agents: 1, chats: 2, tasks: 2, sources: 1 });
    expect(getAgent(dev.id)).toMatchObject({ workspaceId: apps.id, projectId: project.id, reportsTo: null });
    expect(getConversationSummary(helperChat.id)).toMatchObject({ workspaceId: apps.id, projectId: project.id });
    expect(getConversationSummary(devChat.id).projectId).toBeNull();
    expect(getConversationSummary(stayingChat.id).projectId).toBeNull();
    expect(getTask(ticket.id)).toMatchObject({ workspaceId: apps.id, projectId: project.id });
    expect(getTask(part.id)).toMatchObject({ workspaceId: apps.id, projectId: project.id });
    expect(getTask(elsewhere.id).workspaceId).toBe(codext.id);
    expect(getTask(strayPart.id)).toMatchObject({ workspaceId: codext.id, projectId: null });
    expect(get<{ workspace_id: string; is_default: number }>("SELECT workspace_id, is_default FROM browser_profiles WHERE id = ?", own.id)).toEqual({ workspace_id: apps.id, is_default: 0 });

    const src = get<{ workspace_id: string; project_id: string; path: string }>("SELECT workspace_id, project_id, path FROM workspace_sources WHERE id = ?", source)!;
    expect(src).toEqual({ workspace_id: apps.id, project_id: project.id, path: "radio-2" });
    expect(existsSync(join(reposDir(), apps.id, "radio-2", ".git"))).toBe(true);
    expect(existsSync(join(reposDir(), codext.id))).toBe(false);

    const back = await undo(result);
    expect(back.project).toMatchObject({ id: project.id, workspaceId: codext.id });
    expect(getAgent(dev.id).workspaceId).toBe(codext.id);
    expect(getTask(ticket.id).workspaceId).toBe(codext.id);
    expect(existsSync(join(reposDir(), codext.id, "radio-2", ".git"))).toBe(true);
  });

  test("a profile its workspace still uses stays there", async () => {
    const from = createWorkspace({ name: "Shared profile" });
    const to = createWorkspace({ name: "Shared target" });
    createProfile({ name: "Default", workspaceId: from.id });
    const shared = createProfile({ name: "Shared", workspaceId: from.id });
    const project = createProject({ workspaceId: from.id, name: "One", browserProfileId: shared.id });
    createProject({ workspaceId: from.id, name: "Two", browserProfileId: shared.id });
    const result = await moveProject(project.id, { workspaceId: to.id });
    expect(result.project!.browserProfileId).toBeNull();
    expect(get<{ workspace_id: string }>("SELECT workspace_id FROM browser_profiles WHERE id = ?", shared.id)!.workspace_id).toBe(from.id);
  });

  test("refuses its own workspace and missing ones", async () => {
    const ws = createWorkspace({ name: "Home" });
    const project = createProject({ workspaceId: ws.id, name: "Stay" });
    expect(await rejects(moveProject(project.id, { workspaceId: ws.id }))).toBe(400);
    expect(await rejects(moveProject(project.id, { workspaceId: "wsp_gone" }))).toBe(400);
    expect(await rejects(moveProject(project.id, { workspaceId: ws.id, restore: { items: {}, projectIds: [], vmId: null, autoMerge: false } }))).toBe(400);
  });
});

describe("a project becoming a workspace", () => {
  test("gets its settings, keeps its parent's VM and auto-merge, and goes back as a project", async () => {
    const parent = createWorkspace({ name: "Solakon", autoMerge: true });
    const project = createProject({ workspaceId: parent.id, name: "IR meter", icon: "M", color: "amber", description: "Reader", instructions: "Use ESP-IDF." });
    const dev = await createAgent({ name: "Firmware", workspaceId: parent.id, projectId: project.id });
    const report = await createAgent({ name: "Tester", workspaceId: parent.id, reportsTo: dev.id });
    const helper = await createAgent({ name: "Roamer" });
    const chat = createConversation({ agentId: helper.id, projectId: project.id });
    const ticket = createTask({ workspaceId: parent.id, title: "Calibrate", projectId: project.id, agentId: dev.id });
    cloned(parent.id, project.id, "firmware");

    const result = await moveProject(project.id, { workspaceId: null });
    const ws = result.workspace;
    expect(result.project).toBeNull();
    expect(ws).toMatchObject({ name: "IR meter", icon: "M", color: "amber", description: "Reader", instructions: "Use ESP-IDF.", autoMerge: true, vmId: null });
    expect(ws.sources.map((s) => s.name)).toEqual(["firmware"]);
    expect(() => getProject(project.id)).toThrow();
    expect(getAgent(dev.id)).toMatchObject({ workspaceId: ws.id, projectId: null });
    expect(getAgent(report.id).reportsTo).toBeNull();
    expect(getConversationSummary(chat.id)).toMatchObject({ workspaceId: ws.id, projectId: null });
    expect(getTask(ticket.id)).toMatchObject({ workspaceId: ws.id, projectId: null, agentId: dev.id });
    expect(existsSync(join(reposDir(), ws.id, "firmware", ".git"))).toBe(true);

    const back = await undo(result);
    expect(back.workspace.id).toBe(parent.id);
    expect(back.project).toMatchObject({ name: "IR meter", workspaceId: parent.id, instructions: "Use ESP-IDF." });
    expect(getAgent(dev.id)).toMatchObject({ workspaceId: parent.id, projectId: back.project!.id });
    expect(getTask(ticket.id)).toMatchObject({ workspaceId: parent.id, projectId: back.project!.id });
    expect(listWorkspaces().some((w) => w.id === ws.id)).toBe(false);
  });

  test("its own profile becomes the new workspace's default", async () => {
    const parent = createWorkspace({ name: "Profiles home" });
    createProfile({ name: "Home default", workspaceId: parent.id });
    const own = createProfile({ name: "Shop browser", workspaceId: parent.id });
    const project = createProject({ workspaceId: parent.id, name: "Shop", browserProfileId: own.id });
    const result = await moveProject(project.id, { workspaceId: null });
    expect(result.workspace.browserProfileId).toBe(own.id);
  });
});

describe("a workspace becoming a project of another", () => {
  test("brings everything along, deletes nothing, and the undo puts it all back", async () => {
    const host = createWorkspace({ name: "Codext GmbH" });
    const guest = createWorkspace({ name: "Smartbell", icon: "S", color: "sky", instructions: "Expo app.", autoMerge: true });
    createProject({ workspaceId: host.id, name: "Website" });
    const sub = createProject({ workspaceId: guest.id, name: "Website" });
    const profile = createProfile({ name: "Smartbell browser", workspaceId: guest.id });
    const lead = await createAgent({ name: "Smartbell lead", workspaceId: guest.id });
    const dev = await createAgent({ name: "Smartbell dev", workspaceId: guest.id, reportsTo: lead.id });
    const web = await createAgent({ name: "Smartbell web", workspaceId: guest.id, projectId: sub.id });
    const helper = await createAgent({ name: "Global helper" });
    const chat = createConversation({ agentId: helper.id, workspaceId: guest.id });
    const ticket = createTask({ workspaceId: guest.id, title: "Release 9.1" });
    const webTicket = createTask({ workspaceId: guest.id, title: "Landing page", projectId: sub.id });
    const login = createCredential({ workspaceId: guest.id, name: "Expo", username: "dev@smartbell.de", password: "hunter2-very-secret" });
    const goalId = "goal_smartbell";
    const ts = new Date().toISOString();
    insert("goals", { id: goalId, workspace_id: guest.id, title: "1k installs", why: "", status: "active", position: 0, created_at: ts, updated_at: ts });
    cloned(guest.id, null, "smartbell");

    const result = await moveWorkspace(guest.id, { workspaceId: host.id });
    const project = result.project!;
    expect(result.workspace.id).toBe(host.id);
    expect(project).toMatchObject({ name: "Smartbell", icon: "S", color: "sky", instructions: "Expo app.", workspaceId: host.id, browserProfileId: profile.id, fillOnly: false });
    expect(result.moved).toMatchObject({ agents: 3, tasks: 2, sources: 1, projects: 1, credentials: 1, goals: 1, browserProfiles: 1 });
    expect(listWorkspaces().some((w) => w.id === guest.id)).toBe(false);
    expect(getWorkspace(host.id).projects.map((p) => [p.name, p.slug]).sort()).toEqual([
      ["Smartbell", "smartbell"],
      ["Website", "website"],
      ["Website", "website-2"],
    ]);
    expect(getAgent(lead.id)).toMatchObject({ workspaceId: host.id, projectId: project.id });
    expect(getAgent(dev.id)).toMatchObject({ workspaceId: host.id, projectId: project.id, reportsTo: lead.id });
    expect(getAgent(web.id)).toMatchObject({ workspaceId: host.id, projectId: sub.id });
    expect(getConversationSummary(chat.id)).toMatchObject({ workspaceId: host.id, projectId: project.id });
    expect(getTask(ticket.id)).toMatchObject({ workspaceId: host.id, projectId: project.id });
    expect(getTask(webTicket.id)).toMatchObject({ workspaceId: host.id, projectId: sub.id });
    expect(getCredential(login.id).workspaceId).toBe(host.id);
    expect(get<{ workspace_id: string; is_default: number }>("SELECT workspace_id, is_default FROM browser_profiles WHERE id = ?", profile.id)).toEqual({ workspace_id: host.id, is_default: 0 });
    expect(get<{ workspace_id: string }>("SELECT workspace_id FROM goals WHERE id = ?", goalId)!.workspace_id).toBe(host.id);
    expect(existsSync(join(reposDir(), host.id, "smartbell", ".git"))).toBe(true);

    const back = await undo(result);
    const restored = back.workspace;
    expect(back.project).toBeNull();
    expect(restored).toMatchObject({ name: "Smartbell", instructions: "Expo app.", autoMerge: true, browserProfileId: profile.id });
    expect(restored.projects.map((p) => p.id)).toEqual([sub.id]);
    expect(getAgent(lead.id)).toMatchObject({ workspaceId: restored.id, projectId: null });
    expect(getAgent(web.id)).toMatchObject({ workspaceId: restored.id, projectId: sub.id });
    expect(getAgent(dev.id).reportsTo).toBe(lead.id);
    expect(getCredential(login.id).workspaceId).toBe(restored.id);
    expect(getTask(webTicket.id)).toMatchObject({ workspaceId: restored.id, projectId: sub.id });
    expect(get<{ workspace_id: string }>("SELECT workspace_id FROM goals WHERE id = ?", goalId)!.workspace_id).toBe(restored.id);
    expect(getWorkspace(host.id).projects.map((p) => p.name)).toEqual(["Website"]);
  });

  test("refuses itself and missing workspaces", async () => {
    const ws = createWorkspace({ name: "Alone" });
    expect(await rejects(moveWorkspace(ws.id, { workspaceId: ws.id }))).toBe(400);
    expect(await rejects(moveWorkspace(ws.id, { workspaceId: "wsp_gone" }))).toBe(400);
    expect(getWorkspace(ws.id).name).toBe("Alone");
  });

  test("a workspace's VM: its agents leave it, the undo brings it back", async () => {
    const ts = new Date().toISOString();
    insert("vms", { id: "vm_scopemovestest01", name: "Builder", image: "macos", cpu: 4, memory_mb: 8192, disk_gb: 80, display: "1920x1080", created_at: ts, updated_at: ts });
    const host = createWorkspace({ name: "VM host" });
    const guest = createWorkspace({ name: "VM guest", vmId: "vm_scopemovestest01" });
    updateWorkspace(guest.id, { autoMerge: true });
    const result = await moveWorkspace(guest.id, { workspaceId: host.id });
    expect(result.notes).toContain("Its agents no longer work in VM guest's VM.");
    const back = await undo(result);
    expect(back.workspace).toMatchObject({ vmId: "vm_scopemovestest01", autoMerge: true });

    const parent = createWorkspace({ name: "VM parent", vmId: "vm_scopemovestest01" });
    const project = createProject({ workspaceId: parent.id, name: "In the VM" });
    expect((await moveProject(project.id, { workspaceId: null })).workspace.vmId).toBe("vm_scopemovestest01");
  });
});

describe("links across the new boundary", () => {
  test("tickets lose an agent on the other side; agents take what is theirs along", async () => {
    const from = createWorkspace({ name: "Split from" });
    const to = createWorkspace({ name: "Split to" });
    const project = createProject({ workspaceId: from.id, name: "Split" });
    const other = createProject({ workspaceId: from.id, name: "Other side" });
    const member = await createAgent({ name: "Member", workspaceId: from.id, projectId: project.id });
    const outsider = await createAgent({ name: "Outsider", workspaceId: from.id });
    const toMember = createTask({ workspaceId: from.id, title: "Stays, for the member", agentId: member.id });
    const toOutsider = createTask({ workspaceId: from.id, title: "Goes, for the outsider", projectId: project.id, agentId: outsider.id });
    const elsewhere = createConversation({ agentId: member.id, projectId: other.id });
    const ts = new Date().toISOString();
    insert("mcp_servers", { id: "mcp_member_own", workspace_id: from.id, agent_id: member.id, name: "Own", description: "", source: "custom", transport: "stdio", command: "x", args: "[]", url: "", env_keys: "[]", header_keys: "[]", enabled: 1, created_at: ts, updated_at: ts });

    const result = await moveProject(project.id, { workspaceId: to.id });
    expect(getTask(toMember.id)).toMatchObject({ workspaceId: from.id, agentId: null });
    expect(getTask(toOutsider.id)).toMatchObject({ workspaceId: to.id, agentId: null });
    expect(result.notes).toContain("2 tickets have no agent now: their agents are in the other workspace.");
    expect(getConversationSummary(elsewhere.id).projectId).toBeNull();
    expect(get<{ workspace_id: string }>("SELECT workspace_id FROM mcp_servers WHERE id = 'mcp_member_own'")!.workspace_id).toBe(to.id);
  });

  test("an agent wrote its context: it becomes a workspace's only once checked", async () => {
    const parent = createWorkspace({ name: "Review parent" });
    const project = createProject({ workspaceId: parent.id, name: "Agent made", instructions: "Do as I say." }, { offComputer: true });
    expect(await rejects(moveProject(project.id, { workspaceId: null }))).toBe(409);
    expect(getProject(project.id).workspaceId).toBe(parent.id);
    const result = await moveProject(project.id, { workspaceId: null, contextReviewed: true });
    expect(result.workspace.instructions).toBe("Do as I say.");
    const empty = createProject({ workspaceId: parent.id, name: "Agent made, empty" }, { fillOnly: true });
    expect((await moveProject(empty.id, { workspaceId: null })).workspace.name).toBe("Agent made, empty");
  });

  test("runs that used the workspace's default profile are told what they browse with now", async () => {
    const parent = createWorkspace({ name: "Default profile parent" });
    createProfile({ name: "Parent default", workspaceId: parent.id });
    const project = createProject({ workspaceId: parent.id, name: "Profileless" });
    const result = await moveProject(project.id, { workspaceId: null });
    expect(result.notes).toContain("Profileless's agents browse with the global default profile now.");
  });
});

test("every table with a workspace is placed or handed over with an undo", () => {
  const items = new Set(Object.values(SCOPE_ITEMS).map((i) => i.table));
  const unclassified = scopedTables().filter((t) => !PLACED_TABLES.includes(t) && !items.has(t));
  // A new table with a workspace_id: decide whether it goes along as an item (SCOPE_ITEMS) or is placed by the moves.
  expect(unclassified).toEqual([]);
});

test("updateAgent still refuses a project of another workspace after moves", async () => {
  const a = createWorkspace({ name: "Guard A" });
  const b = createWorkspace({ name: "Guard B" });
  const project = createProject({ workspaceId: a.id, name: "Guarded" });
  await moveProject(project.id, { workspaceId: b.id });
  const agent = await createAgent({ name: "Guard", workspaceId: a.id });
  await expect(updateAgent(agent.id, { projectId: project.id })).rejects.toBeInstanceOf(HttpError);
});
