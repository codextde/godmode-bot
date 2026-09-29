/**
 * Which macOS VM an agent, chat or workspace works in (`vm_id` columns). Kept free of service imports so the agent,
 * conversation and workspace services can validate assignments without depending on the VM service.
 */
import type { VmAssignment, VmAssignmentKind } from "@godmode/shared";
import { all, get } from "../db";
import { bus } from "../events/bus";
import { badRequest } from "../util";

export const ASSIGNMENT_TABLES: Record<VmAssignmentKind, string> = {
  agent: "agents",
  conversation: "conversations",
  workspace: "workspaces",
};

export function vmExists(id: string): boolean {
  return get<{ id: string }>("SELECT id FROM vms WHERE id = ?", id) !== null;
}

/** Normalize an assignment from an API input: undefined = unchanged, null/"" = none, else an existing VM id. */
export function normalizeVmId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const id = value?.trim() || null;
  if (id && !vmExists(id)) throw badRequest("That virtual machine doesn't exist anymore");
  return id;
}

/** An assignment changed: VM lists show who uses each VM. */
export function assignmentsChanged(): void {
  bus.changed("vms");
}

/** Agents, chats (not archived) and workspaces that use the VM. */
export function vmAssignments(vmId: string): VmAssignment[] {
  const agents = all<{ id: string; name: string }>("SELECT id, name FROM agents WHERE vm_id = ? ORDER BY name COLLATE NOCASE", vmId);
  const workspaces = all<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE vm_id = ? ORDER BY name COLLATE NOCASE", vmId);
  const chats = all<{ id: string; title: string }>(
    "SELECT id, title FROM conversations WHERE vm_id = ? AND archived = 0 ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 50",
    vmId,
  );
  return [
    ...agents.map((r) => ({ kind: "agent" as const, id: r.id, name: r.name })),
    ...workspaces.map((r) => ({ kind: "workspace" as const, id: r.id, name: r.name })),
    ...chats.map((r) => ({ kind: "conversation" as const, id: r.id, name: r.title })),
  ];
}

/**
 * The VM a run works in: its chat's, else its agent's, else its agent's workspace's. An assignment to a VM that no
 * longer exists (only a restored backup can leave one) still counts — the run fails instead of running on the host.
 */
export function resolveVmId(conversationId: string | null, agent: { vmId: string | null; workspaceId: string | null }): string | null {
  const conv = conversationId ? get<{ vm_id: string | null }>("SELECT vm_id FROM conversations WHERE id = ?", conversationId) : null;
  const workspace = agent.workspaceId ? get<{ vm_id: string | null }>("SELECT vm_id FROM workspaces WHERE id = ?", agent.workspaceId) : null;
  return conv?.vm_id || agent.vmId || workspace?.vm_id || null;
}
