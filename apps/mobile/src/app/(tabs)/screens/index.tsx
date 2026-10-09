import { Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { ScreenTile } from "@/components/screen-tile";
import { EmptyState, LoadingState, SectionTitle } from "@/components/ui";
import { isLive, useLiveScreens, type LiveScreen } from "@/lib/screens";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

export default function Screens() {
  const { screens, loading, refetch } = useLiveScreens();
  const pull = usePullRefresh(refetch);
  const { width } = useWindowDimensions();
  const columns = width > 700 ? 3 : 2;
  const tileWidth = (width - space.lg * 2 - space.md * (columns - 1)) / columns;

  const live = screens.filter(isLive);
  const idle = screens.filter((s) => !isLive(s));
  const groups: [string, LiveScreen[]][] = [
    ["Browsers", idle.filter((s) => s.kind === "browser")],
    ["Virtual machines", idle.filter((s) => s.kind === "vm")],
  ];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Title large>Screens</Stack.Title>

      {live.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle title="Live now" />
          <View style={styles.grid}>
            {live.map((s) => (
              <ScreenTile key={s.key} screen={s} style={tileSize(width > 700 ? (width - space.lg * 2 - space.md) / 2 : width - space.lg * 2)} />
            ))}
          </View>
        </View>
      ) : loading ? (
        <LoadingState label="Looking for screens…" />
      ) : (
        <EmptyState
          icon="screens"
          title="Nothing on screen right now"
          body="When an agent browses, works in a VM or on a screen you shared, you can watch it here live."
        />
      )}

      {groups.map(([title, items]) =>
        items.length ? (
          <View key={title} style={styles.section}>
            <SectionTitle title={title} />
            <View style={styles.grid}>
              {items.map((s) => (
                <ScreenTile key={s.key} screen={s} compact style={tileSize(tileWidth)} />
              ))}
            </View>
          </View>
        ) : null,
      )}
    </ScrollView>
  );
}

const tileSize = (w: number) => ({ width: w, height: Math.round((w * 10) / 16) });

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 140,
    gap: space.xl,
  },
  section: {
    marginTop: space.sm,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.md,
  },
});
