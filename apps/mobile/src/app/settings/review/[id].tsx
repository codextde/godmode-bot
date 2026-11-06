import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Review, ReviewAction, ReviewFinding, ReviewMetrics, ReviewOverview } from "@godmode/shared";
import { Group, LinkRow } from "@/components/form";
import { STATUS_TONE, isActive, useStopReview } from "@/components/review-parts";
import { openChat } from "@/components/rows";
import { isOutdated } from "@/components/settings-state";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Row, T, tap, type Tone } from "@/components/ui";
import { errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const SEVERITY: Record<ReviewFinding["severity"], Tone> = { critical: "danger", warning: "warning", info: "neutral" };

const METRICS = ["runs", "failed", "cancelled", "continuing", "bigChats", "openQuestions", "missingLogins", "logErrors", "memoryOver"] as const satisfies readonly (keyof ReviewMetrics)[];

/** One review: what it found, what it changed (each change can be undone) and how the agents did. */
export default function ReviewScreen() {
  const { t } = useTranslation(["review", "settings"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const review = useQuery({
    queryKey: sq.review(id),
    queryFn: () => settingsApi.reviews.get(id),
    placeholderData: () => queryClient.getQueryData<ReviewOverview>(sq.reviews)?.reviews.find((r) => r.id === id),
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.status) ? 5_000 : false),
  });

  if (!review.data) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: t("detail.title") }} />
        {isOutdated(review.error) ? (
          <EmptyState icon="review" title={t("settings:phone.outdatedTitle")} body={t("settings:phone.outdatedBody")} />
        ) : review.isError ? (
          <ErrorState title={t("detail.openFailed")} error={errorText(review.error)} onRetry={() => void review.refetch()} />
        ) : (
          <LoadingState />
        )}
      </View>
    );
  }
  return <ReviewDetail review={review.data} refetch={review.refetch} />;
}

function ReviewDetail({ review: r, refetch }: { review: Review; refetch: () => Promise<unknown> }) {
  const c = useColors();
  const { t } = useTranslation(["review", "common"]);
  const pull = usePullRefresh(refetch);
  const stop = useStopReview();
  const running = isActive(r.status);
  const forYou = r.findings.filter((f) => f.forHuman);
  const found = r.findings.filter((f) => !f.forHuman);
  const scores = [...r.scores].sort((a, b) => a.score - b.score);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("detail.title") }} />

      <Card style={styles.head}>
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={t(`status.${r.status}`)} tone={STATUS_TONE[r.status]} live={running} />
          {r.reason === "manual" ? <Badge label={t("detail.manual")} dot={false} /> : null}
        </Row>
        <T variant="footnote" muted>
          {whenText(r.startedAt ?? r.createdAt)}
        </T>
        {running ? (
          <Row style={{ gap: space.md, marginTop: space.xs }}>
            <ActivityIndicator color={c.brandStrong} />
            <T variant="callout" style={{ flex: 1 }}>
              {t("running")}
            </T>
          </Row>
        ) : r.summary ? (
          <T variant="body">{r.summary}</T>
        ) : null}
        {r.error ? (
          <T variant="callout" color={c.danger}>
            {r.error}
          </T>
        ) : null}
        {running && r.runId ? (
          <Button title={t("stop")} icon="stop" variant="danger" loading={stop.isPending} onPress={() => r.runId && stop.mutate(r.runId)} style={{ marginTop: space.xs }} />
        ) : null}
      </Card>

      {forYou.length > 0 ? (
        <Group title={t("blocks.forYou")}>
          {forYou.map((f, i) => (
            <FindingRow key={i} finding={f} />
          ))}
        </Group>
      ) : null}

      {r.actions.length > 0 ? (
        <Group title={t("blocks.changes")} footer={r.actions.some((a) => a.canUndo && !a.undoneAt) ? t("detail.undoFooter") : undefined}>
          {r.actions.map((a) => (
            <ActionRow key={a.index} reviewId={r.id} action={a} />
          ))}
        </Group>
      ) : null}

      {found.length > 0 ? (
        <Group title={t("blocks.found")}>
          {found.map((f, i) => (
            <FindingRow key={i} finding={f} />
          ))}
        </Group>
      ) : null}

      {scores.length > 0 ? (
        <Group title={t("blocks.agents")}>
          {scores.map((s) => (
            <View key={s.agentId} style={styles.row}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Row style={{ gap: space.md, justifyContent: "space-between" }}>
                  <T variant="callout" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
                    {s.name}
                  </T>
                  <Score value={s.score} />
                </Row>
                {s.note ? (
                  <T variant="footnote" muted>
                    {s.note}
                  </T>
                ) : null}
              </View>
            </View>
          ))}
        </Group>
      ) : null}

      {r.metrics ? (
        <Group title={t("blocks.numbers")}>
          <View style={styles.metrics}>
            {METRICS.map((key) => (
              <View key={key} style={styles.metric}>
                <T variant="headline" style={{ fontVariant: ["tabular-nums"] }}>
                  {r.metrics![key]}
                </T>
                <T variant="caption" muted numberOfLines={2}>
                  {t(`metrics.${key}`)}
                </T>
              </View>
            ))}
          </View>
        </Group>
      ) : null}

      {r.conversationId ? (
        <Group>
          <LinkRow icon="chats" title={t("openRun")} onPress={() => openChat(r.conversationId!)} />
        </Group>
      ) : null}
    </ScrollView>
  );
}

