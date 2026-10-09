/** Longest random start window of a schedule automation (`startWindowMinutes`). */
export const MAX_START_WINDOW_MINUTES = 24 * 60;

/** Most runs a schedule may spread over one start window (`runsPerWindow`). */
export const MAX_RUNS_PER_WINDOW = 24;

/** Shortest share of the window one of several runs gets. */
export const MIN_MINUTES_PER_RUN = 10;

/** "15 min", "1 h", "1 h 30 min" */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function utcOffset(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * Longest start window a schedule leaves room for: the shortest gap between its next runs, so a late start never
 * overtakes the next run. Gaps around a daylight saving change are left out (the shift only skips a run then).
 * `next(after)` is the schedule's first run after `after`.
 */
export function startWindowLimit(next: (after: Date) => Date | null, timeZone: string, from = new Date()): number {
  let limit = MAX_START_WINDOW_MINUTES;
  let prev = next(from);
  if (!prev) return limit;
  let prevOffset = utcOffset(prev, timeZone);
  let afterShift = false;
  for (let i = 0; i < 24; i++) {
    const at = next(prev);
    if (!at) break;
    const offset = utcOffset(at, timeZone);
    const shift = offset !== prevOffset;
    if (!shift && !afterShift) limit = Math.min(limit, Math.floor((at.getTime() - prev.getTime()) / 60_000));
    afterShift = shift;
    prev = at;
    prevOffset = offset;
  }
  return limit;
}

export function startWindowTooLong(limit: number): string {
  return `Runs are only ${formatMinutes(limit)} apart — the random start window can be at most ${formatMinutes(limit)}`;
}
