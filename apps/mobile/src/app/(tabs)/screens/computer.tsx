import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { AppTile, DesktopTile, DisplayTile, useComputerSources } from "@/components/computer-parts";
import { Group } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { ListRow } from "@/components/readonly-list";
import { Button, EmptyState, ErrorState, Skeleton, SkeletonRows, SectionTitle, T } from "@/components/ui";
import { isRefused } from "@/components/admin";
import { errorText } from "@/lib/api";
import { domainOf, sortedDisplays, sourceHref, tabTarget, windowTarget } from "@/lib/machines";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** This computer's displays, windows and Godmode browser tabs: picked here, watched and controlled live (full access). */
export default function ComputerSources() {
  const { t } = useTranslation("machines");
  const { fullAccess } = useFullAccess();
  const { width } = useWindowDimensions();
  const status = useQuery({ queryKey: sq.computerStatus, queryFn: settingsApi.computer.status, enabled: fullAccess === true });
  const off = status.data?.enabled === false;
  const sources = useComputerSources(fullAccess === true && !off);
  const pull = usePullRefresh(() => Promise.all([status.refetch(), sources.refetch()]));
  const data = sources.data;
  const columns = width > 700 ? 2 : 1;
  const tileWidth = (width - space.lg * 2 - space.md * (columns - 1)) / columns;
  const windows = (data?.windows ?? []).filter((w) => w.onScreen);

  const body = () => {
    if (fullAccess === undefined) return <Loading tileWidth={tileWidth} />;
    if (!fullAccess || isRefused(sources.error) || isRefused(status.error)) return <NeedsFullAccess style={styles.state} />;
    if (off) {
      return (
        <EmptyState
          style={styles.state}
          icon="display"
          title={t("computer.offTitle")}
          action={<Button title={t("computer.openSettings")} icon="settings" variant="outline" onPress={() => router.push("/settings/computer")} />}
        />
      );
    }
    if (sources.isLoading || status.isLoading) return <Loading tileWidth={tileWidth} />;
    if (!data) return <ErrorState title={t("computer.loadFailed")} error={errorText(sources.error ?? status.error)} onRetry={() => void sources.refetch()} />;
    if (!data.displays.length && !windows.length && !data.tabs.length) {
      return <EmptyState style={styles.state} icon="display" title={t("computer.nothingTitle")} body={data.problems[0] ?? t("computer.nothingBody")} />;
    }
    return (
      <>
        {data.displays.length ? (
          <View>
            <SectionTitle title={t("computer.displays")} />
            <View style={styles.grid}>
              {data.displays.length > 1 ? <DesktopTile count={data.displays.length} style={{ width: tileWidth, height: Math.round((tileWidth * 10) / 16) }} /> : null}
              {sortedDisplays(data.displays).map((d) => (
                <DisplayTile key={d.id} display={d} style={{ width: tileWidth, height: Math.round((tileWidth * 10) / 16) }} />
              ))}
            </View>
          </View>
        ) : null}
        <Group title={t("computer.windows")}>
          {windows.length ? (
            windows.map((w) => (
              <ListRow
                key={`${w.pid}:${w.id}`}
                grouped
                lead={<AppTile app={w.app} />}
                title={w.app}
                lines={[w.title]}
                onPress={() => router.push(sourceHref(windowTarget(w)))}
              />
            ))
          ) : (
            <View style={styles.none}>
              <T variant="subhead" muted>
                {t("computer.noWindows")}
              </T>
            </View>
          )}
        </Group>
        {data.tabs.length ? (
          <Group title={t("computer.tabs")}>
            {data.tabs.map((tab) => (
              <ListRow
                key={`${tab.profileId}:${tab.targetId}`}
                grouped
                icon="globe"
                title={tab.title || domainOf(tab.url) || t("computer.newTab")}
                lines={[tab.url ? domainOf(tab.url) : null, tab.profileName]}
                onPress={() => router.push(sourceHref(tabTarget(tab)))}
              />
            ))}
          </Group>
        ) : null}
        {data.problems.length ? (
          <T variant="footnote" muted style={styles.problems}>
            {data.problems.join("\n")}
          </T>
        ) : null}
      </>
    );
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("computer.title") }} />
      {body()}
    </ScrollView>
  );
}

function Loading({ tileWidth }: { tileWidth: number }) {
  return (
    <>
      <Skeleton width={tileWidth} height={Math.round((tileWidth * 10) / 16)} radius={16} />
      <SkeletonRows count={5} avatar={36} inset={0} />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 140,
    gap: space.xl,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.md,
  },
  none: {
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  problems: {
    paddingHorizontal: space.xs,
  },
  state: {
    paddingTop: 80,
  },
});
