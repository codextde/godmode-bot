import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type AgentFileEntry } from "@godmode/shared";
import { NOTES_DIR, failureText, nameOf } from "@/components/agent-actions";
import { HeaderActions } from "@/components/header-actions";
import { useRevealLocked } from "@/components/this-phone-access";
import { Icon } from "@/components/icon";
import { Button, EmptyState, ErrorState, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

/** The agent's notes beyond MEMORY.md (memory/ in its folder): folders first, then files, by name. */
export default function Notes() {
  const { t } = useTranslation(["agents", "common"]);
  const params = useLocalSearchParams<{ id: string; dir?: string }>();
  const id = params.id;
  const dir = params.dir && (params.dir === NOTES_DIR || params.dir.startsWith(`${NOTES_DIR}/`)) ? params.dir : NOTES_DIR;
  const agent = useAgents().byId.get(id);
  const list = useQuery({
    queryKey: qk.agentNotes(id, dir),
    queryFn: () => api.agents.notes(id, dir),
    retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
  const pull = usePullRefresh(list.refetch);
  // A folder that isn't there yet is the same as an empty one: the first note makes it.
  const missing = list.error instanceof ApiError && list.error.status === 404;
  const entries = useMemo(
    () =>
      (list.data ?? [])
        .filter((e) => !nameOf(e.path).startsWith("."))
        .sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.path.localeCompare(b.path))),
    [list.data],
  );
  const newNote = () => router.push({ pathname: "/note", params: { agentId: id, dir } });
  const locked = useRevealLocked(agent);

  const renderItem: ListRenderItem<AgentFileEntry> = useCallback(
    ({ item, index }) => (
      <>
        {index > 0 && <Hairline inset={space.lg + 32 + space.md} />}
        <EntryRow agentId={id} entry={item} />
      </>
    ),
    [id],
  );

  return (
    <>
      <Stack.Title>{dir === NOTES_DIR ? t("notes.title") : nameOf(dir)}</Stack.Title>
      {locked ? null : <HeaderActions actions={[{ icon: "plus", label: t("notes.new"), onPress: newNote }]} />}
      <FlashList
        data={list.isLoading ? [] : entries}
        keyExtractor={(e) => e.path}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={32} />
            </View>
          ) : list.isError && !missing ? (
            <ErrorState title={t("notes.loadFailed")} error={failureText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState
              icon="note"
              title={t("notes.emptyTitle")}
              body={t("notes.emptyBody", { name: agent?.name ?? t("common:words.agent") })}
              action={locked ? undefined : <Button title={t("notes.new")} icon="plus" variant="secondary" onPress={newNote} />}
            />
          )
        }
      />
    </>
  );
}

const EntryRow = memo(function EntryRow({ agentId, entry }: { agentId: string; entry: AgentFileEntry }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const folder = entry.type === "dir";
  const when = entry.modifiedAt ? formatDistanceToNowStrict(new Date(entry.modifiedAt), { addSuffix: true, locale: dateLocale() }) : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        if (folder) router.push({ pathname: "/notes/[id]", params: { id: agentId, dir: entry.path } });
        else router.push({ pathname: "/note", params: { agentId, path: entry.path } });
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name={folder ? "folder" : "note"} size={15} color={folder ? c.brandStrong : c.textMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {nameOf(entry.path)}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {folder ? t("notes.folder") : [formatBytes(entry.size), when].filter(Boolean).join(" · ")}
        </T>
      </View>
      <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  tile: {
    width: 32,
    height: 32,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
