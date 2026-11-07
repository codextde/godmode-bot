import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ArchiveKind } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, Tile } from "@/components/form";
import type { IconName } from "@/components/icon";
import { EmptyState, ErrorState, Hairline, SkeletonRows, T } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { useArchive, useArchiveList, archiveCount } from "@/lib/archive";
import { shortTime } from "@/lib/format";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

interface Item {
  kind: ArchiveKind;
  id: string;
  name: string;
  archivedAt: string | null;
  lead: ReactNode;
}

const ICON: Record<Exclude<ArchiveKind, "agent">, IconName> = { workspace: "layers", project: "folder", routine: "clock" };

/** What was archived on its own, newest first; restoring brings back what it took along. */
export default function Archive() {
  const { t } = useTranslation("archive");
  const list = useArchiveList();
  const pull = usePullRefresh(list.refetch);
  const data = list.data;
  const sections: { key: string; title: string; items: Item[] }[] = data
    ? [
        { key: "workspaces", title: t("sections.workspaces"), items: data.workspaces.map((w) => ({ kind: "workspace" as const, id: w.id, name: w.name, archivedAt: w.archivedAt, lead: <Tile icon={ICON.workspace} /> })) },
        { key: "projects", title: t("sections.projects"), items: data.projects.map((p) => ({ kind: "project" as const, id: p.id, name: p.name, archivedAt: p.archivedAt, lead: <Tile icon={ICON.project} /> })) },
        { key: "agents", title: t("sections.agents"), items: data.agents.map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, archivedAt: a.archivedAt, lead: <CharacterAvatar agent={a} size={30} /> })) },
        { key: "routines", title: t("sections.routines"), items: data.routines.map((r) => ({ kind: "routine" as const, id: r.id, name: r.name, archivedAt: r.archivedAt, lead: <Tile icon={ICON.routine} /> })) },
      ].filter((s) => s.items.length)
    : [];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("title") }} />
      <CloseButton />
      {list.isLoading ? (
        <SkeletonRows count={4} avatar={30} />
      ) : list.error instanceof ApiError && list.error.code === "device_forbidden" ? (
        <EmptyState icon="archive" title={t("unavailable")} />
      ) : list.isError ? (
        <ErrorState title={t("loadError")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : !archiveCount(data) ? (
        <EmptyState icon="archive" title={t("empty")} />
      ) : (
        sections.map((s) => (
          <Group key={s.key} title={s.title}>
            {s.items.map((item, i) => (
              <View key={item.id}>
                {i > 0 && <Hairline inset={58} />}
                <ArchivedRow item={item} />
              </View>
            ))}
          </Group>
        ))
      )}
    </ScrollView>
  );
}

function ArchivedRow({ item }: { item: Item }) {
  const c = useColors();
  const { t } = useTranslation("archive");
  const { restore, pending } = useArchive();
  const busy = pending === item.id;
  return (
    <View style={styles.row}>
      {item.lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="body" numberOfLines={1}>
          {item.name}
        </T>
        {item.archivedAt ? (
          <T variant="footnote" muted numberOfLines={1}>
            {t("archivedAt", { date: shortTime(item.archivedAt) })}
          </T>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("restore")} ${item.name}`}
        disabled={busy}
        onPress={() => restore(item)}
        style={({ pressed }) => [styles.restore, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : (
          <T variant="subhead" style={{ fontWeight: "600" }}>
            {t("restore")}
          </T>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 60, gap: space.xl },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10, paddingHorizontal: space.md },
  restore: { minWidth: 86, height: 32, paddingHorizontal: 14, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
});
