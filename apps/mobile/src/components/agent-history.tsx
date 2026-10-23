import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router } from "expo-router";
import { memo } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import type { Agent, Run, RunStatus } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { runStatusLabel, TRIGGER_LABEL } from "./run-row";
import { Card, Hairline, LiveDot, SectionTitle, SkeletonRows, T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { formatCost, formatWork } from "@/lib/desktop-parity";
import { activityText } from "@/lib/format";
import { useLive, useRunActivity } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { useSpendTracking } from "@/lib/setup";
import { alpha, radius, space, useColors, type Colors } from "@/lib/theme";

const SHOWN_RUNS = 10;

const openRun = (id: string) => {
  tap();
  router.push({ pathname: "/run/[id]", params: { id } });
};

function firstLine(text: string | null | undefined): string {
  return (text ?? "").split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
}

/** The agent's latest run failed and the human hasn't let it go yet: what went wrong, the run, and Dismiss. */
export function FailedRunBanner({ agent }: { agent: Agent }) {
  const c = useColors();
  const runId = agent.failedRunId;
  const run = useQuery({ queryKey: qk.run(runId ?? ""), queryFn: () => api.runs.get(runId!), enabled: !!runId });
  const dismiss = useMutation({
    mutationFn: () => api.agents.dismissFailure(agent.id),
    onSuccess: (updated) => {
      queryClient.setQueryData<Agent[]>(qk.agents, (old) => old?.map((a) => (a.id === updated.id ? updated : a)));
      void queryClient.invalidateQueries({ queryKey: qk.agents });
    },
    onError: (err) => Alert.alert("Couldn't dismiss it", errorText(err)),
  });
  if (!runId) return null;
  const error = firstLine(run.data?.error);

  return (
    <View style={[styles.banner, { backgroundColor: c.dangerSoft, borderColor: alpha(c.danger, 0.25) }]}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Icon name="warning" size={15} color={c.danger} style={{ marginTop: 2 }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="subhead" color={c.danger} style={{ fontWeight: "600" }}>
            Last run failed
          </T>
          {error ? (
            <T variant="footnote" numberOfLines={4}>
              {error}
            </T>
          ) : run.isLoading ? null : (
            <T variant="footnote" muted>
              This is why {agent.name} shows “Last run failed”.
            </T>
          )}
        </View>
      </View>
      <View style={styles.bannerActions}>
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          disabled={dismiss.isPending}
          onPress={() => {
            tap();
            dismiss.mutate();
          }}
          style={{ opacity: dismiss.isPending ? 0.5 : 1, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {dismiss.isPending ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
          <T variant="footnote" muted style={{ fontWeight: "600" }}>
            Dismiss
          </T>
        </Pressable>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => openRun(runId)}>
          <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
            Open run
          </T>
        </Pressable>
      </View>
    </View>
  );
}

/** The desktop's "Recent runs": the agent's latest runs, how each went, what started it, when, how long and what it cost. */
export function AgentHistory({ agent }: { agent: Agent }) {
  const runs = useQuery({ queryKey: qk.agentRuns(agent.id), queryFn: () => api.runs.list({ agentId: agent.id, limit: SHOWN_RUNS }) });
  return (
    <View>
      <SectionTitle title="Recent runs" />
      <Card style={{ overflow: "hidden" }}>
        {runs.data?.length ? (
          runs.data.map((r, i) => (
            <View key={r.id}>
              {i > 0 && <Hairline inset={space.lg + 16 + space.md} />}
              <HistoryRow run={r} />
            </View>
          ))
        ) : runs.isLoading ? (
          <SkeletonRows count={3} avatar={0} />
        ) : (
          <T variant="subhead" muted style={{ padding: space.lg }}>
            {runs.isError ? `Couldn't load runs: ${errorText(runs.error)}` : "No runs yet. Start a chat or give it a task — every run shows up here."}
          </T>
        )}
      </Card>
    </View>
  );
}

const GLYPH: Record<Exclude<RunStatus, "running">, { icon: IconName; color: (c: Colors) => string }> = {
  queued: { icon: "clock", color: (c) => c.textMuted },
  paused: { icon: "pause", color: (c) => c.warning },
  succeeded: { icon: "checkCircle", color: (c) => c.success },
  failed: { icon: "closeCircle", color: (c) => c.danger },
  cancelled: { icon: "minus", color: (c) => c.textMuted },
};

function RunGlyph({ status }: { status: RunStatus }) {
  const c = useColors();
  if (status === "running") return <LiveDot size={8} />;
  const g = GLYPH[status] ?? GLYPH.queued;
  return <Icon name={g.icon} size={16} color={g.color(c)} />;
}

const HistoryRow = memo(function HistoryRow({ run }: { run: Run }) {
  const c = useColors();
  const status = useLive((s) => s.runs[run.id]?.run.status) ?? run.status;
  const activity = useRunActivity(status === "running" ? run.id : undefined);
  const spendTracking = useSpendTracking();
  const finished = status === "succeeded" || status === "failed" || status === "cancelled";
  const when = run.startedAt ?? run.createdAt;
  const meta = [
    TRIGGER_LABEL[run.trigger] ?? "Manual",
    formatDistanceToNowStrict(new Date(when), { addSuffix: true }),
    finished && run.durationMs != null ? formatWork(run.durationMs) : null,
    spendTracking && run.costUsd ? formatCost(run.costUsd) : null,
  ].filter(Boolean);
  const snippet = (run.prompt || "").replace(/\s+/g, " ").trim() || "(no prompt)";
  const error = status === "failed" ? firstLine(run.error) : "";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${runStatusLabel(status)}: ${snippet}`}
      onPress={() => openRun(run.id)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.glyph}>
        <RunGlyph status={status} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" numberOfLines={1}>
          {snippet}
        </T>
        <T variant="caption" muted numberOfLines={1}>
          {meta.join(" · ")}
        </T>
        {error ? (
          <T variant="caption" color={c.danger} numberOfLines={1}>
            {error}
          </T>
        ) : status === "running" ? (
          <T variant="caption" color={c.brandStrong} numberOfLines={1}>
            {activityText(activity)}
          </T>
        ) : status === "queued" ? (
          <T variant="caption" muted numberOfLines={1}>
            Waiting to start
          </T>
        ) : null}
      </View>
      <Icon name="chevron" size={11} color={c.textFaint} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  banner: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  bannerActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space.xl,
    paddingTop: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  glyph: {
    width: 16,
    alignItems: "center",
  },
});
