/**
 * Runtime health for the diagnostic log (owner: core): crashes, event-loop stalls (with what the core was doing
 * meanwhile), sleep/wake gaps and periodic memory snapshots.
 */
import { statSync } from "node:fs";
import { config } from "../config";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { clientCount } from "../server/ws";
import { takeSlowSync } from "./slow";

const log = logger("perf");
const crash = logger("crash");

const TICK_MS = 500;
const STALL_MS = 300;
const SLEEP_MS = 30_000;
const STALL_REPORT_EVERY_MS = 60_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const HIGH_RSS_BYTES = 1.5 * 1024 ** 3;
/** "High memory use" is said again only when the memory grew by this much since it was last said. */
const HIGH_RSS_AGAIN = 1.25;
/** Awake for less than this between two sleeps, the computer only stirred (macOS wakes every few minutes at night). */
const NAP_AWAKE_MS = 5 * 60_000;
const MB = 1024 * 1024;

let tick: ReturnType<typeof setInterval> | null = null;
let snapshot: ReturnType<typeof setInterval> | null = null;
let handlersInstalled = false;
let stalls = 0;
let worstStall = 0;
let stalledMs = 0;
let lastStallReport = -Infinity;
let slowForgottenAt = 0;
/** RSS in MB when "high memory use" was last warned about (0 = it was below the mark since). */
let warnedRssMb = 0;
/** Sleeps since the last snapshot. */
let sleeps = 0;
let sleptMs = 0;

function runCounts() {
  const active = listActiveRuns();
  return { running: active.filter((r) => r.status === "running").length, queued: active.filter((r) => r.status === "queued").length };
}

/** The runs at work, to look up what they were (their "run finished" entries say how heavy they got). */
function runningRuns(): string[] {
  return listActiveRuns()
    .filter((r) => r.status === "running")
    .slice(0, 6)
    .map((r) => r.runId);
}

function fileMb(path: string): number {
  try {
    return Math.round(statSync(path).size / MB);
  } catch {
    return 0;
  }
}

/**
 * Memory: `heapUsedMb` is what JavaScript holds, `rssMb` what the process takes from the system. A large gap means
 * memory that was used once and not given back (large strings and buffers that came and went), not a leak of objects.
 */
export function resourceSnapshot(): Record<string, number> {
  const mem = process.memoryUsage();
  return {
    rssMb: Math.round(mem.rss / MB),
    heapUsedMb: Math.round(mem.heapUsed / MB),
    externalMb: Math.round((mem.external + mem.arrayBuffers) / MB),
    uptimeMin: Math.round(process.uptime() / 60),
    ...runCounts(),
  };
}

/** The periodic snapshot: also the database's size, connected UIs and how the computer slept since the last one. */
function periodicSnapshot(): Record<string, number> {
  const dbPath = config().dbPath;
  const snap: Record<string, number> = { ...resourceSnapshot(), dbMb: fileMb(dbPath), walMb: fileMb(`${dbPath}-wal`), clients: clientCount() };
  if (sleeps) {
    snap.sleeps = sleeps;
    snap.sleptMin = Math.round(sleptMs / 60_000);
  }
  sleeps = 0;
  sleptMs = 0;
  return snap;
}

/** The core exits on these as it always did — now the log says why. */
function installCrashHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("uncaughtException", (err) => {
    crash.error("uncaught exception, core is exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    crash.error("unhandled promise rejection, core is exiting", reason instanceof Error ? reason : { reason });
    process.exit(1);
  });
}

/**
 * `during`: the synchronous work that was slow since the last report, longest first — what blocked the loop. Empty when
 * nothing that is measured was slow (then it was something else: garbage collection, a native call, a busy machine).
 */
function reportStalls() {
  const during = takeSlowSync();
  if (!stalls) return;
  const mem = process.memoryUsage();
  log.warn("event loop blocked", {
    ms: Math.round(worstStall),
    times: stalls,
    totalMs: Math.round(stalledMs),
    ...runCounts(),
    rssMb: Math.round(mem.rss / MB),
    ...(during.length ? { during } : {}),
    ...(runningRuns().length ? { runs: runningRuns() } : {}),
  });
  lastStallReport = Date.now();
  stalls = 0;
  worstStall = 0;
  stalledMs = 0;
}

/** The monotonic clock stops while the computer sleeps, the wall clock doesn't: that tells a stall from sleep. */
function watchEventLoop() {
  let expectedWall = Date.now() + TICK_MS;
  let lastMono = performance.now();
  let awakeSince = lastMono;
  tick = setInterval(() => {
    const now = Date.now();
    const mono = performance.now();
    const busy = mono - lastMono - TICK_MS;
    const gap = now - expectedWall;
    expectedWall = now + TICK_MS;
    lastMono = mono;
    if (busy >= STALL_MS) {
      stalls++;
      stalledMs += busy;
      worstStall = Math.max(worstStall, busy);
    } else if (gap >= SLEEP_MS) {
      const awakeMs = mono - awakeSince;
      awakeSince = mono;
      sleeps++;
      sleptMs += gap;
      // `sleptAt`: when it went to sleep — what happened just before (a browser that went away) belongs to it.
      const details = { pausedMs: Math.round(gap), sleptAt: new Date(now - gap).toISOString(), awakeMin: Math.round(awakeMs / 60_000), ...runCounts() };
      // One entry for a sleep after real use, or under a run; the stirring in between is counted in the next snapshot.
      if (awakeMs >= NAP_AWAKE_MS || details.running) log.info("resumed after the computer slept", details);
      else log.debug("resumed after the computer slept", details);
    }
    // Stalls are reported at once, then at most once a minute. Slow work that stalled nothing is forgotten after a
    // minute, so a later stall isn't blamed on it.
    if (stalls) {
      if (now - lastStallReport >= STALL_REPORT_EVERY_MS) reportStalls();
    } else if (now - slowForgottenAt >= STALL_REPORT_EVERY_MS) {
      takeSlowSync();
      slowForgottenAt = now;
    }
  }, TICK_MS);
  tick.unref?.();
}

function reportResources() {
  reportStalls();
  const snap = periodicSnapshot();
  const high = snap.rssMb * MB >= HIGH_RSS_BYTES;
  if (!high) warnedRssMb = 0;
  if (high && snap.rssMb >= warnedRssMb * HIGH_RSS_AGAIN) {
    warnedRssMb = snap.rssMb;
    log.warn("high memory use", snap);
  } else log.info("resources", snap);
}

export function startDiagnostics() {
  installCrashHandlers();
  if (!tick) watchEventLoop();
  snapshot ??= setInterval(reportResources, SNAPSHOT_EVERY_MS);
  snapshot.unref?.();
}

export function stopDiagnostics() {
  if (tick) clearInterval(tick);
  if (snapshot) clearInterval(snapshot);
  tick = null;
  snapshot = null;
}
