import { describe, expect, test } from "bun:test";
import { parseCron, type CronDraft } from "@godmode/shared";
import { buildCron, severalSpan, severalStarts, severalWindow } from "./cron-draft";

const several = (patch: Partial<CronDraft>): CronDraft => ({ ...parseCron("0 9 * * *"), kind: "several", hour: 9, minute: 0, untilHour: 21, untilMinute: 0, ...patch });

describe("several times a day", () => {
  test("random runs are one cron line with a start window, and read back as the same draft", () => {
    const d = several({ mode: "random", times: 5, days: [1, 2, 3, 4, 5] });
    expect(buildCron(d)).toBe("0 9 * * 1-5");
    expect(severalWindow(d)).toEqual({ startWindowMinutes: 720, runsPerWindow: 5 });
    const back = parseCron(buildCron(d), 720, 5);
    expect(back).toMatchObject({ kind: "several", mode: "random", hour: 9, times: 5, untilHour: 21, untilMinute: 0, days: [1, 2, 3, 4, 5] });
  });

  test("a fixed interval never passes the end time", () => {
    const d = several({ mode: "interval", every: 4, hour: 9, untilHour: 18, days: [0, 1, 2, 3, 4, 5, 6] });
    expect(buildCron(d)).toBe("0 9-18/4 * * *");
    expect(severalStarts(d)).toEqual([540, 780, 1020]);
    expect(parseCron(buildCron(d))).toMatchObject({ kind: "several", mode: "interval", every: 4, hour: 9, untilHour: 18 });
  });

  test("a whole day of even steps stays the short form", () => {
    expect(buildCron(several({ mode: "interval", every: 6, hour: 0, untilHour: 23, untilMinute: 59, days: [0, 1, 2, 3, 4, 5, 6] }))).toBe("0 */6 * * *");
  });

  test("an end before the start has no runs", () => {
    const d = several({ mode: "random", hour: 18, untilHour: 9 });
    expect(severalSpan(d)).toBeLessThan(0);
    expect(severalStarts(d)).toEqual([]);
    expect(severalWindow(d)?.startWindowMinutes).toBe(0);
  });
});
