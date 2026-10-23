/**
 * Projects and workspaces moving into each other: a project moves to another workspace or becomes a workspace of its
 * own, and a workspace becomes a project of another one. Its agents, chats, tickets, folders and repositories go along.
 * The returned undo puts it back where it was; links the move had to cut (a lead, a ticket's agent) stay cut.
 */
import type {
  EntityName,
  Project,
  ProjectMoveInput,
  ScopeItemKind,
  ScopeMoveCounts,
  ScopeMoveResult,
  ScopeRestore,
  Workspace,
  WorkspaceMoveInput,
} from "@godmode/shared";
import { all, get, insert, run, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent, refreshAgentFiles } from "../agents/service";
import { requestAppTriggerSync } from "../integrations/composioTriggers";
import { reloadSchedules } from "../scheduler/scheduler";
import { HttpError, badRequest, newId, now } from "../util";
import { assignmentsChanged, vmExists } from "../vm/assignments";
import { audit } from "./audit";
import { getConversationSummary } from "./conversations";
import { getProject, uniqueSlug as projectSlug } from "./projects";
import { getWorkspace, uniqueSlug as workspaceSlug } from "./workspaces";
import { relocateSources, sourceRows } from "./workspaceSources";

const log = logger("scope-moves");

/** Workspace items without a project: they become the other workspace's when theirs becomes a project of it. */
export const SCOPE_ITEMS: Record<ScopeItemKind, { table: string; entity: EntityName }> = {
  credentials: { table: "credentials", entity: "credentials" },
  totp: { table: "totp", entity: "totp" },
  passkeys: { table: "passkeys", entity: "passkeys" },
  paymentCards: { table: "payment_cards", entity: "payment-cards" },
  mcpServers: { table: "mcp_servers", entity: "mcp-servers" },
  apiTools: { table: "api_tools", entity: "api-tools" },
  composioConnections: { table: "composio_connections", entity: "composio" },
  browserProfiles: { table: "browser_profiles", entity: "browser-profiles" },
  goals: { table: "goals", entity: "goals" },
  humanTasks: { table: "human_tasks", entity: "human-tasks" },
  questions: { table: "questions", entity: "questions" },
  missingLogins: { table: "missing_logins", entity: "missing-logins" },
  artifacts: { table: "artifacts", entity: "artifacts" },
};

/** Vault items: moving them to other agents takes the passphrase, as changing their workspace does. */
export const VAULT_ITEMS: ScopeItemKind[] = ["credentials", "totp", "passkeys", "paymentCards"];

/** Tables with a workspace_id the moves place one by one; every other one is handed over whole. */
export const PLACED_TABLES = ["projects", "agents", "conversations", "tasks", "workspace_sources"];

const KINDS = Object.keys(SCOPE_ITEMS) as ScopeItemKind[];
const ENTITY_OF = new Map(KINDS.map((k) => [SCOPE_ITEMS[k].table, SCOPE_ITEMS[k].entity]));

/** Every table with a workspace_id column (`also`: and this one). */
export function scopedTables(also?: string): string[] {
  return all<{ name: string }>(
    `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
       AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'workspace_id')
       ${also ? "AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = ?)" : ""} ORDER BY m.name`,
    ...(also ? [also] : []),
  ).map((r) => r.name);
}

interface Effects {
  agents: Set<string>;
  chats: Set<string>;
  entities: Set<EntityName>;
  clones: (() => Promise<void>)[];
  vms: boolean;
  notes: string[];
}

const newEffects = (): Effects => ({ agents: new Set(), chats: new Set(), entities: new Set(["workspaces"]), clones: [], vms: false, notes: [] });

const list = (ids: Iterable<string>) => JSON.stringify([...ids]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function add(into: ScopeMoveCounts, from: ScopeMoveCounts) {
  for (const [k, n] of Object.entries(from) as [keyof ScopeMoveCounts, number][]) if (n) into[k] = (into[k] ?? 0) + n;
}

/** A lead is global or of the same workspace: lines between the agents that moved and the ones that stayed are cut. */
function cutReportingLines(ids: string[]): number {
  if (!ids.length) return 0;
  return run(
    `UPDATE agents SET reports_to = NULL WHERE reports_to IS NOT NULL
       AND (id IN (SELECT value FROM json_each(?1)) OR reports_to IN (SELECT value FROM json_each(?1)))
       AND EXISTS (SELECT 1 FROM agents l WHERE l.id = agents.reports_to AND l.workspace_id IS NOT NULL AND l.workspace_id IS NOT agents.workspace_id)`,
    list(ids),
  ).changes;
}

/** A project's tickets with their parts (a part stays where its ticket is); its parts under a ticket that stays lose it. */
function projectTasks(projectId: string, workspaceId: string): { moving: string[]; left: string[] } {
  const rows = all<{ id: string; parent_id: string | null; project_id: string | null }>(
    "SELECT id, parent_id, project_id FROM tasks WHERE workspace_id = ?",
    workspaceId,
  );
  const ids = new Set(rows.map((r) => r.id));
  const moving = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (moving.has(r.id)) continue;
      const parent = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
      if (parent ? moving.has(parent) : r.project_id === projectId) {
        moving.add(r.id);
        grew = true;
      }
    }
  }
  return { moving: [...moving], left: rows.filter((r) => r.project_id === projectId && !moving.has(r.id)).map((r) => r.id) };
}

