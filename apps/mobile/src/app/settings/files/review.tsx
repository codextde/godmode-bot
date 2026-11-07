import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { formatDistanceToNowStrict } from "date-fns";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type FileReviewItem, type FileReviewKind } from "@godmode/shared";
import { openDeleteMany, openMove, useDreamingNow } from "@/components/file-actions";
import { NeedsFullAccessScreen, needsFullAccess, useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { Icon, type IconName } from "@/components/icon";
import { Button, Card, EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { countOf, filesApi, fk, nameOf } from "@/lib/agent-files";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, space, useColors } from "@/lib/theme";

type KindKey = "build" | "junk" | "empty" | "duplicate" | "large" | "scratch" | "stale" | "loose" | "unlinkedNote" | "brokenLink";

/** Like the desktop: safe kinds start ticked (unless the agent still names the item or it is a backup copy). */
const KINDS: Record<FileReviewKind, { key: KindKey; icon: IconName; safe: boolean }> = {
  build: { key: "build", icon: "package", safe: true },
  junk: { key: "junk", icon: "broom", safe: true },
  empty: { key: "empty", icon: "folder", safe: true },
  duplicate: { key: "duplicate", icon: "copy", safe: true },
  large: { key: "large", icon: "archiveFile", safe: false },
  scratch: { key: "scratch", icon: "clock", safe: false },
  stale: { key: "stale", icon: "clock", safe: false },
  loose: { key: "loose", icon: "move", safe: false },
  "unlinked-note": { key: "unlinkedNote", icon: "note", safe: false },
  "broken-link": { key: "brokenLink", icon: "warning", safe: false },
};
const ORDER = Object.keys(KINDS) as FileReviewKind[];
const deletable = (i: FileReviewItem) => i.kind !== "broken-link";

/** What could go from an agent's folder: build output, junk, copies, large and old files, notes nothing links to. */
export default function Review() {
  const { t } = useTranslation("files");
  const { fullAccess } = useFullAccess();
  if (fullAccess === false) {
    return (
      <>
        <Stack.Screen options={{ title: t("review.title"), headerLargeTitleEnabled: false }} />
        <NeedsFullAccessScreen />
      </>
    );
  }
  return <ReviewList />;
}

function ReviewList() {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const { agent } = useLocalSearchParams<{ agent: string }>();
  const agentName = useAgents().byId.get(agent)?.name ?? t("folder.theAgent");
  const frozen = useDreamingNow(agent);
  const review = useQuery({ queryKey: fk.review(agent), queryFn: () => filesApi.review(agent), staleTime: 60_000 });
  const recheck = useMutation({
    mutationFn: () => filesApi.review(agent, true),
    onSuccess: (data) => queryClient.setQueryData(fk.review(agent), data),
  });
  const pull = usePullRefresh(() => recheck.mutateAsync());
  /** What the human ticked or unticked; everything else follows the defaults. */
  const [picked, setPicked] = useState<Map<string, boolean>>(() => new Map());
  const items = useMemo(() => review.data?.items ?? [], [review.data]);
  const defaults = useMemo(() => new Set(items.filter((i) => KINDS[i.kind].safe && !i.namedBy && !/\.bak$/i.test(i.path)).map((i) => i.path)), [items]);
  const chosen = useMemo(() => new Set(items.map((i) => i.path).filter((p) => picked.get(p) ?? defaults.has(p))), [items, picked, defaults]);
  const groups = useMemo(() => ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length), [items]);
  const chosenItems = items.filter((i) => chosen.has(i.path) && deletable(i));
  const chosenBytes = chosenItems.reduce((n, i) => n + i.bytes, 0);
  const totalBytes = items.filter(deletable).reduce((n, i) => n + i.bytes, 0);
  const toggle = (path: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.set(path, on);
      return next;
    });

  const open = (item: FileReviewItem) => {
    const target = item.kind === "broken-link" && item.related ? item.related : item.path;
    if (item.type === "dir" && target === item.path) router.push({ pathname: "/settings/files/[agent]", params: { agent, path: target } });
    else router.push({ pathname: "/settings/files/preview", params: { agent, path: target } });
  };

  const header = <HeaderActions actions={[{ icon: "refresh", label: t("review.checkAgain"), onPress: () => !recheck.isPending && recheck.mutate() }]} />;
  if (needsFullAccess(review.error)) {
    return (
      <>
        <Stack.Screen options={{ title: t("review.title"), headerLargeTitleEnabled: false }} />
        <NeedsFullAccessScreen />
      </>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("review.title"), headerLargeTitleEnabled: false }} />
      {header}
      {review.isLoading ? (
        <View style={{ gap: space.md }}>
          <T variant="footnote" muted>
            {t("review.looking")}
          </T>
          <SkeletonRows count={5} avatar={28} />
        </View>
      ) : review.isError ? (
        <ErrorState title={t("review.loadFailed")} error={errorText(review.error)} onRetry={() => void review.refetch()} />
      ) : !groups.length ? (
        <EmptyState icon="checkCircle" title={t("review.tidyTitle", { name: agentName })} body={t("review.tidyDescription")} />
      ) : (
        <>
          <Card style={styles.summary}>
            <View style={{ gap: 2 }}>
              <T variant="headline">{t("review.toLookAt", { things: countOf(items.length, "thing") })}</T>
              <T variant="footnote" muted>
                {[
                  totalBytes ? t("review.couldGo", { size: formatBytes(totalBytes) }) : null,
                  review.data ? t("review.checked", { time: formatDistanceToNowStrict(new Date(review.data.checkedAt), { addSuffix: true, locale: dateLocale() }) }) : null,
                  review.data?.partial ? t("review.partial") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </T>
            </View>
            <Button
              title={chosenItems.length ? t("review.deleteSelected", { items: countOf(chosenItems.length, "item"), size: formatBytes(chosenBytes) }) : t("review.tickHint")}
              icon={chosenItems.length ? "trash" : undefined}
              variant="danger"
              disabled={!chosenItems.length || frozen}
              onPress={() =>
                openDeleteMany(
                  agent,
                  chosenItems.map((i) => i.path),
                )
              }
            />
          </Card>
          {groups.map((g) => {
            const meta = KINDS[g.kind];
            const bytes = g.items.reduce((n, i) => n + i.bytes, 0);
            return (
              <View key={g.kind}>
                <SectionTitle title={`${t(`review.kinds.${meta.key}.title`)} · ${g.items.length}${bytes ? ` · ${formatBytes(bytes)}` : ""}`} />
                <Card style={{ overflow: "hidden" }}>
                  {g.items.map((item, i) => (
                    <View key={`${item.kind}:${item.path}`}>
                      {i > 0 ? <Hairline inset={52} /> : null}
                      <ReviewRow
                        item={item}
                        icon={meta.icon}
                        checked={chosen.has(item.path)}
                        onCheck={deletable(item) ? (on) => toggle(item.path, on) : undefined}
                        onOpen={() => open(item)}
                        onMove={item.kind === "loose" && !frozen ? () => openMove(agent, item.path) : undefined}
                      />
                    </View>
                  ))}
                </Card>
                <T variant="footnote" color={c.textMuted} style={styles.hint}>
                  {t(`review.kinds.${meta.key}.hint`)}
                </T>
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

function ReviewRow({
  item,
  icon,
  checked,
  onCheck,
  onOpen,
  onMove,
}: {
  item: FileReviewItem;
  icon: IconName;
  checked: boolean;
  onCheck?: (on: boolean) => void;
  onOpen: () => void;
  onMove?: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("files");
  return (
    <View style={styles.row}>
      {onCheck ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={t("review.selectItem", { path: item.path })}
          hitSlop={8}
          onPress={() => {
            tap();
            onCheck(!checked);
          }}
          style={styles.check}
        >
          <Icon name={checked ? "checkFill" : "circle"} size={22} color={checked ? c.brandStrong : c.textFaint} />
        </Pressable>
      ) : (
        <View style={styles.check}>
          <Icon name={icon} size={18} color={c.warning} />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("review.open", { name: nameOf(item.path) })}
        onPress={() => {
          tap();
          onOpen();
        }}
        style={({ pressed }) => [{ flex: 1, minWidth: 0, gap: 2, opacity: pressed ? 0.6 : 1 }]}
      >
        <T variant="footnote" numberOfLines={1} style={{ fontFamily: fonts.mono }}>
          {item.path}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {[item.bytes > 0 ? formatBytes(item.bytes) : null, item.detail, item.namedBy ? t("review.namedIn", { names: item.namedBy }) : null].filter(Boolean).join(" · ")}
        </T>
      </Pressable>
      {onMove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("actions.move")} hitSlop={8} onPress={onMove} style={styles.check}>
          <Icon name="move" size={16} color={c.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 80, gap: space.lg },
  summary: { padding: space.lg, gap: space.md },
  hint: { paddingHorizontal: space.md, paddingTop: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md, paddingRight: space.lg, paddingLeft: space.sm },
  check: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
