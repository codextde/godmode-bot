import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { GitCommit } from "@godmode/shared";
import { failureText } from "@/components/agent-actions";
import { Icon } from "@/components/icon";
import { EmptyState, ErrorState, SkeletonRows, T } from "@/components/ui";
import { api } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, space, useColors } from "@/lib/theme";

type Item = { kind: "day"; key: string; title: string } | { kind: "commit"; key: string; commit: GitCommit; date: Date; last: boolean };

/** isomorphic-git reports seconds; ISO strings and milliseconds are taken too. */
function commitDate(ts: string): Date {
  if (/^\d+$/.test(ts)) {
    const n = Number(ts);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  return new Date(ts);
}

/** Every change to the agent's files, read-only like the desktop's History tab: what changed and when, by day. */
export default function AgentHistory() {
  const { t } = useTranslation(["agents", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgents().byId.get(id);
  const list = useQuery({ queryKey: qk.agentCommits(id), queryFn: () => api.agents.commits(id) });
  const pull = usePullRefresh(list.refetch);

  const items = useMemo(() => {
    const out: Item[] = [];
    let day = "";
    for (const commit of list.data ?? []) {
      const date = commitDate(commit.timestamp);
      const valid = !Number.isNaN(date.getTime());
      const title = !valid
        ? t("history.unknownDate")
        : isToday(date)
          ? t("common:words.today")
          : isYesterday(date)
            ? t("common:words.yesterday")
            : format(date, t("history.dayFormat"), { locale: dateLocale() });
      if (title !== day) {
        const prev = out[out.length - 1];
        if (prev?.kind === "commit") prev.last = true;
        out.push({ kind: "day", key: `d-${title}`, title });
        day = title;
      }
      out.push({ kind: "commit", key: commit.oid, commit, date, last: false });
    }
    const prev = out[out.length - 1];
    if (prev?.kind === "commit") prev.last = true;
    return out;
  }, [list.data, t]);

  const renderItem: ListRenderItem<Item> = useCallback(({ item }) => (item.kind === "day" ? <Day title={item.title} /> : <CommitRow commit={item.commit} date={item.date} last={item.last} />), []);

  return (
    <>
      <Stack.Title>{t("history.title")}</Stack.Title>
      <FlashList
        data={list.isLoading ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={8} avatar={0} />
            </View>
          ) : list.isError ? (
            <ErrorState title={t("history.loadFailed")} error={failureText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState icon="history" title={t("history.emptyTitle")} body={t("history.emptyBody", { name: agent?.name ?? t("common:words.agent") })} />
          )
        }
      />
    </>
  );
}

function Day({ title }: { title: string }) {
  return (
    <T variant="eyebrow" muted style={styles.day}>
      {title}
    </T>
  );
}

function CommitRow({ commit, date, last }: { commit: GitCommit; date: Date; last: boolean }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const [title, ...rest] = commit.message.trim().split("\n");
  const body = rest.join("\n").trim();
  const valid = !Number.isNaN(date.getTime());
  return (
    <View style={styles.row} accessible accessibilityLabel={`${title || t("history.noMessage")}, ${valid ? formatDistanceToNowStrict(date, { addSuffix: true, locale: dateLocale() }) : commit.timestamp}`}>
      <View style={styles.rail}>
        <View style={[styles.node, { backgroundColor: c.surface, borderColor: c.borderStrong }]}>
          <Icon name="dot" size={8} color={c.textMuted} />
        </View>
        {!last ? <View style={[styles.line, { backgroundColor: c.border }]} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3, paddingBottom: space.lg }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "baseline" }}>
          <T variant="subhead" style={{ flex: 1, fontWeight: "600" }} numberOfLines={2}>
            {title || t("history.noMessage")}
          </T>
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {valid ? formatDistanceToNowStrict(date, { addSuffix: true, locale: dateLocale() }) : commit.timestamp}
          </T>
        </View>
        {body ? (
          <T variant="footnote" muted numberOfLines={4}>
            {body}
          </T>
        ) : null}
        <T variant="caption" muted numberOfLines={1}>
          {`${commit.author} · `}
          <T variant="caption" muted style={{ fontFamily: fonts.mono }}>
            {commit.oid.slice(0, 7)}
          </T>
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  day: {
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    gap: space.md,
  },
  rail: {
    width: 18,
    alignItems: "center",
  },
  node: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  line: {
    flex: 1,
    width: StyleSheet.hairlineWidth * 2,
    marginTop: 2,
  },
});
