import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { formatDuration } from "./run-row";
import { Card, Skeleton, T } from "./ui";
import { agentStats, STATS_RUNS } from "@/lib/agent-stats";
import { api } from "@/lib/api";
import { qk } from "@/lib/query";
import { alpha, space, useColors } from "@/lib/theme";

/** The desktop's KPIs over the agent's latest runs: how many, how they went and how long they took. A new agent shows none. */
export function AgentStats({ agent }: { agent: Agent }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const runs = useQuery({ queryKey: [...qk.agentRuns(agent.id), "stats"], queryFn: () => api.runs.list({ agentId: agent.id, limit: STATS_RUNS }) });
  const stats = useMemo(() => agentStats(runs.data ?? []), [runs.data]);
  if (runs.isError || (runs.data && !stats.total)) return null;
  const loading = runs.isLoading;
  const low = stats.successRate != null && stats.successRate < 0.8;
  return (
    <View style={styles.row}>
      <Tile label={stats.total >= STATS_RUNS ? t("stats.runsLast200") : t("stats.totalRuns")} value={loading ? null : String(stats.total)}>
        <Sparkbars values={stats.buckets} />
      </Tile>
      <Tile
        label={t("stats.successRate")}
        value={loading ? null : stats.successRate == null ? "—" : `${Math.round(stats.successRate * 100)}%`}
        color={low ? c.warning : undefined}
      >
        {stats.failed ? (
          <T variant="caption" muted numberOfLines={1}>
            {t("stats.failed", { count: stats.failed })}
          </T>
        ) : null}
      </Tile>
      <Tile label={t("stats.avgDuration")} value={loading ? null : formatDuration(stats.avg)} />
    </View>
  );
}

function Tile({ label, value, color, children }: { label: string; value: string | null; color?: string; children?: ReactNode }) {
  return (
    <Card style={styles.tile}>
      <T variant="caption" muted numberOfLines={1}>
        {label}
      </T>
      {value === null ? (
        <Skeleton width={52} height={24} />
      ) : (
        <T variant="title" color={color} numberOfLines={1} style={styles.value}>
          {value}
        </T>
      )}
      {children}
    </Card>
  );
}

/** Runs per day over the last 14 days. */
function Sparkbars({ values }: { values: number[] }) {
  const c = useColors();
  const max = Math.max(1, ...values);
  if (values.every((v) => v === 0)) return null;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.bars}>
      {values.map((v, i) => (
        <View
          key={i}
          style={[styles.bar, { height: `${Math.max(12, (v / max) * 100)}%`, backgroundColor: v ? alpha(c.text, 0.35 + 0.5 * (v / max)) : c.sunken }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: space.sm,
  },
  tile: {
    flex: 1,
    minWidth: 0,
    gap: 4,
    padding: space.md,
  },
  value: {
    fontVariant: ["tabular-nums"],
  },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 18,
  },
  bar: {
    flex: 1,
    borderRadius: 1.5,
    borderCurve: "continuous",
  },
});
