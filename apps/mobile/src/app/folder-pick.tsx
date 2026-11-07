import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Group, LinkRow, Tile } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { PickRow } from "@/components/pick-sheet";
import { SheetHeader } from "@/components/secret-parts";
import { Card, EmptyState, ErrorState, LoadingState, SkeletonRows, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { folderName, manageApi, mk, patchAgentSetup, shortPath } from "@/lib/manage";
import { fonts, space, useColors } from "@/lib/theme";

/** An agent's working folder on the computer (the desktop's folder picker): browse from home or its folder, then use one. */
export default function FolderPick() {
  const c = useColors();
  const { t } = useTranslation(["manage", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId, isPending } = useAgents();
  const { fullAccess } = useFullAccess();
  const agent = byId.get(id);
  const [path, setPath] = useState<string | undefined>(() => agent?.workingDirectory ?? undefined);
  const listing = useQuery({ queryKey: mk.folders(path ?? ""), queryFn: () => manageApi.folders(path), placeholderData: keepPreviousData, enabled: fullAccess === true });
  const recent = useQuery({ queryKey: mk.recentFolders, queryFn: manageApi.recentFolders, staleTime: 30_000, enabled: fullAccess === true });
  const here = listing.data && !listing.isPlaceholderData ? listing.data : undefined;

  const use = (folder: string | null) => {
    router.back();
    if (agent && folder !== agent.workingDirectory) void patchAgentSetup(agent.id, { workingDirectory: folder });
  };

  if (fullAccess === false || (!agent && !isPending)) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {fullAccess === false ? <NeedsFullAccess /> : <EmptyState icon="agents" title={t("agent.gone")} />}
      </View>
    );
  }

  const atHome = !!listing.data && listing.data.path === listing.data.home;
  const recents = (recent.data ?? []).filter((p) => p !== listing.data?.path).slice(0, 5);

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <SheetHeader title={t("folder.title")} action={t("folder.use")} ready={!!here && !here.blocked} onAction={() => here && use(here.path)} />

      {listing.data ? (
        <Card style={styles.current}>
          <Tile icon="folder" size={36} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="headline" numberOfLines={1}>
              {folderName(listing.data.path)}
            </T>
            <T variant="caption" muted numberOfLines={2} style={{ fontFamily: fonts.mono }}>
              {shortPath(listing.data.path, listing.data.home)}
            </T>
            {listing.data.blocked ? (
              <T variant="footnote" color={c.danger}>
                {listing.data.blocked}
              </T>
            ) : null}
          </View>
        </Card>
      ) : null}

      {atHome && recents.length ? (
        <Group title={t("folder.recent")}>
          {recents.map((p) => (
            <PickRow key={p} icon="history" title={folderName(p)} detail={shortPath(p, listing.data?.home)} selected={false} onPress={() => setPath(p)} />
          ))}
        </Group>
      ) : null}

      {listing.data ? (
        <Group title={t("folder.folders")} footer={listing.data.truncated ? t("folder.more") : undefined}>
          {listing.data.parent ? <PickRow icon="up" title={folderName(listing.data.parent)} detail={shortPath(listing.data.parent, listing.data.home)} selected={false} onPress={() => setPath(listing.data!.parent!)} /> : null}
          {listing.data.entries.map((e) => (
            <PickRow key={e.path} icon={e.git ? "branch" : "folder"} title={e.name} selected={false} disabled={e.blocked} onPress={() => setPath(e.path)} />
          ))}
          {!listing.data.entries.length ? <PickRow icon="folder" title={t("folder.empty")} selected={false} disabled onPress={() => undefined} /> : null}
        </Group>
      ) : listing.isError ? (
        <ErrorState title={t("folder.loadFailed")} error={errorText(listing.error)} onRetry={() => (path ? setPath(undefined) : void listing.refetch())} />
      ) : isPending ? (
        <LoadingState />
      ) : (
        <Group>
          <SkeletonRows count={6} avatar={30} />
        </Group>
      )}

      {agent?.workingDirectory ? (
        <Group>
          <LinkRow icon="close" title={t("folder.own")} tone="danger" chevron={false} onPress={() => use(null)} />
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  content: {
    padding: space.lg,
    paddingBottom: 48,
    gap: space.xl,
  },
  current: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
  },
});
