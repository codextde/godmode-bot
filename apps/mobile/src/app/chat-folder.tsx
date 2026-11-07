import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Group, LinkRow, Tile } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { PickRow } from "@/components/pick-sheet";
import { SheetHeader } from "@/components/secret-parts";
import { Card, ErrorState, SkeletonRows, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useNewChatOptions } from "@/lib/chat-options";
import { folderName, manageApi, mk, shortPath } from "@/lib/manage";
import { fonts, space, useColors } from "@/lib/theme";

/** The folder on the computer a new chat works in (instead of its agent's), browsed like the agent's working folder. */
export default function ChatFolder() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { fullAccess } = useFullAccess();
  const { path: start } = useLocalSearchParams<{ path?: string }>();
  const picked = useNewChatOptions((s) => s.options.workingDirectory);
  const [path, setPath] = useState<string | undefined>(start || undefined);
  const listing = useQuery({ queryKey: mk.folders(path ?? ""), queryFn: () => manageApi.folders(path), placeholderData: keepPreviousData, enabled: fullAccess === true });
  const recent = useQuery({ queryKey: mk.recentFolders, queryFn: manageApi.recentFolders, staleTime: 30_000, enabled: fullAccess === true });
  const here = listing.data && !listing.isPlaceholderData ? listing.data : undefined;

  const use = (folder: string | null) => {
    useNewChatOptions.getState().set({ workingDirectory: folder });
    router.back();
  };

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  const data = listing.data;
  const atHome = !!data && data.path === data.home;
  const recents = (recent.data ?? []).filter((p) => p !== data?.path).slice(0, 5);

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <SheetHeader title={t("place.folder")} action={t("place.useFolder")} ready={!!here && !here.blocked} onAction={() => here && use(here.path)} />

      {data ? (
        <Card style={styles.current}>
          <Tile icon="folder" size={36} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="headline" numberOfLines={1}>
              {folderName(data.path)}
            </T>
            <T variant="caption" muted numberOfLines={2} style={{ fontFamily: fonts.mono }}>
              {shortPath(data.path, data.home)}
            </T>
            {data.blocked ? (
              <T variant="footnote" color={c.danger}>
                {data.blocked}
              </T>
            ) : null}
          </View>
        </Card>
      ) : null}

      {atHome && recents.length ? (
        <Group title={t("place.recent")}>
          {recents.map((p) => (
            <PickRow key={p} icon="history" title={folderName(p)} detail={shortPath(p, data?.home)} selected={false} onPress={() => setPath(p)} />
          ))}
        </Group>
      ) : null}

      {data ? (
        <Group title={t("place.folders")} footer={data.truncated ? t("place.more") : undefined}>
          {data.parent ? <PickRow icon="up" title={folderName(data.parent)} detail={shortPath(data.parent, data.home)} selected={false} onPress={() => setPath(data.parent ?? undefined)} /> : null}
          {data.entries.map((e) => (
            <PickRow key={e.path} icon={e.git ? "branch" : "folder"} title={e.name} selected={false} disabled={e.blocked} onPress={() => setPath(e.path)} />
          ))}
          {!data.entries.length ? <PickRow icon="folder" title={t("place.noFolders")} selected={false} disabled onPress={() => undefined} /> : null}
        </Group>
      ) : listing.isError ? (
        <ErrorState title={t("place.foldersFailed")} error={errorText(listing.error)} onRetry={() => (path ? setPath(undefined) : void listing.refetch())} />
      ) : (
        <Group>
          <SkeletonRows count={6} avatar={30} />
        </Group>
      )}

      {picked ? (
        <Group>
          <LinkRow icon="close" title={t("place.agentFolder")} tone="danger" chevron={false} onPress={() => use(null)} />
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", padding: space.lg },
  content: { padding: space.lg, paddingBottom: 48, gap: space.xl },
  current: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
});
