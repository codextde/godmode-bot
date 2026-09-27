/**
 * CONTRACT (owner: agents agent). Agents (bots): CRUD, per-agent git repo, CLAUDE.md generation.
 */
import type { Agent } from "@godmode/shared";
import type { AgentInput } from "@godmode/shared";

export async function ensureDefaultAgent(): Promise<Agent> {
  throw new Error("not implemented");
}
export function getDefaultAgentId(): string | null {
  return null;
}
export function listAgents(_opts: { workspaceId?: string | null | "all" } = {}): Agent[] {
  throw new Error("not implemented");
}
export function getAgent(_id: string): Agent {
  throw new Error("not implemented");
}
export async function createAgent(_input: AgentInput): Promise<Agent> {
  throw new Error("not implemented");
}
export async function updateAgent(_id: string, _patch: Partial<AgentInput>): Promise<Agent> {
  throw new Error("not implemented");
}
export async function deleteAgent(_id: string): Promise<void> {
  throw new Error("not implemented");
}
