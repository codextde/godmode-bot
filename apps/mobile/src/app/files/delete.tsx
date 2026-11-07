import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@godmode/shared";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Button, Card, ErrorState, Hairline, LoadingState, Skeleton, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { KIND_ICON, countOf, fileChanged, fileKind, filesApi, fk, nameOf, refreshFiles } from "@/lib/agent-files";
import { useAgents } from "@/lib/hooks";
import { fonts, radius, space, useColors } from "@/lib/theme";

/**
 * Before something of an agent goes: what it is, its size, whether the agent still names it and what has to stay. It
 * goes to the agent's bin, where it waits 30 days.
 */
export default function DeleteSheet() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const { agent, path, paths } = useLocalSearchParams<{ agent: string; path?: string; paths?: string }>();
  const going = path ? [path] : listOf(paths);
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (fullAccess === undefined) return <LoadingState />;
  return <DeleteForm agent={agent} paths={going} />;
}

/** Several paths travel as a JSON list (the review's picks). */
function listOf(raw: string | undefined): string[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function DeleteForm({ agent, paths }: { agent: string; paths: string[] }) {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const agentName = useAgents().byId.get(agent)?.name ?? t("folder.theAgent");
  const info = useQuery({ queryKey: fk.inspect(agent, paths), queryFn: () => filesApi.inspect(agent, paths), gcTime: 0, staleTime: 0 });
  const entries = info.data ?? [];
  const going = entries.filter((e) => !e.locked);
  const staying = entries.filter((e) => e.locked);
  const named = going.filter((e) => e.namedBy.length);
  const bytes = going.reduce((n, e) => n + e.bytes, 0);
  const files = going.reduce((n, e) => n + e.files, 0);

  const remove = useMutation({
    mutationFn: () => filesApi.delete(agent, going.map((e) => e.path)),
    onSuccess: ({ deleted, refused }) => {
      refreshFiles(agent);
      router.back();
      if (deleted.length) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        fileChanged({ agentId: agent, deleted: deleted.map((d) => d.path) });
      }
      if (refused.length) Alert.alert(deleted.length ? t("delete.someStayed") : t("delete.nothingDeleted"), refused.map((r) => `${nameOf(r.path)}: ${r.reason}`).join("\n"));
    },
    onError: (err) => Alert.alert(t("delete.failed"), errorText(err)),
  });

  const title = paths.length === 1 ? t("delete.titleOne", { name: nameOf(paths[0]!) }) : t("delete.titleMany", { items: countOf(paths.length, "item") });
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={{ gap: space.xs }}>
        <T variant="title">{title}</T>
        <T variant="subhead" muted>
          {t("delete.description", { name: agentName, count: paths.length })}
        </T>
      </View>
      {info.isLoading ? (
        <View style={{ gap: space.sm }}>
          <Skeleton height={48} radius={radius.lg} />
          <Skeleton height={20} width="40%" />
        </View>
      ) : info.isError ? (
        <ErrorState title={t("delete.loadFailed")} error={errorText(info.error)} onRetry={() => void info.refetch()} />
      ) : (
        <>
          {going.length ? (
            <Card style={{ overflow: "hidden" }}>
              {going.slice(0, 50).map((e, i) => (
                <View key={e.path}>
                  {i > 0 ? <Hairline inset={space.lg} /> : null}
                  <View style={styles.row}>
                    <Icon name={KIND_ICON[fileKind(e)]} size={16} color={c.textMuted} />
                    <T variant="footnote" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono }}>
                      {e.path}
                    </T>
                    <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
                      {formatBytes(e.bytes)}
                    </T>
                  </View>
                </View>
              ))}
              {files > going.length ? (
                <>
                  <Hairline inset={space.lg} />
                  <T variant="footnote" muted style={styles.total}>
                    {`${formatBytes(bytes)} · ${countOf(files, "file")}`}
                  </T>
                </>
              ) : null}
            </Card>
          ) : null}
          {named.length ? (
            <View style={[styles.box, { backgroundColor: c.warningSoft }]}>
              <Icon name="warning" size={14} color={c.warning} />
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="footnote" style={{ fontWeight: "600" }}>
                  {named.length === 1 ? t("delete.stillNamesOne", { name: agentName }) : t("delete.stillNamesMany", { name: agentName, n: named.length })}
                </T>
                {named.slice(0, 4).map((e) => (
                  <T key={e.path} variant="footnote" muted>
                    {t("delete.namedIn", { file: nameOf(e.path), names: e.namedBy.slice(0, 2).join(", ") })}
                  </T>
                ))}
                <T variant="footnote" muted>
                  {named.length === 1 ? t("delete.mayNeedOne") : t("delete.mayNeedMany")}
                </T>
              </View>
            </View>
          ) : null}
          {staying.map((e) => (
            <View key={e.path} style={[styles.box, { paddingVertical: 0 }]}>
              <Icon name="lock" size={13} color={c.textMuted} />
              <T variant="footnote" muted style={{ flex: 1 }}>
                {t("delete.stays", { name: nameOf(e.path) || e.path, reason: e.locked })}
              </T>
            </View>
          ))}
          <View style={{ gap: space.sm }}>
            <Button title={t("delete.moveToBin")} icon="trash" variant="danger" loading={remove.isPending} disabled={!going.length} onPress={() => remove.mutate()} />
            <Button title={t("common:actions.cancel")} variant="secondary" disabled={remove.isPending} onPress={() => router.back()} />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: 44 },
  total: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  box: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, borderCurve: "continuous" },
});
