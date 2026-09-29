/**
 * Runtime health for the diagnostic log (owner: core): crashes, event-loop stalls, sleep/wake gaps and periodic
 * memory snapshots.
 */
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";

const log = logger("perf");
const crash = logger("crash");

const TICK_MS = 500;
const STALL_MS = 300;
const SLEEP_MS = 30_000;
const STALL_REPORT_EVERY_MS = 60_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const HIGH_RSS_BYTES = 1.5 * 1024 ** 3;
const MB = 1024 * 1024;

let tick: ReturnType<typeof setInterval> | null = null;
let snapshot: ReturnType<typeof setInterval> | null = null;
let handlersInstalled = false;
let stalls = 0;
let worstStall = 0;
let lastStallReport = -Infinity;

function runCounts() {
  const active = listActiveRuns();
  return { running: active.filter((r) => r.status === "running").length, queued: active.filter((r) => r.status === "queued").length };
}

export function resourceSnapshot(): Record<string, number> {
  const mem = process.memoryUsage();
  return {
    rssMb: Math.round(mem.rss / MB),
    heapUsedMb: Math.round(mem.heapUsed / MB),
    uptimeMin: Math.round(process.uptime() / 60),
    ...runCounts(),
  };
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

function reportStalls() {
  if (!stalls) return;
  log.warn("event loop blocked", { ms: Math.round(worstStall), times: stalls, ...runCounts() });
  lastStallReport = Date.now();
  stalls = 0;
  worstStall = 0;
}

/** The monotonic clock stops while the computer sleeps, the wall clock doesn't: that tells a stall from sleep. */
function watchEventLoop() {
  let expectedWall = Date.now() + TICK_MS;
  let lastMono = performance.now();
  tick = setInterval(() => {
    const now = Date.now();
    const mono = performance.now();
    const busy = mono - lastMono - TICK_MS;
    const gap = now - expectedWall;
    expectedWall = now + TICK_MS;
    lastMono = mono;
    if (busy >= STALL_MS) {
      stalls++;
      worstStall = Math.max(worstStall, busy);
      if (now - lastStallReport >= STALL_REPORT_EVERY_MS) reportStalls();
    } else if (gap >= SLEEP_MS) {
      log.info("resumed after the computer slept", { pausedMs: Math.round(gap) });
    }
  }, TICK_MS);
  tick.unref?.();
}

export function startDiagnostics() {
  installCrashHandlers();
  if (!tick) watchEventLoop();
  snapshot ??= setInterval(() => {
    reportStalls();
    const snap = resourceSnapshot();
    if (snap.rssMb * MB >= HIGH_RSS_BYTES) log.warn("high memory use", snap);
    else log.info("resources", snap);
  }, SNAPSHOT_EVERY_MS);
  snapshot.unref?.();
}

export function stopDiagnostics() {
  if (tick) clearInterval(tick);
  if (snapshot) clearInterval(snapshot);
  tick = null;
  snapshot = null;
}
