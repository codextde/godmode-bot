import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { formatDistanceToNowStrict } from "date-fns";
import { ActivityIndicator, Alert } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type DeletedAgentFile } from "@godmode/shared";
import { NeedsFullAccessScreen, needsFullAccess, useFullAccess } from "@/components/full-access";
import { useDreamingNow } from "@/components/file-actions";
import { HeaderActions } from "@/components/header-actions";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { RowMenu } from "@/components/secret-parts";
import { T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { KIND_ICON, countOf, fileKind, filesApi, fk, nameOf, refreshFiles } from "@/lib/agent-files";
import { useAgents, useNow } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { useColors } from "@/lib/theme";

const KEEP_DAYS = 30;

/** An agent's recently deleted files: put back, or deleted for good (one, or the whole bin). Kept 30 days. */
export default function Bin() {
  const { t } = useTranslation("files");
  const { fullAccess } = useFullAccess();
  if (fullAccess === false) {
    return (
      <>
        <Stack.Screen options={{ title: t("bin.title"), headerLargeTitleEnabled: false }} />
        <NeedsFullAccessScreen />
      </>
    );
  }
  return <BinList />;
}

function BinList() {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const { agent } = useLocalSearchParams<{ agent: string }>();
  const agentName = useAgents().byId.get(agent)?.name ?? t("folder.theAgent");
  const frozen = useDreamingNow(agent);
  const now = useNow(60_000);
  const bin = useQuery({ queryKey: fk.bin(agent), queryFn: () => filesApi.deleted(agent) });
  const entries = bin.data ?? [];
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);

  const restore = useMutation({
    mutationFn: (id: string) => filesApi.restore(agent, id),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refreshFiles(agent);
    },
    onError: (err) => Alert.alert(t("bin.restoreFailed"), errorText(err)),
  });
  const purge = useMutation({
    mutationFn: (target: "all" | string) => (target === "all" ? filesApi.emptyBin(agent) : filesApi.purge(agent, target)),
    onSuccess: () => refreshFiles(agent),
    onError: (err) => Alert.alert(t("bin.purgeFailed"), errorText(err)),
  });

  const confirmEmpty = () =>
    Alert.alert(t("bin.confirmEmptyTitle", { name: agentName }), `${t("bin.confirmEmptyBody", { items: countOf(entries.length, "item"), size: formatBytes(bytes) })} ${t("bin.historyNote")}`, [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("bin.deleteForGood"), style: "destructive", onPress: () => purge.mutate("all") },
    ]);
  const confirmPurge = (e: DeletedAgentFile) =>
    Alert.alert(t("bin.confirmDeleteTitle", { name: nameOf(e.path) }), `${t("bin.confirmDeleteBody")} ${t("bin.historyNote")}`, [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("bin.deleteForGood"), style: "destructive", onPress: () => purge.mutate(e.id) },
    ]);

  if (needsFullAccess(bin.error)) {
    return (
      <>
        <Stack.Screen options={{ title: t("bin.title"), headerLargeTitleEnabled: false }} />
        <NeedsFullAccessScreen />
      </>
    );
  }
  return (
    <>
      {entries.length ? <HeaderActions menu={[{ icon: "trash", title: t("bin.emptyBin"), destructive: true, onPress: confirmEmpty }]} /> : null}
      <ReadonlyList<DeletedAgentFile>
        title={t("bin.title")}
        inline
        query={bin}
        items={entries}
        keyOf={(e) => e.id}
        extraData={`${restore.variables ?? ""}|${restore.isPending}|${frozen}`}
        icon="trash"
        emptyTitle={t("bin.emptyTitle")}
        emptyBody={t("bin.emptyDescription", { days: KEEP_DAYS })}
        failedTitle={t("bin.loadFailed")}
        header={
          entries.length ? (
            <T variant="footnote" muted>
              {t("bin.keptWith", { items: countOf(entries.length, "item"), size: formatBytes(bytes), days: KEEP_DAYS })}
            </T>
          ) : undefined
        }
        renderRow={(e) => {
          const left = Math.max(0, KEEP_DAYS - Math.floor((now - Date.parse(e.deletedAt)) / 86_400_000));
          const busy = restore.isPending && restore.variables === e.id;
          return (
            <ListRow
              icon={KIND_ICON[fileKind(e)]}
              tint={e.type === "dir" ? c.brandStrong : undefined}
              title={nameOf(e.path)}
              lines={[
                e.path,
                [
                  formatBytes(e.bytes),
                  e.type === "dir" ? (e.files ? countOf(e.files, "file") : t("bin.emptyFolder")) : null,
                  t("bin.deletedAgo", { time: formatDistanceToNowStrict(new Date(e.deletedAt), { addSuffix: true, locale: dateLocale() }) }),
                  left ? t("bin.daysLeft", { count: left }) : t("bin.goesToday"),
                ]
                  .filter(Boolean)
                  .join(" · "),
              ]}
              trailing={
                busy ? (
                  <ActivityIndicator size="small" color={c.textMuted} />
                ) : (
                  <RowMenu
                    label={t("bin.actionsFor", { name: nameOf(e.path) })}
                    items={[
                      ...(frozen ? [] : [{ label: t("bin.putBack"), icon: "history" as const, onPress: () => restore.mutate(e.id) }]),
                      { label: t("bin.deleteForGood"), icon: "trash" as const, destructive: true, onPress: () => confirmPurge(e) },
                    ]}
                  />
                )
              }
            />
          );
        }}
      />
    </>
  );
}
