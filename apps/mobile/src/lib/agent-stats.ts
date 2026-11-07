import type { Run } from "@godmode/shared";

/** Like the desktop: everything is over the agent's latest 200 runs. */
export const STATS_RUNS = 200;

const DAYS = 14;
const DAY_MS = 86_400_000;

/** How many runs, how they went, how long they took, and runs per day over the last 14 days. */
export function agentStats(runs: Pick<Run, "status" | "durationMs" | "startedAt" | "createdAt">[], now = new Date()) {
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const durations = runs.map((r) => r.durationMs).filter((d): d is number => d != null && d > 0);
  const buckets = Array.from({ length: DAYS }, () => 0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime() - (DAYS - 1) * DAY_MS;
  for (const r of runs) {
    const idx = Math.floor((new Date(r.startedAt ?? r.createdAt).getTime() - startMs) / DAY_MS);
    if (idx >= 0 && idx < DAYS) buckets[idx]!++;
  }
  return {
    total: runs.length,
    successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
    failed,
    avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    buckets,
  };
}
