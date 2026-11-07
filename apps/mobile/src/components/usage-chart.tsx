import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { UsageSummary } from "@godmode/shared";
import { Group, Segmented } from "./form";
import { InfoRow } from "./status-rows";
import { ErrorState, Row, Skeleton, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { dateLocale, intlLocale } from "@/lib/i18n";
import { settingsApi, sq } from "@/lib/settings-api";
import { radius, space, useColors } from "@/lib/theme";

const RANGES = ["7", "30", "90"] as const;
type Range = (typeof RANGES)[number];

const DAY_MS = 86_400_000;
const count = (n: number) => n.toLocaleString(intlLocale());

export function hours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? "< 1 min" : "0 min";
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} h`;
}

/** One bar per calendar day of the range, days without runs too (the summary lists only days with some). */
function dayBars(usage: UsageSummary, days: number): { day: string; runs: number }[] {
  const byDay = new Map(usage.byDay.map((d) => [d.day, d.runs]));
  const keys = new Set(byDay.keys());
  const end = new Date(usage.to).getTime();
  if (Number.isFinite(end)) for (let i = 0; i < days; i++) keys.add(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  return [...keys]
    .sort()
    .slice(-days)
    .map((day) => ({ day, runs: byDay.get(day) ?? 0 }));
}

const dayLabel = (day: string) => format(new Date(`${day}T12:00:00`), "d MMM", { locale: dateLocale() });

/**
 * What this computer's agents did over 7, 30 or 90 days (desktop: billing-section.tsx, usage card): runs, time and
 * tokens, and runs per day as bars. Touching a bar shows its day.
 */
export function UsageCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [range, setRange] = useState<Range>("30");
  const days = Number(range);
  // The answer carries its range, so bars never draw old data against a new range while loading.
  const usage = useQuery({ queryKey: sq.usage(days), queryFn: () => settingsApi.usage(days).then((summary) => ({ days, summary })), placeholderData: keepPreviousData });
  const data = usage.data;

  return (
    <Group title={t("usageChart.title")}>
      <View>
        <View style={styles.segment}>
          <Segmented options={RANGES.map((r) => ({ value: r, label: t("usageChart.days", { count: Number(r) }) }))} value={range} onChange={setRange} />
        </View>
        {!data && usage.isError ? (
          <ErrorState title={t("usageChart.loadFailed")} error={errorText(usage.error)} onRetry={() => void usage.refetch()} />
        ) : !data ? (
          <View style={{ padding: space.lg, gap: space.md }}>
            <Skeleton height={14} width="60%" />
            <Skeleton height={112} radius={radius.md} />
          </View>
        ) : (
          <View style={{ opacity: usage.isPlaceholderData ? 0.6 : 1 }}>
            <RunsChart usage={data.summary} days={data.days} />
          </View>
        )}
      </View>
      {data ? <InfoRow icon="play" label={t("license.agents.runs")} value={count(data.summary.runs)} /> : null}
      {data ? <InfoRow icon="clock" label={t("license.agents.time")} value={hours(data.summary.durationMs)} /> : null}
      {data ? (
        <InfoRow
          icon="cpu"
          label={t("license.agents.tokens")}
          detail={t("license.agents.tokensDetail", { input: count(data.summary.tokens.input), output: count(data.summary.tokens.output) })}
          value={count(data.summary.tokens.input + data.summary.tokens.output + data.summary.tokens.cacheRead + data.summary.tokens.cacheWrite)}
        />
      ) : null}
      {data?.summary.byModel.map((m) => (
        <InfoRow key={m.model} icon="sparkles" label={m.model === "unknown" ? t("common:status.unknown") : m.model} value={t("license.agents.modelRuns", { count: m.runs })} />
      ))}
    </Group>
  );
}

function RunsChart({ usage, days }: { usage: UsageSummary; days: number }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<number | null>(null);
  const bars = useMemo(() => dayBars(usage, days), [usage, days]);
  const max = Math.max(1, ...bars.map((b) => b.runs));
  const shown = active !== null ? bars[active] : null;
  if (bars.length === 0) return null;
  const gap = days > 30 ? 1 : 2;

  return (
    <View style={styles.chart}>
      <Row style={{ justifyContent: "space-between", gap: space.md }}>
        <T variant="footnote" muted>
          {shown ? dayLabel(shown.day) : t("usageChart.perDay")}
        </T>
        <T variant="footnote" style={{ fontVariant: ["tabular-nums"] }}>
          {shown ? t("usageChart.runs", { count: shown.runs }) : t("usageChart.upTo", { max })}
        </T>
      </Row>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t("usageChart.label", { days, total: usage.runs, max })}
        style={[styles.bars, { gap, borderBottomColor: c.border }]}
      >
        {bars.map((b, i) => (
          <Pressable
            key={b.day}
            onPressIn={() => {
              if (active !== i) tap();
              setActive(i);
            }}
            onPressOut={() => setActive(null)}
            style={styles.barSlot}
          >
            <View
              style={{
                width: "100%",
                height: b.runs ? `${Math.max(4, (b.runs / max) * 100)}%` : 2,
                borderTopLeftRadius: days > 30 ? 1.5 : 3,
                borderTopRightRadius: days > 30 ? 1.5 : 3,
                backgroundColor: b.runs ? c.brand : c.sunken,
                opacity: active !== null && active !== i ? 0.45 : 1,
              }}
            />
          </Pressable>
        ))}
      </View>
      <Row style={{ justifyContent: "space-between" }}>
        <T variant="caption" muted>
          {dayLabel(bars[0]!.day)}
        </T>
        <T variant="caption" muted>
          {dayLabel(bars[bars.length - 1]!.day)}
        </T>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  chart: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 112,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barSlot: {
    flex: 1,
    height: "100%",
    justifyContent: "flex-end",
  },
});
