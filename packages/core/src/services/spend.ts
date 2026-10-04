/**
 * What the team spent, from the spend ledger (one row per stretch of a run, booked when it ended or stood still).
 */
import type { RunTrigger, SpendKind, SpendPeriod, SpendReport, SpendTotals } from "@godmode/shared";
import { SPEND_KIND_OF } from "@godmode/shared";
import { all, get, insert } from "../db";
import { now } from "../util";

export const SPEND_PERIODS: readonly SpendPeriod[] = ["today", "week", "month", "all"];

/** Where a period starts on this computer's clock: today at midnight, Monday, the 1st; null for all time. */
export function periodStart(period: SpendPeriod, at = new Date()): Date | null {
  if (period === "all") return null;
  if (period === "month") return new Date(at.getFullYear(), at.getMonth(), 1);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  if (period === "week") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

/** Book what one stretch of a run cost. Nothing is booked for a stretch that cost nothing and took no time. */
export function bookSpend(row: { runId: string; agentId: string; agentName: string; trigger: RunTrigger; costUsd: number; durationMs: number; failed: boolean }): void {
  if (!(row.costUsd > 0) && !(row.durationMs > 0)) return;
  insert("spend", {
    run_id: row.runId,
    agent_id: row.agentId,
    agent_name: row.agentName,
    trigger: row.trigger,
    at: now(),
    cost_usd: Math.max(0, Math.round(row.costUsd * 1e6) / 1e6),
    duration_ms: Math.max(0, Math.round(row.durationMs)),
    failed: row.failed ? 1 : 0,
  });
}

/** What was spent since `from` (null = ever), by one agent or the whole team. */
export function spentSince(from: Date | null, agentId?: string): number {
  const where = [from ? "at >= ?" : null, agentId ? "agent_id = ?" : null].filter(Boolean);
  const params = [...(from ? [from.toISOString()] : []), ...(agentId ? [agentId] : [])];
  return get<{ c: number }>(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM spend ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, ...params)?.c ?? 0;
}

interface TotalsRow {
  runs: number;
  failed: number;
  cost: number;
  ms: number;
}

/** The totals of ledger rows (aliased `s`). */
const TOTALS = `COUNT(DISTINCT s.run_id) AS runs, COUNT(DISTINCT CASE WHEN s.failed = 1 THEN s.run_id END) AS failed,
  COALESCE(SUM(s.cost_usd), 0) AS cost, COALESCE(SUM(s.duration_ms), 0) AS ms`;

const totalsOf = (r: TotalsRow | null | undefined): SpendTotals => ({
  runs: r?.runs ?? 0,
  failed: r?.failed ?? 0,
  costUsd: Math.round((r?.cost ?? 0) * 1e6) / 1e6,
  durationMs: r?.ms ?? 0,
});

function scope(period: SpendPeriod, agentId?: string): { where: string; params: string[] } {
  const from = periodStart(period);
  const parts = [from ? "s.at >= ?" : null, agentId ? "s.agent_id = ?" : null].filter(Boolean);
  return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params: [...(from ? [from.toISOString()] : []), ...(agentId ? [agentId] : [])] };
}

/** The four totals, and for `period` the spend per agent and per kind of work. */
export function spendReport(period: SpendPeriod, agentId?: string): SpendReport {
  const periods = Object.fromEntries(
    SPEND_PERIODS.map((p) => {
      const { where, params } = scope(p, agentId);
      return [p, totalsOf(get<TotalsRow>(`SELECT ${TOTALS} FROM spend s ${where}`, ...params))];
    }),
  ) as Record<SpendPeriod, SpendTotals>;
  const { where, params } = scope(period, agentId);
  const byAgent = all<TotalsRow & { agent_id: string; stored_name: string; name: string | null }>(
    `SELECT s.agent_id, MAX(s.agent_name) AS stored_name, a.name, ${TOTALS}
     FROM spend s LEFT JOIN agents a ON a.id = s.agent_id ${where}
     GROUP BY s.agent_id ORDER BY cost DESC, runs DESC`,
    ...params,
  ).map((r) => ({ ...totalsOf(r), agentId: r.agent_id, name: r.name ?? r.stored_name, deleted: r.name === null }));
  const kinds = new Map<SpendKind, SpendTotals>();
  for (const r of all<TotalsRow & { trigger: RunTrigger }>(`SELECT s.trigger, ${TOTALS} FROM spend s ${where} GROUP BY s.trigger`, ...params)) {
    const kind = SPEND_KIND_OF[r.trigger] ?? "chat";
    const t = totalsOf(r);
    const before = kinds.get(kind);
    kinds.set(kind, before ? { runs: before.runs + t.runs, failed: before.failed + t.failed, costUsd: before.costUsd + t.costUsd, durationMs: before.durationMs + t.durationMs } : t);
  }
  const byKind = [...kinds.entries()].map(([kind, t]) => ({ ...t, kind })).sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
  const active =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running', 'paused') ${agentId ? "AND agent_id = ?" : ""}`, ...(agentId ? [agentId] : []))?.n ?? 0;
  return { period, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, periods, byAgent, byKind, active };
}
