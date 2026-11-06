import { useMutation } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cronToHuman, findModel, type Review } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { STATUS_TONE, isActive, useReviews, useStopReview } from "@/components/review-parts";
import { FormSkeleton, isOutdated } from "@/components/settings-state";
import { EmptyState, ErrorState, Row, Skeleton, T, tap, toneColors } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useModelCatalog } from "@/lib/composer";
import { whenText } from "@/lib/format";
import { currentLanguage, uses12Hour } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space, useColors } from "@/lib/theme";

const SCHEDULES = [
  { cron: "0 5 * * *", labelKey: "schedules.morning" },
  { cron: "0 2 * * *", labelKey: "schedules.night" },
  { cron: "0 7 * * 1-5", labelKey: "schedules.weekdays" },
  { cron: "0 5 * * 0", labelKey: "schedules.sunday" },
] as const;

/** Auto review: once a day the main agent looks at the whole setup and fixes what doesn't make sense. */
export default function AutoReview() {
  const { t } = useTranslation(["review", "settings", "common"]);
  const settings = useSettings();
  const overview = useReviews();
  const models = (useModelCatalog().data?.models ?? []).filter((m) => !m.provider);
  const pull = usePullRefresh(() => Promise.all([overview.refetch(), settings.refetch()]));
  const stop = useStopReview();
  const start = useMutation({
    mutationFn: settingsApi.reviews.start,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sq.reviews }),
    onError: (err) => Alert.alert(t("startFailed"), errorText(err)),
  });
  const s = settings.data;
  const r = s?.review;
  const active = overview.data?.active ?? null;

  const header = (
    <>
      <Stack.Screen options={{ title: t("title") }} />
      <CloseButton />
    </>
  );

  if (isOutdated(overview.error)) {
    return (
      <View style={styles.center}>
        {header}
        <EmptyState icon="review" title={t("settings:phone.outdatedTitle")} body={t("settings:phone.outdatedBody")} />
      </View>
    );
  }

  const cron = r?.cron.trim().replace(/\s+/g, " ") ?? "";
  const presets = SCHEDULES.map((p) => ({ value: p.cron as string, label: t(p.labelKey) }));
  const schedules = SCHEDULES.some((p) => p.cron === cron) ? presets : [...presets, { value: cron, label: cronToHuman(cron, currentLanguage(), uses12Hour()) }];
  const reviewModel = findModel(models, r?.model)?.id ?? r?.model ?? "";
  const modelOptions = [
    { value: "", label: t("model.mainAgent") },
    ...(reviewModel && !models.some((m) => m.id === reviewModel) ? [{ value: reviewModel, label: reviewModel }] : []),
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
  ];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      {header}
      {!r ? (
        settings.isError ? (
          <ErrorState title={t("loadFailed")} error={errorText(settings.error)} onRetry={() => void settings.refetch()} />
        ) : (
          <FormSkeleton groups={1} rows={4} />
        )
      ) : (
        <>
          <Group
            title={t("schedule")}
            footer={
              [
                r.enabled && overview.data?.nextReviewAt ? t("next", { when: whenText(overview.data.nextReviewAt) }) : null,
                r.autoFix ? null : t("reportOnly"),
                r.autoFix && r.team ? null : t("onComputer"),
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
            <SwitchRow icon="review" title={t("enabled")} value={r.enabled} onChange={(enabled) => void patchSettings({ review: { enabled } })} />
            {r.enabled ? (
              <PickerRow
                icon="clock"
                title={t("when")}
                value={cron}
                options={schedules}
                onChange={(next) => void patchSettings({ review: { cron: next } })}
              />
            ) : null}
            {/* Off from here; back on at the computer, like the features that widen what agents do. */}
            <SwitchRow icon="wrench" title={t("autoFix")} value={r.autoFix} disabled={!r.autoFix} onChange={(autoFix) => void patchSettings({ review: { autoFix } })} />
            <SwitchRow icon="subagent" title={t("team")} detail={t("teamDetail")} value={r.team} disabled={!r.team} onChange={(team) => void patchSettings({ review: { team } })} />
            <PickerRow icon="sparkles" title={t("model.title")} value={reviewModel} options={modelOptions} onChange={(model) => void patchSettings({ review: { model } })} />
          </Group>

          <Group>
            {active ? (
              <RunningRow review={active} stopping={stop.isPending} onStop={() => active.runId && stop.mutate(active.runId)} />
            ) : (
              <LinkRow icon="play" tone="brand" chevron={false} title={start.isPending ? t("starting") : t("now")} onPress={() => !start.isPending && start.mutate()} />
            )}
          </Group>
        </>
      )}

      <Group title={t("history")}>
        {overview.data ? (
          overview.data.reviews.length ? (
            overview.data.reviews.map((review) => <ReviewRow key={review.id} review={review} />)
          ) : (
            <View style={styles.empty}>
              <T variant="subhead" muted>
                {t("empty")}
              </T>
            </View>
          )
        ) : overview.isError ? (
          <View style={styles.empty}>
            <T variant="subhead" muted style={{ textAlign: "center" }}>
              {errorText(overview.error)}
            </T>
          </View>
        ) : (
          [0, 1, 2].map((i) => <RowSkeleton key={i} />)
        )}
      </Group>
    </ScrollView>
  );
}

