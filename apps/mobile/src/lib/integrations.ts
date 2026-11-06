import { useQuery } from "@tanstack/react-query";
import type { ApiTool, ComposioConnection, ComposioStatus, McpServer, MessagingConnection, Mod, SshServer, SshTestResult } from "@godmode/shared";
import { request } from "./api";

/**
 * Integrations, plugins, messaging and SSH servers as the phone sees them: names and states, never commands, keys,
 * code or passwords (the computer leaves them out). A plugin may be switched off here and a server tested; everything
 * else is set up on the computer.
 */
const get = <T>(path: string) => request<T>("GET", path);

export const integrationsApi = {
  mcpServers: () => get<McpServer[]>("/api/mcp-servers"),
  apiTools: () => get<ApiTool[]>("/api/api-tools"),
  composioStatus: () => get<ComposioStatus>("/api/composio/status"),
  composioConnections: () => get<ComposioConnection[]>("/api/composio/connections"),
  plugins: () => get<Mod[]>("/api/mods"),
  switchOff: (id: string) => request<Mod>("PATCH", `/api/mods/${id}`, { enabled: false }),
  messaging: () => get<MessagingConnection[]>("/api/messaging"),
  sshServers: () => get<SshServer[]>("/api/ssh/servers"),
  /** Signs in and reads the OS: the computer runs nothing else for it. Can take a while on a slow server. */
  testSsh: (id: string) => request<SshTestResult>("POST", `/api/ssh/servers/${id}/test`, {}, 45_000),
};

export const ik = {
  mcpServers: ["integrations", "mcp"],
  apiTools: ["integrations", "api-tools"],
  composioStatus: ["integrations", "composio", "status"],
  composioConnections: ["integrations", "composio", "connections"],
  plugins: ["plugins"],
  messaging: ["messaging"],
  sshServers: ["ssh-servers"],
} as const;

export const useMcpServers = () => useQuery({ queryKey: ik.mcpServers, queryFn: integrationsApi.mcpServers });
export const useApiTools = () => useQuery({ queryKey: ik.apiTools, queryFn: integrationsApi.apiTools });
export const useComposioStatus = () => useQuery({ queryKey: ik.composioStatus, queryFn: integrationsApi.composioStatus });
export const useComposioConnections = () => useQuery({ queryKey: ik.composioConnections, queryFn: integrationsApi.composioConnections });
export const usePlugins = () => useQuery({ queryKey: ik.plugins, queryFn: integrationsApi.plugins });
export const useMessaging = () => useQuery({ queryKey: ik.messaging, queryFn: integrationsApi.messaging });
export const useSshServers = () => useQuery({ queryKey: ik.sshServers, queryFn: integrationsApi.sshServers });

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
