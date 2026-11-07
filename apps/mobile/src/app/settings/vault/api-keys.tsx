import { router, Stack } from "expo-router";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ApiTool } from "@godmode/shared";
import { Group, Tile } from "@/components/form";
import { NeedsFullAccessScreen, needsFullAccess, useFullAccess } from "@/components/full-access";
import type { IconName } from "@/components/icon";
import { confirmDelete, RowMenu, type MenuItem } from "@/components/secret-parts";
import { EmptyState, ErrorState, SkeletonRows, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { toolIcon } from "@/lib/api-tool-presets";
import { whenText } from "@/lib/format";
import { hostOfUrl } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { APP_SECRETS, fullVaultApi, secretLabel, useAppSecrets, useVaultApiTools, vk, type AppSecret } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: vk.secrets });
  void queryClient.invalidateQueries({ queryKey: vk.apiTools });
  void queryClient.invalidateQueries({ queryKey: ["integrations"] });
};

/**
 * API keys in the vault, like the desktop's Settings → API keys and the keys of agents' APIs. Values are never shown,
 * not even on the computer: they can only be replaced or removed.
 */
export default function ApiKeys() {
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const secrets = useAppSecrets(!!fullAccess);
  const tools = useVaultApiTools(!!fullAccess);
  const pull = usePullRefresh(() => Promise.all([secrets.refetch(), tools.refetch()]));

  if (fullAccess === false || needsFullAccess(secrets.error)) {
    return (
      <>
        <Stack.Screen options={{ title: t("apiKeys.title") }} />
        <NeedsFullAccessScreen />
      </>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("apiKeys.title") }} />
      {secrets.isLoading || fullAccess === undefined ? (
        <SkeletonRows count={6} avatar={30} />
      ) : secrets.isError ? (
        <ErrorState title={t("apiKeys.loadFailed")} error={errorText(secrets.error)} onRetry={() => void secrets.refetch()} />
      ) : (
        <>
          <Group title={t("apiKeys.keys")}>
            {(secrets.data ?? []).map((s) => (
              <SecretKeyRow key={s.key} secret={s} />
            ))}
          </Group>
          {tools.data?.length ? (
            <Group title={t("apiKeys.tools")}>
              {tools.data.map((tool) => (
                <ToolRow key={tool.id} tool={tool} />
              ))}
            </Group>
          ) : tools.isError ? (
            <ErrorState title={t("apiKeys.toolsFailed")} error={errorText(tools.error)} onRetry={() => void tools.refetch()} />
          ) : null}
          {!secrets.data?.length && !tools.data?.length ? <EmptyState icon="key" title={t("apiKeys.empty")} /> : null}
        </>
      )}
    </ScrollView>
  );
}

function KeyRow({ icon, title, detail, set, onPress, menu, label }: { icon: IconName; title: string; detail: string; set: boolean; onPress: () => void; menu: MenuItem[]; label: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon={icon} tint={set ? undefined : c.textMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {title}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {detail}
        </T>
      </View>
      <RowMenu label={label} items={menu} />
    </Pressable>
  );
}

function SecretKeyRow({ secret: s }: { secret: AppSecret }) {
  const { t } = useTranslation(["vault", "common"]);
  const name = secretLabel(s.key);
  const edit = () => router.push({ pathname: "/vault/key-edit", params: { kind: "secret", id: s.key } });
  const remove = () =>
    confirmDelete(t("apiKeys.removeTitle", { name }), t("apiKeys.removeBody"), t("common:actions.remove"), t("common:actions.cancel"), () => {
      (s.key === "composio_api_key" ? fullVaultApi.setComposioKey(null) : fullVaultApi.deleteSecret(s.key)).then(refresh, (err: unknown) => Alert.alert(t("apiKeys.removeFailed"), errorText(err)));
    });
  return (
    <KeyRow
      icon={APP_SECRETS[s.key]?.icon ?? "key"}
      title={name}
      detail={s.set ? (s.updatedAt ? t("apiKeys.updated", { when: whenText(s.updatedAt) }) : t("apiKeys.set")) : t("apiKeys.notSet")}
      set={s.set}
      onPress={edit}
      label={t("apiKeys.actionsFor", { name })}
      menu={[
        { label: s.set ? t("apiKeys.replace") : t("apiKeys.setKey"), icon: "pencil", onPress: edit },
        ...(s.set ? [{ label: t("common:actions.remove"), icon: "trash" as const, destructive: true, onPress: remove }] : []),
      ]}
    />
  );
}

function ToolRow({ tool }: { tool: ApiTool }) {
  const { t } = useTranslation(["vault", "common"]);
  const edit = () => router.push({ pathname: "/vault/key-edit", params: { kind: "tool", id: tool.id } });
  const test = () =>
    fullVaultApi.testApiTool(tool.id).then(
      (res) => Alert.alert(res.ok ? t("apiKeys.testOk", { name: tool.name }) : t("apiKeys.testFailed", { name: tool.name }), res.message),
      (err: unknown) => Alert.alert(t("apiKeys.testFailed", { name: tool.name }), errorText(err)),
    );
  const toggle = () => fullVaultApi.updateApiTool(tool.id, { enabled: !tool.enabled }).then(refresh, (err: unknown) => Alert.alert(t("apiKeys.changeFailed"), errorText(err)));
  const remove = () =>
    confirmDelete(t("apiKeys.deleteToolTitle", { name: tool.name }), t("apiKeys.deleteToolBody"), t("common:actions.delete"), t("common:actions.cancel"), () => {
      fullVaultApi.deleteApiTool(tool.id).then(refresh, (err: unknown) => Alert.alert(t("apiKeys.deleteToolFailed"), errorText(err)));
    });
  const host = hostOfUrl(tool.baseUrl);
  return (
    <KeyRow
      icon={toolIcon(tool.preset)}
      title={tool.name}
      detail={[host || null, tool.enabled ? null : t("apiKeys.off"), tool.hasKey ? null : t("apiKeys.noKey")].filter(Boolean).join(" · ") || t("apiKeys.set")}
      set={tool.hasKey}
      onPress={edit}
      label={t("apiKeys.actionsFor", { name: tool.name })}
      menu={[
        { label: tool.hasKey ? t("apiKeys.replace") : t("apiKeys.setKey"), icon: "pencil", onPress: edit },
        { label: t("apiKeys.setUp"), icon: "slider", onPress: () => router.push({ pathname: "/settings/api-tool", params: { id: tool.id } }) },
        ...(tool.testPath && tool.hasKey ? [{ label: t("apiKeys.test"), icon: "checkCircle" as const, onPress: () => void test() }] : []),
        { label: tool.enabled ? t("apiKeys.turnOff") : t("apiKeys.turnOn"), icon: "power", onPress: () => void toggle() },
        { label: t("common:actions.delete"), icon: "trash", destructive: true, onPress: remove },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
});
