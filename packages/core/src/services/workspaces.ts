/**
 * Workspaces: groups of agents, logins, 2FA entries, MCP servers and browser profiles, plus the folders and
 * repositories their agents work with.
 */
import type { Workspace } from "@godmode/shared";
import type { WorkspaceInput } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { listAgents, refreshAgentFiles, removeFromDelegateLists, stopAgentRuns, trashAgentRepo } from "../agents/service";
import { deleteProfile, updateProfile } from "../browser/manager";
import { reloadSchedules } from "../scheduler/scheduler";
import { HttpError, badRequest, newId, notFound, now, slugify } from "../util";
import { assignmentsChanged, normalizeVmId } from "../vm/assignments";
import { gitSourceRows, listSources, setSources, sourcesByWorkspace, trashClones } from "./workspaceSources";

const log = logger("workspaces");

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  icon: string;
  instructions: string;
  vm_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT w.*, (SELECT b.id FROM browser_profiles b WHERE b.workspace_id = w.id AND b.is_default = 1 ORDER BY b.created_at LIMIT 1) AS browser_profile_id
  FROM workspaces w`;

function toModel(r: WorkspaceRow & { browser_profile_id?: string | null }, sources = listSources(r.id)): Workspace {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    color: r.color,
    icon: r.icon,
    instructions: r.instructions,
    vmId: r.vm_id ?? null,
    browserProfileId: r.browser_profile_id ?? null,
    sources,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function uniqueSlug(name: string): string {
  const base = slugify(name);
  let candidate = base;
  for (let i = 2; get<{ id: string }>("SELECT id FROM workspaces WHERE slug = ?", candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

function cleanName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw badRequest("Workspace name is required");
  return trimmed;
}

export function listWorkspaces(): Workspace[] {
  const sources = sourcesByWorkspace();
  return all<WorkspaceRow>(`${SELECT} ORDER BY w.name COLLATE NOCASE ASC`).map((r) => toModel(r, sources.get(r.id) ?? []));
}

export function getWorkspace(id: string): Workspace {
  const row = get<WorkspaceRow>(`${SELECT} WHERE w.id = ?`, id);
  if (!row) throw notFound("Workspace");
  return toModel(row);
}

export function createWorkspace(input: WorkspaceInput): Workspace {
  const name = cleanName(input.name);
  const ts = now();
  const row: WorkspaceRow = {
    id: newId("wsp"),
    name,
    slug: uniqueSlug(name),
    description: input.description?.trim() ?? "",
    color: input.color?.trim() || "violet",
    icon: input.icon?.trim() || "🗂️",
    instructions: input.instructions?.trim() ?? "",
    vm_id: normalizeVmId(input.vmId) ?? null,
    created_at: ts,
    updated_at: ts,
  };
  const applySources = tx(() => {
    insert("workspaces", { ...row });
    const apply = input.sources ? setSources(row.id, input.sources) : undefined;
    assignBrowserProfile(row.id, input.browserProfileId);
    return apply;
  });
  applySources?.();
  bus.changed("workspaces");
  if (row.vm_id) assignmentsChanged();
  return getWorkspace(row.id);
}

/** The workspace's agents browse with this profile unless they pick their own; null = the global default. */
function assignBrowserProfile(workspaceId: string, profileId: string | null | undefined, current: string | null = null) {
  if (profileId === undefined) return;
  const next = profileId?.trim() || null;
  if (next === current) return;
  if (next) updateProfile(next, { workspaceId, isDefault: true });
  else if (current) updateProfile(current, { isDefault: false });
}

export function updateWorkspace(id: string, patch: Partial<WorkspaceInput>): Workspace {
  const current = getWorkspace(id);
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  const description = patch.description !== undefined ? patch.description.trim() : undefined;
  const vmId = normalizeVmId(patch.vmId);
  const applySources = tx(() => {
    update("workspaces", id, {
      name,
      description,
      color: patch.color !== undefined ? patch.color.trim() || "violet" : undefined,
      icon: patch.icon !== undefined ? patch.icon.trim() || "🗂️" : undefined,
      instructions: patch.instructions?.trim(),
      vm_id: vmId,
      updated_at: now(),
    });
    const apply = patch.sources ? setSources(id, patch.sources) : undefined;
    assignBrowserProfile(id, patch.browserProfileId, current.browserProfileId);
    return apply;
  });
  applySources?.();
  const next = getWorkspace(id);
  bus.changed("workspaces");
  if (next.vmId !== current.vmId) assignmentsChanged();

  // Workspace name/description are part of each member agent's CLAUDE.md.
  if (next.name !== current.name || next.description !== current.description) {
    const agentIds = all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ?", id).map((r) => r.id);
    void (async () => {
      for (const agentId of agentIds) {
        await refreshAgentFiles(agentId, "Update workspace details").catch((err) =>
          log.warn(`failed to refresh CLAUDE.md of agent ${agentId}`, err),
        );
      }
    })();
  }
  return next;
}

const DEPENDENTS = [
  { table: "agents", key: "agents" },
  { table: "credentials", key: "credentials" },
  { table: "totp", key: "totp" },
  { table: "mcp_servers", key: "mcpServers" },
  { table: "browser_profiles", key: "browserProfiles" },
  { table: "composio_connections", key: "composioConnections" },
] as const;

type DependentCounts = Record<(typeof DEPENDENTS)[number]["key"], number>;

function countDependents(id: string): DependentCounts {
  const counts = {} as DependentCounts;
  for (const { table, key } of DEPENDENTS) {
    counts[key] = get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ?`, id)?.c ?? 0;
  }
  return counts;
}

