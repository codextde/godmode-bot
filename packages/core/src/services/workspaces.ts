/**
 * CONTRACT (owner: agents agent). Workspaces CRUD.
 */
import type { Workspace } from "@godmode/shared";
import type { WorkspaceInput } from "@godmode/shared";

export function listWorkspaces(): Workspace[] {
  throw new Error("not implemented");
}
export function getWorkspace(_id: string): Workspace {
  throw new Error("not implemented");
}
export function createWorkspace(_input: WorkspaceInput): Workspace {
  throw new Error("not implemented");
}
export function updateWorkspace(_id: string, _patch: Partial<WorkspaceInput>): Workspace {
  throw new Error("not implemented");
}
export async function deleteWorkspace(_id: string, _force = false): Promise<void> {
  throw new Error("not implemented");
}