/** The project's profile when it is one of its workspace's that nothing staying there uses (not its default either). */
function ownProfile(project: Project, agents: string[]): string | null {
  const id = project.browserProfileId;
  const profile = id ? get<{ workspace_id: string | null; is_default: number }>("SELECT workspace_id, is_default FROM browser_profiles WHERE id = ?", id) : null;
  if (!id || !profile || profile.workspace_id !== project.workspaceId || profile.is_default) return null;
  const used =
    get("SELECT 1 FROM projects WHERE browser_profile_id = ? AND id != ?", id, project.id) ??
    get("SELECT 1 FROM agents WHERE json_extract(browser, '$.profileId') = ? AND id NOT IN (SELECT value FROM json_each(?))", id, list(agents)) ??
    get(
      `SELECT 1 FROM conversations c WHERE c.browser_profile_id = ? AND c.agent_id NOT IN (SELECT value FROM json_each(?))
         AND NOT (c.project_id IS ? AND c.agent_id IN (SELECT id FROM agents WHERE workspace_id IS NULL))`,
      id,
      list(agents),
      project.id,
    );
  return used ? null : id;
}

/**
 * Hand a project's agents, chats, tickets and sources to `dest`: still as that project (`keep`) or as the workspace's
 * own. Agents of its workspace that work on it without belonging to it stay, and their chats leave the project; what
 * the moving agents own there (their integrations, questions, …) goes with them.
 */
