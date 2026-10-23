import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { addMonths, format, startOfMonth } from "date-fns";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BUDGET_WARN_AT, type SpendPeriod, type SpendTotals } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Segmented } from "./form";
import { formatDuration } from "./run-row";
import { Card, Hairline, Row, Skeleton, T, tap } from "./ui";
import { ApiError, api, errorText } from "@/lib/api";
import { formatCost } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

type Period = Exclude<SpendPeriod, "all">;

const PERIODS: { value: Period; label: string; none: string }[] = [
  { value: "today", label: "Today", none: "No runs yet today" },
  { value: "week", label: "This week", none: "No runs this week yet" },
  { value: "month", label: "This month", none: "No runs this month yet" },
];

const TOP = 5;

const line = (t: SpendTotals) =>
  [`${t.runs} run${t.runs === 1 ? "" : "s"}`, t.failed ? `${t.failed} failed` : null, t.durationMs ? `${formatDuration(t.durationMs)} working` : null].filter(Boolean).join(" · ");

/**
 * What the team cost today, this week or this month (the desktop's spend strip), the team's monthly budget when one is
 * set, and who the money went to. Nothing while spend tracking is off.
 */
export function SpendStrip() {
  const c = useColors();
  const runner = useSettings().data?.runner;
  const on = !!runner?.spendTracking;
  const [period, setPeriod] = useState<Period>("today");
  const report = useQuery({
    queryKey: qk.spend(period),
    queryFn: () => api.spend.report(period),
    enabled: on,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const { byId } = useAgents();
  if (!on || (report.error instanceof ApiError && report.error.code === "device_forbidden")) return null;

  const data = report.data;
  const meta = PERIODS.find((p) => p.value === period)!;
  const totals = data?.periods[period];
  const budget = runner?.monthlyBudgetUsd ?? null;
  const top = data?.byAgent.slice(0, TOP) ?? [];
  const most = Math.max(0.000001, ...top.map((a) => a.costUsd));

  return (
    <Card style={styles.card}>
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <View accessible accessibilityLabel={totals ? `${meta.label}: ${formatCost(totals.costUsd)}, ${line(totals) || meta.none}` : meta.label} style={{ gap: 2 }}>
        {report.isLoading ? (
          <>
            <Skeleton width={96} height={26} radius={radius.sm} />
            <Skeleton width={160} height={12} style={{ marginTop: 6 }} />
          </>
        ) : (
          <>
            <T variant="title" style={{ fontVariant: ["tabular-nums"] }}>
              {totals ? formatCost(totals.costUsd) : "—"}
            </T>
            <T variant="footnote" muted numberOfLines={1}>
              {totals && totals.runs ? line(totals) : meta.none}
              {period === "today" && data?.active ? ` · ${data.active} not finished yet` : ""}
            </T>
          </>
        )}
      </View>
      {report.isError ? (
        <Row style={{ gap: space.sm }}>
          <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
            {`Couldn't load totals: ${errorText(report.error)}`}
          </T>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              tap();
              void report.refetch();
            }}
          >
            <T variant="footnote" style={{ fontWeight: "600" }}>
              Try again
            </T>
          </Pressable>
        </Row>
      ) : null}

      {budget !== null && budget > 0 && data ? (
        <>
          <Hairline />
          <BudgetMeter spentUsd={data.periods.month.costUsd} budgetUsd={budget} />
        </>
      ) : null}

      {top.length > 0 ? (
        <>
          <Hairline />
          <View style={{ gap: space.sm }}>
            <T variant="eyebrow" muted>
              By agent
            </T>
            {top.map((a) => {
              const agent = byId.get(a.agentId);
              return (
                <Pressable
                  key={a.agentId}
                  disabled={a.deleted}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.name}: ${formatCost(a.costUsd)}, ${a.runs} run${a.runs === 1 ? "" : "s"}`}
                  onPress={() => {
                    tap();
                    router.push({ pathname: "/agent/[id]", params: { id: a.agentId } });
                  }}
                  style={({ pressed }) => [styles.agent, pressed && { opacity: 0.6 }]}
                >
                  {agent ? <CharacterAvatar agent={agent} size={22} /> : <View style={[styles.gone, { backgroundColor: c.sunken }]} />}
                  <T variant="footnote" numberOfLines={1} style={{ width: 96 }}>
                    {a.deleted ? `${a.name} (deleted)` : a.name}
                  </T>
                  <View style={[styles.track, { backgroundColor: c.sunken }]}>
                    <View style={[styles.fill, { width: `${Math.max(2, (a.costUsd / most) * 100)}%`, backgroundColor: c.textMuted }]} />
                  </View>
                  <T variant="caption" muted numberOfLines={1} style={{ fontVariant: ["tabular-nums"], minWidth: 88, textAlign: "right" }}>
                    <T variant="caption">{formatCost(a.costUsd)}</T>
                    {` · ${a.runs} run${a.runs === 1 ? "" : "s"}`}
                  </T>
                </Pressable>
              );
            })}
            {(data?.byAgent.length ?? 0) > TOP ? (
              <T variant="caption" muted>
                {`and ${(data?.byAgent.length ?? 0) - TOP} more`}
              </T>
            ) : null}
          </View>
        </>
      ) : data && !report.isLoading ? (
        <T variant="footnote" muted>
          Nothing ran in this period.
        </T>
      ) : null}
    </Card>
  );
}

/** "Spent $12.40 of $50.00 this month" with a bar (the desktop's budget meter); used up: what waits. */
function BudgetMeter({ spentUsd, budgetUsd }: { spentUsd: number; budgetUsd: number }) {
  const c = useColors();
  const share = Math.min(1, spentUsd / budgetUsd);
  const state = spentUsd >= budgetUsd ? "exhausted" : share >= BUDGET_WARN_AT ? "warning" : "ok";
  const bar = state === "exhausted" ? c.danger : state === "warning" ? c.warning : c.textMuted;
  const sentence = `Spent ${formatCost(spentUsd)} of ${formatCost(budgetUsd)} this month`;
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
        <T variant="footnote" style={{ fontVariant: ["tabular-nums"], flexShrink: 1 }}>
          {"Spent "}
          <T variant="footnote" style={{ fontWeight: "500" }}>
            {formatCost(spentUsd)}
          </T>
          <T variant="footnote" muted>{` of ${formatCost(budgetUsd)} this month`}</T>
        </T>
        {state === "warning" ? (
          <View style={[styles.used, { backgroundColor: c.warningSoft }]}>
            <T variant="caption" color={c.warning} style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }}>
              {`${Math.floor(share * 100)}% used`}
            </T>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <T variant="caption" muted>
          {`Resets ${format(startOfMonth(addMonths(new Date(), 1)), "MMM d")}`}
        </T>
      </Row>
      <View accessible accessibilityRole="progressbar" accessibilityLabel={sentence} style={[styles.meter, { backgroundColor: c.sunken }]}>
        <View style={[styles.fill, { width: `${Math.max(2, share * 100)}%`, backgroundColor: bar }]} />
      </View>
      {state === "exhausted" ? (
        <T variant="caption" muted>
          {"Used up — the team's automations, follow-ups and board tickets wait. Chats you start still run."}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.md,
    gap: space.md,
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 28,
  },
  gone: {
    width: 22,
    height: 22,
    borderRadius: 6,
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  meter: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
  used: {
    paddingHorizontal: 6,
    borderRadius: radius.xs,
  },
});
