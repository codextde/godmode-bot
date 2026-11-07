import { router, Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { DisplayTile, useComputerSources } from "@/components/computer-parts";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { ScreenTile } from "@/components/screen-tile";
import { EmptyState, LoadingState, SectionTitle } from "@/components/ui";
import { sortedDisplays } from "@/lib/machines";
import { isLive, useLiveScreens, type LiveScreen } from "@/lib/screens";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

type Href = "/screens/computer" | "/settings/vms" | "/settings/android" | "/settings/browser";

export default function Screens() {
  const { t } = useTranslation(["tabs", "machines"]);
  const { screens, loading, refetch } = useLiveScreens();
  const admin = useFullAccess().fullAccess === true;
  const sources = useComputerSources(admin);
  const displays = sortedDisplays(sources.data?.displays ?? []);
  const pull = usePullRefresh(() => Promise.all([refetch(), admin ? sources.refetch() : null]));
  const { width } = useWindowDimensions();
  const columns = width > 700 ? 3 : 2;
  const tileWidth = (width - space.lg * 2 - space.md * (columns - 1)) / columns;

  const live = screens.filter(isLive);
  const idle = screens.filter((s) => !isLive(s));
  const groups: [string, LiveScreen[], Href | null][] = [
    [t("screens.browsers"), idle.filter((s) => s.kind === "browser"), "/settings/browser"],
    [t("screens.vms"), idle.filter((s) => s.kind === "vm"), admin ? "/settings/vms" : null],
    [t("screens.android"), idle.filter((s) => s.kind === "android"), admin ? "/settings/android" : null],
  ];
  const open = (href: Href) => router.push(href);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Title large>{t("screens.title")}</Stack.Title>
      <HeaderActions
        menu={[
          { icon: "display", title: t("machines:computer.title"), onPress: () => open("/screens/computer") },
          { icon: "vm", title: t("machines:vms.title"), onPress: () => open("/settings/vms") },
          { icon: "phone", title: t("machines:android.title"), onPress: () => open("/settings/android") },
          { icon: "globe", title: t("machines:browser.profiles"), onPress: () => open("/settings/browser") },
        ]}
      />

      {live.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle title={t("screens.liveNow")} />
          <View style={styles.grid}>
            {live.map((s) => (
              <ScreenTile key={s.key} screen={s} style={tileSize(width > 700 ? (width - space.lg * 2 - space.md) / 2 : width - space.lg * 2)} />
            ))}
          </View>
        </View>
      ) : loading ? (
        <LoadingState label={t("screens.loading")} />
      ) : displays.length ? null : (
        <EmptyState
          icon="screens"
          title={t("screens.empty.title")}
          body={t("screens.empty.body")}
        />
      )}

      {displays.length ? (
        <View style={styles.section}>
          <SectionTitle title={t("machines:computer.title")} action={t("machines:computer.allWindows")} onAction={() => open("/screens/computer")} />
          <View style={styles.grid}>
            {displays.map((d) => (
              <DisplayTile key={d.id} display={d} style={tileSize(displays.length > 1 ? tileWidth : width > 700 ? (width - space.lg * 2 - space.md) / 2 : width - space.lg * 2)} />
            ))}
          </View>
        </View>
      ) : null}

      {groups.map(([title, items, manage]) =>
        items.length ? (
          <View key={title} style={styles.section}>
            <SectionTitle title={title} action={manage ? t("machines:manage") : undefined} onAction={manage ? () => open(manage) : undefined} />
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