function placeProject(project: Project, dest: string, keep: boolean, fx: Effects): ScopeMoveCounts {
  const from = project.workspaceId;
  const ts = now();
  const target = keep ? project.id : null;
  const agents = all<{ id: string }>("SELECT id FROM agents WHERE project_id = ?", project.id).map((r) => r.id);
  run("UPDATE agents SET workspace_id = ?, project_id = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))", dest, target, ts, list(agents));
  const cut = cutReportingLines(agents);
  for (const table of scopedTables("agent_id")) {
    if (PLACED_TABLES.includes(table)) continue;
    const n = run(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ? AND agent_id IN (SELECT value FROM json_each(?))`, dest, from, list(agents)).changes;
    const entity = ENTITY_OF.get(table);
    if (n && entity) fx.entities.add(entity);
  }

  const chats = all<{ id: string; global: number }>(
    "SELECT c.id, a.workspace_id IS NULL AS global FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.project_id = ?",
    project.id,
  );
  run("UPDATE conversations SET workspace_id = ? WHERE project_id = ? AND agent_id IN (SELECT id FROM agents WHERE workspace_id IS NULL)", dest, project.id);
  if (keep) {
    run(
      "UPDATE conversations SET project_id = NULL WHERE project_id = ? AND agent_id IN (SELECT id FROM agents WHERE workspace_id IS NOT NULL AND workspace_id IS NOT ?)",
      project.id,
      dest,
    );
  } else run("UPDATE conversations SET project_id = NULL WHERE project_id = ?", project.id);
  // A moving agent's chats on the old workspace's other projects keep the agent's own.
  run("UPDATE conversations SET project_id = NULL WHERE agent_id IN (SELECT value FROM json_each(?)) AND project_id IS NOT NULL AND project_id IS NOT ?", list(agents), target);
  for (const c of chats) fx.chats.add(c.id);
  const agentChats = get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE agent_id IN (SELECT value FROM json_each(?))", list(agents))?.n ?? 0;

  const tasks = projectTasks(project.id, from);
  run(
    "UPDATE tasks SET workspace_id = ?, project_id = CASE WHEN project_id = ? THEN ? ELSE NULL END, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))",
    dest,
    project.id,
    target,
    ts,
    list(tasks.moving),
  );
  run("UPDATE tasks SET project_id = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))", ts, list(tasks.left));
  // A ticket's agent is global or of its workspace.
  const unassigned =
    run(
      "UPDATE tasks SET agent_id = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND agent_id IN (SELECT id FROM agents WHERE workspace_id IS NOT NULL AND workspace_id IS NOT ?)",
      ts,
      list(tasks.moving),
      dest,
    ).changes + run("UPDATE tasks SET agent_id = NULL, updated_at = ? WHERE workspace_id = ? AND agent_id IN (SELECT value FROM json_each(?))", ts, from, list(agents)).changes;

  const sources = sourceRows(from, project.id);
  fx.clones.push(relocateSources(sources, dest, () => target));

  for (const id of agents) fx.agents.add(id);
  if (agents.length) fx.entities.add("agents");
  if (tasks.moving.length || tasks.left.length || unassigned) fx.entities.add("tasks");
  if (cut) fx.notes.push(`${plural(cut, "agent reports", "agents report")} to Godmode now: ${cut === 1 ? "its lead was" : "their leads were"} on the other side.`);
  if (unassigned) fx.notes.push(`${plural(unassigned, "ticket has", "tickets have")} no agent now: ${unassigned === 1 ? "its agent is" : "their agents are"} in the other workspace.`);
  return { agents: agents.length, chats: agentChats + chats.filter((c) => c.global).length, tasks: tasks.moving.length, sources: sources.length };
}

/** Move a project (staying one) to `dest` along with what belongs to it. Call inside a transaction. */
function relocateProject(project: Project, dest: string, fx: Effects): ScopeMoveCounts {
  const agents = all<{ id: string }>("SELECT id FROM agents WHERE project_id = ?", project.id).map((r) => r.id);
  const own = ownProfile(project, agents);
  let profile = project.browserProfileId;
  if (own) {
    run("UPDATE browser_profiles SET workspace_id = ?, is_default = 0 WHERE id = ?", dest, own);
    fx.entities.add("browser-profiles");
  } else if (profile) {
    // Only a global profile or one of its new workspace's can be the project's.
    const at = get<{ workspace_id: string | null }>("SELECT workspace_id FROM browser_profiles WHERE id = ?", profile);
    if (!at || (at.workspace_id && at.workspace_id !== dest)) {
      profile = null;
      fx.notes.push(`${project.name}'s browser profile stays behind: other things there use it.`);
    }
  }
  const counts = placeProject(project, dest, true, fx);
  run(
    "UPDATE projects SET workspace_id = ?, slug = ?, browser_profile_id = ?, updated_at = ? WHERE id = ?",
    dest,
    projectSlug(dest, project.name, project.id),
    profile,
    now(),
    project.id,
  );
  return counts;
}