function describeCounts(counts: DependentCounts): string {
  const labels: Record<keyof DependentCounts, [string, string]> = {
    agents: ["agent", "agents"],
    credentials: ["login", "logins"],
    totp: ["2FA entry", "2FA entries"],
    mcpServers: ["MCP server", "MCP servers"],
    browserProfiles: ["browser profile", "browser profiles"],
    composioConnections: ["Composio connection", "Composio connections"],
  };
  return (Object.keys(labels) as (keyof DependentCounts)[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${counts[k] === 1 ? labels[k][0] : labels[k][1]}`)
    .join(", ");
}

/**
 * Delete a workspace. Without `force` it refuses (409) while agents, logins, 2FA entries, MCP servers, browser
 * profiles or Composio connections belong to it. With `force` those are deleted too; agent repositories are
 * moved to agents/.trash instead of being deleted.
 */
export async function deleteWorkspace(id: string, force = false): Promise<void> {
  const workspace = getWorkspace(id);
  const counts = countDependents(id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0 && !force) {
    throw new HttpError(
      409,
      `Workspace "${workspace.name}" still contains ${describeCounts(counts)}. Delete with force to remove everything in it.`,
      "conflict",
      { counts },
    );
  }

  const agents = listAgents({ workspaceId: id }).filter((a) => a.workspaceId === id && !a.isDefault);
  for (const agent of agents) await stopAgentRuns(agent.id);
  const clones = gitSourceRows(id);

  // Let the browser manager stop Chromium and clean up each profile; the cascade below removes leftovers.
  const profiles = all<{ id: string }>("SELECT id FROM browser_profiles WHERE workspace_id = ?", id);
  for (const profile of profiles) {
    try {
      await deleteProfile(profile.id);
    } catch (err) {
      log.warn(`could not delete browser profile ${profile.id} of workspace ${workspace.slug}`, err);
    }
  }

  tx(() => {
    // The default agent is always global; never let a cascade take it down.
    run("UPDATE agents SET workspace_id = NULL WHERE workspace_id = ? AND is_default = 1", id);
    run("UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?", id);
    // Global logins/2FA entries must not keep links to items the cascade is about to delete.
    run("UPDATE totp SET credential_id = NULL WHERE credential_id IN (SELECT id FROM credentials WHERE workspace_id = ?)", id);
    run("UPDATE credentials SET totp_id = NULL WHERE totp_id IN (SELECT id FROM totp WHERE workspace_id = ?)", id);
    run("DELETE FROM workspaces WHERE id = ?", id);
    removeFromDelegateLists(agents.map((a) => a.id));
  });

  await trashClones(clones);
  for (const agent of agents) {
    try {
      const moved = await trashAgentRepo(agent);
      if (moved) log.info(`moved repository of agent ${agent.slug} to ${moved}`);
    } catch (err) {
      log.error(`failed to move repository of agent ${agent.slug} to trash`, err);
    }
    bus.emit({ type: "agent.deleted", id: agent.id });
  }

  log.info(`deleted workspace ${workspace.slug}${total ? ` (${describeCounts(counts)})` : ""}`);
  bus.changed("workspaces");
  if (counts.agents) {
    bus.changed("agents");
    bus.changed("routines");
    bus.changed("runs");
    reloadSchedules();
  }
  if (counts.credentials) bus.changed("credentials");
  if (counts.totp) bus.changed("totp");
  if (counts.mcpServers) bus.changed("mcp-servers");
  if (counts.browserProfiles) bus.changed("browser-profiles");
  if (counts.composioConnections) bus.changed("composio");
}
