/** Internal (core-only) types. */

/** An entry in `--mcp-config` JSON for Claude Code (`{ "mcpServers": { name: McpServerJson } }`). */
export type McpServerJson =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface McpConfigFile {
  mcpServers: Record<string, McpServerJson>;
}

/** Identity of a caller of the Godmode MCP gateway (resolved from the per-run bearer token). */
export interface RunContext {
  runId: string;
  agentId: string;
  conversationId: string;
  workspaceId: string | null;
  /** depth of delegation chain (0 = top level) */
  depth: number;
}
