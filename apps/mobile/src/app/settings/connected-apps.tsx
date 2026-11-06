import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { ConnectStatus, Connector } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { ago } from "@/components/status-rows";
import { EmptyState, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** Settings → Connected apps: Claude Code and other MCP clients with a key to Godmode. Seen and revoked here; a full-access phone also connects new ones. */
export default function ConnectedApps() {
  const { t } = useTranslation(["settings", "linking"]);
  const { fullAccess } = useFullAccess();
  const status = useQuery({ queryKey: sq.connectors, queryFn: settingsApi.connectors.status });
  const pull = usePullRefresh(status.refetch);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("connected.title") }} />
      <CloseButton />
      <QueryState query={status} icon="plug" errorTitle={t("connected.loadFailed")}>
        {(s) => (
          <>
            {fullAccess ? (
              <Group>
                <LinkRow icon="plus" title={t("linking:connect.title")} onPress={() => router.push("/settings/connect-app")} />
              </Group>
            ) : null}
            {s.connectors.length ? (
              <Group footer={fullAccess ? t("linking:connect.footer") : t("connected.footer")}>
                {s.connectors.map((c) => (
                  <ConnectorRow key={c.id} connector={c} />
                ))}
              </Group>
            ) : (
              <EmptyState icon="plug" title={t("connected.emptyTitle")} body={fullAccess ? undefined : t("connected.emptyBody")} />
            )}
          </>
        )}
      </QueryState>
    </ScrollView>
  );
}

function ConnectorRow({ connector: c }: { connector: Connector }) {
  const { t } = useTranslation(["settings", "common"]);
  const calls = t("connected.calls", { count: c.calls });
  const used = c.lastUsedAt ? t("connected.lastUsed", { time: ago(c.lastUsedAt), calls }) : t("connected.notUsed");
  const detail = [t(c.access === "manage" ? "connected.access.manage" : "connected.access.read"), used].join(" · ");

  const revoke = async () => {
    const before = queryClient.getQueryData<ConnectStatus>(sq.connectors);
    queryClient.setQueryData<ConnectStatus>(sq.connectors, (s) => (s ? { ...s, connectors: s.connectors.filter((x) => x.id !== c.id) } : s));
    try {
      await settingsApi.connectors.revoke(c.id);
      tap(Haptics.ImpactFeedbackStyle.Medium);
    } catch (err) {
      queryClient.setQueryData(sq.connectors, before);
      Alert.alert(t("connected.removeFailed"), errorText(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: sq.connectors });
    }
  };

  const confirm = () =>
    Alert.alert(t("connected.confirmTitle", { name: c.name }), t(c.installed ? "connected.confirmInstalled" : "connected.confirm"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("common:actions.remove"), style: "destructive", onPress: () => void revoke() },
    ]);

  return <LinkRow icon={c.client === "claude-code" ? "terminal" : "plug"} title={c.name} detail={detail} chevron={false} onPress={confirm} />;
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
