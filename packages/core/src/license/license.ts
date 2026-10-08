/**
 * Godmode's licence (owner: license).
 *
 * The key and the licence server's last answer live in meta keys `license.*` (not in Settings, which paired phones can
 * read). The key is checked at start, every 6 hours and on demand against `<site>/api/license`; network errors and 5xx
 * keep the last answer. Release builds refuse new runs while the licence is missing, invalid or expired; existing
 * installs get 7 days to add a key, and a key that could not be checked yet counts for 7 days.
 */
import {
  LICENSE_INVALID,
  LICENSE_REQUIRED,
  LICENSE_SITE,
  isLicenseKey,
  normalizeLicenseKey,
  type LicensePlan,
  type LicenseState,
  type LicenseStatus,
} from "@godmode/shared";
import { COMPILED, VERSION, config } from "../config";
import { deleteMeta, get, getMeta, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { notify } from "../services/notifications";
import { getSettings } from "../services/settings";
import { HttpError, parseJson } from "../util";

const log = logger("license");

const DAY_MS = 86_400_000;
export const LICENSE_CHECK_INTERVAL_MS = 6 * 3_600_000;
export const LICENSE_GRACE_MS = 7 * DAY_MS;
export const LICENSE_UNVERIFIED_MS = 7 * DAY_MS;
/** A subscription not confirmed for this long after its trial or period ended counts as unverified again. */
export const LICENSE_STALE_MS = 14 * DAY_MS;
const REQUEST_TIMEOUT_MS = 15_000;
/** A refused run asks the server again at most this often (the human may have just paid). */
const RECHECK_BLOCKED_MS = 5 * 60_000;

const META = {
  key: "license.key",
  verdict: "license.verdict",
  /** Since when a key has waited for its first answer; kept across key changes until one is answered. */
  unverifiedSince: "license.unverified_since",
  graceEndsAt: "license.grace_ends_at",
  /** When this install first ran a version with licences (the grace period is decided then, once). */
  firstStart: "license.first_start",
};

/** The licence server's last answer for the stored key. */
interface Verdict {
  valid: boolean;
  /** The subscription status, or the reason a key was refused (`unknown`, `malformed`). */
  status: string | null;
  plan: LicensePlan | null;
  trialEndsAt: string | null;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  manageUrl: string | null;
  checkedAt: string;
}

type Answer = { kind: "verdict"; verdict: Verdict } | { kind: "unreachable"; reason: string };

/** A new run was refused for the licence: HTTP 402 `license_required`. */
export class LicenseRequiredError extends HttpError {
  constructor(message: string) {
    super(402, message, LICENSE_REQUIRED);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: Fetch = (url, init) => fetch(url, init);
let fetchImpl = defaultFetch;
let enforcedOverride: boolean | null = null;
let compiled = COMPILED;
const OFFICIAL = process.env.GODMODE_OFFICIAL_BUILD === "1";
let official = OFFICIAL;
/** A `GODMODE_LICENSE` key that differs from the stored one: it replaces it once the server has answered for it. */
let pendingEnvKey: string | null = null;
let clock = () => Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
let checking: Promise<LicenseState> | null = null;
let signature = "";
let lastNotice = 0;
let lastBlockedCheck = 0;

export function __setLicenseFetchForTests(f: Fetch | null) {
  fetchImpl = f ?? defaultFetch;
}

export function __setLicenseEnforcedForTests(value: boolean | null) {
  enforcedOverride = value;
}

export function __setLicenseCompiledForTests(value: boolean | null) {
  compiled = value ?? COMPILED;
}

export function __setLicenseOfficialForTests(value: boolean | null) {
  official = value ?? OFFICIAL;
}

export function __setLicenseClockForTests(fn: (() => number) | null) {
  clock = fn ?? (() => Date.now());
}

export function __resetLicenseForTests() {
  for (const key of Object.values(META)) deleteMeta(key);
  checking = null;
  pendingEnvKey = null;
  signature = "";
  lastNotice = 0;
  lastBlockedCheck = 0;
}

/**
 * Godmode is MIT licensed: only the official builds from usegodmode.com (compiled with GODMODE_OFFICIAL_BUILD=1 by the
 * release workflow) refuse runs without a Pro licence. Runs from source and builds of your own never do.
 * `GODMODE_LICENSE_ENFORCE=1` turns it on from source (to try it out); nothing turns it off in an official build.
 * A runner works for another Godmode, which holds the licence.
 */
export function licenseEnforced(): boolean {
  if (enforcedOverride !== null) return enforcedOverride;
  try {
    if (config().role === "runner") return false;
  } catch {
    return false;
  }
  return (compiled && official) || process.env.GODMODE_LICENSE_ENFORCE === "1";
}

/** `GODMODE_LICENSE_URL` is for tests and builds from source: a release build only asks the real site. */
export function licenseBaseUrl(): string {
  const override = compiled ? "" : process.env.GODMODE_LICENSE_URL?.trim();
  return (override || LICENSE_SITE).replace(/\/+$/, "");
}

const iso = (ms: number) => new Date(ms).toISOString();
const PLANS: readonly string[] = ["monthly", "yearly", "lifetime"];
const ENDED: readonly string[] = ["canceled", "refunded", "expired"];

function statusOf(v: Verdict): LicenseStatus {
  if (v.valid) return v.status === "trialing" ? "trial" : v.status === "past_due" ? "past_due" : "active";
  return v.status && ENDED.includes(v.status) ? "expired" : "invalid";
}

function shortDate(at: string | number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function refusedKeyMessage(v: Verdict): string {
  if (v.status === "pending") return "The payment for this licence isn't complete yet. Finish the checkout, then try the key again.";
  return "This licence key isn't valid. Check it for typos, or start a free trial to get one.";
}

/**
 * Fail-open has an end: a good answer older than 14 days whose trial (or paid period) has ended since stops counting
 * as proof. Returns when that happened; the 7-day unverified window starts there. Lifetime licences never go stale.
 */
function staleSince(v: Verdict, now: number): number | null {
  const status = statusOf(v);
  if (status === "invalid" || status === "expired") return null;
  const checked = Date.parse(v.checkedAt);
  const end = Date.parse((status === "trial" ? (v.trialEndsAt ?? v.renewsAt) : v.renewsAt) ?? "");
  if (Number.isNaN(checked) || Number.isNaN(end)) return null;
  if (now - checked <= LICENSE_STALE_MS || now <= end) return null;
  return Math.max(checked + LICENSE_STALE_MS, end);
}

/** The stored key, for what needs it besides the licence check (a runner downloading Godmode from the site). */
export function licenseKey(): string | null {
  return getMeta(META.key);
}

export function licenseState(): LicenseState {
  const now = clock();
  const key = getMeta(META.key);
  const verdict = key ? parseJson<Verdict | null>(getMeta(META.verdict), null) : null;
  const graceEndsAt = getMeta(META.graceEndsAt);
  const graceOpen = !!graceEndsAt && now < Date.parse(graceEndsAt);
  const enforced = licenseEnforced();

  let status: LicenseStatus;
  let refuses: boolean;
  let unverifiedUntil: string | null = null;
  if (!key) {
    status = graceOpen ? "grace" : "missing";
    refuses = true;
  } else if (!verdict) {
    const since = Date.parse(getMeta(META.unverifiedSince) ?? "");
    const until = (Number.isNaN(since) ? now : since) + LICENSE_UNVERIFIED_MS;
    unverifiedUntil = iso(until);
    status = "unverified";
    refuses = now >= until;
  } else if (staleSince(verdict, now) !== null) {
    const until = staleSince(verdict, now)! + LICENSE_UNVERIFIED_MS;
    unverifiedUntil = iso(until);
    status = "unverified";
    refuses = now >= until;
  } else {
    status = statusOf(verdict);
    refuses = status === "invalid" || status === "expired";
  }
  const blocked = enforced && refuses && !graceOpen;

  let message: string | null = null;
  if (blocked) {
    if (status === "missing" && graceEndsAt) {
      message = `The 7 days to add a licence key ended on ${shortDate(graceEndsAt)}. Add your key or start the free trial to keep your agents working.`;
    } else if (status === "missing") message = "Godmode needs a licence to start new work. Add your licence key or start the 14-day free trial.";
    else if (status === "unverified") message = "Godmode couldn't check your licence key for 7 days. Connect to the internet, then refresh the licence.";
    else if (status === "invalid") message = refusedKeyMessage(verdict!);
    else message = "Your Godmode licence has ended. Renew it or add another key to keep your agents working.";
  } else if (status === "grace" && graceEndsAt) {
    message = `Add your licence key by ${shortDate(graceEndsAt)}. Until then everything works as before.`;
  } else if (status === "unverified" && unverifiedUntil) {
    message = `Your key couldn't be checked yet. Godmode accepts it until ${shortDate(unverifiedUntil)} and tries again every few hours.`;
  } else if (status === "past_due") {
    message = "The last payment didn't go through. Update your payment method to keep Godmode working.";
  } else if (graceOpen && (status === "invalid" || status === "expired")) {
    message = `${status === "invalid" ? refusedKeyMessage(verdict!) : "This licence has ended."} Everything keeps working until ${shortDate(graceEndsAt!)}.`;
  }

  return {
    status,
    plan: verdict?.plan ?? null,
    keyHint: key ? key.slice(-5) : null,
    trialEndsAt: verdict?.trialEndsAt ?? null,
    renewsAt: verdict?.renewsAt ?? null,
    cancelAtPeriodEnd: verdict?.cancelAtPeriodEnd ?? false,
    graceEndsAt,
    unverifiedUntil,
    checkedAt: verdict?.checkedAt ?? null,
    manageUrl: verdict?.manageUrl ?? null,
    message,
    enforced,
    blocked,
  };
}

/** Tells the UIs when what they show about the licence changed. */
function publish(): LicenseState {
  const state = licenseState();
  const next = JSON.stringify(state);
  if (next !== signature) {
    signature = next;
    bus.changed("license");
  }
  return state;
}

function time(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return iso(value);
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return iso(Date.parse(value));
  return null;
}

/** Only the licence server's own pages, or https. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.origin === new URL(licenseBaseUrl()).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reads both the full answer and the older `{ valid, plan, status }`; missing fields are null. */
function parseVerdict(body: unknown, checkedAt: string): Verdict | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.valid !== "boolean") return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
  return {
    valid: b.valid,
    status: text(b.status) ?? text(b.reason),
    plan: typeof b.plan === "string" && PLANS.includes(b.plan) ? (b.plan as LicensePlan) : null,
    trialEndsAt: time(b.trialEndsAt),
    renewsAt: time(b.renewsAt),
    cancelAtPeriodEnd: b.cancelAtPeriodEnd === true,
    manageUrl: safeUrl(b.manageUrl),
    checkedAt,
  };
}

async function ask(key: string): Promise<Answer> {
  const base = licenseBaseUrl();
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/license?key=${encodeURIComponent(key)}`, {
      headers: { accept: "application/json", "user-agent": `GodmodeBot/${VERSION}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? err.name === "TimeoutError" ? "timed out" : err.message : String(err) };
  }
  const body: unknown = await res.json().catch(() => null);
  const verdict = parseVerdict(body, iso(clock()));
  // A refusal counts only when it is the licence server's own (`{ valid: false }`), not a proxy's error page.
  if (res.status === 400 || res.status === 404) {
    if (verdict && !verdict.valid) return { kind: "verdict", verdict: { ...verdict, status: verdict.status ?? (res.status === 404 ? "unknown" : "malformed") } };
    return { kind: "unreachable", reason: `HTTP ${res.status}` };
  }
  if (!res.ok) return { kind: "unreachable", reason: `HTTP ${res.status}` };
  return verdict ? { kind: "verdict", verdict } : { kind: "unreachable", reason: "unexpected answer" };
}

