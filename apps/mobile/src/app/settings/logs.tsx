import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { router, Stack } from "expo-router";
import { memo, useCallback, useDeferredValue, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { LogEntry, LogLevel, LogOverview } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { FilterChips } from "@/components/filter-chips";
import { Group, LinkRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { QueryState } from "@/components/settings-state";
import { InfoRow, ago } from "@/components/status-rows";
import { EmptyState, ErrorState, Hairline, Row, SkeletonRows, T, tap, toneColors, type Tone } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { dateLocale, intlLocale } from "@/lib/i18n";
import { programsApi } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

type Level = "all" | LogLevel;

const LIMIT = 200;
const TONE = { debug: "neutral", info: "sky", warn: "warning", error: "danger" } as const satisfies Record<LogLevel, Tone>;

/**
 * Settings → Logs: Godmode's diagnostic log on the computer (secrets are masked before it is written). A full-access
 * phone also shares it, hands it to an agent to fix in code, and deletes it.
 */
export default function Logs() {
  const { t } = useTranslation("settings");
  const overview = useQuery({ queryKey: sq.logOverview, queryFn: settingsApi.logs.overview });
  const pull = usePullRefresh(overview.refetch);

  if (!overview.data) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
        <Stack.Screen options={{ title: t("logs.title") }} />
        <CloseButton />
        <QueryState query={overview} icon="doc" errorTitle={t("logs.loadFailed")}>
          {() => null}
        </QueryState>
      </ScrollView>
    );
  }
  return <Entries overview={overview.data} refetchOverview={overview.refetch} />;
}

