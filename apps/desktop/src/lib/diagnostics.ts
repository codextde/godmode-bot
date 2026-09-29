/**
 * Sends errors the UI runs into to the core's diagnostic log (Settings → Logs). Failed API calls are left out: the
 * core logs its own failures. Repeats are dropped for a minute, and reports never trigger more reports.
 */
import type { ClientLogInput } from "@godmode/shared";
import { ApiRequestError } from "./api";
import { getCoreInfo } from "./core";

type Entry = ClientLogInput["entries"][number];

const FLUSH_MS = 2_000;
const RETRY_MS = 15_000;
const MAX_QUEUE = 50;
const REPEAT_WINDOW_MS = 60_000;
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/];

const queue: Entry[] = [];
const recent = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

function describe(err: unknown): { msg: string; stack?: string } {
  if (err instanceof Error) return { msg: err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message, stack: err.stack };
  if (typeof err === "string") return { msg: err };
  try {
    return { msg: JSON.stringify(err) ?? String(err) };
  } catch {
    return { msg: String(err) };
  }
}

function schedule(ms: number) {
  if (!timer) timer = setTimeout(flush, ms);
}

async function flush() {
  timer = null;
  const entries = queue.splice(0, queue.length);
  if (!entries.length) return;
  try {
    const { baseUrl, token } = await getCoreInfo();
    const res = await fetch(`${baseUrl}/api/logs/client`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ entries }),
      credentials: "same-origin",
    });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Core unreachable (restarting, asleep): try again later.
    queue.unshift(...entries.slice(0, MAX_QUEUE - queue.length));
    schedule(RETRY_MS);
  }
}

export function reportClientError(level: Entry["level"], err: unknown, data?: Record<string, unknown>) {
  const { msg, stack } = describe(err);
  const text = (msg ?? "").trim().slice(0, 2000) || "Unknown error";
  if (IGNORED.some((re) => re.test(text))) return;
  const key = `${level}|${text}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < REPEAT_WINDOW_MS) return;
  if (recent.size > 200) recent.clear();
  recent.set(key, now);
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ level, msg: text, ...(stack ? { stack: stack.slice(0, 8000) } : {}), data: { ...data, page: window.location.pathname } });
  schedule(FLUSH_MS);
}

/** QueryCache / MutationCache `onError`: the core can't know about requests that never reached it or UI code that threw. */
export function reportRequestError(err: unknown, what: string) {
  if (err instanceof ApiRequestError) return;
  const offline = err instanceof TypeError && /fetch|load failed|network/i.test(err.message);
  reportClientError(offline ? "warn" : "error", err, { request: what, ...(offline ? { offline: true } : {}) });
}

export function installErrorReporting() {
  window.addEventListener("error", (e) => {
    if (!e.error && !e.message) return;
    reportClientError("error", e.error ?? e.message, { source: "window.onerror" });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const status = e.reason instanceof ApiRequestError ? { status: e.reason.status, code: e.reason.code } : {};
    reportClientError("error", e.reason, { source: "unhandled promise rejection", ...status });
  });
}

type ErrorInfo = { componentStack?: string | null };

function onReactError(kind: string, level: Entry["level"]) {
  return (error: unknown, info: ErrorInfo) => {
    console.error(error);
    reportClientError(level, error, { source: kind, componentStack: info.componentStack?.trim().slice(0, 2000) });
  };
}

/** `createRoot` options: render crashes are recorded (and still printed to the console). */
export const reactRootErrorHandlers = {
  onUncaughtError: onReactError("render crash", "error"),
  onCaughtError: onReactError("render error (caught)", "error"),
  onRecoverableError: onReactError("recoverable render error", "warn"),
};