function storeVerdict(verdict: Verdict) {
  setMeta(META.verdict, JSON.stringify(verdict));
  deleteMeta(META.unverifiedSince);
}

/** Ask the licence server about the stored key now. Fails open: without an answer the last state stays. */
export function refreshLicense(): Promise<LicenseState> {
  checking ??= (async () => {
    try {
      if (pendingEnvKey) await adoptEnvKey(pendingEnvKey);
      const key = getMeta(META.key);
      if (!key) return publish();
      const answer = await ask(key);
      // Changed or removed while the server was asked.
      if (getMeta(META.key) !== key) return publish();
      if (answer.kind === "verdict") {
        const before = parseJson<Verdict | null>(getMeta(META.verdict), null);
        storeVerdict(answer.verdict);
        const status = statusOf(answer.verdict);
        if (!before || statusOf(before) !== status) log.info("licence checked", { key: key.slice(-5), status, plan: answer.verdict.plan });
      } else {
        log.info("licence server not reachable, keeping the last state", { reason: answer.reason });
      }
      return publish();
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** The key from `GODMODE_LICENSE` replaces the stored one once the server answered for it (and didn't refuse it). */
async function adoptEnvKey(key: string): Promise<void> {
  const answer = await ask(key);
  if (answer.kind === "unreachable") {
    log.info("GODMODE_LICENSE differs from the stored key; it is checked again later", { key: key.slice(-5), reason: answer.reason });
    return;
  }
  pendingEnvKey = null;
  if (statusOf(answer.verdict) === "invalid") {
    log.warn("GODMODE_LICENSE was refused by the licence server; the stored key stays", { key: key.slice(-5) });
    return;
  }
  setMeta(META.key, key);
  storeVerdict(answer.verdict);
  audit("system", "license.set", key.slice(-5), { from: "GODMODE_LICENSE", status: statusOf(answer.verdict) });
  log.info("licence key taken from GODMODE_LICENSE", { key: key.slice(-5) });
}

/** PUT /api/license: a key the server refuses is not stored; one it can't be asked about counts as unverified. */
export async function setLicenseKey(input: string): Promise<LicenseState> {
  const key = normalizeLicenseKey(input);
  if (!isLicenseKey(key)) {
    throw new HttpError(400, "That doesn't look like a Godmode licence key. It has the form GM-XXXXX-XXXXX-XXXXX-XXXXX.", LICENSE_INVALID);
  }
  const answer = await ask(key);
  if (answer.kind === "verdict" && statusOf(answer.verdict) === "invalid") throw new HttpError(400, refusedKeyMessage(answer.verdict), LICENSE_INVALID);
  const changed = getMeta(META.key) !== key;
  if (changed) {
    setMeta(META.key, key);
    deleteMeta(META.verdict);
  }
  if (answer.kind === "verdict") storeVerdict(answer.verdict);
  else if (changed && !getMeta(META.unverifiedSince)) setMeta(META.unverifiedSince, iso(clock()));
  audit("user", "license.set", key.slice(-5), { status: licenseState().status });
  log.info("licence key added", { key: key.slice(-5), verified: answer.kind === "verdict" });
  return publish();
}

export function removeLicenseKey(): LicenseState {
  const key = getMeta(META.key);
  if (key) {
    deleteMeta(META.key);
    deleteMeta(META.verdict);
    audit("user", "license.remove", key.slice(-5));
    log.info("licence key removed", { key: key.slice(-5) });
  }
  return publish();
}

/** Whether new runs are refused right now. */
export function licenseBlocks(): boolean {
  return licenseEnforced() && licenseState().blocked;
}

/** The gate for every new run. Throws `LicenseRequiredError` (402) while the licence refuses them. */
export function requireLicense(): void {
  if (!licenseEnforced()) return;
  const state = licenseState();
  if (!state.blocked) return;
  if (getMeta(META.key) && clock() - lastBlockedCheck >= RECHECK_BLOCKED_MS) {
    lastBlockedCheck = clock();
    void refreshLicense().catch((err) => log.warn("licence check failed", err));
  }
  throw new LicenseRequiredError(state.message ?? "Godmode needs an active licence to start new work.");
}

export function isLicenseRequired(err: unknown): err is LicenseRequiredError {
  return err instanceof HttpError && err.code === LICENSE_REQUIRED;
}

/** Background work the licence stopped (automations, follow-ups): the human hears about it once a day, not on every tick. */
export function noteLicenseRefusal(what: string, err: HttpError) {
  log.info(`${what} not started: no active licence`);
  if (clock() - lastNotice < DAY_MS) return;
  lastNotice = clock();
  notify("warning", "Godmode needs an active licence", `${what} couldn't start. ${err.message}`, "/settings/license");
}

/** An install that was used before this version (set up, or with chats, runs or more than the default agent). */
function usedBefore(): boolean {
  const count = (table: string) => get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0;
  return getSettings().onboardingComplete || count("runs") > 0 || count("conversations") > 0 || count("agents") > 1;
}

/**
 * Before anything can start a run: takes the key from `GODMODE_LICENSE` (and keeps it from child processes) — at once
 * when none is stored, after the next check when it differs from the stored one — and, on the first start with
 * licences, gives an install that was already used 7 days to add a key.
 */
export function initLicense(): void {
  const fromEnv = process.env.GODMODE_LICENSE;
  delete process.env.GODMODE_LICENSE;
  const stored = getMeta(META.key);
  if (fromEnv?.trim()) {
    const key = normalizeLicenseKey(fromEnv);
    if (!isLicenseKey(key)) log.warn("GODMODE_LICENSE is not a licence key (GM-XXXXX-XXXXX-XXXXX-XXXXX), ignored");
    else if (!stored) {
      setMeta(META.key, key);
      if (!getMeta(META.unverifiedSince)) setMeta(META.unverifiedSince, iso(clock()));
      log.info("licence key taken from GODMODE_LICENSE", { key: key.slice(-5) });
    } else if (stored !== key) pendingEnvKey = key;
  }
  if (!getMeta(META.firstStart)) {
    setMeta(META.firstStart, iso(clock()));
    if (!getMeta(META.key) && usedBefore()) {
      setMeta(META.graceEndsAt, iso(clock() + LICENSE_GRACE_MS));
      log.info("existing install without a licence key: 7 days to add one");
    }
  }
  signature = JSON.stringify(licenseState());
}

export function startLicense(): void {
  initLicense();
  void refreshLicense().catch((err) => log.warn("licence check failed", err));
  timer = setInterval(() => void refreshLicense().catch((err) => log.warn("licence check failed", err)), LICENSE_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopLicense(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