function Entries({ overview, refetchOverview }: { overview: LogOverview; refetchOverview: () => Promise<unknown> }) {
  const { t } = useTranslation("settings");
  const admin = useFullAccess().fullAccess === true;
  const c = useColors();
  const [level, setLevel] = useState<Level>("all");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [open, setOpen] = useState<string | null>(null);
  const entries = useQuery({
    queryKey: sq.logEntries(level, query),
    queryFn: () => settingsApi.logs.entries({ level: level === "all" ? undefined : level, search: query || undefined, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  const pull = usePullRefresh(() => Promise.all([refetchOverview(), entries.refetch()]));
  const list = entries.data ?? [];
  const count = (n: number) => n.toLocaleString(intlLocale());

  const renderItem: ListRenderItem<LogEntry> = useCallback(
    ({ item, index }) => {
      const key = `${item.ts}|${item.scope}|${item.msg}`;
      return (
        <>
          {index > 0 && <Hairline inset={space.md + 14} />}
          <EntryRow entry={item} open={open === key} onPress={() => setOpen((o) => (o === key ? null : key))} />
        </>
      );
    },
    [open],
  );

  const header = (
    <View style={styles.header}>
      <Group footer={t("logs.masked")}>
        <InfoRow icon="doc" label={t("logs.entries")} value={count(overview.entries)} />
        <InfoRow icon="warning" label={t("logs.warnings")} value={count(overview.counts.warn)} tone={overview.counts.warn ? "warning" : undefined} />
        <InfoRow icon="octagon" label={t("logs.errors")} value={count(overview.counts.error)} tone={overview.counts.error ? "danger" : undefined} />
        {overview.lastTs ? <InfoRow icon="clock" label={t("logs.lastEntry")} value={ago(overview.lastTs)} /> : null}
      </Group>

      {admin ? <LogActions empty={overview.entries === 0} /> : null}

      {overview.issues.length ? (
        <Group title={t("logs.issues")}>
          {overview.issues.slice(0, 8).map((i) => (
            <InfoRow key={`${i.level}-${i.scope}-${i.msg}`} label={i.msg} detail={`${i.scope} · ${ago(i.lastTs)}`} value={`${i.count}×`} tone={i.level === "error" ? "danger" : "warning"} />
          ))}
        </Group>
      ) : null}

      <View style={{ gap: space.md }}>
        <FilterChips
          bleed={space.lg}
          value={level}
          onChange={(next) => {
            setOpen(null);
            setLevel(next);
          }}
          filters={[
            { id: "all", label: t("logs.level.all") },
            { id: "error", label: t("logs.level.error"), count: overview.counts.error },
            { id: "warn", label: t("logs.level.warn"), count: overview.counts.warn },
            { id: "info", label: t("logs.level.info") },
            { id: "debug", label: t("logs.level.debug") },
          ]}
        />
        <View style={[styles.search, { backgroundColor: c.sunken }]}>
          <Icon name="search" size={15} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t("logs.search")}
            value={search}
            onChangeText={setSearch}
            placeholder={t("logs.search")}
            placeholderTextColor={c.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={[styles.searchInput, { color: c.text }]}
          />
          {search ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("logs.clearSearch")} hitSlop={8} onPress={() => setSearch("")}>
              <Icon name="close" size={13} color={c.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: t("logs.title") }} />
      <CloseButton />
      <FlashList
        data={entries.isLoading ? [] : list}
        keyExtractor={(e, i) => `${e.ts}-${i}`}
        renderItem={renderItem}
        extraData={open}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          entries.isLoading ? (
            <SkeletonRows count={6} avatar={0} inset={space.md} />
          ) : entries.isError ? (
            <ErrorState title={t("logs.loadFailed")} error={errorText(entries.error)} onRetry={() => void entries.refetch()} />
          ) : (
            <EmptyState icon="doc" title={query || level !== "all" ? t("logs.noMatch") : t("logs.empty")} />
          )
        }
        ListFooterComponent={
          list.length >= LIMIT ? (
            <T variant="footnote" muted style={styles.more}>
              {t("logs.latest", { count: LIMIT })}
            </T>
          ) : null
        }
      />
    </>
  );
}

/** What the desktop does with the log: share it (for a chat with Claude), file a fix in Godmode's code, delete it. */
function LogActions({ empty }: { empty: boolean }) {
  const { t } = useTranslation(["programs", "common"]);
  const repair = useSettings().data?.selfRepair;
  const { data: agents } = useAgents();
  const [busy, setBusy] = useState<"share" | "fix" | "delete" | null>(null);
  const agent = agents?.find((a) => a.id === repair?.agentId) ?? agents?.find((a) => a.isDefault);
  const who = agent?.name ?? t("logs.anAgent");

  const run = async (what: "share" | "fix" | "delete", job: () => Promise<void>, failed: string) => {
    setBusy(what);
    try {
      await job();
    } catch (err) {
      Alert.alert(failed, errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const share = () =>
    run(
      "share",
      async () => {
        const text = await programsApi.logs.report();
        await Share.share({ message: text, title: "godmode-log.md" });
      },
      t("logs.shareFailed"),
    );

  const file = (note?: string) =>
    run(
      "fix",
      async () => {
        const { task, skipped } = await programsApi.logs.fix({ note: note?.trim() || undefined });
        if (!task) return Alert.alert(t("logs.nothingNew"), skipped ?? undefined);
        const merge = repair?.autoMerge ?? true;
        Alert.alert(t("logs.filed", { number: task.number }), merge ? t("logs.filedMerge", { branch: task.baseBranch || repair?.baseBranch || "main" }) : t("logs.filedReview"), [
          { text: t("common:actions.done"), style: "cancel" },
          { text: t("logs.openTask"), onPress: () => router.push(`/task/${task.id}`) },
        ]);
      },
      t("logs.fixFailed"),
    );

  const fix = () => {
    if (process.env.EXPO_OS === "ios") {
      Alert.prompt(t("logs.fix"), t("logs.fixBody", { who }), [
        { text: t("common:actions.cancel"), style: "cancel" },
        { text: t("logs.fixConfirm"), onPress: (note?: string) => void file(note) },
      ]);
      return;
    }
    Alert.alert(t("logs.fix"), t("logs.fixBodyPlain", { who }), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("logs.fixConfirm"), onPress: () => void file() },
    ]);
  };

  const remove = () =>
    Alert.alert(t("logs.deleteTitle"), t("logs.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("logs.delete"),
        style: "destructive",
        onPress: () =>
          void run(
            "delete",
            async () => {
              await programsApi.logs.clear();
              await queryClient.invalidateQueries({ queryKey: sq.logOverview });
            },
            t("logs.deleteFailed"),
          ),
      },
    ]);

  const pending = (what: typeof busy) => (busy === what ? t("common:status.loading") : undefined);
  return (
    <Group title={t("logs.title")}>
      <LinkRow icon="share" title={t("logs.share")} value={pending("share")} chevron={false} onPress={() => !busy && !empty && void share()} />
      <LinkRow icon="wrench" title={t("logs.fix")} value={pending("fix")} chevron={false} onPress={() => !busy && !empty && fix()} />
      <LinkRow icon="trash" tone="danger" title={t("logs.delete")} value={pending("delete")} chevron={false} onPress={() => !busy && !empty && remove()} />
    </Group>
  );
}

const EntryRow = memo(function EntryRow({ entry: e, open, onPress }: { entry: LogEntry; open: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const extra = e.err || (e.data && Object.keys(e.data).length) ? JSON.stringify({ ...(e.err ? { err: e.err } : {}), ...(e.data ?? {}) }, null, 2) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint={extra ? t("logs.showDetails") : undefined}
      disabled={!extra}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.dot, { backgroundColor: toneColors(c, TONE[e.level]).dot }]} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="caption" muted numberOfLines={1} style={{ flex: 1 }}>
            {e.scope}
          </T>
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {format(new Date(e.ts), isToday(new Date(e.ts)) ? "pp" : "PP p", { locale: dateLocale() })}
          </T>
        </Row>
        <T variant="subhead" numberOfLines={open ? undefined : 2}>
          {e.err?.message && e.err.message !== e.msg ? `${e.msg}: ${e.err.message}` : e.msg}
        </T>
        {open && extra ? (
          <View style={[styles.data, { backgroundColor: c.sunken }]}>
            <T variant="mono" style={styles.mono} selectable>
              {extra}
            </T>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: 80,
  },
  header: {
    gap: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm + 2,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 5,
  },
  data: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  mono: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  more: {
    textAlign: "center",
    paddingTop: space.lg,
  },
});
