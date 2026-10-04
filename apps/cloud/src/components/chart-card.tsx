"use client";

import { useId, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatBytes, formatDate, formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ChartDatum = Record<string, string | number | null>;

export interface ChartSeries {
  /** Field in each datum. Letters, digits and dashes only (it becomes a CSS variable). */
  key: string;
  label: string;
  /** Pin a --chart-N token. By default series take 1, 4, 2, 5, 3 — the order that stays apart for colour-blind readers. */
  color?: 1 | 2 | 3 | 4 | 5;
}

const ORDER = [1, 4, 2, 5, 3] as const;

type ValueFormat = "number" | "bytes" | "money";

function formatValue(value: number, format: ValueFormat, currency: string, compact: boolean): string {
  if (format === "bytes") return formatBytes(value, compact ? { decimals: 0 } : {});
  if (format === "money") return formatMoney(value, currency, { trimZero: compact });
  return formatNumber(value, { compact });
}

function formatX(value: unknown, format: "day" | "month" | "raw"): string {
  if (format === "raw" || value === null || value === undefined) return String(value ?? "");
  // Date-only strings ("2026-10-04") are calendar days, not instants: print them in UTC so no zone shifts the day.
  const s = String(value);
  const opts = /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? { timeZone: "UTC" } : {};
  return formatDate(s, format === "month" ? "month" : "day", opts);
}

/**
 * A chart in a card (house rule 14) on the --chart-1..5 tokens, in both themes. Hairline grid, 2 px lines, 10 % area
 * washes, bars ≤ 24 px with rounded tops; a legend from two series; tooltip on hover/tap; a visually hidden data table
 * for screen readers. Formats are names, not functions, so server pages can render it directly.
 *
 *   <ChartCard title="New people" description="Last 30 days" summary="128" type="bar"
 *     data={series} xKey="day" series={[{ key: "count", label: "Sign-ups" }]} />
 */
export function ChartCard({
  title,
  description,
  summary,
  actions,
  data,
  xKey,
  series,
  type = "area",
  stacked = false,
  valueFormat = "number",
  currency = "usd",
  xFormat = "day",
  height = 220,
  emptyText = "No data for this period yet.",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The headline value for the period, e.g. a total. */
  summary?: ReactNode;
  actions?: ReactNode;
  data: ChartDatum[];
  xKey: string;
  series: ChartSeries[];
  type?: "area" | "bar" | "line";
  stacked?: boolean;
  valueFormat?: ValueFormat;
  /** For valueFormat "money": amounts are minor units of this currency. */
  currency?: string;
  xFormat?: "day" | "month" | "raw";
  height?: number;
  emptyText?: string;
  className?: string;
}) {
  const titleId = useId();
  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [s.key, { label: s.label, color: `var(--chart-${s.color ?? ORDER[i % ORDER.length]})` }]),
  );
  const empty = data.length === 0 || data.every((d) => series.every((s) => !d[s.key]));
  const legend = series.length > 1;

  const axes = [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis
      key="x"
      dataKey={xKey}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={28}
      tickFormatter={(v) => formatX(v, xFormat)}
    />,
    <YAxis
      key="y"
      tickLine={false}
      axisLine={false}
      tickMargin={4}
      width={valueFormat === "number" ? 36 : 56}
      allowDecimals={valueFormat !== "number"}
      tickFormatter={(v: number) => formatValue(v, valueFormat, currency, true)}
    />,
    <ChartTooltip
      key="tooltip"
      cursor={type === "bar" ? { fill: "var(--accent)", opacity: 0.5 } : { stroke: "var(--border)" }}
      content={
        <ChartTooltipContent
          labelFormatter={(_, payload) => formatX(payload?.[0]?.payload?.[xKey], xFormat)}
          formatter={(value, name, item) => (
            <div className="flex w-full items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                {config[String(name)]?.label ?? name}
              </span>
              <span className="font-mono font-medium text-foreground tabular-nums">
                {formatValue(Number(value), valueFormat, currency, false)}
              </span>
            </div>
          )}
        />
      }
    />,
    legend ? <ChartLegend key="legend" content={<ChartLegendContent />} /> : null,
  ];

  const chart =
    type === "bar" ? (
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
        {axes}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={`var(--color-${s.key})`}
            maxBarSize={24}
            stackId={stacked ? "stack" : undefined}
            radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : 0}
            stroke={stacked ? "var(--card)" : undefined}
            strokeWidth={stacked ? 2 : 0}
          />
        ))}
      </BarChart>
    ) : type === "line" ? (
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        {axes}
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
        ))}
      </LineChart>
    ) : (
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        {axes}
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.1}
            stackId={stacked ? "stack" : undefined}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
        ))}
      </AreaChart>
    );

  return (
    <figure aria-labelledby={titleId} className={cn("animate-enter min-w-0 rounded-xl border bg-card shadow-card", className)}>
      <figcaption className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          {summary !== undefined && <p className="mt-2 text-[26px] leading-none font-medium tracking-[-0.03em]">{summary}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </figcaption>
      <div className="px-2 pt-3 pb-3 @2xl:px-3">
        {empty ? (
          <div className="grid place-items-center px-4 text-center text-sm text-muted-foreground" style={{ height }}>
            {emptyText}
          </div>
        ) : (
          <ChartContainer config={config} className="aspect-auto w-full" style={{ height }} aria-hidden>
            {chart}
          </ChartContainer>
        )}
      </div>
      {!empty && (
        <table className="sr-only">
          <caption>{typeof title === "string" ? title : "Chart data"}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={i}>
                <th scope="row">{formatX(d[xKey], xFormat)}</th>
                {series.map((s) => (
                  <td key={s.key}>{d[s.key] === null ? "—" : formatValue(Number(d[s.key]), valueFormat, currency, false)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
