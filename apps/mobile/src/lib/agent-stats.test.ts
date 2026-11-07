import { describe, expect, test } from "bun:test";
import { agentStats } from "./agent-stats";

const run = (status: string, at: string, durationMs: number | null = null) => ({ status, createdAt: at, startedAt: at, durationMs }) as Parameters<typeof agentStats>[0][number];

describe("agent stats", () => {
  const now = new Date(2026, 10, 7, 12);
  test("the success rate leaves out runs that neither succeeded nor failed", () => {
    const stats = agentStats([run("succeeded", now.toISOString(), 2000), run("failed", now.toISOString(), 4000), run("cancelled", now.toISOString())], now);
    expect(stats).toMatchObject({ total: 3, successRate: 0.5, failed: 1, avg: 3000 });
  });

  test("no finished run means no rate", () => {
    expect(agentStats([run("running", now.toISOString())], now).successRate).toBeNull();
  });

  test("the last bucket is today and runs older than 14 days are left out", () => {
    const { buckets, total } = agentStats([run("succeeded", now.toISOString()), run("succeeded", new Date(2026, 10, 1, 9).toISOString()), run("succeeded", new Date(2026, 9, 1).toISOString())], now);
    expect(buckets).toHaveLength(14);
    expect(buckets[13]).toBe(1);
    expect(buckets[7]).toBe(1);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(2);
    expect(total).toBe(3);
  });
});
