import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ComposioConnection, ComposioStatus } from "@godmode/shared";
import { isRefused, useFullAccess } from "@/components/admin";
import { useScopeLabel } from "@/components/app-trigger-fields";
import { CloseButton } from "@/components/close-button";
import { ConnectionBadge, ToolkitLogo } from "@/components/composio-parts";
import { Group, LinkRow } from "@/components/form";
import { FieldCard, InputRow } from "@/components/secret-parts";
import { FormSkeleton } from "@/components/settings-state";
import { InfoRow } from "@/components/status-rows";
import { ActionRow } from "@/components/tool-form";
import { ErrorState, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { composioAdmin, connectionTone, refreshComposio, toolkitLogoUrl } from "@/lib/composio-admin";
import { dateLocale } from "@/lib/i18n";
import { ik, useComposioConnections, useComposioStatus } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { appName } from "@/components/routine-row";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space, useColors } from "@/lib/theme";

const COMPOSIO_DASHBOARD = "https://app.composio.dev";

/** Settings → Integrations → Composio (desktop: composio-tab.tsx): the API key, the connected accounts, and connecting more. */
export default function Composio() {
  const { t } = useTranslation(["integrations", "components"]);
  const admin = useFullAccess().fullAccess === true;
  const status = useComposioStatus();
  const connections = useComposioConnections();
  const ready = !!status.data?.configured && status.data.valid !== false;
  const pull = usePullRefresh(() => Promise.all([status.refetch(), connections.refetch()]));
  const list = connections.data ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: "Composio" }} />
      <CloseButton />
      {status.isLoading ? (
        <FormSkeleton groups={2} rows={2} />
      ) : status.isError ? (
        <ErrorState title={t("composioAdmin.statusFailed")} error={errorText(status.error)} onRetry={() => void status.refetch()} />
      ) : (
        <>
          <KeyGroup status={status.data!} admin={admin} />
          {ready ? (
            connections.isError ? (
              <ErrorState title={t("composioAdmin.connectionsFailed")} error={errorText(connections.error)} onRetry={() => void connections.refetch()} />
            ) : (
              <Connections connections={list} admin={admin} loading={connections.isLoading} />
            )
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function KeyGroup({ status, admin }: { status: ComposioStatus; admin: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["integrations", "common", "components"]);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const configured = status.configured;
  const invalid = configured && status.valid === false;

  const fail = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));
  const store = (next: ComposioStatus) => {
    queryClient.setQueryData(ik.composioStatus, next);
    refreshComposio();
  };
  const save = async () => {
    const apiKey = key.trim();
    if (!apiKey || busy) return;
    setBusy("save");
    try {
      const next = await composioAdmin.setKey(apiKey);
      store(next);
      setKey("");
      setEditing(false);
      if (next.valid === false) Alert.alert(t("composioAdmin.key.rejected"), next.error ?? t("composioAdmin.key.rejectedHint"));
      else tap();
    } catch (err) {
      fail(t("composioAdmin.key.saveFailed"), err);
    } finally {
      setBusy(null);
    }
  };
  const recheck = async () => {
    setBusy("check");
    try {
      const next = await composioAdmin.recheck();
      store(next);
      if (next.valid === false) Alert.alert(t("composioAdmin.key.rejected"), next.error ?? undefined);
      else if (next.valid) Alert.alert(t("composioAdmin.key.valid"));
    } catch (err) {
      fail(t("composioAdmin.key.checkFailed"), err);
    } finally {
      setBusy(null);
    }
  };
  const remove = () =>
    Alert.alert(t("composioAdmin.key.removeTitle"), t("composioAdmin.key.removeDescription"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("composioAdmin.key.removeConfirm"),
        style: "destructive",
        onPress: () => {
          setBusy("remove");
          composioAdmin
            .setKey(null)
            .then(store)
            .catch((err) => fail(t("composioAdmin.key.saveFailed"), err))
            .finally(() => setBusy(null));
        },
      },
    ]);

  const form = admin && (!configured || editing);
  const state = !configured ? t("composioAdmin.key.notSetUp") : invalid ? t("composioAdmin.key.invalidTitle") : t("composioAdmin.key.connectedTitle");
  const detail = !configured ? undefined : invalid ? (status.error ?? t("composioAdmin.key.rejectedReplace")) : status.valid === null ? t("composioAdmin.key.pending") : t("composioAdmin.key.stored");

  return (
    <View style={{ gap: space.md }}>
      <Group title={t("composioAdmin.key.label")} footer={admin ? undefined : t("components:fullAccess.title")}>
        <InfoRow icon={invalid ? "warning" : configured ? "checkCircle" : "key"} label={state} detail={detail} tone={invalid ? "danger" : configured ? "success" : undefined} />
        {admin && configured && !editing ? <ActionRow icon="refresh" title={t("composioAdmin.key.recheck")} busy={busy === "check"} onPress={() => void recheck()} /> : null}
        {admin && configured && !editing ? <ActionRow icon="pencil" title={t("composioAdmin.key.replace")} onPress={() => setEditing(true)} /> : null}
        {admin && configured && !editing ? <ActionRow icon="trash" title={t("composioAdmin.key.removeConfirm")} busy={busy === "remove"} tone="danger" onPress={remove} /> : null}
      </Group>
      {form ? (
        <View style={{ gap: space.sm }}>
          <FieldCard>
            <InputRow label={t("composioAdmin.key.short")} value={key} onChangeText={setKey} placeholder="ak_…" secure autoFocus={editing} onSubmitEditing={() => void save()} />
            <ActionRow icon="check" title={busy === "save" ? t("composioAdmin.key.checking") : t("composioAdmin.key.save")} busy={busy === "save"} onPress={() => void save()} />
            {editing ? <ActionRow icon="close" title={t("common:actions.cancel")} onPress={() => (setEditing(false), setKey(""))} /> : null}
          </FieldCard>
          <Pressable accessibilityRole="link" hitSlop={6} onPress={() => void Linking.openURL(COMPOSIO_DASHBOARD)} style={{ alignSelf: "flex-start" }}>
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("composioAdmin.key.getKey")}
            </T>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface ScopeGroup {
  key: string;
  label: string;
  items: ComposioConnection[];
}

/** Connected accounts by who may use them: everyone, a workspace, one agent. */
function Connections({ connections, admin, loading }: { connections: ComposioConnection[]; admin: boolean; loading: boolean }) {
  const { t } = useTranslation(["integrations", "common", "components"]);
  const scopeOf = useScopeLabel();
  const [busy, setBusy] = useState<string | null>(null);
  const map = new Map<string, ScopeGroup>();
  for (const x of connections) {
    const key = x.agentId ? `agent:${x.agentId}` : x.workspaceId ? `ws:${x.workspaceId}` : "global";
    if (!map.has(key)) map.set(key, { key, label: key === "global" ? t("composioAdmin.connections.global") : scopeOf(x), items: [] });
    map.get(key)!.items.push(x);
  }
  const order = (k: string) => (k === "global" ? 0 : k.startsWith("ws:") ? 1 : 2);
  const groups = [...map.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));

  const fail = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));
  const refresh = (x: ComposioConnection) => {
    setBusy(x.id);
    composioAdmin
      .refresh(x.id)
      .then((next) => {
        queryClient.setQueryData<ComposioConnection[]>(ik.composioConnections, (list) => list?.map((y) => (y.id === next.id ? next : y)));
        Alert.alert(connectionTone(next.status) === "ok" ? t("composioAdmin.connections.isActive") : t("composioAdmin.connections.statusIs", { status: next.status.toLowerCase() }));
      })
      .catch((err) => fail(t("composioAdmin.connections.refreshFailed"), err))
      .finally(() => setBusy(null));
  };
  const disconnect = (x: ComposioConnection) =>
    Alert.alert(t("composioAdmin.connections.disconnectTitle", { name: appName(x.toolkit) }), t("composioAdmin.connections.disconnectDescription"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("composioAdmin.connections.disconnect"),
        style: "destructive",
        onPress: () => {
          const before = queryClient.getQueryData<ComposioConnection[]>(ik.composioConnections);
          queryClient.setQueryData<ComposioConnection[]>(ik.composioConnections, (list) => list?.filter((y) => y.id !== x.id));
          composioAdmin
            .disconnect(x.id)
            .then(() => tap())
            .catch((err) => {
              if (before) queryClient.setQueryData(ik.composioConnections, before);
              fail(t("composioAdmin.connections.disconnectFailed"), err);
            })
            .finally(refreshComposio);
        },
      },
    ]);
  const actions = (x: ComposioConnection) =>
    Alert.alert(appName(x.toolkit), scopeOf(x), [
      { text: t("composioAdmin.connections.checkStatus"), onPress: () => refresh(x) },
      { text: t("composioAdmin.connections.disconnect"), style: "destructive", onPress: () => disconnect(x) },
      { text: t("common:actions.cancel"), style: "cancel" },
    ]);

  if (loading) return <FormSkeleton groups={1} rows={2} />;
  return (
    <View style={{ gap: space.xl }}>
      {groups.map((g) => (
        <Group key={g.key} title={g.label}>
          {g.items.map((x) => (
            <ConnectionRow key={x.id} connection={x} busy={busy === x.id} onPress={admin ? () => actions(x) : undefined} />
          ))}
        </Group>
      ))}
      {admin ? (
        <Group footer={connections.length ? undefined : t("composioAdmin.connections.empty")}>
          <LinkRow icon="plus" title={t("composioAdmin.gallery.title")} onPress={() => router.push("/settings/composio-connect")} />
        </Group>
      ) : null}
    </View>
  );
}

function ConnectionRow({ connection: x, busy, onPress }: { connection: ComposioConnection; busy: boolean; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("integrations");
  const ago = formatDistanceToNowStrict(new Date(x.createdAt), { addSuffix: true, locale: dateLocale() });
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress || busy}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }, busy && { opacity: 0.5 }]}
    >
      <ToolkitLogo uri={toolkitLogoUrl(x.toolkit)} name={appName(x.toolkit)} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
          {appName(x.toolkit)}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {t("composioAdmin.connections.connectedAgo", { ago })}
        </T>
      </View>
      <ConnectionBadge status={x.status} />
    </Pressable>
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
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
