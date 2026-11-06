import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, ArtifactSummary } from "@godmode/shared";
import { openArtifact } from "@/components/artifact-card";
import { CharacterAvatar } from "@/components/character";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Button, EmptyState, ErrorState, Hairline, Row, SkeletonRows, T } from "@/components/ui";
import { ApiError, api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { patchSettings, useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

/** Dashboards and small apps agents built: pinned first, then the latest. */
export default function Artifacts() {
  const { t } = useTranslation("artifacts");
  const { id: workspaceId } = useWorkspace();
  const settings = useSettings();
  const off = settings.data?.artifacts?.enabled === false;
  const list = useQuery({ queryKey: qk.artifactList(workspaceId), queryFn: () => api.artifacts.list(workspaceId ? { workspaceId } : {}), enabled: !off });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const [search, setSearch] = useState("");

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [...(list.data ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    return q ? all.filter((a) => `${a.title} ${a.description} ${a.agentName ?? ""}`.toLowerCase().includes(q)) : all;
  }, [list.data, search]);

  const renderItem: ListRenderItem<ArtifactSummary> = useCallback(
    ({ item, index }) => (
      <>
        {index > 0 && <Hairline inset={72} />}
        <ArtifactRow artifact={item} agent={item.agentId ? byId.get(item.agentId) : undefined} />
      </>
    ),
    [byId],
  );

  return (
    <>
      <Stack.Title>{t("list.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("list.search")} hideWhenScrolling onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      {!off && <HeaderActions actions={[{ icon: "plus", label: t("new.title"), onPress: () => router.push("/artifact-new") }]} />}
      <FlashList
        data={list.isLoading || off ? [] : items}
        keyExtractor={(a) => a.id}
        renderItem={renderItem}
        extraData={byId}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          off ? (
            <EmptyState
              icon="artifact"
              title={t("list.offTitle")}
              action={<Button title={t("list.switchOn")} variant="secondary" onPress={() => void patchSettings({ artifacts: { enabled: true } } as never)} />}
            />
          ) : list.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={5} avatar={44} />
            </View>
          ) : list.error instanceof ApiError && list.error.code === "device_forbidden" ? (
            <EmptyState icon="artifact" title={t("list.unavailableTitle")} body={t("list.unavailableBody")} />
          ) : list.isError ? (
            <ErrorState title={t("list.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : search.trim() ? (
            <EmptyState icon="search" title={t("list.noMatch", { query: search.trim() })} />
          ) : (
            <EmptyState
              icon="artifact"
              title={t("list.emptyTitle")}
              body={t("list.emptyBody")}
              action={<Button title={t("new.title")} icon="plus" onPress={() => router.push("/artifact-new")} />}
            />
          )
        }
      />
    </>
  );
}

const ArtifactRow = memo(function ArtifactRow({ artifact: a, agent }: { artifact: ArtifactSummary; agent?: Agent }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a.title}
      onPress={() => openArtifact(a.id)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.tile, { backgroundColor: c.brandSoft }]}>
        <Icon name="artifact" size={19} color={c.brandStrong} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
            {a.title}
          </T>
          {a.pinned ? <Icon name="pin" size={12} color={c.textFaint} /> : null}
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {shortTime(a.updatedAt)}
          </T>
        </Row>
        {a.description ? (
          <T variant="footnote" muted numberOfLines={2}>
            {a.description}
          </T>
        ) : null}
        {a.agentName ? (
          <Row style={{ gap: 5, marginTop: 2 }}>
            {agent ? <CharacterAvatar agent={agent} size={16} /> : null}
            <T variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {agent?.name ?? a.agentName}
            </T>
          </Row>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  tile: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