/** What changes for runs that used the old workspace's VM or default profile. */
function settingNotes(fx: Effects, what: string, from: Workspace, to: Workspace | null, hadProfile: boolean) {
  const vm = to ? to.vmId : from.vmId;
  if (from.vmId && from.vmId !== vm) fx.notes.push(`${what} no longer ${to ? "works" : "work"} in ${from.name}'s VM.`);
  if (!hadProfile && from.browserProfileId && from.browserProfileId !== to?.browserProfileId) {
    fx.notes.push(`${what} ${to ? "browses" : "browse"} with ${to?.browserProfileId ? `${to.name}'s` : "the global"} default profile now.`);
  }
}

async function settle(fx: Effects) {
  await Promise.all(fx.clones.map((move) => move()));
  for (const id of fx.chats) {
    try {
      bus.emit({ type: "conversation.updated", conversation: getConversationSummary(id) });
    } catch {
      // Deleted meanwhile.
    }
  }
  for (const entity of fx.entities) bus.changed(entity);
  if (fx.vms) assignmentsChanged();
  if (!fx.agents.size) return;
  for (const id of fx.agents) {
    try {
      bus.emit({ type: "agent.updated", agent: getAgent(id) });
    } catch {
      // Deleted meanwhile.
    }
  }
  bus.changed("routines");
  reloadSchedules();
  requestAppTriggerSync();
  // Their workspace is part of each agent's CLAUDE.md.
  void (async () => {
    for (const id of fx.agents) {
      await refreshAgentFiles(id, "Move to another workspace").catch((err) => log.warn(`failed to refresh CLAUDE.md of agent ${id}`, err));
    }
  })();
}

/** One move at a time: the next (an undo, say) starts once the clones of the last one are where its rows say. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

function workspaceExists(id: string): Workspace {
  try {
    return getWorkspace(id);
  } catch {
    throw badRequest("That workspace doesn't exist anymore");
  }
}

/** Whether a project's context was written by an agent and would reach every run of the workspace it becomes. */
export function needsContextReview(project: Project): boolean {
  return (project.fillOnly || project.offComputer) && !!(project.instructions.trim() || project.description.trim());
}

/** Move a project to another workspace, or (`workspaceId: null`) make it a workspace of its own. */
export function moveProject(id: string, input: ProjectMoveInput, actor = "user"): Promise<ScopeMoveResult> {
  return serial(async () => {
    const project = getProject(id);
    if (input.workspaceId === null) return promoteProject(project, input, actor);
    if (input.restore) throw badRequest("Only a project that becomes a workspace brings things back");
    const dest = workspaceExists(input.workspaceId);
    const from = getWorkspace(project.workspaceId);
    if (dest.id === from.id) throw badRequest(`${project.name} is in ${dest.name} already`);
    const fx = newEffects();
    const moved = tx(() => relocateProject(project, dest.id, fx));
    settingNotes(fx, project.name, from, dest, !!project.browserProfileId);
    audit(actor, "project.move", project.id, { from: from.id, to: dest.id, moved });
    await settle(fx);
    return {
      workspace: getWorkspace(dest.id),
      project: getProject(project.id),
      moved: compact(moved),
      notes: fx.notes,
      undo: { projectId: project.id, input: { workspaceId: from.id } },
    };
  });
}

async function promoteProject(project: Project, input: ProjectMoveInput, actor: string): Promise<ScopeMoveResult> {
  const restore = input.restore;
  if (!restore && needsContextReview(project) && !input.contextReviewed) {
    throw new HttpError(409, `An agent wrote ${project.name}'s context. Check it before it becomes a workspace's, which every run there gets.`, "context_review");
  }
  const parent = getWorkspace(project.workspaceId);
  const fx = newEffects();
  const ts = now();
  const id = newId("wsp");
  const vmId = restore ? (restore.vmId && vmExists(restore.vmId) ? restore.vmId : null) : parent.vmId;
  const moved = tx(() => {
    insert("workspaces", {
      id,
      name: project.name,
      slug: workspaceSlug(project.name),
      description: project.description,
      color: project.color,
      icon: project.icon,
      instructions: project.instructions,
      vm_id: vmId,
      auto_merge: (restore ? restore.autoMerge : parent.autoMerge) ? 1 : 0,
      created_at: ts,
      updated_at: ts,
    });
    const agents = all<{ id: string }>("SELECT id FROM agents WHERE project_id = ?", project.id).map((r) => r.id);
    const own = ownProfile(project, agents);
    const counts = placeProject(project, id, false, fx);

    for (const kind of KINDS) {
      const ids = restore?.items[kind];
      if (!ids?.length) continue;
      const { table, entity } = SCOPE_ITEMS[kind];
      const n = run(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`, id, parent.id, list(ids)).changes;
      if (!n) continue;
      counts[kind] = n;
      fx.entities.add(entity);
    }
    const profile = own ?? project.browserProfileId;
    if (profile && (own || get("SELECT 1 FROM browser_profiles WHERE id = ? AND workspace_id = ?", profile, id))) {
      run("UPDATE browser_profiles SET workspace_id = ?, is_default = 1 WHERE id = ?", id, profile);
      fx.entities.add("browser-profiles");
    } else if (!restore) settingNotes(fx, `${project.name}'s agents`, parent, null, !!project.browserProfileId);
    for (const projectId of restore?.projectIds ?? []) {
      const other = get<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND id != ?", projectId, parent.id, project.id);
      if (!other) continue;
      add(counts, relocateProject(getProject(other.id), id, fx));
      counts.projects = (counts.projects ?? 0) + 1;
    }
    run("DELETE FROM projects WHERE id = ?", project.id);
    return counts;
  });
  fx.vms = !!vmId;
  audit(actor, "project.promote", project.id, { from: parent.id, workspace: id, moved });
  await settle(fx);
  return { workspace: getWorkspace(id), project: null, moved: compact(moved), notes: fx.notes, undo: { workspaceId: id, input: { workspaceId: parent.id } } };
}

/**
 * Make a workspace a project of another one. Its own agents, chats, tickets and sources become the project's; its
 * projects become the other workspace's; its logins, integrations, profiles and the rest become the other workspace's.
 */
export function moveWorkspace(id: string, input: WorkspaceMoveInput, actor = "user"): Promise<ScopeMoveResult> {
  return serial(async () => {
    const source = getWorkspace(id);
    const dest = workspaceExists(input.workspaceId);
    if (dest.id === source.id) throw badRequest(`${source.name} can't go into itself`);
    const fx = newEffects();
    const ts = now();
    const projectId = newId("prj");
    const items: ScopeRestore["items"] = {};
    const subprojects = source.projects.map((p) => p.id);

    const moved = tx(() => {
      insert("projects", {
        id: projectId,
        workspace_id: dest.id,
        name: source.name,
        slug: projectSlug(dest.id, source.name),
        description: source.description,
        color: source.color,
        icon: source.icon,
        instructions: source.instructions,
        browser_profile_id: source.browserProfileId,
        created_at: ts,
        updated_at: ts,
      });
      // Its projects keep browsing with its default profile, which goes along.
      for (const p of source.projects) {
        run(
          "UPDATE projects SET workspace_id = ?, slug = ?, browser_profile_id = COALESCE(browser_profile_id, ?), updated_at = ? WHERE id = ?",
          dest.id,
          projectSlug(dest.id, p.name, p.id),
          source.browserProfileId,
          ts,
          p.id,
        );
      }

      const agents = all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ?", source.id).map((r) => r.id);
      run("UPDATE agents SET project_id = ? WHERE workspace_id = ? AND project_id IS NULL", projectId, source.id);
      run("UPDATE agents SET workspace_id = ?, updated_at = ? WHERE workspace_id = ?", dest.id, ts, source.id);
      const chats = all<{ id: string }>("SELECT id FROM conversations WHERE workspace_id = ?", source.id).map((r) => r.id);
      run("UPDATE conversations SET project_id = ? WHERE workspace_id = ? AND project_id IS NULL", projectId, source.id);
      run("UPDATE conversations SET workspace_id = ? WHERE workspace_id = ?", dest.id, source.id);
      const agentChats = get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE agent_id IN (SELECT value FROM json_each(?))", list(agents))?.n ?? 0;
      run("UPDATE tasks SET project_id = ? WHERE workspace_id = ? AND project_id IS NULL", projectId, source.id);
      const tasks = run("UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE workspace_id = ?", dest.id, ts, source.id).changes;
      const sources = sourceRows(source.id);
      fx.clones.push(relocateSources(sources, dest.id, (r) => r.project_id ?? projectId));
      // Its default profile becomes the project's.
      run("UPDATE browser_profiles SET is_default = 0 WHERE workspace_id = ?", source.id);

      const counts: ScopeMoveCounts = { agents: agents.length, chats: agentChats + chats.length, tasks, sources: sources.length, projects: subprojects.length };
      const kinds = new Map(KINDS.map((k) => [SCOPE_ITEMS[k].table, k]));
      for (const table of scopedTables()) {
        if (PLACED_TABLES.includes(table)) continue;
        const kind = kinds.get(table);
        const ids = kind ? all<{ id: string }>(`SELECT id FROM ${table} WHERE workspace_id = ?`, source.id).map((r) => r.id) : [];
        run(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`, dest.id, source.id);
        if (kind && ids.length) {
          items[kind] = ids;
          counts[kind] = ids.length;
          fx.entities.add(SCOPE_ITEMS[kind].entity);
        }
      }
      // Deleting the workspace would take along whatever still points at it.
      for (const table of scopedTables()) {
        if (get(`SELECT 1 FROM ${table} WHERE workspace_id = ?`, source.id)) throw new HttpError(500, `${table} of ${source.name} could not be moved`);
      }
      run("DELETE FROM workspaces WHERE id = ?", source.id);
      for (const id of agents) fx.agents.add(id);
      for (const id of chats) fx.chats.add(id);
      if (agents.length) fx.entities.add("agents");
      if (tasks) fx.entities.add("tasks");
      return counts;
    });
    fx.vms = !!source.vmId;
    if (source.vmId && source.vmId !== dest.vmId) fx.notes.push(`Its agents no longer work in ${source.name}'s VM.`);
    if (!source.browserProfileId && dest.browserProfileId) fx.notes.push(`Its agents browse with ${dest.name}'s default profile now.`);
    audit(actor, "workspace.move", source.id, { into: dest.id, project: projectId, moved });
    await settle(fx);
    return {
      workspace: getWorkspace(dest.id),
      project: getProject(projectId),
      moved: compact(moved),
      notes: fx.notes,
      undo: { projectId, input: { workspaceId: null, restore: { items, projectIds: subprojects, vmId: source.vmId, autoMerge: source.autoMerge } } },
    };
  });
}

function compact(counts: ScopeMoveCounts): ScopeMoveCounts {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n)) as ScopeMoveCounts;
}
