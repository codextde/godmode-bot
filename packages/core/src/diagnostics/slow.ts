/**
 * Work that held the event loop (owner: core). Whoever does something synchronous that can get slow — a database
 * statement, sending a run's delta, building a report — notes how long it took here, so an "event loop blocked" entry
 * in the diagnostic log can say what the core was doing meanwhile. Depends on nothing: every module may use it.
 */

/** Shorter work is no reason for a stall. */
const NOTE_FROM_MS = 30;
const MAX_KINDS = 40;

interface Slow {
  times: number;
  totalMs: number;
  worstMs: number;
}

const noted = new Map<string, Slow>();

/** `what` names the kind of work in a few words (no ids, no user data: it groups entries and goes to the log). */
export function noteSync(what: string, ms: number): void {
  if (ms < NOTE_FROM_MS) return;
  const s = noted.get(what);
  if (s) {
    s.times++;
    s.totalMs += ms;
    s.worstMs = Math.max(s.worstMs, ms);
    return;
  }
  // Never grows without bound when nobody asks (the monitor takes it every minute at the latest).
  if (noted.size >= MAX_KINDS) return;
  noted.set(what, { times: 1, totalMs: ms, worstMs: ms });
}

/** Run synchronous work and note it when it was slow. */
export function timedSync<T>(what: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    noteSync(what, performance.now() - started);
  }
}

/** The slow work noted since the last call, the kind that took longest first. */
export function takeSlowSync(limit = 5): { what: string; times: number; totalMs: number; worstMs: number }[] {
  const out = [...noted.entries()]
    .map(([what, s]) => ({ what, times: s.times, totalMs: Math.round(s.totalMs), worstMs: Math.round(s.worstMs) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
  noted.clear();
  return out;
}
