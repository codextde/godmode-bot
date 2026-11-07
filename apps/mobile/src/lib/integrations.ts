import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import type { TFunction } from "i18next";
import { modState, modUpdateAvailable, type ApiTool, type ComposioConnection, type ComposioStatus, type McpServer, type MessagingConnection, type Mod, type SshServer, type SshTestResult } from "@godmode/shared";
import { request } from "./api";
import { dateLocale } from "./i18n";
import { useSettings } from "./setup";

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

/** Plugins that wait for the human: an agent's draft or install to review, code the check refuses, an update. */
export function usePluginsWaiting(): number {
  const { data: settings } = useSettings();
  const { data: mods } = usePlugins();
  if (!settings?.plugins.enabled) return 0;
  return (mods ?? []).filter((m) => ["review", "broken"].includes(modState(m)) || modUpdateAvailable(m)).length;
}
export const useMessaging = () => useQuery({ queryKey: ik.messaging, queryFn: integrationsApi.messaging });
export const useSshServers = (enabled = true) => useQuery({ queryKey: ik.sshServers, queryFn: integrationsApi.sshServers, enabled });

/**
 * "Docs · Used 2 hours ago" for an API tool. `full`: a phone with full access; the computer doesn't tell a limited phone
 * about docs, so it can't say there are none.
 */
export function toolStatus(tool: ApiTool, t: TFunction<"integrations">, full: boolean): string {
  return [
    tool.hasKey ? null : t("apiTools.noKey"),
    full ? (tool.docs ? t("apiTools.docs") : tool.docsUrl ? t("apiTools.docsLink") : t("apiTools.noDocs")) : null,
    tool.lastUsedAt ? t("apiTools.usedAgo", { ago: formatDistanceToNowStrict(new Date(tool.lastUsedAt), { addSuffix: true, locale: dateLocale() }) }) : t("apiTools.notUsed"),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
