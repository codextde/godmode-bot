/**
 * What the agents on this computer used, from its own run history (GET /api/usage). One aggregate query over `runs`;
 * days are UTC days, and every day of the range is listed (with zeros) so a chart needs no gaps filled in.
 */
import type { UsageSummary } from "@godmode/shared";
import { all } from "../db";

interface Row {
  day: string;
  model: string;
  runs: number;
  cost: number;
  duration: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const token = (field: string) => `COALESCE(SUM(CASE WHEN json_valid(usage) THEN json_extract(usage, '$.${field}') END), 0)`;

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

export function usageSummary(days: number): UsageSummary {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - (days - 1)));
  const rows = all<Row>(
    `SELECT substr(created_at, 1, 10) AS day, COALESCE(model, '') AS model, COUNT(*) AS runs,
       COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS duration, COALESCE(SUM(num_turns), 0) AS turns,
       ${token("inputTokens")} AS input, ${token("outputTokens")} AS output,
       ${token("cacheReadTokens")} AS cacheRead, ${token("cacheWriteTokens")} AS cacheWrite
     FROM runs WHERE created_at >= ? GROUP BY day, model`,
    from.toISOString(),
  );

  const summary: UsageSummary = {
    from: from.toISOString(),
    to: to.toISOString(),
    runs: 0,
    costUsd: 0,
    durationMs: 0,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byDay: [],
    byModel: [],
  };
  const byDay = new Map<string, { day: string; runs: number; costUsd: number }>();
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, { day, runs: 0, costUsd: 0 });
  }
  const byModel = new Map<string, { model: string; runs: number; costUsd: number }>();
  for (const r of rows) {
    summary.runs += r.runs;
    summary.costUsd += r.cost;
    summary.durationMs += r.duration;
    summary.turns += r.turns;
    summary.tokens.input += r.input;
    summary.tokens.output += r.output;
    summary.tokens.cacheRead += r.cacheRead;
    summary.tokens.cacheWrite += r.cacheWrite;
    const day = byDay.get(r.day);
    if (day) {
      day.runs += r.runs;
      day.costUsd += r.cost;
    }
    const name = r.model || "unknown";
    const model = byModel.get(name) ?? { model: name, runs: 0, costUsd: 0 };
    model.runs += r.runs;
    model.costUsd += r.cost;
    byModel.set(name, model);
  }
  summary.costUsd = round(summary.costUsd);
  summary.byDay = [...byDay.values()].map((d) => ({ ...d, costUsd: round(d.costUsd) }));
  summary.byModel = [...byModel.values()].map((m) => ({ ...m, costUsd: round(m.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
  return summary;
}
