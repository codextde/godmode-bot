import { Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ApiTool, ComposioConnection, McpServer } from "@godmode/shared";
import { Group } from "@/components/form";
import { ListRow } from "@/components/readonly-list";
import { Badge, EmptyState, ErrorState, SkeletonRows } from "@/components/ui";
import { errorText } from "@/lib/api";
import { hostOfUrl, useApiTools, useComposioConnections, useComposioStatus, useMcpServers } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated } from "@/lib/vault";
import { space } from "@/lib/theme";

/** What agents connect to: MCP servers, API keys and Composio apps, by name and state. Set up and tested on the computer. */
export default function Integrations() {
  const { t } = useTranslation("integrations");
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
      {loading ? (
        <SkeletonRows count={5} avatar={36} />
      ) : isOutdated(mcp.error) ? (
        <EmptyState icon="plug" title={t("outdatedTitle")} body={t("outdatedBody")} />
      ) : mcp.isError && tools.isError ? (
        <ErrorState title={t("loadFailed")} error={errorText(mcp.error)} onRetry={() => void pull.onRefresh()} />
      ) : empty ? (
        <EmptyState icon="plug" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <View style={{ gap: space.xl }}>
          {servers.length ? (
            <Group title={t("mcp.title")}>
              {servers.map((s) => (
                <McpRow key={s.id} server={s} />
              ))}
            </Group>
          ) : null}
          {keys.length ? (
            <Group title={t("apiTools.title")}>
              {keys.map((tool) => (
                <ApiToolRow key={tool.id} tool={tool} />
              ))}
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

function McpRow({ server: s }: { server: McpServer }) {
  const { t } = useTranslation("integrations");
  const where = s.source === "composio" ? t("mcp.composio") : s.transport === "stdio" ? t("mcp.local") : hostOfUrl(s.url) || s.transport.toUpperCase();
  return (
    <ListRow
      grouped
      icon="network"
      title={s.name}
      lines={[[where, s.transport === "stdio" ? null : s.transport.toUpperCase()].filter(Boolean).join(" · ")]}
      trailing={<Badge label={s.enabled ? t("on") : t("off")} tone={s.enabled ? "success" : "neutral"} />}
    />
  );
}

function ApiToolRow({ tool }: { tool: ApiTool }) {
  const { t } = useTranslation("integrations");
  return (
    <ListRow
      grouped
      icon="link"
      title={tool.name}
      lines={[hostOfUrl(tool.baseUrl) || t("apiTools.noAddress"), tool.hasKey ? null : t("apiTools.noKey")]}
      trailing={<Badge label={tool.enabled ? t("on") : t("off")} tone={tool.enabled ? "success" : "neutral"} />}
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
