import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { GithubErrorCode, type PullRequestMergeMethod, type PullRequestView } from "@godmode/shared";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Button, Card, Hairline, LoadingState, T, tap } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { preferredMethod, prApi, prKey, rememberMethod } from "@/lib/pull-requests";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** Before a pull request is merged (or set to merge by itself): how, and what speaks against it right now. */
export default function MergeSheet() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const { url = "", mode } = useLocalSearchParams<{ url: string; mode?: "now" | "auto" }>();
  const pr = useQuery({ queryKey: prKey(url), queryFn: () => prApi.get(url), staleTime: 30_000 });
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (!pr.data || fullAccess === undefined) return <LoadingState />;
  return <MergeForm pr={pr.data} url={url} initial={mode === "auto" ? "auto" : "now"} />;
}

function MergeForm({ pr, url, initial }: { pr: PullRequestView; url: string; initial: "now" | "auto" }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const [mode, setMode] = useState(initial);
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(() => preferredMethod(pr.mergeMethods));
  const [problem, setProblem] = useState<string | null>(null);
  const failing = (pr.checks ?? []).filter((x) => x.state === "failure").length;
  const running = (pr.checks ?? []).filter((x) => x.state === "pending").length;
  const wantsChanges = (pr.reviews ?? []).some((r) => r.state === "changes_requested");
  const warnings = [
    failing > 0 && t("pullRequest.merge.warnFailing", { count: failing }),
    running > 0 && t("pullRequest.merge.warnRunning", { count: running }),
    wantsChanges && t("pullRequest.merge.warnChanges"),
    pr.mergeable === "blocked" && t("pullRequest.merge.warnBlocked"),
  ].filter((w): w is string => !!w);
  const offerAuto = pr.autoMergeAllowed && !pr.autoMerge && pr.state === "open" && pr.mergeable !== "conflicting" && (running > 0 || pr.mergeable === "blocked");

  const run = useMutation({
    mutationFn: () => {
      rememberMethod(method!);
      return mode === "auto" ? prApi.autoMerge({ url, method }) : prApi.merge({ url, method: method!, headSha: pr.headSha });
    },
    onSuccess: (view) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.setQueryData(prKey(url), view);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      router.back();
    },
    onError: (err) => {
      setProblem(errorText(err));
      if (err instanceof ApiError && err.code === GithubErrorCode.MergeRefused) void queryClient.invalidateQueries({ queryKey: prKey(url) });
    },
  });

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={{ gap: space.xs }}>
        <T variant="title">
          {mode === "auto"
            ? t("pullRequest.autoMerge.confirmTitle", { number: pr.ref.number, base: pr.baseBranch })
            : t("pullRequest.merge.confirmTitle", { number: pr.ref.number, base: pr.baseBranch })}
        </T>
        <T variant="subhead" muted>
          {mode === "auto" ? t("pullRequest.autoMerge.explain") : pr.title}
        </T>
      </View>

      {pr.mergeMethods.length > 1 ? (
        <Card style={{ overflow: "hidden" }}>
          {pr.mergeMethods.map((m, i) => {
            const on = method === m;
            return (
              <View key={m}>
                {i > 0 ? <Hairline inset={space.lg} /> : null}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    tap();
                    setMethod(m);
                  }}
                  style={({ pressed }) => [styles.method, pressed && { backgroundColor: c.sunken }]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <T variant="callout" style={{ fontWeight: "500" }}>
                      {t(`pullRequest.merge.methods.${m}.label`)}
                    </T>
                    <T variant="footnote" muted>
                      {t(`pullRequest.merge.methods.${m}.hint`)}
                    </T>
                  </View>
                  {on ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
                </Pressable>
              </View>
            );
          })}
        </Card>
      ) : null}

      {mode === "now" && warnings.length ? (
        <View style={[styles.box, { backgroundColor: c.warningSoft }]}>
          <Icon name="warning" size={14} color={c.warning} />
          <T variant="footnote" style={{ flex: 1 }}>
            {t("pullRequest.merge.headsUp", { warnings: warnings.join(", ") })}
          </T>
        </View>
      ) : null}
      {problem ? (
        <View style={[styles.box, { backgroundColor: c.dangerSoft }]} accessibilityRole="alert">
          <Icon name="warning" size={14} color={c.danger} />
          <T variant="footnote" color={c.danger} style={{ flex: 1 }}>
            {mode === "auto" ? t("pullRequest.autoMerge.refused", { reason: problem }) : t("pullRequest.merge.refused", { reason: problem })}
          </T>
        </View>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Button
          title={mode === "auto" ? t("pullRequest.autoMerge.confirm") : method ? t(`pullRequest.merge.methods.${method}.label`) : t("pullRequest.merge.button")}
          icon="merge"
          loading={run.isPending}
          disabled={!method}
          onPress={() => {
            setProblem(null);
            run.mutate();
          }}
        />
        {mode === "now" && offerAuto ? (
          <Button
            title={t("pullRequest.autoMerge.button")}
            variant="outline"
            disabled={run.isPending}
            onPress={() => {
              setProblem(null);
              setMode("auto");
            }}
          />
        ) : null}
        <Button title={t("pullRequest.merge.cancel")} variant="secondary" disabled={run.isPending} onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  method: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  box: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, borderCurve: "continuous" },
});
