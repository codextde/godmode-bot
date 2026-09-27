/**
 * CONTRACT (owner: platform agent). Custom MCP servers + Composio-backed servers, scoped global/workspace/agent.
 */
import type { Agent } from "@godmode/shared";
import type { McpServerJson } from "../types";

/**
 * All external MCP servers (custom + composio) an agent gets for a run, keyed by a unique server name,
 * with secrets (env/headers) decrypted. Respects agent.inheritMcp and agent.mcpServerIds.
 */
export async function mcpServersForAgent(_agent: Agent): Promise<Record<string, McpServerJson>> {
  return {};
}
