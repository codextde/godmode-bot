import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { FolderListing } from "@godmode/shared";
import { Group, LinkRow, Tile } from "./form";
import { Icon } from "./icon";
import { PickRow } from "./pick-sheet";
import { SheetHeader } from "./secret-parts";
import { Card, ErrorState, Hairline, SkeletonRows, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { folderName, manageApi, mk, shortPath } from "@/lib/manage";
import { sshAdmin } from "@/lib/ssh-admin";
import { fonts, radius, space, type, useColors } from "@/lib/theme";

/** Where the folders are: this computer (with its recent ones) or an SSH server, read over SSH. */
export interface FolderSource {
  key: string;
  list: (path: string | undefined, hidden: boolean) => Promise<FolderListing>;
  recent?: boolean;
}

export const computerFolders: FolderSource = { key: "computer", list: manageApi.folders, recent: true };

export const serverFolders = (serverId: string): FolderSource => ({ key: `ssh:${serverId}`, list: (path, hidden) => sshAdmin.folders(serverId, path, hidden) });

/** The desktop's folder picker on a phone: go through the folders and take the one that is open. */
export function FolderBrowser({
  title,
  action,
  source = computerFolders,
  start,
  enabled = true,
  clear,
  onUse,
}: {
  title: string;
  /** The button that takes the open folder. */
  action: string;
  source?: FolderSource;
  start?: string;
  enabled?: boolean;
  /** A way to take the choice back, e.g. "Use its own folder". */
  clear?: { title: string; onPress: () => void };
  onUse: (path: string) => void;
}) {
  const c = useColors();
  const { t } = useTranslation("manage");
  const [path, setPath] = useState<string | undefined>(start);
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const query = useDeferredValue(filter.trim().toLowerCase());
  const listing = useQuery({ queryKey: [...mk.folders(path ?? ""), source.key, hidden], queryFn: () => source.list(path, hidden), placeholderData: keepPreviousData, enabled });
  const recent = useQuery({ queryKey: mk.recentFolders, queryFn: manageApi.recentFolders, staleTime: 30_000, enabled: enabled && !!source.recent });
  const data = listing.data;
  const here = data && !listing.isPlaceholderData ? data : undefined;
  const atHome = !!data && data.path === data.home;
  const recents = (recent.data ?? []).filter((p) => p !== data?.path).slice(0, 5);
  const entries = (data?.entries ?? []).filter((e) => !query || e.name.toLowerCase().includes(query));
  const open = (next: string) => {
    setFilter("");
    setPath(next);
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={title} action={action} ready={!!here && !here.blocked} onAction={() => here && onUse(here.path)} />

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? t("folder.hideHidden") : t("folder.showHidden")}
            accessibilityState={{ selected: hidden }}
            hitSlop={10}
            onPress={() => {
              tap();
              setHidden((v) => !v);
            }}
          >
            <Icon name={hidden ? "eye" : "eyeOff"} size={17} color={c.textMuted} />
          </Pressable>
        </Card>
      ) : null}

      {atHome && recents.length ? (
        <Group title={t("folder.recent")}>
          {recents.map((p) => (
            <PickRow key={p} icon="history" title={folderName(p)} detail={shortPath(p, data?.home)} selected={false} onPress={() => open(p)} />
          ))}
        </Group>
      ) : null}

      {data ? (
        <Group title={t("folder.folders")} footer={data.truncated ? t("folder.more") : undefined}>
          {data.entries.length > 8 ? (
            <>
              <View style={styles.filter}>
                <Icon name="search" size={14} color={c.textMuted} />
                <TextInput
                  accessibilityLabel={t("folder.filter")}
                  value={filter}
                  onChangeText={setFilter}
                  placeholder={t("folder.filter")}
                  placeholderTextColor={c.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[type.body, { flex: 1, padding: 0, color: c.text }]}
                />
              </View>
              <Hairline />
            </>
          ) : null}
          {data.parent ? <PickRow icon="up" title={folderName(data.parent)} detail={shortPath(data.parent, data.home)} selected={false} onPress={() => open(data.parent!)} /> : null}
          {entries.map((e) => (
            <PickRow key={e.path} icon={e.git ? "branch" : "folder"} title={e.name} selected={false} disabled={e.blocked} onPress={() => open(e.path)} />
          ))}
          {!entries.length ? <PickRow icon="folder" title={query ? t("folder.noMatch") : t("folder.empty")} selected={false} disabled onPress={() => undefined} /> : null}
        </Group>
      ) : listing.isError ? (
        <ErrorState title={t("folder.loadFailed")} error={errorText(listing.error)} onRetry={() => (path ? setPath(undefined) : void listing.refetch())} />
      ) : (
        <Group>
          <SkeletonRows count={6} avatar={30} />
        </Group>
      )}

      {clear ? (
        <Group>
          <LinkRow icon="close" title={clear.title} tone="danger" chevron={false} onPress={clear.onPress} />
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 48, gap: space.xl },
  current: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg },
  filter: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.lg },
});