function FindingRow({ finding: f }: { finding: ReviewFinding }) {
  const c = useColors();
  const tone = SEVERITY[f.severity];
  const dot = tone === "danger" ? c.danger : tone === "warning" ? c.warning : c.textFaint;
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" style={f.forHuman ? { fontWeight: "500" } : undefined}>
          {f.forHuman || f.text}
        </T>
        {f.forHuman ? (
          <T variant="footnote" muted>
            {f.text}
          </T>
        ) : null}
      </View>
    </View>
  );
}

function ActionRow({ reviewId, action: a }: { reviewId: string; action: ReviewAction }) {
  const c = useColors();
  const { t } = useTranslation(["review", "common"]);
  const [busy, setBusy] = useState(false);
  const undo = () =>
    Alert.alert(t("detail.undoTitle"), a.text, [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("undo"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          settingsApi.reviews
            .undo(reviewId, a.index)
            .then((next) => {
              queryClient.setQueryData(sq.review(reviewId), next);
              queryClient.setQueryData<ReviewOverview>(sq.reviews, (o) => (o ? { ...o, reviews: o.reviews.map((r) => (r.id === next.id ? next : r)) } : o));
            })
            .catch((err) => Alert.alert(t("detail.undoFailed"), errorText(err)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  const text = (
    <T variant="callout" color={a.undoneAt ? c.textMuted : c.text} style={a.undoneAt ? { textDecorationLine: "line-through" } : undefined}>
      {a.text}
    </T>
  );
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        {a.conversationId ? (
          <Pressable accessibilityRole="link" onPress={() => openChat(a.conversationId!)}>
            {text}
          </Pressable>
        ) : (
          text
        )}
      </View>
      {a.undoneAt ? (
        <T variant="footnote" muted>
          {t("undoneLabel")}
        </T>
      ) : a.canUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("undo")}
          disabled={busy}
          hitSlop={8}
          onPress={() => {
            tap();
            undo();
          }}
          style={({ pressed }) => [styles.undo, { backgroundColor: c.sunken, opacity: busy ? 0.5 : pressed ? 0.8 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={c.text} />
          ) : (
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {t("undo")}
            </T>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function Score({ value }: { value: number }) {
  const c = useColors();
  const fill = value <= 2 ? c.danger : value === 3 ? c.warning : c.success;
  return (
    <View accessible accessibilityLabel={`${value}/5`} style={{ flexDirection: "row", gap: 3 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <View key={n} style={[styles.pip, { backgroundColor: n <= value ? fill : c.sunken }]} />
      ))}
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
  head: {
    padding: space.lg,
    gap: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 7,
  },
  undo: {
    minWidth: 76,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  pip: {
    width: 12,
    height: 5,
    borderRadius: 3,
  },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingVertical: space.sm,
  },
  metric: {
    width: "33.33%",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: 1,
  },
});