function RunningRow({ review, stopping, onStop }: { review: Review; stopping: boolean; onStop: () => void }) {
  const c = useColors();
  const { t } = useTranslation("review");
  return (
    <Row style={styles.running}>
      <ActivityIndicator color={c.brandStrong} />
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }} numberOfLines={1}>
        {review.status === "queued" ? t("status.queued") : t("running")}
      </T>
      {review.runId ? (
        <Pressable
          accessibilityRole="button"
          disabled={stopping}
          hitSlop={8}
          onPress={() => {
            tap();
            onStop();
          }}
          style={({ pressed }) => [styles.stop, { backgroundColor: c.dangerSoft, opacity: stopping ? 0.5 : pressed ? 0.8 : 1 }]}
        >
          <T variant="footnote" color={c.danger} style={{ fontWeight: "600" }}>
            {t("stop")}
          </T>
        </Pressable>
      ) : null}
    </Row>
  );
}

function ReviewRow({ review: r }: { review: Review }) {
  const c = useColors();
  const { t } = useTranslation("review");
  const running = isActive(r.status);
  const forYou = r.findings.filter((f) => f.forHuman).length;
  const summary = running ? t("running") : r.summary || r.error || t(`status.${r.status}`);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push({ pathname: "/settings/review/[id]", params: { id: r.id } });
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.dotBox}>
        {running ? <ActivityIndicator size="small" color={c.brandStrong} /> : <View style={[styles.dot, { backgroundColor: toneColors(c, STATUS_TONE[r.status]).dot }]} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={1}>
          {whenText(r.startedAt ?? r.createdAt)}
        </T>
        <T variant="footnote" muted={!r.summary} numberOfLines={2}>
          {summary}
        </T>
        {!running && (r.actions.length > 0 || forYou > 0) ? (
          <Row style={{ gap: space.sm, marginTop: 4 }}>
            {r.actions.length > 0 ? (
              <T variant="caption" muted>
                {t("changes", { count: r.actions.length })}
              </T>
            ) : null}
            {forYou > 0 ? (
              <T variant="caption" color={c.warning} style={{ fontWeight: "600" }}>
                {t("forYou", { count: forYou })}
              </T>
            ) : null}
          </Row>
        ) : null}
      </View>
      <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" />
    </Pressable>
  );
}

function RowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={8} height={8} radius={4} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width="40%" height={13} />
        <Skeleton width="85%" height={11} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  running: {
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  stop: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  dotBox: {
    width: 16,
    height: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  empty: {
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    alignItems: "center",
  },
});
