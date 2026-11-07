import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ApiTool, ComposioConnection, McpServer } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { ListRow } from "@/components/readonly-list";
import { ActionRow } from "@/components/tool-form";
import { Badge, EmptyState, ErrorState, SkeletonRows, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { toolIcon } from "@/lib/api-tool-presets";
import { hostOfUrl, useApiTools, useComposioConnections, useComposioStatus, useMcpServers } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { setEnabled } from "@/lib/tools-admin";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

/**
 * What agents connect to: MCP servers, API keys and Composio apps, by name and state. A full-access phone also adds,
 * edits, tests and switches servers and API tools, like the desktop.
 */
export default function Integrations() {
  const { t } = useTranslation(["integrations", "tools"]);
  const admin = !!useFullAccess().fullAccess;
  const mcp = useMcpServers();
  const tools = useApiTools();
  const composio = useComposioStatus();
  const connections = useComposioConnections();
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: ["integrations"] }));
  const loading = mcp.isLoading || tools.isLoading;
  const servers = mcp.data ?? [];
  const keys = tools.data ?? [];
  const apps = connections.data ?? [];
  const empty = !servers.length && !keys.length && !apps.length && !composio.data?.configured;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("title") }} />
      <CloseButton />
      {loading ? (
        <SkeletonRows count={5} avatar={36} />
      ) : isOutdated(mcp.error) ? (
        <EmptyState icon="plug" title={t("outdatedTitle")} body={t("outdatedBody")} />
      ) : mcp.isError && tools.isError ? (
        <ErrorState title={t("loadFailed")} error={errorText(mcp.error)} onRetry={() => void pull.onRefresh()} />
      ) : empty && !admin ? (
        <EmptyState icon="plug" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <View style={{ gap: space.xl }}>
          {servers.length || admin ? (
            <Group title={t("mcp.title")}>
              {servers.map((s) => (
                <McpRow key={s.id} server={s} admin={admin} />
              ))}
              {admin ? <ActionRow icon="plus" title={t("tools:mcp.add")} onPress={() => router.push("/settings/mcp-server")} /> : null}
            </Group>
          ) : null}
          {keys.length || admin ? (
            <Group title={t("apiTools.title")}>
              {keys.map((tool) => (
                <ApiToolRow key={tool.id} tool={tool} admin={admin} />
              ))}
              {admin ? <ActionRow icon="plus" title={t("tools:api.add")} onPress={() => router.push("/settings/api-tool")} /> : null}
            </Group>
          ) : null}
          {composio.data?.configured || apps.length ? (
            <Group title={t("composio.title")}>
              <ListRow
                grouped
                icon="layers"
                title={t("composio.account")}
                trailing={
                  composio.data?.valid === false ? (
                    <Badge label={t("composio.invalid")} tone="danger" />
                  ) : composio.data?.configured ? (
                    <Badge label={t("composio.connected")} tone="success" />
                  ) : (
                    <Badge label={t("composio.notSetUp")} />
                  )
                }
              />
              {apps.map((a) => (
                <ComposioRow key={a.id} connection={a} />
              ))}
            </Group>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

/** A switch in the row on a full-access phone, like the desktop's list. */
function EnabledSwitch({ kind, id, name, enabled }: { kind: "mcp" | "api"; id: string; name: string; enabled: boolean }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  return (
    <Switch
      accessibilityLabel={t("list.switch", { name })}
      value={enabled}
      onValueChange={async (next) => {
        tap();
        const failed = await setEnabled(kind, id, next);
        if (failed) Alert.alert(t("list.switchFailed"), failed);
      }}
      trackColor={{ true: c.brand, false: c.sunken }}
    />
  );
}

function McpRow({ server: s, admin }: { server: McpServer; admin: boolean }) {
  const { t } = useTranslation("integrations");
  const where = s.source === "composio" ? t("mcp.composio") : s.transport === "stdio" ? t("mcp.local") : hostOfUrl(s.url) || s.transport.toUpperCase();
  return (
    <ListRow
      grouped
      icon="network"
      title={s.name}
      lines={[[where, s.transport === "stdio" ? null : s.transport.toUpperCase()].filter(Boolean).join(" · ")]}
      trailing={admin ? <EnabledSwitch kind="mcp" id={s.id} name={s.name} enabled={s.enabled} /> : <Badge label={s.enabled ? t("on") : t("off")} tone={s.enabled ? "success" : "neutral"} />}
      onPress={admin ? () => router.push({ pathname: "/settings/mcp-server", params: { id: s.id } }) : undefined}
    />
  );
}

function ApiToolRow({ tool, admin }: { tool: ApiTool; admin: boolean }) {
  const { t } = useTranslation("integrations");
  return (
    <ListRow
      grouped
      icon={toolIcon(tool.preset)}
      title={tool.name}
      lines={[hostOfUrl(tool.baseUrl) || t("apiTools.noAddress"), tool.hasKey ? null : t("apiTools.noKey")]}
      trailing={admin ? <EnabledSwitch kind="api" id={tool.id} name={tool.name} enabled={tool.enabled} /> : <Badge label={tool.enabled ? t("on") : t("off")} tone={tool.enabled ? "success" : "neutral"} />}
      onPress={admin ? () => router.push({ pathname: "/settings/api-tool", params: { id: tool.id } }) : undefined}
    />
  );
}

function ComposioRow({ connection: c }: { connection: ComposioConnection }) {
  const { t } = useTranslation("integrations");
  const state = c.status.toUpperCase();
  const tone = state === "ACTIVE" ? "success" : state === "INITIATED" || state === "INITIALIZING" ? "warning" : "danger";
  const label = state === "ACTIVE" ? t("composio.active") : state === "INITIATED" || state === "INITIALIZING" ? t("composio.waiting") : t("composio.attention");
  return <ListRow grouped icon="layers" title={c.toolkit.charAt(0).toUpperCase() + c.toolkit.slice(1)} trailing={<Badge label={label} tone={tone} />} />;
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
