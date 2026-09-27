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
/** Update runtime status (idle/running/error). Emits agent.updated. */
export function setAgentStatus(_id: string, _status: import("@godmode/shared").AgentStatus): void {
  throw new Error("not implemented");
}
/** Set lastRunAt = now. */
export function touchAgentRun(_id: string): void {
  throw new Error("not implemented");
}
/** Commit all changes in the agent repo (serialized per repo). No-op if nothing changed. */
export async function commitAgentRepo(_agentId: string, _message: string): Promise<void> {
  throw new Error("not implemented");
}
/** Agents visible to `agent` for delegation (same workspace + global), excluding itself, respecting delegateTo. */
export function peersFor(_agent: Agent): Agent[] {
  throw new Error("not implemented");
}
